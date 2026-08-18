/**
 * Registro e relay de salas.
 *
 * Salas são criadas explicitamente por alguém e vivem em memória. Cada uma
 * pertence a uma instância da Activity (o canal de voz), então canais
 * diferentes não enxergam as salas uns dos outros.
 *
 * Vários transmissores simultâneos por sala; N espectadores. Cada transmissor
 * recebe um "slot" numérico e carimba esse número no primeiro byte de todo
 * quadro, então o servidor repassa o buffer sem tocar nele e o espectador sabe
 * para qual decoder mandar.
 *
 * O servidor não decodifica nada. Ele guarda o decoderConfig de cada
 * transmissor e distingue keyframe de delta, porque quem começa a assistir
 * precisa de um keyframe: delta em decoder frio só dá erro.
 */
import crypto from 'node:crypto';

const MAX_BROADCASTERS = 4;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const MAX_NAME = 32;
const MAX_ROOM_NAME = 40;

// Sala vazia fecha, mas não no mesmo instante: recarregar a atividade
// desconecta e reconecta, e quem estivesse sozinho perderia a sala a cada F5.
// 12s cobre um reload com folga e some rápido o bastante para não deixar sala
// fantasma na lista.
const EMPTY_GRACE_MS = 12 * 1000;
const SWEEP_EVERY_MS = 4 * 1000;

// Freio de força bruta: sem isso uma senha curta cai em segundos, porque o
// endpoint responde tão rápido quanto a rede permite.
const MAX_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MS = 60 * 1000;
const LOCKOUT_MS = 30 * 1000;

const SLOT_BYTE = 0;
const TYPE_BYTE = 1;
const KEYFRAME = 1;

const rooms = new Map();

// ------------------------------------------------------------------- senha

function hashPassword(password, salt = crypto.randomBytes(16)) {
  return { salt, hash: crypto.scryptSync(password, salt, 32) };
}

function passwordMatches(room, password) {
  if (!room.password) return true;
  const { hash } = hashPassword(password, room.password.salt);
  return crypto.timingSafeEqual(hash, room.password.hash);
}

/** Retorna null se pode tentar, ou os segundos que faltam para liberar. */
function lockoutRemaining(room) {
  if (!room.lockedUntil) return null;
  const left = room.lockedUntil - Date.now();
  if (left <= 0) {
    room.lockedUntil = 0;
    room.attempts = [];
    return null;
  }
  return Math.ceil(left / 1000);
}

/**
 * @returns {{ok:true}|{ok:false, reason:'senha'|'bloqueado', seconds?:number}}
 */
export function checkPassword(room, password) {
  const locked = lockoutRemaining(room);
  if (locked !== null) return { ok: false, reason: 'bloqueado', seconds: locked };

  if (passwordMatches(room, password ?? '')) {
    room.attempts = [];
    return { ok: true };
  }

  const now = Date.now();
  room.attempts = room.attempts.filter((t) => now - t < ATTEMPT_WINDOW_MS);
  room.attempts.push(now);

  if (room.attempts.length >= MAX_ATTEMPTS) {
    room.lockedUntil = now + LOCKOUT_MS;
    return { ok: false, reason: 'bloqueado', seconds: Math.ceil(LOCKOUT_MS / 1000) };
  }
  return { ok: false, reason: 'senha' };
}

/** Só o dono mexe na senha. Passar vazio remove. */
export function setPassword(room, userId, password) {
  if (room.ownerId !== userId) return 'Só quem criou a sala pode mudar a senha.';

  if (!password) {
    room.password = null;
  } else {
    room.password = hashPassword(String(password));
  }
  room.attempts = [];
  room.lockedUntil = 0;
  broadcastState(room);
  return null;
}

// ------------------------------------------------------------------ registro

export function createRoom({ instance, name, ownerId, ownerName, password }) {
  const escolhido = String(name ?? '').replace(/\s+/g, ' ').trim();
  // Nome é opcional: sem ele, um baseado em quem criou.
  const clean = (escolhido || `Sala de ${ownerName}`).slice(0, MAX_ROOM_NAME);

  const id = crypto.randomBytes(6).toString('base64url');

  const room = {
    id,
    instance,
    name: clean,
    ownerId,
    ownerName,
    password: password ? hashPassword(String(password)) : null,
    attempts: [],
    lockedUntil: 0,
    createdAt: Date.now(),
    emptySince: Date.now(),
    broadcasters: new Map(),
    slots: new Map(),
    viewers: new Set(),
    droppedChunks: 0,
  };

  rooms.set(id, room);
  return { room };
}

export const getRoom = (id) => rooms.get(id) ?? null;

/**
 * A sala fixa de uma call: id derivado do canal, criada na primeira entrada.
 *
 * Não tem dono nem senha — quem controla o acesso é a própria call, já que só
 * entra quem o Discord confirmou estar conectado ao canal.
 */
