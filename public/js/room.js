import { $, el, api, icon, hydrateIcons, storage, randomId, normalizeRoomId, formatTime, toast, copyText } from './common.js';
import { Clock } from './clock.js';
import { YouTubePlayer, FilePlayer, NetflixPlayer } from './players.js';
import { createSearch } from './search.js';
import { createVoice } from './voice.js';

hydrateIcons();

const roomId = normalizeRoomId(decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() ?? ''));
if (!roomId) location.replace('/');
// Ссылка-приглашение (?i=…) пускает без пароля. Запоминаем её и убираем из адресной строки:
// делиться комнатой — через кнопку с кодом, а не копированием адреса
const inviteParam = new URLSearchParams(location.search).get('i');
if (inviteParam) storage.set(`kr_invite:${roomId}`, inviteParam);
if (location.pathname !== `/r/${roomId}` || location.search) history.replaceState(null, '', `/r/${roomId}`);
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

const SOURCE_LABELS = { youtube: 'YouTube', archive: 'Internet Archive', link: 'Ссылка', library: 'Медиатека', tmdb: 'Трейлер', gdrive: 'Google Диск', netflix: 'Netflix' };
const HARD_DRIFT = { youtube: 1.2, file: 2, external: 2.5 }; // дальше этого — перематываем (Netflix перематывает медленнее)
const SOFT_DRIFT = 0.25; // ближе этого — считаем, что всё синхронно

const state = {
  me: null,
  room: { name: '', locked: false, listed: true, invite: null, isOwner: false },
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
  // Пауза или перемотка прямо в Netflix — это действие зрителя, его нужно разослать комнате
  onUserControl(player, action, time) {
    if (player === active) sendControl(action, time);
  },
  onExternalStatus() {
    renderExternal();
  },
};
const youtube = new YouTubePlayer($('#yt-host'), playerEvents);
const file = new FilePlayer($('#video'), playerEvents);
const netflix = new NetflixPlayer($('#external-view'), playerEvents);
const players = [youtube, file, netflix];

let active = null;
let loadSeq = 0;
let blocked = false;
let lastCorrection = 0;
let lastPlayAttempt = 0;
let scrubbing = false;

/** Сколько мс до назначенного старта (общий отсчёт у фильмов на Netflix), 0 — старт уже был. */
function startsIn() {
  return state.playback.playing ? Math.max(0, state.playback.updatedAt - clock.now()) : 0;
}

function expectedPosition() {
  const { playing, position, updatedAt } = state.playback;
  if (startsIn() > 0) return position; // идёт отсчёт — фильм ещё стоит
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
    for (const player of players) {
      player.stop();
      player.show(false);
    }
    $('#player-empty').hidden = false;
    updateControls();
    return;
  }

  $('#player-empty').hidden = true;
  const next = media.kind === 'youtube' ? youtube : media.kind === 'external' ? netflix : file;
  for (const other of players) {
    if (other === next) continue;
    other.stop();
    other.show(false);
  }
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
  renderExternal();
  applyPlayback(true);
}

/** Приводит локальный плеер к состоянию комнаты. force — после явного действия кого-то из участников. */
let startTimer = null;

