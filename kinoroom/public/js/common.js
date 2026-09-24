export const $ = (selector, root = document) => root.querySelector(selector);

/** Создаёт DOM-элемент. Текст всегда вставляется как текст, не как HTML. */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter((child) => child != null && child !== false));
  return node;
}

const ICONS = {
  play: '<path d="M8 5.2v13.6a.8.8 0 0 0 1.2.7l10.6-6.8a.8.8 0 0 0 0-1.4L9.2 4.5A.8.8 0 0 0 8 5.2z" fill="currentColor"/>',
  pause: '<rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor"/>',
  plus: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  close: '<path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  search: '<circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M16 16l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  volume: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>',
  mute: '<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M16 9.5l5 5M21 9.5l-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>',
  back: '<path d="M15 5l-7 7 7 7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  next: '<path d="M6 5.8v12.4a.7.7 0 0 0 1.1.6l8.4-6.2a.7.7 0 0 0 0-1.2L7.1 5.2a.7.7 0 0 0-1.1.6z" fill="currentColor"/><rect x="16.5" y="5" width="2.5" height="14" rx="1" fill="currentColor"/>',
  film: '<rect x="3.5" y="5" width="17" height="14" rx="2" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M7.5 5v14M16.5 5v14M3.5 9.5h4M3.5 14.5h4M16.5 9.5h4M16.5 14.5h4" stroke="currentColor" stroke-width="1.8"/>',
  chat: '<path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 5z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/>',
  queue: '<path d="M4 6.5h12M4 12h12M4 17.5h7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M15 15v5l4-2.5z" fill="currentColor"/>',
  users: '<circle cx="9" cy="8.5" r="3.2" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/><path d="M15.5 5.6a3.2 3.2 0 0 1 0 5.8M17.5 14a5.5 5.5 0 0 1 3 5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round"/>',
  send: '<path d="M4.5 12L20 4.5l-4 15-4.2-5.8z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/><path d="M11.8 13.7L20 4.5" stroke="currentColor" stroke-width="1.8"/>',
  folder: '<path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4.2l2 2H19a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linejoin="round"/>',
};

export function icon(name, size = 20) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  svg.innerHTML = ICONS[name] ?? '';
  return svg;
}

/** Заменяет <i data-icon="…"> в статической разметке на SVG-иконки. */
export function hydrateIcons(root = document) {
  for (const node of root.querySelectorAll('i[data-icon]')) {
    node.replaceWith(icon(node.dataset.icon, Number(node.dataset.size) || 20));
  }
}

export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

// crypto.randomUUID доступен только по HTTPS, а по локальной сети сайт открывают по HTTP.
export function randomId(length = 16, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789') {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const newRoomId = () => randomId(6, ROOM_ALPHABET);

export function normalizeRoomId(value) {
  const id = String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{4,12}$/.test(id) ? id : null;
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export async function api(path, { signal } = {}) {
  const res = await fetch(path, { signal, headers: { accept: 'application/json' } });
  if (res.status === 401) {
    location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    throw new Error('Нужно войти');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) throw new Error(data?.error || `Ошибка сервера (${res.status})`);
  return data;
}

export function toast(text, { error = false } = {}) {
  const container = $('#toasts');
  if (!container) return;
  const node = el('div', { class: error ? 'toast toast-error' : 'toast', role: 'status' }, text);
  container.append(node);
  setTimeout(() => node.remove(), 3200);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // navigator.clipboard недоступен по HTTP — старый способ работает везде.
    const area = el('textarea', { readonly: true, style: { position: 'fixed', opacity: '0' } });
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}
