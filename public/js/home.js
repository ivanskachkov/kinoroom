import { $, el, api, icon, hydrateIcons, storage, newRoomId, normalizeRoomId, formatTime } from './common.js';

hydrateIcons();

const nameInput = $('#name');
nameInput.value = storage.get('kr_name', '');

function saveName() {
  const name = nameInput.value.trim().slice(0, 24);
  if (name) storage.set('kr_name', name);
}

$('#create-form').addEventListener('submit', (event) => {
  event.preventDefault();
  saveName();
  const id = newRoomId();
  // Название и пароль применит комната, как только создатель войдёт в неё и станет владельцем.
  // Через sessionStorage, а не адрес: пароль не должен попасть в историю браузера
  const pending = { id, name: $('#room-name').value.trim(), password: $('#room-password').value, listed: $('#room-listed').checked };
  if (pending.name || pending.password || !pending.listed) {
    try {
      sessionStorage.setItem('kr_new_room', JSON.stringify(pending));
    } catch {}
  }
  location.href = `/r/${id}`;
});

$('#join-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const id = normalizeRoomId($('#code').value);
  if (!id) {
    $('#code-error').textContent = 'Код — это 4–12 латинских букв и цифр, например K7QX2M';
    return;
  }
  saveName();
  location.href = `/r/${id}`;
});

function ago(ts) {
  const minutes = Math.round((Date.now() - ts) / 60_000);
  if (minutes < 2) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.round(hours / 24)} дн. назад`;
}

// --- Общий список комнат ---

function roomItem(room) {
  const playing = room.playing
    ? `▶ ${room.playing}${room.position > 5 ? ` · ${formatTime(room.position)}` : ''}`
    : 'ничего не играет';
  return el(
    'li',
    {},
    el(
      'a',
      { class: 'room-item', href: `/r/${room.id}` },
      el(
        'span',
        { class: 'room-item-main' },
        el('span', { class: 'room-item-name' }, room.locked ? el('span', { class: 'room-item-lock', title: 'С паролем' }, icon('lock', 14)) : null, room.name),
        el('span', { class: 'room-item-sub' }, playing),
      ),
      room.members
        ? el('span', { class: 'room-item-live', title: 'Сейчас в комнате' }, icon('users', 14), room.members)
        : el('span', { class: 'room-item-time' }, ago(room.updatedAt)),
    ),
  );
}

const roomsList = $('#rooms-list');
let searchTimer = null;

async function loadRooms() {
  const q = $('#rooms-search').value.trim();
  try {
    const { rooms } = await api(`/api/rooms${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    roomsList.replaceChildren(
      ...(rooms.length ? rooms.map(roomItem) : [el('li', { class: 'rooms-empty' }, q ? 'Ничего не нашлось' : 'Пока нет комнат — создайте первую')]),
    );
  } catch (err) {
    roomsList.replaceChildren(el('li', { class: 'rooms-empty' }, err.message));
  }
}

$('#rooms-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadRooms, 250);
});
loadRooms();
setInterval(loadRooms, 30_000);

// --- Недавние комнаты этого браузера ---

const recent = storage.get('kr_recent', []);
if (recent.length) {
  const format = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  $('#recent-list').replaceChildren(
    ...recent.map((room) =>
      el(
        'li',
        {},
        el(
          'a',
          { class: 'recent-link', href: `/r/${room.id}` },
          el('span', {}, room.name ?? el('span', { class: 'room-code' }, room.id)),
          el('span', { class: 'muted' }, format.format(room.ts)),
        ),
      ),
    ),
  );
  $('#recent').hidden = false;
}
