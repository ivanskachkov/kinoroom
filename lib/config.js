import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

loadEnvFile(path.join(ROOT, '.env'));

// Минимальный парсер .env, чтобы не тянуть зависимость и работать на любой версии Node.
// Переменные, уже заданные в окружении (например, в systemd), не перезаписываются.
function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    const quoted = match[2].match(/^(['"])(.*)\1$/);
    process.env[match[1]] = quoted ? quoted[2] : match[2].replace(/\s+#.*$/, '');
  }
}

const env = (name, fallback = '') => (process.env[name] ?? fallback).trim();

function resolveMediaDir(dir) {
  if (!dir) return null;
  const abs = path.resolve(ROOT, dir);
  try {
    if (fs.statSync(abs).isDirectory()) return abs;
  } catch {}
  console.warn(`[config] Папка MEDIA_DIR «${dir}» не найдена — медиатека выключена`);
  return null;
}

export const config = {
  port: Number(env('PORT', '3000')) || 3000,
  host: env('HOST') || undefined,
  tmdbKey: env('TMDB_API_KEY'),
  tmdbLanguage: env('TMDB_LANGUAGE', 'ru-RU'),
  youtubeKey: env('YOUTUBE_API_KEY'),
  youtubeRegion: env('YOUTUBE_REGION').toUpperCase(),
  mediaDir: resolveMediaDir(env('MEDIA_DIR')),
  sitePassword: env('SITE_PASSWORD'),
  dataDir: path.resolve(ROOT, env('DATA_DIR') || 'data'),
  roomTtlDays: Number(env('ROOM_TTL_DAYS', '30')) || 30,
  // TURN-ретранслятор для голоса: либо Cloudflare (ключ + токен), либо любой свой (coturn и т.п.).
  cfTurnKeyId: env('CF_TURN_KEY_ID'),
  cfTurnToken: env('CF_TURN_API_TOKEN'),
  turnUrls: env('TURN_URLS').split(',').map((url) => url.trim()).filter(Boolean),
  turnUsername: env('TURN_USERNAME'),
  turnCredential: env('TURN_CREDENTIAL'),
};
