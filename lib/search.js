import express from 'express';
import { config } from './config.js';
import { createCache } from './cache.js';

const cached = createCache({ ttl: 6 * 60 * 60 * 1000 });
const cachedShort = createCache({ ttl: 60 * 1000 }); // папка на Диске меняется — туда докладывают фильмы
const DRIVE = 'Google Диск';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
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
  if (res.status === 401 || (res.status === 400 && body.includes('API key not valid'))) {
    throw new UpstreamError(502, `${source}: неверный API-ключ в .env`);
  }
  if (source === DRIVE) {
    if (res.status === 404) throw new UpstreamError(404, 'Файл не найден или закрыт: откройте доступ «Все, у кого есть ссылка»');
    if (/REFERRER|referer/i.test(body)) throw new UpstreamError(502, 'Ключ Google Диска не разрешает этот сайт: добавьте его адрес в ограничения ключа');
    if (/SERVICE_DISABLED|accessNotConfigured/.test(body)) throw new UpstreamError(502, 'В проекте Google Cloud не включён Google Drive API');
    if (/downloadQuotaExceeded/.test(body)) throw new UpstreamError(429, 'Google временно ограничил скачивание этого файла — попробуйте позже');
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

// --- Google Диск ------------------------------------------------------------
// Файл, открытый «всем, у кого есть ссылка», браузер зрителя тянет прямо из Drive API по ключу
// (?alt=media поддерживает перемотку). Ключ виден зрителям, поэтому в Google Cloud он ограничен
// Drive API и адресом сайта. Запросы с сервера подписываем тем же адресом в Referer.

function driveGet(req, pathname, params) {
  const url = new URL(`${DRIVE_API}${pathname}`);
  url.search = new URLSearchParams({ ...params, supportsAllDrives: 'true', key: config.gdriveKey });
  const site = `${req.protocol}://${req.get('x-forwarded-host') ?? req.get('host')}/`;
  return getJson(url, DRIVE, { headers: { referer: site } });
}

// Без thumbnailLink: эти превью живут несколько часов и часто требуют входа в Google
const DRIVE_FIELDS = 'id,name,mimeType,videoMediaMetadata(durationMillis,height)';

function driveMedia(file) {
  const meta = file.videoMediaMetadata ?? {};
  return {
    id: file.id,
    title: file.name.replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').trim(),
    url: `${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media&key=${encodeURIComponent(config.gdriveKey)}`,
    duration: meta.durationMillis ? Number(meta.durationMillis) / 1000 : null,
    height: meta.height ? Number(meta.height) : null,
  };
}

// Папка и подпапки на два уровня вглубь: фильмы в корне, сериалы — по папкам сезонов
async function driveFolders(req, root) {
  const folders = [root];
  let level = [root];
  for (let depth = 0; depth < 2 && level.length; depth += 1) {
    const parents = level.slice(0, 20).map((id) => `'${id}' in parents`).join(' or ');
    const found = await driveGet(req, '/files', {
      q: `(${parents}) and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: 'files(id)',
      pageSize: '100',
      includeItemsFromAllDrives: 'true',
    });
    level = (found.files ?? []).map((folder) => folder.id);
    folders.push(...level);
  }
  return folders.slice(0, 40);
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
      tmdb(`/${type}/${id}`, { append_to_response: 'videos,watch/providers', include_video_language: [...new Set([lang, 'en', 'null'])].join(',') }),
    );

    // Где фильм есть легально в стране зрителей (данные JustWatch через TMDB)
    const region = config.youtubeRegion || 'UA';
    const offers = d['watch/providers']?.results?.[region] ?? {};
    const names = (list) => (list ?? []).map((provider) => provider.provider_name);
    const watch = {
      region,
      link: offers.link ?? null,
      subscription: names(offers.flatrate),
      free: [...names(offers.free), ...names(offers.ads)],
      rent: names(offers.rent),
      buy: names(offers.buy),
    };

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
      watch,
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

  router.get('/gdrive/:id', async (req, res) => {
    if (!config.gdriveKey) return res.status(503).json({ error: 'Google Диск не подключён: нужен GDRIVE_API_KEY в .env' });
    const { id } = req.params;
    if (!/^[\w-]{10,120}$/.test(id)) return res.status(400).json({ error: 'Неверная ссылка на файл' });
    const file = await cached(`gdrive:file:${id}`, () => driveGet(req, `/files/${encodeURIComponent(id)}`, { fields: DRIVE_FIELDS }));
    if (!file.mimeType?.startsWith('video/')) return res.status(400).json({ error: 'По ссылке не видео — нужен видеофайл, например .mp4' });
    res.json(driveMedia(file));
  });

  router.get('/search/gdrive', async (req, res) => {
    if (!config.gdriveKey || !config.gdriveFolder) return res.status(503).json({ error: 'Папка Google Диска не подключена: нужны GDRIVE_API_KEY и GDRIVE_FOLDER_ID в .env' });
    // Кавычки и обратные слэши экранируются по правилам языка запросов Drive
    const q = readQuery(req).replace(/[\\']/g, (char) => `\\${char}`);
    const results = await cachedShort(`gdrive:search:${q.toLowerCase()}`, async () => {
      const folders = await driveFolders(req, config.gdriveFolder);
      const parents = folders.map((id) => `'${id}' in parents`).join(' or ');
      const found = await driveGet(req, '/files', {
        q: `(${parents}) and mimeType contains 'video/' and trashed = false${q ? ` and name contains '${q}'` : ''}`,
        fields: `files(${DRIVE_FIELDS})`,
        orderBy: 'name_natural',
        pageSize: '60',
        includeItemsFromAllDrives: 'true',
      });
      return (found.files ?? []).map(driveMedia);
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
