import express from 'express';
import { config } from './config.js';
import { createCache } from './cache.js';

const cached = createCache({ ttl: 6 * 60 * 60 * 1000 });
const TMDB_IMG = 'https://image.tmdb.org/t/p/';

class UpstreamError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function getJson(url, source, init = {}) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new UpstreamError(502, `${source} не отвечает`);
  }
  if (res.ok) return res.json();

  const body = await res.text().catch(() => '');
  if (source === 'YouTube' && body.includes('quotaExceeded')) {
    throw new UpstreamError(429, 'Дневная квота YouTube API закончилась — поиск заработает завтра. Ссылки можно вставлять и сейчас.');
  }
  if (res.status === 401 || (source === 'YouTube' && res.status === 400 && body.includes('API key'))) {
    throw new UpstreamError(502, `${source}: неверный API-ключ в .env`);
  }
  if (res.status === 404) throw new UpstreamError(404, 'Не найдено');
  throw new UpstreamError(502, `${source} вернул ошибку ${res.status}`);
}

function readQuery(req) {
  return String(req.query.q ?? '').trim().slice(0, 120);
}

const first = (value) => (Array.isArray(value) ? value[0] : value);

// --- TMDB -----------------------------------------------------------------

function tmdb(pathname, params = {}) {
  const url = new URL(`https://api.themoviedb.org/3${pathname}`);
  url.searchParams.set('language', config.tmdbLanguage);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const headers = { accept: 'application/json' };
  // Подходит и v3 «API Key», и v4 «API Read Access Token» (он начинается с eyJ).
  if (config.tmdbKey.startsWith('eyJ')) headers.authorization = `Bearer ${config.tmdbKey}`;
  else url.searchParams.set('api_key', config.tmdbKey);

  return getJson(url, 'TMDB', { headers });
}

function tmdbSummary(item) {
  return {
    id: item.id,
    type: item.media_type ?? (item.title ? 'movie' : 'tv'),
    title: item.title ?? item.name,
    originalTitle: item.original_title ?? item.original_name,
    year: (item.release_date ?? item.first_air_date ?? '').slice(0, 4),
    overview: item.overview,
    poster: item.poster_path ? `${TMDB_IMG}w342${item.poster_path}` : null,
    rating: item.vote_count > 0 ? item.vote_average : null,
  };
}

// --- YouTube --------------------------------------------------------------

function parseIsoDuration(value = '') {
  const m = value.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  // Отсутствующая часть («PT1H5M» без секунд) — undefined, а Number(undefined) даёт NaN, а не 0
  const [, d, h, min, s] = m.map((part) => Number(part ?? 0));
  return ((d * 24 + h) * 60 + min) * 60 + s;
}

// --- Internet Archive -----------------------------------------------------

// Производные файлы Archive (h.264) гарантированно играют в браузере,
// а «MPEG4»-оригиналы бывают в кодеке MPEG-4 Part 2, который Chrome не умеет.
const ARCHIVE_FORMAT_RANK = { 'h.264 IA': 0, 'h.264': 1, 'h.264 HD': 1, '512Kb MPEG4': 2, MPEG4: 3, WebM: 4, 'Ogg Video': 5 };

function parseLength(value) {
  if (value == null) return null;
  const parts = String(value).split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return null;
  return parts.reduce((total, n) => total * 60 + n, 0) || null;
}

function prettyFileName(name) {
  return name
    .split('/')
    .pop()
    .replace(/(\.ia)?(_512kb)?\.\w+$/i, '')
    .replace(/[._]+/g, ' ')
    .trim();
}

// Версии для выбора качества: только то, что точно играет в браузере. Оригиналы «MPEG4»
// не предлагаем — у них бывает кодек MPEG-4 Part 2, и у зрителя просто не будет картинки.
const QUALITY_FORMATS = new Set(['h.264 IA', 'h.264', 'h.264 HD', '512Kb MPEG4', 'WebM']);

function archiveUrl(id, name) {
  return `https://archive.org/download/${encodeURIComponent(id)}/${name.split('/').map(encodeURIComponent).join('/')}`;
}

