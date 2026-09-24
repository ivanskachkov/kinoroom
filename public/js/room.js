import { $, el, api, icon, hydrateIcons, storage, randomId, normalizeRoomId, formatTime, toast, copyText } from './common.js';
import { Clock } from './clock.js';
import { YouTubePlayer, FilePlayer } from './players.js';
import { createSearch } from './search.js';
import { createVoice } from './voice.js';

hydrateIcons();

const roomId = normalizeRoomId(decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() ?? ''));
if (!roomId) location.replace('/');
if (location.pathname !== `/r/${roomId}`) history.replaceState(null, '', `/r/${roomId}${location.search}`);
document.title = `Комната ${roomId} · KinoRoom`;
$('#room-code').textContent = roomId;

// Постоянный id вкладки: после перезагрузки страницы сервер узнаёт участника и не пишет «вышел/зашёл».
const clientId = (() => {
  try {
    let id = sessionStorage.getItem('kr_client');
    if (!id) sessionStorage.setItem('kr_client', (id = randomId(20)));
    return id;
  } catch {
    return randomId(20);
  }
})();

const SOURCE_LABELS = { youtube: 'YouTube', archive: 'Internet Archive', link: 'Ссылка', library: 'Медиатека', tmdb: 'Трейлер' };
const HARD_DRIFT = { youtube: 1.2, file: 2 }; // дальше этого — перематываем
const SOFT_DRIFT = 0.25; // ближе этого — считаем, что всё синхронно

const state = {
  me: null,
  media: null,
  playback: { playing: false, position: 0, updatedAt: 0 },
  queue: [],
  members: [],
};

const socket = io({ autoConnect: false });
const clock = new Clock(socket);
let myName = storage.get('kr_name', '');
let joined = false;

// ---------------------------------------------------------------------------
// Плееры и синхронизация
// ---------------------------------------------------------------------------

const playerEl = $('#player');
const playerEvents = {
  onPlaying(player) {
    if (player !== active) return;
    if (blocked) {
      blocked = false;
      hideNotice();
    }
    $('#click-layer').classList.remove('passthrough');
    applyPlayback(true);
  },
  onEnded(player) {
    if (player === active && state.media) socket.emit('player:ended', { mid: state.media.mid });
  },
  onBlocked(player) {
    if (player === active) showBlocked();
  },
  onError(player, message) {
    if (player === active) showNotice(message, { error: true });
  },
  onDuration(player) {
    if (player === active) updateControls();
  },
};
const youtube = new YouTubePlayer($('#yt-host'), playerEvents);
const file = new FilePlayer($('#video'), playerEvents);

let active = null;
let loadSeq = 0;
let blocked = false;
let lastCorrection = 0;
let lastPlayAttempt = 0;
let scrubbing = false;

function expectedPosition() {
  const { playing, position, updatedAt } = state.playback;
  let pos = playing ? position + (clock.now() - updatedAt) / 1000 : position;
  const duration = active?.duration();
  if (duration > 0) pos = Math.min(pos, duration);
  return Math.max(0, pos);
}

function nearEnd(position) {
  const duration = active?.duration();
  return duration > 0 && position >= duration - 0.5;
}

async function applyMedia() {
  const seq = ++loadSeq;
  const media = state.media;
  renderNow();
  hideNotice();
  blocked = false;
  active = null;

  if (!media) {
    for (const player of [youtube, file]) {
      player.stop();
      player.show(false);
    }
    $('#player-empty').hidden = false;
    updateControls();
    return;
  }

  $('#player-empty').hidden = true;
  const next = media.kind === 'youtube' ? youtube : file;
  const other = next === youtube ? file : youtube;
  other.stop();
  other.show(false);
  next.show(true);
  showNotice('Загрузка…', { spinner: true });

  try {
    await next.load(media, expectedPosition(), state.playback.playing);
  } catch (err) {
    if (seq === loadSeq) showNotice(err.message, { error: true });
    return;
  }
  if (seq !== loadSeq) return;
  hideNotice();
  active = next;
  applyVolume();
  applyPlayback(true);
}

