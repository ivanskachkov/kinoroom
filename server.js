import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { Server } from 'socket.io';
import { config, ROOT } from './lib/config.js';
import { createAuth } from './lib/auth.js';
import { createSearchRouter } from './lib/search.js';
import { createLibraryRouter } from './lib/library.js';
import { attachRooms } from './lib/rooms.js';
import { createRoomStore } from './lib/store.js';
import { getIceServers, hasTurn } from './lib/ice.js';

const app = express();
app.disable('x-powered-by');
// cloudflared / nginx на той же малинке подключаются с localhost — доверяем их X-Forwarded-*.
app.set('trust proxy', 'loopback');

const auth = config.sitePassword ? createAuth(config.sitePassword) : null;
if (auth) {
  app.post('/api/login', express.urlencoded({ extended: false, limit: '4kb' }), auth.login);
  app.use(auth.guard);
}

app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));
app.get('/vendor/hls.min.js', (req, res) => res.sendFile(path.join(ROOT, 'node_modules/hls.js/dist/hls.min.js')));
app.get('/r/:id', (req, res) => res.sendFile(path.join(ROOT, 'public/room.html')));

app.get('/api/config', (req, res) => {
  res.json({
    sources: { tmdb: Boolean(config.tmdbKey), youtube: Boolean(config.youtubeKey), archive: true, library: Boolean(config.mediaDir) },
  });
});
app.get('/api/ice', async (req, res) => {
  res.set('cache-control', 'no-store').json({ iceServers: await getIceServers() });
});
app.use('/api', createSearchRouter());
if (config.mediaDir) {
  app.use('/api', createLibraryRouter(config.mediaDir));
  app.use(
    '/media',
    express.static(config.mediaDir, { index: false, dotfiles: 'ignore', fallthrough: false }),
    // 404 и 403 (например, попытка выйти за пределы папки) — без стектрейса в логе.
    (err, req, res, next) => res.status(err.status ?? 500).end(),
  );
}
app.use('/api', (req, res) => res.status(404).json({ error: 'Не найдено' }));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 64 * 1024 });
if (auth) io.use(auth.socketGuard);
const store = createRoomStore({ dir: config.dataDir, ttlDays: config.roomTtlDays });
const rooms = attachRooms(io, { libraryEnabled: Boolean(config.mediaDir), store });

server.listen(config.port, config.host, () => {
  const on = (value) => (value ? 'вкл' : 'выкл');
  console.log(`KinoRoom запущен: http://localhost:${config.port}`);
  console.log(
    `  Поиск фильмов (TMDB): ${on(config.tmdbKey)} · YouTube-поиск: ${on(config.youtubeKey)} · ` +
      `Медиатека: ${config.mediaDir ?? 'выкл'} · Пароль: ${on(config.sitePassword)} · TURN для голоса: ${on(hasTurn())}`,
  );
  console.log(`  Комнаты хранятся ${config.roomTtlDays} дн. в ${config.dataDir}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    rooms.saveAll(); // перезапуск сторожем или обновление не должны сбрасывать позицию
    io.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
