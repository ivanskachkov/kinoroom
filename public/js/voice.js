import { api, storage } from './common.js';

/*
 * Голосовой чат «в одну сторону»: включивший микрофон отправляет звук каждому в комнате,
 * слушателям микрофон не нужен. На каждую пару «говорящий → слушатель» — своё
 * RTCPeerConnection (mesh). Для компании до ~10 человек это проще и надёжнее медиасервера.
 *
 * Соединения различаются направлением: 'out' — я говорю этой вкладке, 'in' — она говорит мне.
 * Если говорят оба, между ними два независимых соединения.
 */

const MIC_ERRORS = {
  NotAllowedError: 'Доступ к микрофону запрещён — разрешите его в настройках сайта в браузере',
  NotFoundError: 'Микрофон не найден',
  NotReadableError: 'Микрофон занят другой программой',
};

/** «Windows Chrome 140» — для журнала связи: жалобы на звук часто зависят от браузера и системы. */
function browserName() {
  const ua = navigator.userAgent;
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '?';
  const browsers = [['Edg', 'Edge'], ['OPR', 'Opera'], ['YaBrowser', 'Яндекс'], ['SamsungBrowser', 'Samsung'], ['FxiOS', 'Firefox'], ['Firefox', 'Firefox'], ['CriOS', 'Chrome'], ['Chrome', 'Chrome'], ['Version', 'Safari']];
  for (const [token, name] of browsers) {
    const match = ua.match(new RegExp(`${token}/(\\d+)`));
    if (match) return `${os} ${name} ${match[1]}`;
  }
  return os;
}

const SPEAKING_LEVEL = 0.04; // уровень входящего звука, выше которого считаем, что человек говорит
const MAX_RETRIES = 2;
const DEFAULT_GATE = 0.1;
const GATE_HOLD_MS = 600; // не обрезать окончания слов и короткие паузы между ними