export function ensureCallRoom(instance, channelId) {
  const id = `call-${channelId}`;
  let room = rooms.get(id);
  if (room) {
    // A instância da Activity muda a cada relançamento no mesmo canal; o canal
    // é que é estável. Sem atualizar, a sala sumiria da lista após um relaunch.
    room.instance = instance;
    return room;
  }

  room = {
    id,
    instance,
    name: 'Sala da call',
    isCall: true,
    ownerId: null,
    ownerName: 'a call',
    password: null,
    attempts: [],
    lockedUntil: 0,
    createdAt: Date.now(),
    emptySince: Date.now(),
    broadcasters: new Map(),
    slots: new Map(),
    viewers: new Set(),
    droppedChunks: 0,
  };

  rooms.set(id, room);
  return room;
}

/** Lista pública: nunca vaza hash de senha, só se ela existe. */
export function listRooms(instance) {
  return [...rooms.values()]
    .filter((r) => r.instance === instance)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((r) => ({
      id: r.id,
      name: r.name,
      owner: r.ownerName,
      isCall: Boolean(r.isCall),
      locked: Boolean(r.password),
      people: countPeople(r),
      streams: [...r.broadcasters.values()].filter((e) => e.streaming).length,
    }));
}

function countPeople(room) {
  const ids = new Set();
  for (const v of room.viewers) if (v.__info) ids.add(v.__info.id);
  for (const uid of room.broadcasters.keys()) ids.add(uid);
  return ids.size;
}

/**
 * Fecha salas vazias há tempo demais.
 *
 * A carência existe porque recarregar a atividade desconecta e reconecta: sem
 * ela, quem estivesse sozinho perderia a sala a cada F5.
 */
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const empty = room.viewers.size === 0 && room.broadcasters.size === 0;

    if (!empty) {
      room.emptySince = null;
      continue;
    }
    if (room.emptySince === null) {
      room.emptySince = now;
      continue;
    }
    if (now - room.emptySince > EMPTY_GRACE_MS) {
      rooms.delete(room.id);
      console.log(`[room ${room.id}] fechada por inatividade`);
    }
  }
}, SWEEP_EVERY_MS);
sweeper.unref?.();

// -------------------------------------------------------------------- envio

function send(ws, data) {
  if (!ws || ws.readyState !== ws.OPEN) return false;
  ws.send(data);
  return true;
}

export function sendJson(ws, obj) {
  return send(ws, JSON.stringify(obj));
}

function toViewers(room, obj) {
  const msg = JSON.stringify(obj);
  for (const v of room.viewers) send(v, msg);
}

// -------------------------------------------------------------------- estado

function watchersOf(room, slot) {
  const byId = new Map();
  for (const v of room.viewers) {
    if (v.__watching?.has(slot) && v.__info) byId.set(v.__info.id, v.__info.name);
  }
  return [...byId].map(([id, name]) => ({ id, name }));
}

function roomState(room) {
  // Uma pessoa pode ter a sala aberta em mais de uma aba; agrupamos por id
  // para não aparecer duplicada na lista.
  const byId = new Map();
  for (const v of room.viewers) {
    if (v.__info) byId.set(v.__info.id, v.__info);
  }

  const participants = [...byId.values()].map((info) => ({
    id: info.id,
    name: info.name,
    avatar: info.avatar ?? null,
    broadcasting: room.broadcasters.has(info.id),
  }));

  // Quem transmite pode ter fechado a aba da Activity: continua na lista,
  // senão o vídeo fica sem dono visível.
  for (const [uid, entry] of room.broadcasters) {
    if (byId.has(uid)) continue;
    participants.push({
      id: uid,
      name: entry.info.name,
      avatar: entry.info.avatar ?? null,
      broadcasting: true,
    });
  }

  participants.sort((a, b) => Number(b.broadcasting) - Number(a.broadcasting));

  return {
    type: 'state',
    room: { id: room.id, name: room.name, ownerId: room.ownerId, locked: Boolean(room.password) },
    broadcasting: room.broadcasters.size > 0,
    viewers: room.viewers.size,
    participants,
    streams: [...room.broadcasters.values()]
      .filter((e) => e.streaming)
      .map((e) => ({ slot: e.slot, userId: e.info.id, watchers: watchersOf(room, e.slot) })),
  };
}

export function broadcastState(room) {
  const msg = JSON.stringify(roomState(room));
  for (const v of room.viewers) send(v, msg);
  for (const e of room.broadcasters.values()) send(e.ws, msg);
}

function requestKeyframe(entry) {
  sendJson(entry.ws, { type: 'need-keyframe' });
}

export function rename(room, ws, raw) {
  if (!ws.__info || typeof raw !== 'string') return;

  const name = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  if (!name) return;

  ws.__info.name = name;
  const entry = room.broadcasters.get(ws.__info.id);
  if (entry) entry.info.name = name;
  broadcastState(room);
}

// ---------------------------------------------------------------- transmissor