function applyPlayback(force = false) {
  updateControls();
  renderCountdown();
  if (!active) return;
  // Назначен старт по отсчёту: держим на паузе на нужной секунде и запускаемся ровно в ноль
  const wait = startsIn();
  clearTimeout(startTimer);
  if (wait > 0) {
    if (active.isPlaying()) active.pause();
    if (Math.abs(active.time() - expectedPosition()) > 0.5) active.seek(expectedPosition());
    startTimer = setTimeout(() => applyPlayback(true), wait + 20);
    return;
  }
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
  if (startsIn() > 0) return setSync('wait', 0); // идёт отсчёт — всё решит applyPlayback в ноль
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
// Фильм на Netflix: экран вместо плеера, общий отсчёт и подсказки для ручной синхронизации
// ---------------------------------------------------------------------------

function externalStatus() {
  if (netflix.auto) return ['✅ Netflix подключён через расширение — пауза и перемотка у вас срабатывают сами'];
  if (netflix.extension) return ['Расширение на месте — откройте фильм на Netflix в соседней вкладке этого браузера'];
  return [
    'Синхронизация вручную: жмите ▶ в Netflix по общему отсчёту. На компьютере всё может происходить само — ',
    el('a', { href: '/kinoroom-extension.zip' }, 'поставьте расширение KinoRoom'),
    '.',
  ];
}

function renderExternal() {
  const media = state.media;
  if (media?.kind !== 'external') return;
  $('#ext-title').textContent = media.title;
  $('#ext-open').href = media.url;
  const me = state.members.find((member) => member.id === state.me?.id);
  const readyButton = $('#ext-ready');
  readyButton.textContent = me?.ready ? '✓ Готов' : 'Я готов';
  readyButton.classList.toggle('is-ready', Boolean(me?.ready));
  const ready = state.members.filter((member) => member.ready).length;
  $('#ext-ready-count').textContent = state.members.length > 1 ? `Готовы: ${ready} из ${state.members.length}` : '';
  $('#ext-status').replaceChildren(...externalStatus());
}

$('#ext-ready').addEventListener('click', () => {
  const me = state.members.find((member) => member.id === state.me?.id);
  socket.emit('external:ready', { ready: !me?.ready });
});

const countdownBox = $('#countdown');
let countdownTimer = null;

function countdownTick() {
  const wait = startsIn();
  if (wait > 0) {
    countdownBox.textContent = Math.ceil(wait / 1000);
    countdownBox.classList.remove('is-go');
    countdownBox.hidden = false;
    return;
  }
  clearInterval(countdownTimer);
  countdownTimer = null;
  if (countdownBox.hidden || countdownBox.classList.contains('is-go')) return;
  // Отсчёт закончился. Без расширения каждый жмёт Play сам — напоминаем крупно
  if (state.media?.kind === 'external' && !netflix.auto && state.playback.playing) {
    countdownBox.textContent = '▶ Жмите Play!';
    countdownBox.classList.add('is-go');
    setTimeout(() => (countdownBox.hidden = true), 1500);
  } else {
    countdownBox.hidden = true;
  }
}

function renderCountdown() {
  countdownTick();
  if (startsIn() > 0 && !countdownTimer) countdownTimer = setInterval(countdownTick, 100);
}

let externalNoticeTimer = null;

// Без расширения чужую паузу и перемотку каждый повторяет у себя — подсказываем, что сделать
function showExternalNotice(playback) {
  if (state.media?.kind !== 'external' || netflix.auto) return;
  if (playback.updatedAt - clock.now() > 500) return; // это старт по отсчёту — он и так крупно на экране
  const time = formatTime(playback.position);
  const text = {
    pause: `⏸ Пауза на ${time} — поставьте на паузу у себя`,
    seek: `⏩ Перемотайте у себя на ${time}`,
    play: `▶ Продолжаем с ${time} — жмите Play`,
  }[playback.action];
  if (!text) return;
  const box = $('#ext-notice');
  box.textContent = text;
  box.hidden = false;
  clearTimeout(externalNoticeTimer);
  externalNoticeTimer = setTimeout(() => (box.hidden = true), 5000);
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
  cc: $('#btn-cc'),
  quality: $('#btn-quality'),
};

const COUNTDOWN_MS = 3000; // как на сервере: EXTERNAL_COUNTDOWN_MS

function sendControl(action, position, { countdown = false } = {}) {
  if (!state.media || !joined) return;
  const at = clock.now();
  const playing = action === 'play' ? true : action === 'pause' ? false : state.playback.playing;
  // Применяем сразу, не дожидаясь ответа сервера, — так управление не «залипает».
  state.playback = { playing, position, updatedAt: countdown ? at + COUNTDOWN_MS : at };
  applyPlayback(true);
  socket.emit('player:control', { action, position, at, countdown });
}

function currentTime() {
  return active ? active.time() : expectedPosition();
}

function togglePlay() {
  if (!state.media) return;
  if (state.playback.playing) return sendControl('pause', currentTime());
  const position = expectedPosition();
  // Фильм на Netflix каждый запускает у себя — поэтому старт по общему отсчёту
  sendControl('play', nearEnd(position) ? 0 : position, { countdown: state.media.kind === 'external' });
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
  ui.cc.hidden = state.media?.kind !== 'youtube';
  ui.quality.hidden = !state.media || state.media.kind === 'external';
  if (state.media?.kind === 'external') {
    const duration = active?.duration();
    $('#ext-time').textContent = formatTime(expectedPosition()) + (duration ? ` / ${formatTime(duration)}` : '');
  }
  if (state.media) $('#quality-label').textContent = currentQualityLabel();

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

// Субтитры YouTube — личная настройка зрителя, по умолчанию выключены
let captionsOn = storage.get('kr_captions', false);
function applyCaptions() {
  youtube.setCaptions(captionsOn);
  ui.cc.classList.toggle('is-on', captionsOn);
  ui.cc.title = captionsOn ? 'Субтитры включены' : 'Субтитры выключены';
}
ui.cc.addEventListener('click', () => {
  captionsOn = !captionsOn;
  storage.set('kr_captions', captionsOn);
  applyCaptions();
});
applyCaptions();

// Качество — тоже личная настройка устройства: у каждого зрителя своё, синхронизация не страдает
let qualityPref = storage.get('kr_quality', 'auto');
file.setQuality(qualityPref);
const qualityMenu = $('#quality-menu');
const heightLabel = (height) => (height >= 2160 ? '4K' : `${height}p`);

function currentQualityLabel() {
  if (active === youtube) return youtube.qualityLabel() ?? 'Авто';
  const height = active === file ? file.currentHeight() : null;
  return height ? heightLabel(height) : 'Авто';
}

function renderQualityMenu() {
  if (state.media?.kind === 'youtube') {
    qualityMenu.replaceChildren(
      el('div', { class: 'qm-title' }, `Сейчас: ${youtube.qualityLabel() ?? 'подбирается'}`),
      el('p', { class: 'qm-hint' }, 'YouTube сам подбирает качество под скорость интернета каждого устройства. Выбрать его вручную во встроенном плеере нельзя — YouTube это отключил.'),
    );
    return;
  }
  const heights = file.qualityOptions();
  if (!heights) {
    qualityMenu.replaceChildren(
      el('div', { class: 'qm-title' }, `Сейчас: ${currentQualityLabel()}`),
      el('p', { class: 'qm-hint' }, 'У этого видео одна версия — выбирать не из чего.'),
    );
    return;
  }
  const current = qualityPref === 'auto' ? 'auto' : file.currentHeight();
  const option = (value, label) =>
    el('button', { class: value === current ? 'qm-option is-active' : 'qm-option', type: 'button', onclick: () => chooseQuality(value) }, label);
  qualityMenu.replaceChildren(el('div', { class: 'qm-title' }, 'Качество — только у вас'), option('auto', 'Авто'), ...heights.map((h) => option(h, heightLabel(h))));
}

function chooseQuality(value) {
  qualityPref = value;
  storage.set('kr_quality', value);
  file.setQuality(value);
  qualityMenu.hidden = true;
}

ui.quality.addEventListener('click', () => {
  if (qualityMenu.hidden) renderQualityMenu();
  qualityMenu.hidden = !qualityMenu.hidden;
});
document.addEventListener('pointerdown', (event) => {
  if (!qualityMenu.hidden && !event.target.closest('.quality-wrap')) qualityMenu.hidden = true;
});

function isFullscreen() {
  return (document.fullscreenElement ?? document.webkitFullscreenElement) === playerEl || playerEl.classList.contains('pseudo-fullscreen');
}

function toggleFullscreen() {
  const current = document.fullscreenElement ?? document.webkitFullscreenElement;
  if (current) return (document.exitFullscreen ?? document.webkitExitFullscreen).call(document);
  if (playerEl.classList.contains('pseudo-fullscreen')) {
    playerEl.classList.remove('pseudo-fullscreen');
    return syncFullscreen();
  }
  // На iPhone полноэкранный режим есть только у самого <video>, поэтому растягиваем плеер стилями.
  const pseudo = () => {
    playerEl.classList.add('pseudo-fullscreen');
    syncFullscreen();
  };
  const request = playerEl.requestFullscreen ?? playerEl.webkitRequestFullscreen;
  if (!request) return pseudo();
  request.call(playerEl)?.catch?.(pseudo);
}
ui.fullscreen.addEventListener('click', toggleFullscreen);

// В полноэкранном режиме боковой панели не видно — новые сообщения всплывают поверх видео,
// а ответить можно, не выходя из него (кнопка чата на панели управления).
const chatOverlay = $('#chat-overlay');
const overlayForm = $('#overlay-chat');

function syncFullscreen() {
  const fullscreen = isFullscreen();
  playerEl.classList.toggle('is-fullscreen', fullscreen);
  if (!fullscreen) {
    overlayForm.hidden = true;
    chatOverlay.replaceChildren();
  }
}
document.addEventListener('fullscreenchange', syncFullscreen);
document.addEventListener('webkitfullscreenchange', syncFullscreen);

function showOverlayMessage(msg) {
  const node = msg.type === 'system'
    ? el('div', { class: 'ov-msg ov-system' }, msg.text)
    : el('div', { class: 'ov-msg' }, el('b', { style: { color: msg.color } }, msg.name), ' ', msg.text);
  chatOverlay.append(node);
  while (chatOverlay.children.length > 5) chatOverlay.firstElementChild.remove();
  setTimeout(() => {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 500);
  }, msg.type === 'system' ? 5000 : 9000);
}

function toggleOverlayChat() {
  overlayForm.hidden = !overlayForm.hidden;
  if (!overlayForm.hidden) $('#overlay-chat-input').focus();
}
$('#btn-chat').addEventListener('click', toggleOverlayChat);
overlayForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('#overlay-chat-input');
  if (sendChat(input.value)) input.value = '';
});
$('#overlay-chat-input').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') overlayForm.hidden = true;
});

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
  if (!$('#join').hidden || !$('#search-panel').hidden || !$('#room-settings').hidden) return;
  // Зажатая клавиша повторяется — без этой проверки F мигал бы полноэкранным режимом, а K паузой
  if (event.repeat) return;
  // Иначе пробел «нажмёт» кнопку, на которой остался фокус (например, реакцию).
  if (event.code === 'Space' && event.target.closest?.('button')) event.target.blur();
  // Раскладка как на YouTube. event.code не зависит от языка: K работает и на кириллице.
  const actions = {
    Space: togglePlay,
    KeyK: togglePlay,
    ArrowLeft: () => seekBy(-10),
    KeyJ: () => seekBy(-10),
    ArrowRight: () => seekBy(10),
    KeyL: () => seekBy(10),
    KeyF: toggleFullscreen,
    KeyM: () => ui.mute.click(),
    KeyC: () => (isFullscreen() ? toggleOverlayChat() : (selectTab('chat'), $('#chat-input').focus())),
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
        state.media?.kind === 'external' && m.ready ? el('span', { class: 'person-ready', title: 'Открыл фильм и готов' }, '✓') : null,
      ),
    ),
  );
  renderExternal();
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
  if (isFullscreen()) showOverlayMessage(msg);
  if (msg.type === 'user' && msg.userId !== state.me?.id) playMessageSound();
}