/** Приводит локальный плеер к состоянию комнаты. force — после явного действия кого-то из участников. */
function applyPlayback(force = false) {
  updateControls();
  if (!active) return;
  const expected = expectedPosition();
  const drift = active.time() - expected;
  if (Math.abs(drift) > (force ? 0.5 : HARD_DRIFT[active.kind])) {
    active.seek(expected);
    lastCorrection = performance.now();
  }
  if (state.playback.playing) {
    if (!active.isPlaying() && !blocked && !nearEnd(expected)) active.play();
  } else if (active.isPlaying()) {
    active.pause();
  }
}

// Раз в секунду сверяемся с «идеальной» позицией и мягко догоняем.
function syncTick() {
  if (!active) return setSync(state.media ? 'wait' : 'idle');
  const now = performance.now();
  const expected = expectedPosition();
  const drift = active.time() - expected;

  if (!state.playback.playing) {
    if (active.isPlaying()) active.pause();
    if (Math.abs(drift) > 0.5 && now - lastCorrection > 1000) {
      active.seek(expected);
      lastCorrection = now;
    }
    return setSync('ok', 0);
  }
  if (nearEnd(expected)) return setSync('ok', 0);
  if (!active.isPlaying()) {
    if (!blocked && now - lastPlayAttempt > 3000) {
      lastPlayAttempt = now;
      active.play();
    }
    return setSync('wait', drift);
  }
  if (active.isBuffering()) return setSync('wait', drift);

  if (Math.abs(drift) > HARD_DRIFT[active.kind]) {
    // Пауза между перемотками, чтобы медленный интернет не уходил в цикл «перемотка → буферизация».
    if (now - lastCorrection > 4000) {
      active.seek(expected);
      lastCorrection = now;
    }
    active.setRate(1);
    return setSync('wait', drift);
  }
  // Небольшое расхождение у <video> убираем изменением скорости на ±5% — незаметно на слух.
  active.setRate(Math.abs(drift) > SOFT_DRIFT ? (drift > 0 ? 0.95 : 1.05) : 1);
  setSync(Math.abs(drift) > 0.6 ? 'drift' : 'ok', drift);
}
setInterval(syncTick, 1000);
setInterval(updateControls, 250);
setInterval(() => joined && clock.sync(3), 30_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) applyPlayback(true);
});

function setSync(status, drift = 0) {
  const node = $('#sync');
  const labels = { ok: 'Синхронно', drift: 'Догоняем', wait: 'Подключаемся', idle: '' };
  node.dataset.state = status;
  $('#sync-label').textContent = labels[status];
  node.title = status === 'idle' ? '' : `Расхождение с комнатой: ${drift >= 0 ? '+' : ''}${drift.toFixed(2)} с · пинг ${Math.round(clock.rtt)} мс`;
}

// ---------------------------------------------------------------------------
// Уведомления поверх плеера
// ---------------------------------------------------------------------------

function showNotice(text, { error = false, spinner = false, action = null } = {}) {
  const notice = $('#player-notice');
  notice.className = error ? 'player-notice is-error' : 'player-notice';
  notice.replaceChildren(...[spinner && el('div', { class: 'spinner' }), el('p', {}, text), action].filter(Boolean));
  notice.hidden = false;
}

function hideNotice() {
  $('#player-notice').hidden = true;
}

// Браузер не дал включить звук без клика. Для <video> хватает клика по кнопке;
// в YouTube-iframe на iPhone нужно нажать на само видео — пропускаем клики к нему.
function showBlocked() {
  blocked = true;
  const button = el('button', { class: 'btn btn-primary btn-lg', type: 'button' }, icon('play'), 'Смотреть вместе со всеми');
  button.addEventListener('click', () => {
    blocked = false;
    hideNotice();
    if (active === youtube) $('#click-layer').classList.add('passthrough');
    applyPlayback(true);
    active?.play();
  });
  showNotice('Браузер попросил подтвердить воспроизведение', { action: button });
}

// ---------------------------------------------------------------------------
// Управление
// ---------------------------------------------------------------------------

const ui = {
  play: $('#btn-play'),
  next: $('#btn-next'),
  seek: $('#seek'),
  time: $('#time'),
  mute: $('#btn-mute'),
  volume: $('#volume'),
  fullscreen: $('#btn-fullscreen'),
};

function sendControl(action, position) {
  if (!state.media || !joined) return;
  const at = clock.now();
  const playing = action === 'play' ? true : action === 'pause' ? false : state.playback.playing;
  // Применяем сразу, не дожидаясь ответа сервера, — так управление не «залипает».
  state.playback = { playing, position, updatedAt: at };
  applyPlayback(true);
  socket.emit('player:control', { action, position, at });
}

