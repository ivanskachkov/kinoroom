import crypto from 'node:crypto';

const COOKIE = 'kr_session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PUBLIC_PATHS = new Set(['/login', '/login.html', '/favicon.svg']);

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    try {
      cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {}
  }
  return cookies;
}

function safeEqual(a, b) {
  const hash = (value) => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
}

function safeNext(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

// Один общий пароль на весь сайт. Сессия — подписанная паролем кука:
// смена SITE_PASSWORD разлогинивает всех.
export function createAuth(password) {
  const token = crypto.createHmac('sha256', password).update('kinoroom-session-v1').digest('base64url');
  const isAuthed = (cookieHeader) => safeEqual(parseCookies(cookieHeader)[COOKIE] ?? '', token);
  const attempts = new Map();

  function guard(req, res, next) {
    if (isAuthed(req.headers.cookie) || PUBLIC_PATHS.has(req.path) || req.path.startsWith('/css/')) return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/media/')) return res.status(401).json({ error: 'Нужно войти' });
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }

  function login(req, res) {
    const now = Date.now();
    const record = attempts.get(req.ip);
    const recent = record && now - record.since < 10 * 60 * 1000 ? record : { since: now, count: 0 };
    const next = safeNext(req.body?.next);
    if (recent.count >= 10) return res.redirect(303, `/login?error=limit&next=${encodeURIComponent(next)}`);

    if (!safeEqual(req.body?.password ?? '', password)) {
      recent.count += 1;
      if (attempts.size > 1000) attempts.clear();
      attempts.set(req.ip, recent);
      return res.redirect(303, `/login?error=1&next=${encodeURIComponent(next)}`);
    }
    attempts.delete(req.ip);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: MAX_AGE_MS, path: '/' });
    res.redirect(303, next);
  }

  function socketGuard(socket, next) {
    if (isAuthed(socket.handshake.headers.cookie)) next();
    else next(new Error('unauthorized'));
  }

  return { guard, login, socketGuard };
}