function pickArchiveVideos(id, files) {
  // Один и тот же ролик лежит в нескольких производных файлах: film.mp4, film.ia.mp4, film_512kb.mp4…
  const groups = new Map();
  for (const file of files) {
    if (!/\.(mp4|m4v|webm|ogv)$/i.test(file.name)) continue;
    const key = file.name.replace(/(\.ia)?(_512kb)?\.(mp4|m4v|webm|ogv)$/i, '').toLowerCase();
    const group = groups.get(key) ?? [];
    group.push({ ...file, rank: ARCHIVE_FORMAT_RANK[file.format] ?? 6, height: Number(file.height) || null });
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => {
      group.sort((a, b) => a.rank - b.rank);
      const best = group[0];
      const byHeight = new Map(); // одна версия на разрешение — с лучшим форматом
      for (const file of group) {
        if (!QUALITY_FORMATS.has(file.format) || !file.height || byHeight.has(file.height)) continue;
        byHeight.set(file.height, { url: archiveUrl(id, file.name), height: file.height, label: `${file.height}p` });
      }
      const variants = [...byHeight.values()].sort((a, b) => b.height - a.height);
      return {
        name: best.name,
        title: best.title || prettyFileName(best.name),
        url: archiveUrl(id, best.name),
        duration: parseLength(best.length),
        height: best.height,
        ...(variants.length > 1 ? { variants } : {}),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .slice(0, 300);
}

// --- Router ---------------------------------------------------------------

export function createSearchRouter() {
  const router = express.Router();

  router.get('/search/tmdb', async (req, res) => {
    if (!config.tmdbKey) return res.status(503).json({ error: 'Поиск фильмов выключен: нужен TMDB_API_KEY в .env' });
    const q = readQuery(req);
    if (!q) return res.json({ results: [] });
    const data = await cached(`tmdb:search:${q.toLowerCase()}`, () =>
      tmdb('/search/multi', { query: q, include_adult: 'false' }),
    );
    const results = (data.results ?? [])
      .filter((item) => item.media_type === 'movie' || item.media_type === 'tv')
      .slice(0, 20)
      .map(tmdbSummary);
    res.json({ results });
  });

  router.get('/tmdb/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    if (!config.tmdbKey) return res.status(503).json({ error: 'Нужен TMDB_API_KEY в .env' });
    if (!['movie', 'tv'].includes(type) || !/^\d{1,9}$/.test(id)) return res.status(400).json({ error: 'Неверный запрос' });

    const lang = config.tmdbLanguage.split('-')[0];
    const d = await cached(`tmdb:${type}:${id}`, () =>
      tmdb(`/${type}/${id}`, { append_to_response: 'videos', include_video_language: [...new Set([lang, 'en', 'null'])].join(',') }),
    );

    const typeRank = { Trailer: 0, Teaser: 1 };
    const videos = (d.videos?.results ?? [])
      .filter((v) => v.site === 'YouTube' && /^[\w-]{11}$/.test(v.key))
      .sort((a, b) => (typeRank[a.type] ?? 2) - (typeRank[b.type] ?? 2) || Number(b.iso_639_1 === lang) - Number(a.iso_639_1 === lang))
      .slice(0, 6)
      .map((v) => ({ id: v.key, name: v.name, type: v.type }));

    res.json({
      ...tmdbSummary({ ...d, media_type: type }),
      runtime: d.runtime ?? d.episode_run_time?.[0] ?? null,
      seasons: d.number_of_seasons ?? null,
      genres: (d.genres ?? []).map((g) => g.name),
      videos,
    });
  });

  router.get('/search/youtube', async (req, res) => {
    if (!config.youtubeKey) return res.status(503).json({ error: 'Поиск YouTube выключен: нужен YOUTUBE_API_KEY в .env' });
    const q = readQuery(req);
    if (!q) return res.json({ results: [] });
    // long=1 — только видео длиннее 20 минут: полные фильмы и серии без трейлеров и обзоров
    const long = req.query.long === '1';

    const results = await cached(`yt:search:${long ? 'long:' : ''}${q.toLowerCase()}`, async () => {
      // search.list стоит 100 единиц квоты из 10 000 в сутки, videos.list — всего 1.
      const search = new URL('https://www.googleapis.com/youtube/v3/search');
      const params = { part: 'id', type: 'video', videoEmbeddable: 'true', maxResults: '18', q, key: config.youtubeKey };
      if (long) params.videoDuration = 'long';
      // Только то, что можно смотреть в этой стране: фильмы на YouTube часто закрыты по регионам
      if (config.youtubeRegion) params.regionCode = config.youtubeRegion;
      search.search = new URLSearchParams(params);
      const found = await getJson(search, 'YouTube');
      const ids = (found.items ?? []).map((item) => item.id?.videoId).filter(Boolean);
      if (!ids.length) return [];

      const videos = new URL('https://www.googleapis.com/youtube/v3/videos');
      videos.search = new URLSearchParams({ part: 'snippet,contentDetails', id: ids.join(','), key: config.youtubeKey });
      const details = await getJson(videos, 'YouTube');
      const byId = new Map((details.items ?? []).map((item) => [item.id, item]));

      return ids
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((item) => ({
          id: item.id,
          title: item.snippet.title,
          channel: item.snippet.channelTitle,
          thumb: item.snippet.thumbnails?.medium?.url ?? `https://i.ytimg.com/vi/${item.id}/mqdefault.jpg`,
          duration: parseIsoDuration(item.contentDetails?.duration),
          live: item.snippet.liveBroadcastContent === 'live',
        }));
    });
    res.json({ results });
  });

  // Название и превью для вставленной ссылки — через oEmbed, ключ не нужен.
  router.get('/youtube/info/:id', async (req, res) => {
    const { id } = req.params;
    if (!/^[\w-]{11}$/.test(id)) return res.status(400).json({ error: 'Неверный ID видео' });
    const info = await cached(`yt:oembed:${id}`, () =>
      getJson(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`, 'YouTube'),
    );
    res.json({ id, title: info.title, channel: info.author_name, thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` });
  });

  router.get('/search/archive', async (req, res) => {
    const terms = readQuery(req)
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 8);
    if (!terms.length) return res.json({ results: [] });

    const url = new URL('https://archive.org/advancedsearch.php');
    url.searchParams.set('q', `title:(${terms.join(' AND ')}) AND mediatype:(movies)`);
    for (const field of ['identifier', 'title', 'year', 'creator']) url.searchParams.append('fl[]', field);
    url.searchParams.append('sort[]', 'downloads desc');
    url.searchParams.set('rows', '24');
    url.searchParams.set('output', 'json');

    const data = await cached(`ia:search:${terms.join(' ').toLowerCase()}`, () => getJson(url, 'Internet Archive'));
    const results = (data.response?.docs ?? []).map((doc) => ({
      id: doc.identifier,
      title: first(doc.title) ?? doc.identifier,
      year: first(doc.year) ?? null,
      creator: first(doc.creator) ?? null,
      thumb: `https://archive.org/services/img/${encodeURIComponent(doc.identifier)}`,
    }));
    res.json({ results });
  });

  router.get('/archive/:id', async (req, res) => {
    const { id } = req.params;
    if (!/^[\w.-]{1,120}$/.test(id)) return res.status(400).json({ error: 'Неверный идентификатор' });
    const meta = await cached(`ia:meta:${id}`, () => getJson(`https://archive.org/metadata/${encodeURIComponent(id)}`, 'Internet Archive'));
    if (!Array.isArray(meta.files)) return res.status(404).json({ error: 'Запись не найдена' });
    res.json({
      id,
      title: first(meta.metadata?.title) ?? id,
      thumb: `https://archive.org/services/img/${encodeURIComponent(id)}`,
      files: pickArchiveVideos(id, meta.files),
    });
  });

  // Express отличает обработчик ошибок по четырём аргументам, поэтому next остаётся в сигнатуре.
  router.use((err, req, res, next) => {
    if (err instanceof UpstreamError) return res.status(err.status).json({ error: err.message });
    console.error('[search]', err);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  });

  return router;
}
