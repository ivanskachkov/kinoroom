import fs from 'node:fs';
import path from 'node:path';

/*
 * Квота поиска YouTube: 100 вызовов search.list в сутки на проект, купить больше нельзя.
 * Сутки у YouTube начинаются в полночь по тихоокеанскому времени (около 10:00 по Киеву).
 * Здесь — счётчик поисков за эти сутки и результаты поиска, сохранённые на диск: одинаковый
 * запрос в течение суток квоту не тратит, в том числе после перезапуска сервера.
 */

const PACIFIC = 'America/Los_Angeles';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 300; // ~5 КБ на запрос — файл не больше пары мегабайт
const SAVE_DELAY_MS = 2000;

const pacificFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: PACIFIC, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function pacificParts(ts) {
  const parts = {};
  for (const { type, value } of pacificFormat.formatToParts(ts)) if (type !== 'literal') parts[type] = Number(value);
  return parts;
}

/** Сутки квоты, например «2026-09-27». */
export function quotaDay(ts = Date.now()) {
  const { year, month, day } = pacificParts(ts);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Когда начнутся следующие сутки квоты: полночь по тихоокеанскому времени (летом UTC−7, зимой UTC−8). */
export function nextReset(ts = Date.now()) {
  const { year, month, day } = pacificParts(ts);
  const midnightAsUtc = Date.UTC(year, month - 1, day + 1);
  const probe = midnightAsUtc + 8 * 60 * 60 * 1000; // около той полуночи — узнаём смещение пояса в этот момент
  const p = pacificParts(probe);
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - probe;
  return midnightAsUtc - offset;
}

export function createYoutubeQuota({ dir, limit }) {
  const file = path.join(dir, 'youtube.json');
  let quota = { day: quotaDay(), used: 0, exhausted: false };
  let cache = new Map(); // ключ запроса → { value, expires }
  let saveTimer = null;

  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.quota?.day === quota.day) {
      quota = { day: quota.day, used: Number(saved.quota.used) || 0, exhausted: saved.quota.exhausted === true };
    }
    const now = Date.now();
    for (const [key, entry] of Object.entries(saved.cache ?? {})) {
      if (entry?.expires > now && Array.isArray(entry.value)) cache.set(key, entry);
    }
  } catch {} // файла ещё нет или он повреждён — начинаем с чистого листа

  function saveNow() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ quota, cache: Object.fromEntries(cache) }));
      fs.renameSync(`${file}.tmp`, file);
    } catch (err) {
      console.warn('[youtube] не удалось сохранить квоту и кэш:', err.message);
    }
  }

  const saveSoon = () => {
    saveTimer ??= setTimeout(saveNow, SAVE_DELAY_MS);
    saveTimer.unref?.();
  };

  function today() {
    const day = quotaDay();
    if (quota.day !== day) quota = { day, used: 0, exhausted: false };
    return quota;
  }

  return {
    /** Сохранённые результаты поиска или undefined. */
    get(key) {
      const entry = cache.get(key);
      if (!entry) return undefined;
      if (entry.expires <= Date.now()) {
        cache.delete(key);
        return undefined;
      }
      return entry.value;
    },

    set(key, value) {
      cache.delete(key);
      cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      saveSoon();
    },

    /** Поиск прошёл — минус один из суточных. */
    spend() {
      const q = today();
      q.used += 1;
      const left = limit - q.used;
      if (left === 10 || left === 0) console.log(`[youtube] осталось поисков на сегодня: ${Math.max(0, left)} из ${limit}`);
      saveSoon();
    },

    /** YouTube ответил, что квота кончилась: до конца суток поиск не дёргаем. */
    exhaust() {
      const q = today();
      if (!q.exhausted) {
        console.warn(`[youtube] квота поиска на сегодня закончилась (наших поисков: ${q.used}), обновится ${new Date(nextReset()).toISOString()}`);
      }
      q.exhausted = true;
      saveSoon();
    },

    get exhausted() {
      return today().exhausted;
    },

    status() {
      const q = today();
      return { used: q.used, limit, left: q.exhausted ? 0 : Math.max(0, limit - q.used), resetsAt: nextReset() };
    },

    flush: saveNow,
  };
}