function sendChat(raw) {
  const text = raw.trim();
  if (!text) return false;
  socket.emit('chat:send', { text });
  return true;
}

$('#chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('#chat-input');
  if (sendChat(input.value)) input.value = '';
});

// Звук новых сообщений — только на компьютере: на телефоне уведомления и так видны поверх видео
const finePointer = matchMedia('(hover: hover) and (pointer: fine)').matches;
let chatSound = storage.get('kr_chat_sound', true);
let soundContext = null;

function playMessageSound() {
  if (!finePointer || !chatSound) return;
  try {
    soundContext ??= new AudioContext();
    if (soundContext.state === 'suspended') soundContext.resume();
    const now = soundContext.currentTime;
    // Короткое «динь-дон»: два тона с плавным затуханием, чтобы не щёлкало
    for (const [freq, start] of [[880, 0], [1320, 0.1]]) {
      const osc = soundContext.createOscillator();
      const gain = soundContext.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + start);
      gain.gain.exponentialRampToValueAtTime(0.08, now + start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + start + 0.3);
      osc.connect(gain).connect(soundContext.destination);
      osc.start(now + start);
      osc.stop(now + start + 0.32);
    }
  } catch {}
}

const soundButton = $('#chat-sound');
function renderSoundButton() {
  soundButton.replaceChildren(icon(chatSound ? 'bell' : 'bellOff', 18));
  soundButton.title = chatSound ? 'Звук новых сообщений включён' : 'Звук новых сообщений выключен';
  soundButton.setAttribute('aria-label', soundButton.title);
}
soundButton.hidden = !finePointer;
soundButton.addEventListener('click', () => {
  chatSound = !chatSound;
  storage.set('kr_chat_sound', chatSound);
  renderSoundButton();
  if (chatSound) playMessageSound();
});
renderSoundButton();

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
  // Шкала и отсечка видны и во время проверки микрофона — чтобы настроить порог до выхода в эфир
  $('#mic-meter').hidden = !voice.micOpen;
  $('#voice-gate-row').hidden = !voice.micOpen;
  $('#mic-test').disabled = voice.testing || starting || !voice.supported;
  $('#voice-unlock').hidden = !voice.audioBlocked;
  $('#voice-status').textContent = active ? `в эфире · слушателей: ${voice.connectedCount()}` : '';
  if (!voice.supported) {
    $('#voice-hint').textContent = 'Слушать голоса можно и так, а включить свой микрофон браузер разрешает только по HTTPS (например, через Cloudflare Tunnel) или на localhost.';
  }
}

