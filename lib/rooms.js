import crypto from 'node:crypto';

const ROOM_ID = /^[A-Z0-9]{4,12}$/;
const COLORS = ['#ff7a59', '#f5b942', '#3ecf8e', '#4ab3ff', '#b18cff', '#ff7eb6', '#5ee0d6', '#c3e35b'];
const REACTIONS = new Set(['😂', '😮', '😍', '👍', '🔥', '😢', '👏', '💀']);
const SOURCES = new Set(['youtube', 'archive', 'link', 'library', 'tmdb', 'gdrive', 'netflix']);
const EXTERNAL_COUNTDOWN_MS = 3_000; // фильм в чужом сервисе запускают по общему отсчёту
const LIMITS = { name: 24, roomName: 60, password: 100, chat: 500, title: 200, queue: 200, history: 100, members: 50, rooms: 500 };
const PASSWORD_FAILS = { max: 10, windowMs: 10 * 60 * 1000 };
const LEAVE_GRACE_MS = 8_000; // перезагрузка страницы не должна спамить «вышел/зашёл»
const UNLOAD_EMPTY_ROOM_MS = 60 * 60 * 1000; // из памяти; на диске комната живёт ROOM_TTL_DAYS
const PLAYING_SAVE_INTERVAL_MS = 30_000; // при внезапном отключении питания теряется не больше этого
const MAX_POSITION = 7 * 24 * 60 * 60;

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max);
}

function safeUrl(value, { allowLibrary = false } = {}) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  if (allowLibrary && value.startsWith('/media/')) return value;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function sanitizeMedia(input, libraryEnabled) {
  if (!input || typeof input !== 'object') return null;
  const title = cleanText(input.title, LIMITS.title) || 'Без названия';
  const source = SOURCES.has(input.source) ? input.source : 'link';
  const duration = Number.isFinite(input.duration) && input.duration > 0 ? input.duration : null;

  if (input.kind === 'youtube') {
    if (typeof input.id !== 'string' || !/^[\w-]{11}$/.test(input.id)) return null;
    const thumb = safeUrl(input.thumb) ?? `https://i.ytimg.com/vi/${input.id}/mqdefault.jpg`;
    return { kind: 'youtube', id: input.id, title, thumb, source, duration };
  }
  if (input.kind === 'file') {
    const url = safeUrl(input.url, { allowLibrary: libraryEnabled });
    if (!url) return null;
    // Версии разного качества одного видео: каждый зритель выбирает свою, таймлайн у всех общий
    const variants = (Array.isArray(input.variants) ? input.variants.slice(0, 8) : [])
      .map((variant) => ({
        url: safeUrl(variant?.url, { allowLibrary: libraryEnabled }),
        height: Number.isInteger(variant?.height) && variant.height > 0 && variant.height < 10_000 ? variant.height : null,
      }))
      .filter((variant) => variant.url && variant.height)
      .map((variant) => ({ ...variant, label: `${variant.height}p` }));
    return { kind: 'file', url, title, thumb: safeUrl(input.thumb), source, duration, ...(variants.length > 1 ? { variants } : {}) };
  }
  if (input.kind === 'external') {
    // Фильм в стороннем сервисе: видео каждый смотрит со своего аккаунта, KinoRoom синхронизирует только время
    if (input.service !== 'netflix') return null;
    const ref = typeof input.ref === 'string' && /^\d{5,12}$/.test(input.ref) ? input.ref : null;
    const url = ref ? `https://www.netflix.com/watch/${ref}` : safeUrl(input.url);
    if (!url?.startsWith('https://www.netflix.com/')) return null;
    return { kind: 'external', service: 'netflix', ref, url, title, thumb: safeUrl(input.thumb), source: 'netflix', duration };
  }
  return null;
}

function readPosition(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= MAX_POSITION ? n : null;
}

function formatTime(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function currentPosition(room, at = Date.now()) {
  const { playing, position, updatedAt } = room.playback;
  return playing ? position + (at - updatedAt) / 1000 : position;
}

function rateLimiter() {
  const hits = new Map();
  return (key, max, windowMs) => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    const allowed = recent.length < max;
    if (allowed) recent.push(now);
    hits.set(key, recent);
    return allowed;
  };
}