function currentTime() {
  return active ? active.time() : expectedPosition();
}

function togglePlay() {
  if (!state.media) return;
  if (state.playback.playing) return sendControl('pause', currentTime());
  const position = expectedPosition();
  sendControl('play', nearEnd(position) ? 0 : position);
}

function seekBy(delta) {
  if (!state.media) return;
  const duration = active?.duration() || Infinity;
  sendControl('seek', Math.min(Math.max(0, currentTime() + delta), duration));
}

ui.play.addEventListener('click', togglePlay);
ui.next.addEventListener('click', () => socket.emit('queue:next'));
ui.seek.addEventListener('input', () => {
  scrubbing = true;
  updateControls();
});
ui.seek.addEventListener('change', () => {
  scrubbing = false;
  sendControl('seek', Number(ui.seek.value));
});

function updateControls() {
  const playing = Boolean(state.media) && state.playback.playing;
  if (ui.play.dataset.playing !== String(playing)) {
    ui.play.dataset.playing = String(playing);
    ui.play.replaceChildren(icon(playing ? 'pause' : 'play', 22));
    ui.play.setAttribute('aria-label', playing ? 'Пауза' : 'Смотреть');
  }
  playerEl.classList.toggle('is-paused', !playing);
  playerEl.classList.toggle('is-empty', !state.media);
  ui.next.hidden = state.queue.length === 0;

  const duration = active?.duration() || state.media?.duration || 0;
  const current = scrubbing ? Number(ui.seek.value) : state.media ? currentTime() : 0;
  ui.seek.disabled = !state.media || !duration;
  ui.seek.max = duration || 1;
  if (!scrubbing) ui.seek.value = Math.min(current, duration);
  ui.seek.style.setProperty('--pct', `${duration ? (Math.min(current, duration) / duration) * 100 : 0}%`);
  ui.time.textContent = state.media ? `${formatTime(current)} / ${duration ? formatTime(duration) : '--:--'}` : '';
}

// Громкость у каждого своя и не синхронизируется. duck — множитель, пока кто-то говорит (1 — не приглушено).
const volume = { level: storage.get('kr_volume', 1), muted: storage.get('kr_muted', false), duck: 1 };

function setPlayersVolume() {
  for (const player of [youtube, file]) player.setVolume(volume.level * volume.duck);
}

function applyVolume() {
  setPlayersVolume();
  for (const player of [youtube, file]) player.setMuted(volume.muted);
  const shown = volume.muted ? 0 : volume.level;
  ui.volume.value = shown;
  ui.volume.style.setProperty('--pct', `${shown * 100}%`);
  ui.mute.replaceChildren(icon(shown === 0 ? 'mute' : 'volume', 22));
  storage.set('kr_volume', volume.level);
  storage.set('kr_muted', volume.muted);
}

ui.volume.addEventListener('input', () => {
  volume.level = Number(ui.volume.value);
  volume.muted = volume.level === 0;
  applyVolume();
});
ui.mute.addEventListener('click', () => {
  volume.muted = !volume.muted;
  if (!volume.muted && volume.level === 0) volume.level = 0.5;
  applyVolume();
});
applyVolume();

function toggleFullscreen() {
  const current = document.fullscreenElement ?? document.webkitFullscreenElement;
  if (current) return (document.exitFullscreen ?? document.webkitExitFullscreen).call(document);
  if (playerEl.classList.contains('pseudo-fullscreen')) return playerEl.classList.remove('pseudo-fullscreen');
  // На iPhone полноэкранный режим есть только у самого <video>, поэтому растягиваем плеер стилями.
  const pseudo = () => playerEl.classList.add('pseudo-fullscreen');
  const request = playerEl.requestFullscreen ?? playerEl.webkitRequestFullscreen;
  if (!request) return pseudo();
  request.call(playerEl)?.catch?.(pseudo);
}
ui.fullscreen.addEventListener('click', toggleFullscreen);

// Клик по видео — пауза/продолжение, двойной клик — полный экран. На телефоне тап показывает панель.
const coarsePointer = matchMedia('(hover: none)').matches;
let clickTimer = null;
let idleTimer = null;

