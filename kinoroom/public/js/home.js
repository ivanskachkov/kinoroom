import { $, el, hydrateIcons, storage, newRoomId, normalizeRoomId } from './common.js';

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
  location.href = `/r/${newRoomId()}`;
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

const recent = storage.get('kr_recent', []);
if (recent.length) {
  const format = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  $('#recent-list').replaceChildren(
    ...recent.map((room) =>
      el('li', {}, el('a', { class: 'recent-link', href: `/r/${room.id}` }, el('span', { class: 'room-code' }, room.id), el('span', { class: 'muted' }, format.format(room.ts)))),
    ),
  );
  $('#recent').hidden = false;
}
