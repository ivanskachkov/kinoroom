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
  let gateTimer = null;
  let lastLoudAt = 0;
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
      if (pc.connectionState === 'failed' && peers.get(key) === peer) {
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

  // --- Микрофон -------------------------------------------------------------

  function startMeter(stream) {
    try {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      meter = {
        context,
        level() {
          analyser.getFloatTimeDomainData(samples);
          let sum = 0;
          for (const s of samples) sum += s * s;
          return Math.min(1, Math.sqrt(sum / samples.length) * 4);
        },
      };
    } catch {
      meter = null;
    }
  }

  // Шумовой порог: пока уровень ниже порога, слушателям уходит тишина, а не шум комнаты,
  // и у них не приглушается фильм. Без индикатора (нет AudioContext) порог всегда открыт.
  function startGate() {
    gateOpen = false;
    lastLoudAt = 0;
    gateTimer = setInterval(() => {
      micLevelValue = meter ? meter.level() : 1;
      const now = performance.now();
      if (micLevelValue >= gateThreshold) lastLoudAt = now;
      const open = now - lastLoudAt < GATE_HOLD_MS;
      if (open === gateOpen) return;
      gateOpen = open;
      for (const track of localStream?.getAudioTracks() ?? []) track.enabled = open;
    }, 40);
  }

  function stopGate() {
    clearInterval(gateTimer);
    gateTimer = null;
    gateOpen = false;
    micLevelValue = 0;
  }

  async function announce() {
    const res = await socket.timeout(5000).emitWithAck('voice:start');
    if (res?.error) throw new Error(res.error);
    for (const id of res.listeners ?? []) callListener(id).catch((err) => console.warn('[voice]', err));
  }

  async function openMic() {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    // Выключать саму дорожку микрофона нельзя: индикатор замолчит, и порог больше не откроется
    const sendTrack = micStream.getAudioTracks()[0].clone();
    sendTrack.enabled = false;
    localStream = new MediaStream([sendTrack]);
    startMeter(micStream);
    startGate();
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
    stopGate();
    for (const stream of [localStream, micStream]) stream?.getTracks().forEach((track) => track.stop());
    localStream = null;
    micStream = null;
    live = false;
    meter?.context.close().catch(() => {});
    meter = null;
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
  };
}