function showControlsBriefly() {
  playerEl.classList.add('ui-active');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => playerEl.classList.remove('ui-active'), coarsePointer ? 3500 : 2500);
}

$('#click-layer').addEventListener('click', () => {
  if (coarsePointer) {
    if (playerEl.classList.contains('ui-active')) playerEl.classList.remove('ui-active');
    else showControlsBriefly();
    return;
  }
  clearTimeout(clickTimer);
  clickTimer = setTimeout(togglePlay, 220);
});
$('#click-layer').addEventListener('dblclick', () => {
  clearTimeout(clickTimer);
  toggleFullscreen();
});
playerEl.addEventListener('mousemove', showControlsBriefly);
playerEl.addEventListener('mouseleave', () => playerEl.classList.remove('ui-active'));
$('.controls').addEventListener('pointerdown', showControlsBriefly);

document.addEventListener('keydown', (event) => {
  if (event.target.closest?.('input, textarea, select, [contenteditable]') || event.ctrlKey || event.metaKey || event.altKey) return;
  if (!$('#join').hidden || !$('#search-panel').hidden) return;
  // Иначе пробел «нажмёт» кнопку, на которой остался фокус (например, реакцию).
  if (event.code === 'Space' && event.target.closest?.('button')) event.target.blur();
  // event.code не зависит от раскладки: K работает и когда включена кириллица.
  const actions = {
    Space: togglePlay,
    KeyK: togglePlay,
    ArrowLeft: () => seekBy(-10),
    KeyJ: () => seekBy(-10),
    ArrowRight: () => seekBy(10),
    KeyL: () => seekBy(10),
    KeyF: toggleFullscreen,
    KeyM: () => ui.mute.click(),
    Slash: () => $('#search-input').focus(),
  };
  const action = actions[event.code];
  if (!action) return;
  event.preventDefault();
  action();
  showControlsBriefly();
});

// Кнопки на наушниках и клавиатуре тоже должны управлять всей комнатой.
if ('mediaSession' in navigator) {
  try {
    navigator.mediaSession.setActionHandler('play', () => !state.playback.playing && togglePlay());
    navigator.mediaSession.setActionHandler('pause', () => state.playback.playing && togglePlay());
    navigator.mediaSession.setActionHandler('seekbackward', () => seekBy(-10));
    navigator.mediaSession.setActionHandler('seekforward', () => seekBy(10));
  } catch {}
}

// ---------------------------------------------------------------------------
// Реакции
// ---------------------------------------------------------------------------

for (const button of document.querySelectorAll('[data-reaction]')) {
  button.addEventListener('click', () => socket.emit('reaction', { emoji: button.dataset.reaction }));
}

function spawnReaction({ emoji, name, color }) {
  const node = el(
    'div',
    { class: 'reaction', style: { left: `${8 + Math.random() * 80}%` } },
    el('span', { class: 'reaction-emoji' }, emoji),
    el('span', { class: 'reaction-name', style: { color } }, name),
  );
  $('#reactions-layer').append(node);
  node.addEventListener('animationend', () => node.remove());
}

// ---------------------------------------------------------------------------
// Отрисовка: сейчас играет, участники, очередь, чат
// ---------------------------------------------------------------------------

function renderNow() {
  const media = state.media;
  $('#now-title').textContent = media ? media.title : 'Ничего не играет';
  const sub = $('#now-sub');
  sub.replaceChildren();
  if (!media) return sub.append('Найдите фильм или вставьте ссылку в строку поиска');
  sub.append(el('span', { class: `tag tag-${media.source}` }, SOURCE_LABELS[media.source] ?? 'Видео'));
  if (media.addedBy) sub.append(el('span', {}, `выбор: ${media.addedBy}`));
  if ('mediaSession' in navigator && 'MediaMetadata' in window) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: media.title, artist: 'KinoRoom', artwork: media.thumb ? [{ src: media.thumb }] : [] });
  }
}

const avatar = (m) =>
  el('span', { class: m.mic ? 'avatar has-mic' : 'avatar', 'data-member': m.id, style: { background: m.color } }, m.name.slice(0, 1).toUpperCase());