// --- Доступ к комнате: пароль, приглашение, владелец ----------------------
// Пароль хранится как scrypt-хэш с солью. Приглашение — случайный токен в ссылке: кто пришёл
// по ней, входит без пароля. Ключ владельца получает первый вошедший, храним только его хэш.

const randomToken = (bytes = 12) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

function sameSecret(given, expected) {
  if (typeof given !== 'string' || !given || typeof expected !== 'string' || !expected) return false;
  return crypto.timingSafeEqual(Buffer.from(sha256(given), 'hex'), Buffer.from(sha256(expected), 'hex'));
}

function scrypt(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 32, (err, key) => (err ? reject(err) : resolve(key.toString('hex'))));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: await scrypt(password, salt) };
}

async function checkPassword(password, pass) {
  if (typeof password !== 'string' || !password) return false;
  const hash = await scrypt(password.slice(0, LIMITS.password), pass.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(pass.hash, 'hex'));
}

// За Tailscale Funnel и другими прокси на этой же машине настоящий адрес — в X-Forwarded-For
function clientIp(socket) {
  const direct = socket.handshake.address ?? '';
  const viaLocalProxy = /^(::1|127\.|::ffff:127\.)/.test(direct);
  const forwarded = socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim();
  return viaLocalProxy && forwarded ? forwarded : direct;
}

const roomMeta = (room) => ({ name: room.name, locked: Boolean(room.pass), listed: room.listed, invite: room.invite });

const isSpeaking = (member, room) => [...member.sockets].some((socketId) => room.speakers.has(socketId));
const publicMember = (member, room) => ({
  id: member.id,
  name: member.name,
  color: member.color,
  mic: isSpeaking(member, room),
  ready: room.ready.has(member.id), // «Я готов» — открыл фильм в своём сервисе
});

// Сигнальные сообщения WebRTC пересылаются как есть, поэтому проверяем форму и размер.
function readSignal(data) {
  if (!data || typeof data !== 'object' || !['out', 'in'].includes(data.pc)) return null;
  const { description, candidate } = data;
  if (description) {
    if (!['offer', 'answer'].includes(description.type) || typeof description.sdp !== 'string' || description.sdp.length > 20_000) return null;
    return { pc: data.pc, description: { type: description.type, sdp: description.sdp } };
  }
  if (candidate && typeof candidate === 'object' && typeof candidate.candidate === 'string' && candidate.candidate.length < 1000) {
    const { sdpMid = null, sdpMLineIndex = null, usernameFragment = null } = candidate;
    return { pc: data.pc, candidate: { candidate: candidate.candidate, sdpMid, sdpMLineIndex, usernameFragment } };
  }
  return null;
}

/**
 * Состояние воспроизведения хранится на сервере как «позиция в момент времени»:
 * { playing, position, updatedAt }. Клиенты сами досчитывают текущую позицию
 * по своим часам, скорректированным по серверу, поэтому сервер не шлёт тики.
 */