function freeSlot(room) {
  for (let i = 0; i < MAX_BROADCASTERS; i++) {
    if (!room.slots.has(i)) return i;
  }
  return null;
}

/** Retorna a entry criada, ou uma string com o motivo da recusa. */
export function attachBroadcaster(room, ws, info) {
  if (room.broadcasters.has(info.id)) return 'Você já está transmitindo nesta sala.';
  if (room.broadcasters.size >= MAX_BROADCASTERS) {
    return `Limite de ${MAX_BROADCASTERS} transmissões simultâneas atingido.`;
  }

  const slot = freeSlot(room);
  if (slot === null) return 'Sem espaço para mais transmissões.';

  const entry = { ws, info, slot, streaming: false, config: null };
  room.broadcasters.set(info.id, entry);
  room.slots.set(slot, entry);
  ws.__entry = entry;
  room.emptySince = null;

  sendJson(ws, { type: 'slot', slot });
  broadcastState(room);
  return entry;
}

export function startStream(room, entry) {
  entry.streaming = true;
  entry.config = null;
  // Transmissão nova recomeça do zero: ninguém assiste até pedir.
  for (const v of room.viewers) {
    v.__primed?.delete(entry.slot);
    v.__watching?.delete(entry.slot);
  }
  toViewers(room, { type: 'stream-start', slot: entry.slot, userId: entry.info.id });
  broadcastState(room);
}

export function setConfig(room, entry, config) {
  entry.config = config;
  // Config nova significa decoder recriado; ele volta a precisar de keyframe.
  for (const v of room.viewers) v.__primed?.delete(entry.slot);
  for (const v of room.viewers) {
    if (v.__watching?.has(entry.slot)) sendJson(v, { type: 'config', slot: entry.slot, config });
  }
}

export function pushChunk(room, entry, chunk) {
  // O transmissor carimba o próprio slot; conferimos para um cliente adulterado
  // não conseguir injetar quadros no stream de outra pessoa.
  if (chunk[SLOT_BYTE] !== entry.slot) return;

  const isKeyframe = chunk[TYPE_BYTE] === KEYFRAME;

  for (const v of room.viewers) {
    if (v.readyState !== v.OPEN) continue;

    // Assistir é opt-in: quem não pediu esta tela não recebe os bytes dela.
    if (!v.__watching.has(entry.slot)) continue;

    if (isKeyframe) {
      if (v.bufferedAmount > MAX_BUFFERED_BYTES * 2) {
        room.droppedChunks++;
        continue;
      }
      v.send(chunk);
      v.__primed.add(entry.slot);
      continue;
    }

    if (!v.__primed.has(entry.slot)) continue;

    if (v.bufferedAmount > MAX_BUFFERED_BYTES) {
      room.droppedChunks++;
      continue;
    }
    v.send(chunk);
  }
}

export function stopStream(room, entry) {
  if (!entry.streaming) return;
  entry.streaming = false;
  entry.config = null;
  for (const v of room.viewers) {
    v.__primed?.delete(entry.slot);
    v.__watching?.delete(entry.slot);
  }
  toViewers(room, { type: 'stream-stop', slot: entry.slot });
}

export function detachBroadcaster(room, ws) {
  const entry = ws.__entry;
  if (!entry || room.broadcasters.get(entry.info.id) !== entry) return;

  stopStream(room, entry);
  room.broadcasters.delete(entry.info.id);
  room.slots.delete(entry.slot);
  broadcastState(room);
}

export function broadcasterOf(room, userId) {
  return room.broadcasters.get(userId) ?? null;
}

// --------------------------------------------------------------- espectador

export function watch(room, ws, slot) {
  const entry = room.slots.get(slot);
  if (!entry || !entry.streaming) return;

  ws.__watching.add(slot);
  ws.__primed.delete(slot);

  if (entry.config) sendJson(ws, { type: 'config', slot, config: entry.config });
  requestKeyframe(entry);
  broadcastState(room);
}

export function unwatch(room, ws, slot) {
  ws.__watching.delete(slot);
  ws.__primed.delete(slot);
  broadcastState(room);
}

export function attachViewer(room, ws, info) {
  ws.__primed = new Set();
  ws.__watching = new Set();
  ws.__info = info;
  room.viewers.add(ws);
  room.emptySince = null;

  sendJson(ws, roomState(room));

  // Anuncia o que está no ar, sem começar a mandar quadros: assistir é opt-in.
  for (const entry of room.broadcasters.values()) {
    if (!entry.streaming) continue;
    sendJson(ws, { type: 'stream-start', slot: entry.slot, userId: entry.info.id });
  }

  broadcastState(room);
}

export function detachViewer(room, ws) {
  room.viewers.delete(ws);
  broadcastState(room);
}

export function stats() {
  return [...rooms.values()].map((r) => ({
    id: r.id,
    name: r.name,
    locked: Boolean(r.password),
    broadcasting: r.broadcasters.size,
    viewers: r.viewers.size,
    droppedChunks: r.droppedChunks,
  }));
}