export function createVoice({ socket, onChange }) {
  const peers = new Map(); // `${dir}:${socketId}` → { pc, dir, remoteId, memberId, pending, audio, receiver }
  const queues = new Map(); // сигналы по одному соединению обрабатываем строго по порядку
  const audioBox = document.createElement('div');
  audioBox.hidden = true;
  document.body.append(audioBox);

  let micStream = null; // сам микрофон — его слушает индикатор уровня
  let localStream = null; // то, что уходит слушателям: копия дорожки, которую выключает шумовой порог
  let live = false; // объявлены говорящим — нас слышат (микрофон может быть открыт и только для проверки)
  let starting = false;
  let testing = false;
  let gateThreshold = storage.get('kr_voice_gate', DEFAULT_GATE);
  let gateOpen = false;
  let gateOpenMs = 0; // сколько порог был открыт — для диагностики
  let gateChangedAt = 0;
  let micLevelValue = 0;
  let audioBlocked = false;
  let volume = storage.get('kr_voice_volume', 1);
  let meter = null;
  let iceServers = null;

  const supported = Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.RTCPeerConnection);

  function loadIceServers() {
    iceServers ??= api('/api/ice')
      .then((res) => res.iceServers)
      .catch(() => [{ urls: 'stun:stun.l.google.com:19302' }]);
    return iceServers;
  }
  if (window.RTCPeerConnection) loadIceServers();

  const send = (to, dir, payload) => socket.emit('voice:signal', { to, pc: dir, ...payload });

  function closePeer(key) {
    const peer = peers.get(key);
    if (!peer) return;
    peers.delete(key);
    peer.pc.close();
    if (peer.audio) {
      peer.audio.srcObject = null;
      peer.audio.remove();
    }
    onChange();
  }

  function closeAll(dir) {
    for (const key of [...peers.keys()]) if (!dir || key.startsWith(`${dir}:`)) closePeer(key);
  }

  async function createPeer(dir, remoteId, memberId = null) {
    const key = `${dir}:${remoteId}`;
    closePeer(key);
    const pc = new RTCPeerConnection({ iceServers: await loadIceServers() });
    const peer = { pc, dir, remoteId, memberId, pending: [], audio: null, receiver: null };
    peers.set(key, peer);

    pc.onicecandidate = (event) => {
      if (event.candidate) send(remoteId, dir, { candidate: event.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setTimeout(() => refreshLinks(true).catch(() => {}), 3000);
      if (pc.connectionState === 'failed' && peers.get(key) === peer) {
        sendReport([{ dir, memberId: peer.memberId, state: 'failed' }]);
        closePeer(key);
        // Переподключается говорящий: он и создаёт предложение.
        if (dir === 'out' && localStream && (peer.retries ?? 0) < MAX_RETRIES) {
          setTimeout(() => callListener(remoteId, (peer.retries ?? 0) + 1), 1500);
        }
      }
      onChange();
    };
    if (dir === 'in') {
      pc.ontrack = (event) => playRemote(peer, event.streams[0] ?? new MediaStream([event.track]), event.receiver);
    }
    return peer;
  }

  function playRemote(peer, stream, receiver) {
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    audio.srcObject = stream;
    audio.volume = volume;
    audioBox.append(audio);
    peer.audio = audio;
    peer.receiver = receiver;
    audio.play().catch(() => {
      audioBlocked = true;
      onChange();
    });
    onChange();
  }

  async function callListener(remoteId, retries = 0) {
    if (!localStream) return;
    const peer = await createPeer('out', remoteId);
    peer.retries = retries;
    if (!localStream) return closePeer(`out:${remoteId}`);
    for (const track of localStream.getAudioTracks()) {
      peer.pc.addTransceiver(track, { direction: 'sendonly', streams: [localStream] });
    }
    await peer.pc.setLocalDescription(await peer.pc.createOffer());
    send(remoteId, 'out', { description: peer.pc.localDescription.toJSON() });
  }

  async function flushCandidates(peer) {
    for (const candidate of peer.pending.splice(0)) await peer.pc.addIceCandidate(candidate).catch(() => {});
  }

  async function handleSignal({ from, memberId, pc: remoteDir, description, candidate }) {
    // Отправитель пишет со своей стороны: его 'out' — это моё 'in', и наоборот.
    const dir = remoteDir === 'out' ? 'in' : 'out';
    const key = `${dir}:${from}`;

    if (description?.type === 'offer' && dir === 'in') {
      const peer = await createPeer('in', from, memberId);
      await peer.pc.setRemoteDescription(description);
      await flushCandidates(peer);
      await peer.pc.setLocalDescription(await peer.pc.createAnswer());
      send(from, 'in', { description: peer.pc.localDescription.toJSON() });
      return;
    }
    const peer = peers.get(key);
    if (!peer) return;
    if (description?.type === 'answer' && dir === 'out') {
      peer.memberId ??= memberId; // кому мы говорим — для панели связи
      await peer.pc.setRemoteDescription(description);
      await flushCandidates(peer);
    } else if (candidate) {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(candidate).catch(() => {});
      else peer.pending.push(candidate);
    }
  }

  socket.on('voice:signal', (signal) => {
    const key = `${signal.pc === 'out' ? 'in' : 'out'}:${signal.from}`;
    const next = (queues.get(key) ?? Promise.resolve())
      .then(() => handleSignal(signal))
      .catch((err) => console.warn('[voice]', err));
    queues.set(key, next);
    next.finally(() => queues.get(key) === next && queues.delete(key));
  });
  socket.on('voice:listener', ({ socketId }) => callListener(socketId).catch((err) => console.warn('[voice]', err)));
  socket.on('voice:stopped', ({ socketId }) => closePeer(`in:${socketId}`));
  socket.on('voice:peer-left', ({ socketId }) => {
    closePeer(`in:${socketId}`);
    closePeer(`out:${socketId}`);
  });
  // После обрыва связи у всех вкладок новые id — старые соединения бесполезны.
  socket.on('disconnect', () => closeAll());

  // --- Диагностика связи ------------------------------------------------------
  // Раз в 2 секунды снимаем статистику соединений: панель показывает, с кем связь есть и какая,
  // а раз в 10 секунд короткая сводка уходит на сервер — в журнал, чтобы разбирать жалобы на звук.
  let links = [];
  let statsTick = 0;
  let gateMark = { at: 0, openMs: 0 };

  async function linkInfo(peer) {
    const info = { dir: peer.dir, memberId: peer.memberId, state: peer.pc.connectionState };
    const stats = await peer.pc.getStats().catch(() => null);
    if (!stats) return info;
    let pair = null;
    let rtp = null;
    let remoteRtp = null;
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId) ?? pair;
      if (s.type === 'candidate-pair' && !pair && (s.selected || (s.nominated && s.state === 'succeeded'))) pair = s;
      if (s.kind === 'audio' && s.type === (peer.dir === 'in' ? 'inbound-rtp' : 'outbound-rtp')) rtp = s;
      if (s.kind === 'audio' && s.type === 'remote-inbound-rtp') remoteRtp = s;
    });
    if (pair) {
      const local = stats.get(pair.localCandidateId);
      const remote = stats.get(pair.remoteCandidateId);
      info.route = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct';
      info.net = `${local?.candidateType ?? '?'}/${remote?.candidateType ?? '?'} ${local?.relayProtocol ?? local?.protocol ?? ''}`.trim();
      if (Number.isFinite(pair.currentRoundTripTime)) info.rtt = Math.round(pair.currentRoundTripTime * 1000);
    }
    const prev = peer.prevStats ?? {};
    if (rtp && peer.dir === 'in') {
      const received = rtp.packetsReceived ?? 0;
      const lost = Math.max(0, rtp.packetsLost ?? 0);
      const concealed = rtp.concealedSamples ?? 0;
      const samples = rtp.totalSamplesReceived ?? 0;
      const dReceived = received - (prev.received ?? 0);
      const dLost = Math.max(0, lost - (prev.lost ?? 0));
      const dSamples = samples - (prev.samples ?? 0);
      info.packets = dReceived;
      info.loss = dReceived + dLost > 0 ? Math.round((100 * dLost) / (dReceived + dLost)) : 0;
      // Доля звука, который браузеру пришлось «додумать» из-за потерь и опозданий, — это и есть хрип
      info.conceal = dSamples > 0 ? Math.round((100 * (concealed - (prev.concealed ?? 0))) / dSamples) : 0;
      info.level = Math.round((rtp.audioLevel ?? 0) * 100) / 100;
      info.playing = Boolean(peer.audio && !peer.audio.paused);
      peer.prevStats = { received, lost, concealed, samples };
    } else if (rtp) {
      const sent = rtp.packetsSent ?? 0;
      info.packets = sent - (prev.sent ?? 0);
      if (Number.isFinite(remoteRtp?.fractionLost)) info.loss = Math.round(remoteRtp.fractionLost * 100);
      peer.prevStats = { sent };
    }
    return info;
  }

  async function refreshLinks(reportNow = false) {
    if (!peers.size) {
      if (links.length) {
        links = [];
        onChange();
      }
      return;
    }
    links = await Promise.all([...peers.values()].map(linkInfo));
    onChange();
    statsTick += 1;
    if (reportNow || statsTick % 5 === 0) sendReport(links);
  }
  setInterval(() => refreshLinks().catch(() => {}), 2000);

  function sendReport(items) {
    let mic = null;
    if (localStream) {
      const now = performance.now();
      const openMs = gateOpenMs + (gateOpen ? now - gateChangedAt : 0);
      const span = gateMark.at ? now - gateMark.at : 0;
      mic = {
        meter: meter?.kind ?? 'none',
        context: meter?.context.state ?? null,
        threshold: gateThreshold,
        // доля времени с открытым порогом с прошлой сводки: 0 — слушатели слышат тишину
        open: span > 0 ? Math.round((100 * (openMs - gateMark.openMs)) / span) : null,
      };
      gateMark = { at: now, openMs };
    }
    socket.emit('voice:report', { ua: browserName(), live, mic, links: items });
  }

  // --- Микрофон -------------------------------------------------------------

  // Шумовой порог: пока уровень ниже порога, слушателям уходит тишина, а не шум комнаты,
  // и у них не приглушается фильм. Без индикатора (нет AudioContext) порог всегда открыт.
  function applyGate(open) {
    if (open === gateOpen) return;
    const now = performance.now();
    if (gateOpen) gateOpenMs += now - gateChangedAt;
    gateChangedAt = now;
    gateOpen = open;
    for (const track of localStream?.getAudioTracks() ?? []) track.enabled = open;
  }

  async function startMeter(context, stream) {
    const source = context.createMediaStreamSource(stream);
    if (context.audioWorklet && window.AudioWorkletNode) {
      try {
        await context.audioWorklet.addModule('/js/voice-meter.worklet.js');
        const node = new AudioWorkletNode(context, 'voice-meter', { numberOfOutputs: 1, outputChannelCount: [1] });
        node.port.postMessage({ threshold: gateThreshold, hold: GATE_HOLD_MS / 1000 });
        node.port.onmessage = ({ data }) => {
          micLevelValue = data.level;
          applyGate(data.open);
        };
        // Выход узла — тишина; без подключения к выходу браузер узел не обсчитывает
        source.connect(node).connect(context.destination);
        return { context, kind: 'worklet', setThreshold: (threshold) => node.port.postMessage({ threshold }) };
      } catch (err) {
        console.warn('[voice] AudioWorklet недоступен — уровень по таймеру', err);
      }
    }
    // Запасной путь для старых браузеров: по таймеру, в фоновой вкладке — рывками
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let lastLoudAt = 0;
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const s of samples) sum += s * s;
      micLevelValue = Math.min(1, Math.sqrt(sum / samples.length) * 4);
      const now = performance.now();
      if (micLevelValue >= gateThreshold) lastLoudAt = now;
      applyGate(now - lastLoudAt < GATE_HOLD_MS);
    }, 40);
    return { context, kind: 'timer', timer, setThreshold() {} };
  }

  function stopMeter() {
    if (meter) {
      clearInterval(meter.timer);
      meter.context.close().catch(() => {});
      meter = null;
    }
    applyGate(false);
    micLevelValue = 0;
  }

  async function announce() {
    const res = await socket.timeout(5000).emitWithAck('voice:start');
    if (res?.error) throw new Error(res.error);
    for (const id of res.listeners ?? []) callListener(id).catch((err) => console.warn('[voice]', err));
  }

  async function openMic() {
    // AudioContext — до первого await, пока ещё идёт нажатие на кнопку: иначе Safari оставит его на паузе
    let context = null;
    try {
      context = new AudioContext();
      context.resume().catch(() => {});
    } catch {}
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (err) {
      context?.close().catch(() => {});
      throw err;
    }
    micStream = stream;
    // Выключать саму дорожку микрофона нельзя: индикатор замолчит, и порог больше не откроется
    const sendTrack = stream.getAudioTracks()[0].clone();
    sendTrack.enabled = false;
    localStream = new MediaStream([sendTrack]);
    gateOpen = false;
    gateOpenMs = 0;
    gateChangedAt = performance.now();
    gateMark = { at: 0, openMs: 0 };
    const started = context ? await startMeter(context, stream).catch(() => null) : null;
    if (micStream !== stream) {
      // Микрофон выключили, пока подключался индикатор
      started?.context.close().catch(() => {});
      return;
    }
    meter = started;
    if (!meter) {
      context?.close().catch(() => {});
      micLevelValue = 1;
      applyGate(true);
    }
  }

  async function start() {
    if (!supported) throw new Error('Микрофон работает только по HTTPS (или на localhost)');
    if (live || starting) return;
    starting = true;
    onChange();
    try {
      if (!localStream) await openMic();
      await announce();
      live = true;
    } catch (err) {
      stopLocal();
      throw new Error(MIC_ERRORS[err?.name] ?? err?.message ?? 'Не удалось включить микрофон');
    } finally {
      starting = false;
      onChange();
    }
  }

  function stopLocal() {
    closeAll('out');
    stopMeter();
    for (const stream of [localStream, micStream]) stream?.getTracks().forEach((track) => track.stop());
    localStream = null;
    micStream = null;
    live = false;
    onChange();
  }

  function stop() {
    if (!live) return;
    socket.emit('voice:stop');
    stopLocal();
  }

  /** Записывает несколько секунд того, что уходит слушателям (после шумового порога), и отдаёт запись. */
  async function testMic(seconds = 4) {
    if (!supported || !window.MediaRecorder) throw new Error('Этот браузер не умеет записывать звук');
    if (testing) return null;
    testing = true;
    onChange();
    const temporary = !localStream; // микрофон был выключен — открываем только на время проверки, в эфир не выходим
    try {
      if (temporary) await openMic();
      const recorder = new MediaRecorder(localStream);
      const chunks = [];
      recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
      const stopped = new Promise((resolve) => (recorder.onstop = resolve));
      recorder.start();
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      recorder.stop();
      await stopped;
      return new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
    } catch (err) {
      throw new Error(MIC_ERRORS[err?.name] ?? err?.message ?? 'Не удалось проверить микрофон');
    } finally {
      if (temporary && !live) stopLocal();
      testing = false;
      onChange();
    }
  }

  return {
    supported,
    start,
    stop,
    testMic,
    /** В эфире — нас слышат. */
    get active() {
      return live;
    },
    /** Микрофон открыт: в эфире или идёт проверка. */
    get micOpen() {
      return Boolean(localStream);
    },
    get testing() {
      return testing;
    },
    get starting() {
      return starting;
    },
    get audioBlocked() {
      return audioBlocked;
    },

    /** После переподключения к комнате снова объявляем себя говорящим. */
    async resume() {
      if (live) await announce().catch((err) => console.warn('[voice]', err));
    },

    /** Браузер не дал включить звук без клика — повторяем воспроизведение из обработчика клика. */
    unlock() {
      if (!audioBlocked) return;
      audioBlocked = false;
      for (const peer of peers.values()) peer.audio?.play().catch(() => (audioBlocked = true));
      onChange();
    },

    setVolume(level) {
      volume = level;
      storage.set('kr_voice_volume', level);
      for (const peer of peers.values()) if (peer.audio) peer.audio.volume = level;
    },
    get volume() {
      return volume;
    },

    /** Уровень громкости собственного микрофона, 0…1. */
    micLevel() {
      return micLevelValue;
    },
    /** Открыт ли шумовой порог — то есть слышат ли вас сейчас. */
    get gateOpen() {
      return gateOpen;
    },
    get gateThreshold() {
      return gateThreshold;
    },
    setGateThreshold(value) {
      gateThreshold = value;
      storage.set('kr_voice_gate', value);
      meter?.setThreshold(value);
    },

    /** id участников, которых сейчас слышно (по уровню входящего звука). */
    speakingMembers() {
      const speaking = new Set();
      for (const peer of peers.values()) {
        if (peer.dir !== 'in' || !peer.receiver || !peer.memberId) continue;
        const level = peer.receiver.getSynchronizationSources?.()[0]?.audioLevel ?? 0;
        if (level > SPEAKING_LEVEL) speaking.add(peer.memberId);
      }
      return speaking;
    },

    connectedCount() {
      return [...peers.values()].filter((peer) => peer.dir === 'out' && peer.pc.connectionState === 'connected').length;
    },

    /** Состояние каждого голосового соединения: с кем, напрямую или через TURN, потери. */
    get links() {
      return links;
    },
  };
}