export function attachRooms(io, { libraryEnabled, store = null }) {
  const rooms = new Map();
  const saveTimers = new Map();

  // --- Сохранение на диск -------------------------------------------------
  // Сохраняется то, что нужно, чтобы вернуться завтра: видео, позиция, очередь и чат.
  // Участники и голос — нет: после перерыва все всё равно подключаются заново.

  function writeRoom(room) {
    clearTimeout(saveTimers.get(room.id));
    saveTimers.delete(room.id);
    try {
      store.save(room.id, {
        version: 2,
        name: room.name,
        listed: room.listed,
        pass: room.pass,
        invite: room.invite,
        ownerHash: room.ownerHash,
        media: room.media,
        position: currentPosition(room),
        queue: room.queue,
        chat: room.chat,
      });
    } catch (err) {
      console.error(`[rooms] не удалось сохранить комнату ${room.id}: ${err.message}`);
    }
  }

  // Изменения идут пачками (действие + системное сообщение) — пишем один раз через секунду
  function persist(room) {
    if (!store || saveTimers.has(room.id)) return;
    saveTimers.set(room.id, setTimeout(() => writeRoom(room), 1000));
  }

  function restore(room, saved) {
    room.fresh = false;
    if (typeof saved.name === 'string' && saved.name) room.name = saved.name;
    if (typeof saved.listed === 'boolean') room.listed = saved.listed;
    if (saved.pass?.salt && saved.pass?.hash) room.pass = saved.pass;
    if (typeof saved.invite === 'string' && saved.invite) room.invite = saved.invite;
    room.ownerHash = typeof saved.ownerHash === 'string' ? saved.ownerHash : null;
    room.media = saved.media ?? null;
    room.queue = Array.isArray(saved.queue) ? saved.queue.slice(0, LIMITS.queue) : [];
    room.chat = Array.isArray(saved.chat) ? saved.chat.slice(-LIMITS.history) : [];
    // После перерыва комната всегда на паузе: кто вернётся — нажмёт «Смотреть»
    room.playback = { playing: false, position: readPosition(saved.position) ?? 0, updatedAt: Date.now() };
    if (room.media && room.playback.position > 5) {
      system(room, `Остановились на ${formatTime(room.playback.position)} — «${room.media.title}». Нажмите ▶, чтобы продолжить`);
    }
  }

  if (store) {
    const removed = store.prune();
    if (removed) console.log(`[rooms] удалено старых комнат: ${removed}`);
    setInterval(() => store.prune(), 6 * 60 * 60 * 1000).unref();
    setInterval(() => {
      for (const room of rooms.values()) if (room.playback.playing) writeRoom(room);
    }, PLAYING_SAVE_INTERVAL_MS).unref();
  }

  setInterval(() => {
    for (const [id, room] of rooms) {
      if (room.members.size > 0 || Date.now() - room.emptySince < UNLOAD_EMPTY_ROOM_MS) continue;
      if (store) writeRoom(room);
      rooms.delete(id);
    }
  }, 60_000).unref();

  function openRoom(id) {
    if (rooms.size >= LIMITS.rooms) return null;
    const room = {
      id,
      name: `Комната ${id}`,
      listed: true, // сайт и так закрыт общим паролем — по умолчанию комната видна в списке
      pass: null,
      invite: randomToken(),
      ownerHash: null,
      fresh: true, // новая комната: назовём её по имени первого вошедшего
      media: null,
      playback: { playing: false, position: 0, updatedAt: Date.now() },
      queue: [],
      members: new Map(),
      sockets: new Map(), // socket.id → id участника; у участника может быть несколько вкладок
      speakers: new Set(), // socket.id вкладок с включённым микрофоном
      ready: new Set(), // id участников, открывших фильм в своём сервисе
      chat: [],
      emptySince: Date.now(),
    };
    rooms.set(id, room);
    const saved = store?.load(id);
    if (saved) restore(room, saved);
    return room;
  }

  function snapshot(room) {
    return {
      id: room.id,
      media: room.media,
      playback: room.playback,
      queue: room.queue,
      members: [...room.members.values()].map((m) => publicMember(m, room)),
      chat: room.chat,
    };
  }

  function pickColor(room) {
    const used = new Set([...room.members.values()].map((m) => m.color));
    return COLORS.find((c) => !used.has(c)) ?? COLORS[room.members.size % COLORS.length];
  }

  function pushChat(room, message) {
    room.chat.push(message);
    if (room.chat.length > LIMITS.history) room.chat.shift();
    io.to(room.id).emit('chat', message);
    persist(room); // почти каждое действие сопровождается системным сообщением
  }

  function system(room, text) {
    pushChat(room, { id: crypto.randomUUID(), type: 'system', text, ts: Date.now() });
  }

  const emitMembers = (room) => io.to(room.id).emit('members', [...room.members.values()].map((m) => publicMember(m, room)));
  const emitQueue = (room) => {
    io.to(room.id).emit('queue', room.queue);
    persist(room);
  };

  function startMedia(room, media, byName) {
    room.media = { ...media, mid: crypto.randomUUID() };
    // Фильм в чужом сервисе сначала на паузе: каждому нужно открыть его у себя и нажать «Я готов»
    const external = media.kind === 'external';
    room.playback = { playing: !external, position: 0, updatedAt: Date.now() };
    room.ready.clear();
    io.to(room.id).emit('media', { media: room.media, playback: room.playback });
    emitMembers(room);
    system(room, byName ? `${byName} включает «${media.title}»` : `Дальше по очереди: «${media.title}»`);
    if (external) system(room, 'Откройте фильм на Netflix у себя и нажмите «Я готов» — старт по общему отсчёту');
  }

  function playNextOrStop(room) {
    const next = room.queue.shift();
    if (next) {
      emitQueue(room);
      startMedia(room, next, null);
      return;
    }
    room.playback = { playing: false, position: currentPosition(room), updatedAt: Date.now() };
    io.to(room.id).emit('playback', { ...room.playback, action: 'ended' });
    persist(room);
  }

  const passwordFails = new Map(); // ip → { count, since }

  function passwordBlocked(ip) {
    const record = passwordFails.get(ip);
    if (record && Date.now() - record.since > PASSWORD_FAILS.windowMs) passwordFails.delete(ip);
    return (passwordFails.get(ip)?.count ?? 0) >= PASSWORD_FAILS.max;
  }

  function notePasswordFail(ip) {
    const record = passwordFails.get(ip) ?? { count: 0, since: Date.now() };
    record.count += 1;
    if (passwordFails.size > 1000) passwordFails.clear();
    passwordFails.set(ip, record);
  }

  /** null — можно входить, иначе ответ с ошибкой для клиента. */
  async function checkAccess(target, data, isOwner, ip) {
    if (!target.pass || isOwner || sameSecret(data?.invite, target.invite)) return null;
    if (!data?.password) return { error: 'Комната защищена паролем', needPassword: true };
    if (passwordBlocked(ip)) return { error: 'Слишком много неверных попыток — подождите 10 минут', needPassword: true };
    if (await checkPassword(String(data.password), target.pass)) return null;
    notePasswordFail(ip);
    return { error: 'Неверный пароль комнаты', needPassword: true };
  }

  io.on('connection', (socket) => {
    const allow = rateLimiter();
    let room = null;
    let member = null;
    let isOwner = false;
    let joining = false;

    // Обработчик вызывается только после успешного входа в комнату.
    const inRoom = (handler) => (...args) => {
      if (room && member) handler(...args);
    };

    socket.on('time:ping', (ack) => {
      if (typeof ack === 'function') ack(Date.now());
    });

    socket.on('room:join', async (data, ack) => {
      if (typeof ack !== 'function') return;
      if (room || joining) return ack({ error: 'Вы уже в комнате' });

      const id = String(data?.roomId ?? '').toUpperCase();
      if (!ROOM_ID.test(id)) return ack({ error: 'Неверный код комнаты' });
      const name = cleanText(data?.name, LIMITS.name);
      if (!name) return ack({ error: 'Введите имя' });
      const clientId = typeof data?.clientId === 'string' && /^[\w-]{8,64}$/.test(data.clientId) ? data.clientId : crypto.randomUUID();

      const target = rooms.get(id) ?? openRoom(id);
      if (!target) return ack({ error: 'Сервер переполнен, попробуйте позже' });

      const owner = Boolean(target.ownerHash) && typeof data?.ownerKey === 'string' && sameSecret(sha256(data.ownerKey), target.ownerHash);
      joining = true;
      let denied;
      try {
        denied = await checkAccess(target, data, owner, clientIp(socket));
      } finally {
        joining = false;
      }
      if (denied) return ack(denied);
      if (!socket.connected) return;

      // У комнаты нет владельца (новая или сохранённая до появления владельцев) — им становится вошедший
      let ownerKey = null;
      if (!target.ownerHash) {
        ownerKey = randomToken(18);
        target.ownerHash = sha256(ownerKey);
        if (target.fresh) target.name = `Комната ${name}`;
      }
      target.fresh = false;
      isOwner = owner || Boolean(ownerKey);

      let existing = target.members.get(clientId);
      const returning = Boolean(existing);
      if (!existing) {
        if (target.members.size >= LIMITS.members) return ack({ error: 'Комната заполнена' });
        existing = { id: clientId, name, color: pickColor(target), sockets: new Set(), leaveTimer: null };
        target.members.set(clientId, existing);
      }
      clearTimeout(existing.leaveTimer);
      existing.leaveTimer = null;
      existing.sockets.add(socket.id);
      existing.name = name;
      target.sockets.set(socket.id, clientId);
      target.emptySince = null;

      room = target;
      member = existing;
      socket.join(id);
      ack({ ok: true, you: publicMember(member, room), state: snapshot(room), room: { ...roomMeta(room), isOwner, ownerKey } });
      emitMembers(room);
      if (!returning) system(room, `${name} заходит в комнату`);
      if (ownerKey) persist(room);
      // Те, кто уже говорит, сами позвонят новому слушателю.
      for (const speaker of room.speakers) io.to(speaker).emit('voice:listener', { socketId: socket.id });
    });

    socket.on('player:control', inRoom((data) => {
      if (!room.media || !allow('control', 20, 5_000)) return;
      const action = data?.action;
      if (!['play', 'pause', 'seek'].includes(action)) return;
      const position = readPosition(data?.position);
      if (position === null) return;

      // Клиент присылает момент действия по часам сервера — так компенсируется задержка сети.
      const now = Date.now();
      const at = Number(data?.at);
      // У фильма в чужом сервисе «Смотреть» может назначить старт в будущем — это общий отсчёт
      const countdown = room.media.kind === 'external' && action === 'play' && data?.countdown === true;
      const updatedAt = countdown
        ? now + EXTERNAL_COUNTDOWN_MS
        : Number.isFinite(at) && at >= now - 5_000 && at <= now + 1_000 ? Math.min(at, now) : now;
      const playing = action === 'play' ? true : action === 'pause' ? false : room.playback.playing;
      room.playback = { playing, position, updatedAt };
      io.to(room.id).emit('playback', { ...room.playback, action, by: member.id });

      if (action === 'pause') system(room, `${member.name} ставит на паузу · ${formatTime(position)}`);
      else if (countdown) system(room, `${member.name} запускает — старт через ${EXTERNAL_COUNTDOWN_MS / 1000} секунды`);
      else if (action === 'play') system(room, `${member.name} продолжает просмотр`);
      else system(room, `${member.name} перематывает на ${formatTime(position)}`);
    }));

    socket.on('player:ended', inRoom((data) => {
      // Конец видео присылают все клиенты — реагируем только на первое сообщение про текущее видео.
      if (!room.media || data?.mid !== room.media.mid || !room.playback.playing) return;
      playNextOrStop(room);
    }));

    socket.on('media:play', inRoom((data) => {
      if (!allow('media', 10, 10_000)) return;
      const media = sanitizeMedia(data, libraryEnabled);
      if (media) startMedia(room, { ...media, addedBy: member.name }, member.name);
    }));

    socket.on('queue:add', inRoom((data) => {
      if (!allow('queue', 20, 10_000)) return;
      const items = (Array.isArray(data?.items) ? data.items : [data])
        .slice(0, 100)
        .map((item) => sanitizeMedia(item, libraryEnabled))
        .filter(Boolean);
      if (!items.length) return;

      // Если ничего не играет — первое добавленное сразу запускается.
      if (!room.media) startMedia(room, { ...items.shift(), addedBy: member.name }, member.name);
      const free = LIMITS.queue - room.queue.length;
      const added = items.slice(0, Math.max(0, free)).map((item) => ({ ...item, qid: crypto.randomUUID(), addedBy: member.name }));
      if (!added.length) return;
      room.queue.push(...added);
      emitQueue(room);
      system(room, added.length === 1
        ? `${member.name} добавляет в очередь «${added[0].title}»`
        : `${member.name} добавляет в очередь ${added.length} видео`);
    }));

    socket.on('queue:remove', inRoom((data) => {
      if (!allow('queue', 20, 10_000)) return;
      const before = room.queue.length;
      room.queue = room.queue.filter((item) => item.qid !== data?.qid);
      if (room.queue.length !== before) emitQueue(room);
    }));

    socket.on('queue:play', inRoom((data) => {
      if (!allow('media', 10, 10_000)) return;
      const index = room.queue.findIndex((item) => item.qid === data?.qid);
      if (index === -1) return;
      const [item] = room.queue.splice(index, 1);
      emitQueue(room);
      startMedia(room, { ...item, addedBy: member.name }, member.name);
    }));

    socket.on('queue:next', inRoom(() => {
      if (!allow('media', 10, 10_000) || !room.queue.length) return;
      const [item] = room.queue.splice(0, 1);
      emitQueue(room);
      startMedia(room, { ...item, addedBy: member.name }, member.name);
    }));

    socket.on('chat:send', inRoom((data) => {
      const text = cleanText(data?.text, LIMITS.chat);
      if (!text || !allow('chat', 6, 5_000)) return;
      pushChat(room, { id: crypto.randomUUID(), type: 'user', userId: member.id, name: member.name, color: member.color, text, ts: Date.now() });
    }));

    socket.on('reaction', inRoom((data) => {
      if (!REACTIONS.has(data?.emoji) || !allow('reaction', 12, 5_000)) return;
      io.to(room.id).emit('reaction', { emoji: data.emoji, name: member.name, color: member.color });
    }));

    socket.on('external:ready', inRoom((data) => {
      if (room.media?.kind !== 'external' || !allow('ready', 10, 10_000)) return;
      const ready = data?.ready === true;
      if (ready === room.ready.has(member.id)) return;
      if (ready) room.ready.add(member.id);
      else room.ready.delete(member.id);
      emitMembers(room);
    }));

    socket.on('room:settings', inRoom(async (data, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (!isOwner) return reply({ error: 'Настройки меняет только создатель комнаты' });
      if (!allow('settings', 10, 60_000)) return reply({ error: 'Слишком часто — подождите минуту' });

      const changes = [];
      const name = typeof data?.name === 'string' ? cleanText(data.name, LIMITS.roomName) : '';
      if (name && name !== room.name) {
        room.name = name;
        changes.push(`переименовывает комнату в «${name}»`);
      }
      if (typeof data?.listed === 'boolean' && data.listed !== room.listed) {
        room.listed = data.listed;
        changes.push(data.listed ? 'показывает комнату в общем списке' : 'скрывает комнату из общего списка');
      }
      if (data?.removePassword === true && room.pass) {
        room.pass = null;
        changes.push('снимает пароль с комнаты');
      } else if (typeof data?.password === 'string' && data.password) {
        room.pass = await hashPassword(data.password.slice(0, LIMITS.password));
        changes.push('ставит пароль на комнату 🔒');
      }
      if (data?.rotateInvite === true) {
        room.invite = randomToken();
        changes.push('делает новую ссылку-приглашение — старые больше не работают');
      }
      if (!changes.length) return reply({ ok: true });

      io.to(room.id).emit('room:meta', roomMeta(room));
      for (const change of changes) system(room, `${member.name} ${change}`);
      persist(room);
      reply({ ok: true });
    }));

    // --- Голосовой чат ------------------------------------------------------
    // Звук идёт напрямую между браузерами (WebRTC). Сервер только знает, кто говорит,
    // и пересылает сигнальные сообщения, поэтому малинку голос почти не нагружает.

    function stopSpeaking() {
      if (!room.speakers.delete(socket.id)) return false;
      socket.to(room.id).emit('voice:stopped', { socketId: socket.id });
      return true;
    }

    socket.on('voice:start', inRoom((ack) => {
      if (typeof ack !== 'function') return;
      if (!allow('voice', 10, 30_000)) return ack({ error: 'Слишком часто — подождите немного' });
      const wasSpeaking = isSpeaking(member, room);
      room.speakers.add(socket.id);
      ack({ ok: true, listeners: [...room.sockets.keys()].filter((id) => id !== socket.id) });
      emitMembers(room);
      if (!wasSpeaking) system(room, `${member.name} включает микрофон`);
    }));

    socket.on('voice:stop', inRoom(() => {
      if (!stopSpeaking()) return;
      emitMembers(room);
      if (!isSpeaking(member, room)) system(room, `${member.name} выключает микрофон`);
    }));

    socket.on('voice:signal', inRoom((data) => {
      const to = data?.to;
      if (typeof to !== 'string' || to === socket.id || !room.sockets.has(to) || !allow('signal', 300, 10_000)) return;
      const signal = readSignal(data);
      if (signal) io.to(to).emit('voice:signal', { ...signal, from: socket.id, memberId: member.id });
    }));

    socket.on('disconnect', () => {
      if (!room || !member) return;
      const r = room;
      const m = member;
      r.sockets.delete(socket.id);
      if (r.sockets.size === 0) r.lastLeftAt = Date.now();
      socket.to(r.id).emit('voice:peer-left', { socketId: socket.id });
      if (stopSpeaking()) emitMembers(r);
      m.sockets.delete(socket.id);
      if (m.sockets.size > 0) return;
      m.leaveTimer = setTimeout(() => {
        if (m.sockets.size > 0) return;
        r.members.delete(m.id);
        r.ready.delete(m.id);
        emitMembers(r);
        system(r, `${m.name} выходит из комнаты`);
        if (r.members.size === 0) {
          r.emptySince = Date.now();
          // Никого не осталось — пауза там, где ушёл последний, а не спустя LEAVE_GRACE_MS
          if (r.playback.playing) {
            r.playback = { playing: false, position: currentPosition(r, r.lastLeftAt), updatedAt: Date.now() };
          }
        }
      }, LEAVE_GRACE_MS);
    });
  });

  return {
    /** Сохранить все комнаты прямо сейчас — при остановке сервера, чтобы не потерять позицию. */
    saveAll() {
      if (store) for (const room of rooms.values()) writeRoom(room);
    },

    /**
     * Общий список комнат: открытые в памяти и сохранённые на диске. Показываем только те,
     * что не скрыты владельцем и где что-то есть — людей или видео. Пароли и приглашения не отдаём.
     */
    list(query = '') {
      const q = String(query ?? '').trim().toLowerCase().slice(0, LIMITS.roomName);
      const entries = new Map();
      for (const { id, data, savedAt } of store?.all() ?? []) {
        entries.set(id, {
          id,
          name: data.name || `Комната ${id}`,
          listed: data.listed ?? true,
          locked: Boolean(data.pass),
          members: 0,
          playing: data.media?.title ?? null,
          position: readPosition(data.position) ?? 0,
          hasContent: Boolean(data.media || data.queue?.length),
          updatedAt: savedAt,
        });
      }
      for (const room of rooms.values()) {
        entries.set(room.id, {
          id: room.id,
          name: room.name,
          listed: room.listed,
          locked: Boolean(room.pass),
          members: room.members.size,
          playing: room.media?.title ?? null,
          position: currentPosition(room),
          hasContent: Boolean(room.media || room.queue.length),
          updatedAt: room.members.size ? Date.now() : room.emptySince ?? Date.now(),
        });
      }
      return [...entries.values()]
        .filter((r) => r.listed && (r.members > 0 || r.hasContent))
        .filter((r) => !q || r.name.toLowerCase().includes(q) || r.playing?.toLowerCase().includes(q) || r.id.toLowerCase() === q)
        .sort((a, b) => b.members - a.members || b.updatedAt - a.updatedAt)
        .slice(0, 50)
        .map(({ listed, hasContent, ...room }) => room);
    },
  };
}