micButtons.toggle.addEventListener('click', toggleMic);

// Самопроверка: 4 секунды записи того, что уходит слушателям, и сразу воспроизведение.
// Так слышно всё, что мешает: звук фильма из колонок, эхо, обрывы из-за слишком высокой отсечки.
const TEST_SECONDS = 4;
$('#mic-test').addEventListener('click', async () => {
  const label = $('#mic-test-label');
  const reset = () => (label.textContent = 'Проверить, как меня слышно');
  let left = TEST_SECONDS;
  let heard = false;
  label.textContent = `Говорите… ${left}`;
  const countdown = setInterval(() => {
    left -= 1;
    if (left > 0) label.textContent = `Говорите… ${left}`;
  }, 1000);
  const watch = setInterval(() => (heard ||= voice.gateOpen), 100);
  let recording = null;
  try {
    recording = await voice.testMic(TEST_SECONDS);
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    clearInterval(countdown);
    clearInterval(watch);
  }
  if (!recording) return reset();
  if (!heard) {
    toast('Вас не было слышно: микрофон слишком тихий или метка отсечки шума сдвинута слишком далеко вправо', { error: true });
    return reset();
  }
  label.textContent = 'Воспроизвожу — так вас слышат';
  const url = URL.createObjectURL(recording);
  const audio = new Audio(url);
  const done = () => {
    URL.revokeObjectURL(url);
    reset();
  };
  audio.onended = done;
  audio.onerror = done;
  audio.play().catch(done);
});
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
// Если подключена папка на Google Диске — сразу показываем свои фильмы, иначе просто поиск
$('#empty-search').addEventListener('click', () => (sources.gdriveFolder ? search.browseDrive() : $('#search-input').focus()));