function renderMembers() {
  const list = $('#members');
  const shown = state.members.slice(0, 5);
  list.replaceChildren(...shown.map((m) => {
    const node = avatar(m);
    node.title = m.id === state.me?.id ? `${m.name} (вы)` : m.name;
    return node;
  }));
  if (state.members.length > shown.length) list.append(el('span', { class: 'avatar avatar-more' }, `+${state.members.length - shown.length}`));
  list.title = state.members.map((m) => m.name).join(', ');
  $('#members-count').textContent = state.members.length;
  $('#people-badge').textContent = state.members.length || '';

  $('#people-list').replaceChildren(
    ...state.members.map((m) =>
      el(
        'li',
        { class: 'person', 'data-member': m.id },
        avatar(m),
        el('span', { class: 'person-name' }, m.name, m.id === state.me?.id ? el('span', { class: 'muted' }, ' (вы)') : null),
        m.mic ? el('span', { class: 'person-mic', title: 'Микрофон включён' }, icon('mic', 16)) : null,
      ),
    ),
  );
}

function renderQueue() {
  const list = $('#queue-list');
  $('#queue-badge').textContent = state.queue.length || '';
  updateControls();
  if (!state.queue.length) {
    list.replaceChildren(el('li', { class: 'empty' }, 'Очередь пуста. Найдите что-нибудь и нажмите «В очередь» — видео включатся по порядку.'));
    return;
  }
  list.replaceChildren(
    ...state.queue.map((item, index) =>
      el(
        'li',
        { class: 'q-item' },
        el('span', { class: 'q-index' }, index + 1),
        el('span', { class: 'q-thumb' }, item.thumb ? el('img', { src: item.thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : icon('film', 22)),
        el(
          'div',
          { class: 'q-info' },
          el('div', { class: 'q-title', title: item.title }, item.title),
          el('div', { class: 'q-meta' }, [SOURCE_LABELS[item.source], item.duration ? formatTime(item.duration) : null, item.addedBy].filter(Boolean).join(' · ')),
        ),
        el(
          'div',
          { class: 'q-actions' },
          el('button', { class: 'icon-btn', type: 'button', title: 'Включить сейчас', 'aria-label': 'Включить сейчас', onclick: () => socket.emit('queue:play', { qid: item.qid }) }, icon('play', 18)),
          el('button', { class: 'icon-btn', type: 'button', title: 'Убрать из очереди', 'aria-label': 'Убрать из очереди', onclick: () => socket.emit('queue:remove', { qid: item.qid }) }, icon('close', 18)),
        ),
      ),
    ),
  );
}

const chatList = $('#chat-list');
let unread = 0;

function chatNode(msg) {
  const time = new Date(msg.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (msg.type === 'system') return el('li', { class: 'msg msg-system', title: time }, msg.text);
  return el(
    'li',
    { class: msg.userId === state.me?.id ? 'msg msg-own' : 'msg', title: time },
    el('span', { class: 'msg-name', style: { color: msg.color } }, msg.name),
    el('span', { class: 'msg-text' }, msg.text),
  );
}

function appendChat(msg) {
  const atBottom = chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 80;
  chatList.append(chatNode(msg));
  while (chatList.children.length > 200) chatList.firstElementChild.remove();
  if (atBottom || msg.userId === state.me?.id) chatList.scrollTop = chatList.scrollHeight;
  if ($('#panel-chat').hidden && msg.type === 'user') {
    unread += 1;
    $('#chat-badge').textContent = unread;
  }
}

$('#chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('#chat-input');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chat:send', { text });
  input.value = '';
});

function selectTab(name) {
  for (const tab of document.querySelectorAll('[data-tab]')) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
  $('#panel-chat').hidden = name !== 'chat';
  $('#panel-queue').hidden = name !== 'queue';
  $('#panel-people').hidden = name !== 'people';
  if (name === 'chat') {
    unread = 0;
    $('#chat-badge').textContent = '';
    chatList.scrollTop = chatList.scrollHeight;
  }
}
for (const tab of document.querySelectorAll('[data-tab]')) tab.addEventListener('click', () => selectTab(tab.dataset.tab));
$('#members-wrap').addEventListener('click', () => selectTab('people'));

// ---------------------------------------------------------------------------
// Голосовой чат
// ---------------------------------------------------------------------------

const voice = createVoice({ socket, onChange: renderVoice });
const micButtons = { toggle: $('#mic-toggle'), quick: $('#mic-quick') };
const DUCK_HOLD_MS = 1200; // пауза между фразами не должна дёргать громкость фильма туда-обратно
// Громкость фильма, пока кто-то говорит (1 — не приглушать). Раньше здесь был флажок вкл/выкл
let duckLevel = storage.get('kr_voice_duck_level', storage.get('kr_voice_duck', true) ? 0.6 : 1);
let lastVoiceAt = 0;

function syncRange(input) {
  const { min, max, value } = input;
  input.style.setProperty('--pct', `${((value - min) / (max - min)) * 100}%`);
}

async function toggleMic() {
  if (voice.active) return voice.stop();
  try {
    await voice.start();
    toast('Микрофон включён — вас слышат все в комнате');
  } catch (err) {
    toast(err.message, { error: true });
  }
}

function renderVoice() {
  const { active, starting } = voice;
  const label = starting ? 'Подключаем микрофон…' : active ? 'Выключить микрофон' : 'Включить микрофон';
  micButtons.toggle.replaceChildren(icon(active ? 'micOff' : 'mic', 18), label);
  micButtons.toggle.className = active ? 'btn btn-danger mic-toggle' : 'btn btn-primary mic-toggle';
  micButtons.toggle.disabled = starting || !voice.supported;
  micButtons.quick.classList.toggle('is-live', active);
  micButtons.quick.title = label;
  micButtons.quick.setAttribute('aria-label', label);
  micButtons.quick.disabled = starting;
  $('#mic-meter').hidden = !active;
  $('#voice-gate-row').hidden = !active;
  $('#voice-unlock').hidden = !voice.audioBlocked;
  $('#voice-status').textContent = active ? `в эфире · слушателей: ${voice.connectedCount()}` : '';
  if (!voice.supported) {
    $('#voice-hint').textContent = 'Слушать голоса можно и так, а включить свой микрофон браузер разрешает только по HTTPS (например, через Cloudflare Tunnel) или на localhost.';
  }
}

micButtons.toggle.addEventListener('click', toggleMic);
micButtons.quick.addEventListener('click', () => {
  if (!voice.supported) {
    selectTab('people');
    return toast('Микрофон доступен только по HTTPS', { error: true });
  }
  toggleMic();
});
$('#voice-unlock').addEventListener('click', () => voice.unlock());
// Любой клик по странице — повод снова попробовать включить заблокированный звук.
document.addEventListener('pointerdown', () => voice.unlock());

const voiceVolume = $('#voice-volume');
voiceVolume.value = voice.volume;
syncRange(voiceVolume);
voiceVolume.addEventListener('input', () => {
  voice.setVolume(Number(voiceVolume.value));
  syncRange(voiceVolume);
});

const duckInput = $('#voice-duck');
function renderDuck() {
  duckInput.value = duckLevel;
  syncRange(duckInput);
  $('#voice-duck-value').textContent = duckLevel >= 1 ? 'не приглушать' : `${Math.round(duckLevel * 100)}%`;
}
duckInput.addEventListener('input', () => {
  duckLevel = Number(duckInput.value);
  storage.set('kr_voice_duck_level', duckLevel);
  renderDuck();
});
renderDuck();

// Порог отсечки шума: метка на шкале уровня микрофона. Всё, что левее, слушатели не слышат
const gateInput = $('#voice-gate');
function renderGate() {
  gateInput.value = voice.gateThreshold;
  syncRange(gateInput);
  $('#mic-threshold').style.left = `${Math.min(100, voice.gateThreshold * 100)}%`;
}
gateInput.addEventListener('input', () => {
  voice.setGateThreshold(Number(gateInput.value));
  renderGate();
});
renderGate();

// Подсветка говорящих, шкала микрофона и приглушение фильма
setInterval(() => {
  const speaking = voice.speakingMembers();
  if (voice.active && voice.gateOpen && state.me) speaking.add(state.me.id);
  for (const node of document.querySelectorAll('[data-member]')) node.classList.toggle('speaking', speaking.has(node.dataset.member));
  const fill = $('#mic-meter-fill');
  fill.style.width = `${Math.round(voice.micLevel() * 100)}%`;
  fill.classList.toggle('is-open', voice.gateOpen);

  // Приглушаем быстро, чтобы сразу расслышать речь, а возвращаем громкость плавно
  const now = performance.now();
  if ([...speaking].some((id) => id !== state.me?.id)) lastVoiceAt = now;
  const target = now - lastVoiceAt < DUCK_HOLD_MS ? duckLevel : 1;
  const step = target < volume.duck ? 0.15 : 0.05;
  const next = Math.abs(target - volume.duck) <= step ? target : volume.duck + Math.sign(target - volume.duck) * step;
  if (next !== volume.duck) {
    volume.duck = next;
    setPlayersVolume();
  }
}, 150);
setInterval(renderVoice, 2000);
renderVoice();

// ---------------------------------------------------------------------------
// Поиск
// ---------------------------------------------------------------------------

const { sources } = await api('/api/config').catch(() => ({ sources: { archive: true } }));
const search = createSearch({
  sources,
  onPlay(media) {
    socket.emit('media:play', media);
    search.close();
  },
  onQueue(media) {
    const items = Array.isArray(media) ? media : [media];
    socket.emit('queue:add', { items });
    toast(items.length === 1 ? `В очереди: ${items[0].title}` : `В очередь добавлено: ${items.length}`);
  },
});
$('#empty-search').addEventListener('click', () => $('#search-input').focus());

// ---------------------------------------------------------------------------
// Подключение к комнате
// ---------------------------------------------------------------------------

$('#copy-link').addEventListener('click', async () => {
  const ok = await copyText(location.origin + location.pathname);
  toast(ok ? 'Ссылка на комнату скопирована — отправьте её друзьям' : 'Не получилось скопировать — скопируйте адрес из строки браузера');
});

function applyState(snapshot) {
  // После короткого обрыва связи видео то же самое — не перезагружаем плеер, только догоняем.
  const sameMedia = active && state.media?.mid === snapshot.media?.mid;
  state.media = snapshot.media;
  state.playback = snapshot.playback;
  state.queue = snapshot.queue;
  state.members = snapshot.members;
  chatList.replaceChildren(...snapshot.chat.map(chatNode));
  requestAnimationFrame(() => (chatList.scrollTop = chatList.scrollHeight));
  renderMembers();
  renderQueue();
  if (sameMedia) {
    renderNow();
    applyPlayback(true);
  } else {
    applyMedia();
  }
}

async function join() {
  let res;
  try {
    res = await socket.timeout(8000).emitWithAck('room:join', { roomId, name: myName, clientId });
  } catch {
    res = { error: 'Сервер не отвечает' };
  }
  if (res.error) return showJoin(res.error);

  joined = true;
  state.me = res.you;
  $('#join').hidden = true;
  $('#connection').hidden = true;
  rememberRoom();
  applyState(res.state);
  voice.resume();
}

function rememberRoom() {
  const recent = storage.get('kr_recent', []).filter((r) => r.id !== roomId);
  storage.set('kr_recent', [{ id: roomId, ts: Date.now() }, ...recent].slice(0, 6));
}

function showJoin(error = '') {
  $('#join').hidden = false;
  $('#join-error').textContent = error;
  $('#join-name').value = myName;
  $('#join-name').focus();
}

$('#join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('#join-name').value.trim().slice(0, 24);
  if (!name) return;
  myName = name;
  storage.set('kr_name', name);
  if (socket.connected) join();
  else socket.connect();
});

// Часы сверяем до входа: снимок комнаты сразу применяется с правильной позицией,
// и события, пришедшие во время замеров, не перетираются устаревшим снимком.
socket.on('connect', async () => {
  await clock.sync(5);
  if (myName && socket.connected) join();
});
socket.on('disconnect', () => {
  joined = false;
  $('#connection').hidden = false;
});
socket.on('connect_error', (err) => {
  if (err.message === 'unauthorized') location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
  $('#connection').hidden = false;
});

socket.on('playback', (playback) => {
  state.playback = { playing: playback.playing, position: playback.position, updatedAt: playback.updatedAt };
  applyPlayback(true);
});
socket.on('media', ({ media, playback }) => {
  state.media = media;
  state.playback = playback;
  applyMedia();
});
socket.on('queue', (queue) => {
  state.queue = queue;
  renderQueue();
});
socket.on('members', (members) => {
  state.members = members;
  renderMembers();
});
socket.on('chat', appendChat);
socket.on('reaction', spawnReaction);

// Имя уже знаем — входим сразу; иначе спрашиваем. Если браузер заблокирует звук,
// плеер сам покажет кнопку подтверждения.
if (myName) socket.connect();
else showJoin();
