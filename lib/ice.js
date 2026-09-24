import { config } from './config.js';

const STUN = { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] };
const CF_TTL_S = 24 * 60 * 60;

let cloudflare = null; // { servers, expires }

// Cloudflare выдаёт временные логин/пароль к своему TURN по долгоживущему ключу.
async function cloudflareServers() {
  if (cloudflare && cloudflare.expires > Date.now()) return cloudflare.servers;
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(config.cfTurnKeyId)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.cfTurnToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ttl: CF_TTL_S }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`Cloudflare TURN: HTTP ${res.status}`);
  const { iceServers } = await res.json();
  // Порт 53 браузеры блокируют — такие адреса только замедляют подключение.
  const servers = (iceServers ?? [])
    .map((server) => ({ ...server, urls: [server.urls].flat().filter((url) => !/:53(\?|$)/.test(url)) }))
    .filter((server) => server.urls.length);
  cloudflare = { servers, expires: Date.now() + (CF_TTL_S / 2) * 1000 };
  return servers;
}

/** Список STUN/TURN-серверов для RTCPeerConnection. Без TURN голос работает не во всех сетях. */
export async function getIceServers() {
  if (config.cfTurnKeyId && config.cfTurnToken) {
    try {
      return await cloudflareServers();
    } catch (err) {
      console.warn('[ice]', err.message, '— голос будет работать только через STUN');
    }
  }
  if (config.turnUrls.length) {
    return [STUN, { urls: config.turnUrls, username: config.turnUsername, credential: config.turnCredential }];
  }
  return [STUN];
}

export const hasTurn = () => Boolean((config.cfTurnKeyId && config.cfTurnToken) || config.turnUrls.length);