// ---------------------------------------------------------------------------
// Подключение к комнате
// ---------------------------------------------------------------------------

$('#copy-link').addEventListener('click', async () => {
  const invite = state.room.invite;
  const url = `${location.origin}/r/${roomId}${invite ? `?i=${encodeURIComponent(invite)}` : ''}`;
  const ok = await copyText(url);
  if (!ok) return toast(`Не получилось скопировать. Ссылка: ${url}`, { error: true });
  toast(state.room.locked ? 'Ссылка-приглашение скопирована — по ней войдут без пароля' : 'Ссылка на комнату скопирована — отправьте её друзьям');
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

let joinPassword = '';

async function join() {
  let res;
  try {
    res = await socket.timeout(8000).emitWithAck('room:join', {
      roomId,
      name: myName,
      clientId,
      invite: storage.get(`kr_invite:${roomId}`),
      ownerKey: storage.get(`kr_owner:${roomId}`),
      password: joinPassword || undefined,
    });
  } catch {
    res = { error: 'Сервер не отвечает' };
  }
  if (res.error) return showJoin(res.error, res.needPassword);

  joinPassword = '';
  joined = true;
  state.me = res.you;
  if (res.room.ownerKey) storage.set(`kr_owner:${roomId}`, res.room.ownerKey);
  $('#join').hidden = true;
  $('#connection').hidden = true;
  applyRoomMeta(res.room);
  applyState(res.state);
  applyCreationSettings();
  voice.resume();
}

// Приглашение приходит каждому вошедшему: сохранённое, оно пускает без пароля при следующих входах
function applyRoomMeta(meta) {
  state.room = { ...state.room, ...meta };
  if (meta.invite) storage.set(`kr_invite:${roomId}`, meta.invite);
  $('#room-name').textContent = state.room.name;
  $('#room-lock').hidden = !state.room.locked;
  $('#room-settings-btn').hidden = !state.room.isOwner;
  document.title = `${state.room.name} · KinoRoom`;
  rememberRoom();
}
socket.on('room:meta', applyRoomMeta);

// Комнату создали на главной с названием и паролем — применяем их, как только стали владельцем
function applyCreationSettings() {
  let pending = null;
  try {
    pending = JSON.parse(sessionStorage.getItem('kr_new_room') ?? 'null');
    sessionStorage.removeItem('kr_new_room');
  } catch {}
  if (!pending || pending.id !== roomId || !state.room.isOwner) return;
  socket.emit('room:settings', { name: pending.name || undefined, password: pending.password || undefined, listed: pending.listed }, (res) => {
    if (res?.error) toast(res.error, { error: true });
  });
}

function rememberRoom() {
  const recent = storage.get('kr_recent', []).filter((r) => r.id !== roomId);
  storage.set('kr_recent', [{ id: roomId, name: state.room.name, ts: Date.now() }, ...recent].slice(0, 6));
}

function showJoin(error = '', needPassword = false) {
  $('#join').hidden = false;
  $('#join-password-row').hidden = !needPassword;
  // Первый раз о пароле говорит сама подсказка, ошибку показываем только после неудачной попытки
  $('#join-error').textContent = needPassword && !joinPassword ? '' : error;
  $('#join-name').value = myName;
  (needPassword && myName ? $('#join-password') : $('#join-name')).focus();
}

$('#join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const name = $('#join-name').value.trim().slice(0, 24);
  if (!name) return;
  myName = name;
  storage.set('kr_name', name);
  joinPassword = $('#join-password').value;
  $('#join-password').value = '';
  if (socket.connected) join();
  else socket.connect();
});

// --- Настройки комнаты (только для создателя) ---
const settingsModal = $('#room-settings');

$('#room-settings-btn').addEventListener('click', () => {
  const room = state.room;
  $('#rs-name').value = room.name;
  $('#rs-password').value = '';
  $('#rs-password-label').textContent = room.locked ? 'Новый пароль — пусто, чтобы оставить прежний' : 'Пароль — пусто, чтобы комната была открытой';
  $('#rs-remove-row').hidden = !room.locked;
  $('#rs-remove-password').checked = false;
  $('#rs-listed').checked = room.listed;
  $('#rs-rotate').checked = false;
  $('#rs-error').textContent = '';
  settingsModal.hidden = false;
  $('#rs-name').focus();
});
$('#rs-cancel').addEventListener('click', () => (settingsModal.hidden = true));
settingsModal.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') settingsModal.hidden = true;
});

$('#room-settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = {
    name: $('#rs-name').value,
    listed: $('#rs-listed').checked,
    rotateInvite: $('#rs-rotate').checked,
    removePassword: $('#rs-remove-password').checked,
  };
  const password = $('#rs-password').value;
  if (password && !payload.removePassword) payload.password = password;
  let res;
  try {
    res = await socket.timeout(8000).emitWithAck('room:settings', payload);
  } catch {
    res = { error: 'Сервер не отвечает' };
  }
  if (res?.error) {
    $('#rs-error').textContent = res.error;
    return;
  }
  settingsModal.hidden = true;
  if (payload.rotateInvite) toast('Старые ссылки больше не работают. Новая — в кнопке с кодом комнаты');
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
  showExternalNotice(playback);
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
