import { DiscordSDK } from '@discord/embedded-app-sdk';
import { createPlayer } from './player.js';
import { createBroadcaster } from '../../shared/broadcaster.js';

const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
// O Discord injeta frame_id/instance_id na URL do iframe. Sem eles, estamos
// rodando direto no navegador — modo de desenvolvimento.
const inDiscord = params.has('frame_id');

// Dentro da Activity todo tráfego precisa passar pelo proxy do Discord.
const P = inDiscord ? '/.proxy' : '';

// Um decoder e um canvas por transmissor, indexados pelo slot que o servidor
// atribuiu. Os canvas vivem fora do DOM entre renderizações e são movidos para
// dentro do tile de cada pessoa — detachar não apaga o conteúdo nem invalida o
// contexto 2D, então os decoders seguem desenhando sem saber de nada.
const streams = new Map(); // slot -> { userId, canvas, player }

// Transmissões anunciadas pelo servidor, assistidas ou não. Assistir é opt-in:
// sem pedir, o servidor nem envia os quadros — a economia de banda depende
// disso, filtrar só na exibição gastaria a mesma saída.
const available = new Map(); // slot -> { userId, config }
const watching = new Set(); // slots que eu pedi para assistir

let sdk = null;
let session = null;
let ws = null;
let participants = [];
let reconnectDelay = 1000;
let lagTimer = null;
// Transmissão nascida aqui dentro, quando o Discord permite capturar no iframe.
let myBroadcast = null;
// Slot ampliado. Guardado fora do render porque a grade é reconstruída a cada
// mudança de estado e o foco precisa sobreviver a isso.
let focusedSlot = null;

// ------------------------------------------------------------------- helpers

let toastTimer = null;
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 6000);
}

function setEmpty(title, text) {
  $('emptyTitle').textContent = title;
  $('emptyText').textContent = text;
}

/** Cor estável por usuário — mesma pessoa, mesma cor, em qualquer sessão. */
function colorFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360} 45% 42%)`;
}

/**
 * Avatares vêm do CDN do Discord, que o CSP da Activity bloqueia a menos que
 * exista um mapeamento /cdn → cdn.discordapp.com. Se não houver, o onerror
 * troca pelas iniciais — funciona dos dois jeitos, sem configuração extra.
 */
function avatarUrl(p) {
  if (!p.avatar) return null;
  const path = `/avatars/${p.id}/${p.avatar}.png?size=128`;
  return inDiscord ? `${P}/cdn${path}` : `https://cdn.discordapp.com${path}`;
}

function initials(name) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => [...w][0] ?? '')
    .join('')
    .toUpperCase();
}

const slotOf = (userId) =>
  [...available.entries()].find(([, a]) => a.userId === userId)?.[0] ?? null;

function watchSlot(slot) {
  const info = available.get(slot);
  if (!info) return;
  watching.add(slot);
  ws?.send(JSON.stringify({ type: 'watch', slot }));
  // O config pode já ter chegado; se não, ele chega logo e dispara o start.
  if (info.config) {
    openStream(slot, info.userId);
    startStream(slot, info.config);
  }
  renderGrid();
}

function unwatchSlot(slot) {
  watching.delete(slot);
  ws?.send(JSON.stringify({ type: 'unwatch', slot }));
  closeStream(slot);
  renderGrid();
  renderBar();
}

// --------------------------------------------------------------------- grade

/** Colunas aproximando o layout da call do Discord: quadrado, crescendo em passos. */
function columnsFor(n) {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

function renderGrid() {
  const grid = $('grid');

  // Fora de uma sala quem manda é o lobby. Sem esta guarda, o render disparado
  // pelo fechamento do WebSocket mostrava o painel "Ninguém na sala" por cima
  // da lista de salas.
  if (!inRoom()) {
    grid.hidden = true;
    $('empty').hidden = true;
    return;
  }

  const hasPeople = participants.length > 0;
  $('empty').hidden = hasPeople;
  grid.hidden = !hasPeople;
  if (!hasPeople) return;

  // Só faz sentido manter o foco enquanto aquele stream existe.
  if (focusedSlot !== null && !streams.has(focusedSlot)) focusedSlot = null;

  grid.classList.toggle('focused', focusedSlot !== null);
  grid.style.setProperty('--cols', columnsFor(participants.length));
  // Os canvas são reanexados abaixo; removê-los daqui não perde o conteúdo.
  grid.replaceChildren();

  for (const p of participants) {
    const slot = p.broadcasting ? slotOf(p.id) : null;
    const stream = slot !== null ? streams.get(slot) : null;

    const tile = document.createElement('div');
    tile.className = p.broadcasting ? 'tile sharing' : 'tile';
    if (slot !== null && slot === focusedSlot) tile.classList.add('focus');

    if (stream) {
      tile.append(stream.canvas);
      tile.title = focusedSlot === slot ? 'Clique para voltar à grade' : 'Clique para ampliar';
      tile.addEventListener('click', () => {
        focusedSlot = focusedSlot === slot ? null : slot;
        $('fullscreen').classList.toggle('on', focusedSlot !== null);
        renderGrid();
      });
      // Botão direito para largar a tela, sem precisar caçar controle.
      tile.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        openTileMenu(e.clientX, e.clientY, slot, p.name);
      });

      // O clique direito pode ser capturado pelo cliente do Discord antes de
      // chegar aqui, então o botão visível é o caminho garantido.
      const stop = document.createElement('button');
      stop.className = 'tile-stop';
      stop.title = 'Parar de assistir';
      stop.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      stop.addEventListener('click', (e) => {
        e.stopPropagation();
        unwatchSlot(slot);
      });
      tile.append(stop);
    } else if (slot !== null) {
      tile.append(buildWatchPrompt(slot, p.name));
    } else {
      tile.append(buildAvatar(p));
    }

    const footer = document.createElement('div');
    footer.className = 'tile-footer';

    const badge = document.createElement('div');
    badge.className = 'tile-name';
    if (p.broadcasting) {
      const dot = document.createElement('span');
      dot.className = 'dot';
      badge.append(dot);
    }
    // textContent, nunca innerHTML: nome vem do Discord, é conteúdo de terceiro.
    badge.append(document.createTextNode(p.name));
    footer.append(badge);

    if (slot !== null) footer.append(buildWatchers(slot));
    tile.append(footer);

    if (p.id === session?.user?.id) {
      const you = document.createElement('span');
      you.className = 'tile-you';
      you.textContent = 'você';
      tile.append(you);
    }

    grid.append(tile);
  }
}

/** Quantas pessoas assistem esta tela; a lista aparece ao passar o mouse. */
function buildWatchers(slot) {
  const people = available.get(slot)?.watchers ?? [];

  const badge = document.createElement('div');
  badge.className = 'tile-watchers';
  badge.innerHTML =
    '<svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>' +
    '<circle cx="12" cy="7" r="4"/></svg>';
  badge.append(document.createTextNode(String(people.length)));

  const list = document.createElement('div');
  list.className = 'watchers-list';

  if (!people.length) {
    const empty = document.createElement('span');
    empty.className = 'watchers-empty';
    empty.textContent = 'Ninguém assistindo';
    list.append(empty);
  } else {
    for (const w of people) {
      const row = document.createElement('span');
      row.textContent = w.name;
      list.append(row);
    }
  }

  badge.append(list);
  return badge;
}

/** Tela cinza com o convite para assistir — nada é baixado até clicar. */
function buildWatchPrompt(slot, name) {
  const wrap = document.createElement('div');
  wrap.className = 'watch-prompt';

  const btn = document.createElement('button');
  btn.className = 'btn go';
  btn.innerHTML =
    '<svg viewBox="0 0 24 24"><path d="M3 5h18v11H3z"/><path d="M8 20h8"/></svg>';
  btn.append(document.createTextNode('Assistir tela'));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    watchSlot(slot);
  });

  const who = document.createElement('span');
  who.className = 'watch-who';
  who.textContent = `${name} está transmitindo`;

  wrap.append(btn, who);
  return wrap;
}

// -------------------------------------------------------------------- perfil

function renderProfileButton() {
  if (!session) return;
  const me = participants.find((p) => p.id === session.user.id) ?? session.user;

  $('profile').replaceChildren(buildAvatar({ ...me, id: session.user.id }));

  // Mesma identidade, duas superfícies: bolinha no dock dentro da sala,
  // bolinha com nome no cabeçalho do lobby.
  const name = document.createElement('span');
  name.textContent = me.name;
  $('lobbyUser').replaceChildren(buildAvatar({ ...me, id: session.user.id }), name);
  $('lobbyUser').hidden = false;
}

$('lobbyUser').addEventListener('click', openProfile);
$('profile').addEventListener('click', openProfile);

function openProfile() {
  if (!session) return;
  const me = participants.find((p) => p.id === session.user.id) ?? session.user;

  $('profileAvatar').replaceChildren(buildAvatar({ ...me, id: session.user.id }));
  $('profileName').textContent = me.name;
  $('profileId').textContent = inDiscord ? `Discord · ${session.user.id}` : 'modo local';
  $('profileInput').value = me.name;

  $('profileModal').hidden = false;
  wakeHud();
  $('profileInput').focus();
  $('profileInput').select();
}

const closeProfile = () => {
  $('profileModal').hidden = true;
};

$('profileCancel').addEventListener('click', closeProfile);

$('profileModal').addEventListener('click', (e) => {
  if (e.target === $('profileModal')) closeProfile();
});

$('profileInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('profileSave').click();
});

$('profileSave').addEventListener('click', () => {
  const name = $('profileInput').value.replace(/\s+/g, ' ').trim().slice(0, 32);
  if (name) {
    session.user.name = name;
    storeName(name);
    ws?.send(JSON.stringify({ type: 'rename', name }));
    renderProfileButton();
  }
  closeProfile();
});

/**
 * O apelido vive no localStorage, não no servidor.
 *
 * Os acessos vão em try/catch porque dentro de um iframe de terceiro o
 * armazenamento pode estar particionado ou bloqueado — e perder o apelido é
 * bem melhor do que a sala não abrir.
 */
const storedName = () => read('displayName');
const storeName = (name) => store('displayName', name);

/** Menu de contexto do tile. Some ao primeiro clique ou tecla em qualquer lugar. */
function openTileMenu(x, y, slot, name) {
  document.querySelector('.tile-menu')?.remove();

  const menu = document.createElement('div');
  menu.className = 'tile-menu';
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  const item = document.createElement('button');
  item.textContent = `Parar de assistir ${name}`;
  item.addEventListener('click', () => {
    menu.remove();
    unwatchSlot(slot);
  });

  menu.append(item);
  document.body.append(menu);

  // Mantém o menu dentro da janela quando o clique acontece perto das bordas.
  const box = menu.getBoundingClientRect();
  if (x + box.width > window.innerWidth) menu.style.left = `${window.innerWidth - box.width - 8}px`;
  if (y + box.height > window.innerHeight)
    menu.style.top = `${window.innerHeight - box.height - 8}px`;

  // setTimeout: sem ele, o próprio clique que abriu o menu já o fecharia.
  setTimeout(() => {
    const close = (e) => {
      // pointerdown dispara ANTES do click. Sem esta guarda, clicar no item
      // removia o menu do DOM e o click nunca chegava ao botão — era por isso
      // que "parar de assistir" não fazia nada.
      if (e.type === 'pointerdown' && menu.contains(e.target)) return;
      menu.remove();
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', close);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
  }, 0);
}

function buildAvatar(p) {
  const url = avatarUrl(p);

  const fallback = () => {
    const div = document.createElement('div');
    div.className = 'avatar';
    div.style.background = colorFor(p.id);
    div.textContent = initials(p.name);
    return div;
  };

  if (!url) return fallback();

  const img = document.createElement('img');
  img.className = 'avatar';
  img.src = url;
  img.alt = p.name;
  img.addEventListener('error', () => img.replaceWith(fallback()), { once: true });
  return img;
}

function renderBar() {
  $('people').replaceChildren();
  $('people').insertAdjacentHTML(
    'afterbegin',
    '<svg viewBox="0 0 24 24"><path d="M17 20v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>' +
      '<circle cx="9" cy="7" r="4"/><path d="M23 20v-2a4 4 0 0 0-3-3.87"/>' +
      '<path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>'
  );
  $('people').append(document.createTextNode(String(participants.length)));

  const casters = participants.filter((p) => p.broadcasting);
  // myBroadcast entra no OU porque o `state` leva um instante para chegar, e
  // sem isso o botão pisca de volta para "Compartilhar" logo após começar.
  const iAmCasting = Boolean(myBroadcast) || casters.some((p) => p.id === session?.user?.id);

  const btn = $('share');
  btn.classList.toggle('go', !iAmCasting);
  btn.classList.toggle('live', iAmCasting);
  btn.disabled = false;
  $('shareLabel').textContent = iAmCasting ? 'Parar transmissão' : 'Compartilhar tela';

  // A engrenagem só aparece para transmissão nascida aqui: a que roda na aba
  // externa é configurada por lá, e daqui não dá para mexer nela.
  $('liveSettings').hidden = !myBroadcast;

  renderProfileButton();

  $('pWho').textContent = casters.length ? casters.map((p) => p.name).join(', ') : 'ninguém';
}

// ------------------------------------------------------------------- streams

/** Prepara o lugar do transmissor; o decoder só nasce quando o config chega. */
function openStream(slot, userId) {
  closeStream(slot);
  const canvas = document.createElement('canvas');
  streams.set(slot, {
    userId,
    canvas,
    player: createPlayer(canvas, { onError: (m) => toast(m, true) }),
  });
}

function startStream(slot, config) {
  const s = streams.get(slot);
  if (!s || !s.player.start(config)) return;
  renderGrid();
  renderBar();
  ensureStatsTimer();
}

function closeStream(slot) {
  const s = streams.get(slot);
  if (!s) return;
  s.player.stop();
  s.canvas.remove();
  streams.delete(slot);
  if (focusedSlot === slot) focusedSlot = null;
}

function endStream(slot) {
  if (!streams.has(slot)) return;
  closeStream(slot);

  if (streams.size === 0) {
    clearInterval(lagTimer);
    lagTimer = null;
    for (const id of ['pLag', 'pFps', 'pRes']) $(id).textContent = '—';
  }

  renderGrid();
  renderBar();
}

function closeAllStreams() {
  for (const slot of [...streams.keys()]) closeStream(slot);
  clearInterval(lagTimer);
  lagTimer = null;
}

/**
 * O painel mostra os números de um stream por vez: o ampliado, ou o primeiro.
 * Somar latências de fontes diferentes não significaria nada.
 */
function ensureStatsTimer() {
  if (lagTimer) return;
  lagTimer = setInterval(() => {
    const s = streams.get(focusedSlot) ?? streams.values().next().value;
    if (!s) return;
    $('pLag').textContent = `${Math.max(0, s.player.getLag())} ms`;
    $('pFps').textContent = `${s.player.takeFrameCount()} fps`;
    $('pRes').textContent = s.player.getSizes().video;
  }, 1000);
}

// ------------------------------------------------------------------- arranque

boot().catch((err) => {
  console.error(err);
  setEmpty('Não foi possível entrar', err.message);
});

async function boot() {
  checkVersion();

  // Sem login o lobby ainda abre: dá para ver as salas antes de entrar. Só
  // criar e entrar é que pedem identidade.
  session = inDiscord ? await authDiscord() : await authWeb();

  renderProfileButton();

  // Lido antes de showLobby, que limpa o parâmetro da URL ao voltar ao lobby.
  const alvo = new URLSearchParams(location.search).get('sala');

  await showLobby();
  if (session && alvo) await joinById(alvo);
}

// ---------------------------------------------------------------- login web

$('loginBtn').addEventListener('click', () => {
  // Sobe de convidado para conta do Discord: a identidade nova substitui a
  // antiga, então as salas criadas como convidado ficam sem dono.
  remove('identity');
  location.href = '/auth/login';
});

/**
 * Identidade fora do Discord.
 *
 * O callback do OAuth devolve o token no fragmento da URL — que não é enviado
 * ao servidor nem entra em log de proxy. Lemos, guardamos e limpamos a barra
 * de endereço para o token não ficar visível nem no histórico.
 */
async function authWeb() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const fromLogin = fragment.get('identity');

  if (fromLogin) {
    store('identity', fromLogin);
    history.replaceState(null, '', location.pathname + location.search);
  }

  let identity = fromLogin ?? read('identity');

  // Sem identidade nenhuma: entra como convidado. O login do Discord é uma
  // melhoria opcional, não um pedágio para assistir uma tela.
  if (!identity) {
    const guest = await post('/api/session-guest', { name: storedName() });
    store('identity', guest.identity);
    identity = guest.identity;
  }

  const payload = decodeIdentity(identity);
  if (!payload) {
    remove('identity');
    return null;
  }

  return {
    identity,
    isGuest: String(payload.uid).startsWith('guest-'),
    user: { id: payload.uid, name: payload.name, avatar: payload.av ?? null },
  };
}

function decodeIdentity(token) {
  try {
    const p = JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
    // O servidor revalida a assinatura; aqui só descartamos o que já venceu,
    // para não tentar usar um token morto e cair num erro sem explicação.
    if (p.exp && p.exp * 1000 < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}

// O armazenamento pode estar bloqueado num iframe de terceiro, então todo
// acesso é protegido — perder a sessão é melhor do que a página não abrir.
function read(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* sessão só em memória */
  }
}

function remove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* nada a limpar */
  }
}

// -------------------------------------------------------------------- lobby

/** Tokens da sala atual. null = estamos no lobby. */
let roomTokens = null;
let roomInfo = null;
let joinTarget = null;
let lastRoomState = null;
let lobbyRooms = [];

function inRoom() {
  return roomTokens !== null;
}

// A lista precisa se atualizar sozinha: salas abrem, enchem e fecham enquanto
// alguém olha o lobby parado.
const LOBBY_REFRESH_MS = 4000;
let lobbyTimer = null;

async function showLobby() {
  if (roomInfo) remove(`sala:${roomInfo.id}`);
  roomTokens = null;
  roomInfo = null;
  setRoomUrl(null);

  ws?.close();
  ws = null;

  $('lobby').hidden = false;
  $('grid').hidden = true;
  $('empty').hidden = true;
  $('roomPill').hidden = true;
  $('leaveRoom').hidden = true;
  $('roomSettings').hidden = true;
  $('share').hidden = true;
  $('liveSettings').hidden = true;

  // O login só aparece para convidado: quem já entrou pelo Discord não tem o
  // que melhorar.
  $('loginBtn').hidden = inDiscord || !session?.isGuest;
  $('profile').hidden = !session;
  $('people').hidden = true;

  await loadRooms();

  clearInterval(lobbyTimer);
  lobbyTimer = setInterval(() => {
    // Nenhum modal aberto: recarregar sob o cursor tiraria o card do lugar no
    // meio de um clique.
    const busy = ['createModal', 'joinModal'].some((id) => !$(id).hidden);
    if (!busy && !$('lobby').hidden) loadRooms();
  }, LOBBY_REFRESH_MS);
}

async function loadRooms() {
  const list = $('roomList');

  let rooms = [];
  try {
    rooms = (await post(`${P}/api/rooms/list`, { identity: session?.identity })).rooms ?? [];
  } catch (err) {
    list.replaceChildren(msgRow(`Não foi possível carregar: ${err.message}`));
    return;
  }

  lobbyRooms = rooms;

  if (!rooms.length) {
    list.replaceChildren(msgRow('Nenhuma sala aberta. Crie a primeira.'));
    return;
  }

  list.replaceChildren(...rooms.map(roomCard));
}

function msgRow(text) {
  const el = document.createElement('div');
  el.className = 'lobby-empty';
  el.textContent = text;
  return el;
}

function roomCard(room) {
  const card = document.createElement('button');
  card.className = 'room-card';

  const top = document.createElement('div');
  top.className = 'room-card-top';

  if (room.locked) {
    top.insertAdjacentHTML(
      'afterbegin',
      '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/>' +
        '<path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
    );
  }

  const name = document.createElement('span');
  name.className = 'room-card-name';
  // textContent: nome de sala é escrito por outra pessoa.
  name.textContent = room.name;
  top.append(name);

  const meta = document.createElement('span');
  meta.className = 'room-card-meta';
  const pessoas = room.people === 1 ? '1 pessoa' : `${room.people} pessoas`;
  meta.textContent = `${pessoas} · por ${room.owner}`;

  card.append(top, meta);

  if (room.streams > 0) {
    const live = document.createElement('span');
    live.className = 'room-card-meta room-live';
    live.textContent = room.streams === 1 ? '1 tela no ar' : `${room.streams} telas no ar`;
    card.append(live);
  }

  card.addEventListener('click', () => enterRoom(room));
  return card;
}

async function enterRoom(room, password) {
  if (!session) return;
  try {
    const tokens = await post(`${P}/api/rooms/join`, {
      identity: session.identity,
      roomId: room.id,
      password: password ?? '',
    });
    openRoom(tokens, room);
  } catch (err) {
    // 403 numa sala trancada é o caminho normal: pedir a senha.
    if (err.status === 403 && !password) return askPassword(room);
    if (err.status === 403) return askPassword(room, 'Senha incorreta.');
    if (err.status === 429) return askPassword(room, err.detail);
    if (err.status === 404) {
      toast('Essa sala já fechou.', true);
      remove(`sala:${room.id}`);
      setRoomUrl(null);
      loadRooms();
      return;
    }
    toast(err.message, true);
  }
}

function askPassword(room, error) {
  joinTarget = room;
  $('joinSub').textContent = `"${room.name}" pede uma senha para entrar.`;
  $('joinError').textContent = error ?? '';
  $('joinError').hidden = !error;
  if (!error) $('joinPass').value = '';
  $('joinModal').hidden = false;
  wakeHud();
  $('joinPass').focus();
}

/**
 * Entra na sala apontada pela URL.
 *
 * Serve para os dois casos: recarregar a página estando numa sala, e abrir um
 * link `?sala=<id>` que alguém mandou.
 */
async function joinById(id) {
  // Token guardado de uma visita anterior: entra sem pedir a senha de novo.
  const saved = read(`sala:${id}`);
  if (saved) {
    try {
      const { tokens, name } = JSON.parse(saved);
      openRoom(tokens, { id, name });
      return;
    } catch {
      remove(`sala:${id}`);
    }
  }

  // Link recebido de fora: usa o fluxo normal, que pede a senha quando precisa.
  // O nome vem da lista já carregada; salas com senha também aparecem nela.
  const known = lobbyRooms.find((r) => r.id === id);
  await enterRoom(known ?? { id, name: 'Sala' });
}

/** Mantém `?sala=` na barra de endereço, preservando os parâmetros do Discord. */
function setRoomUrl(id) {
  const url = new URL(location.href);
  if (id) url.searchParams.set('sala', id);
  else url.searchParams.delete('sala');
  history.replaceState(null, '', url);
}

function openRoom(tokens, room) {
  roomTokens = tokens;
  roomInfo = room;

  setRoomUrl(room.id);
  store(`sala:${room.id}`, JSON.stringify({ tokens, name: room.name }));

  $('lobby').hidden = true;
  $('empty').hidden = false;
  $('share').hidden = false;
  $('leaveRoom').hidden = false;
  $('roomPill').hidden = false;
  $('people').hidden = false;
  $('loginBtn').hidden = true;

  clearInterval(lobbyTimer);
  lobbyTimer = null;
  $('roomPill').textContent = room.name;

  setEmpty('Entrando…', room.name);
  connect();
}

$('leaveRoom').addEventListener('click', () => {
  myBroadcast?.stop();
  myBroadcast = null;
  closeAllStreams();
  available.clear();
  watching.clear();
  participants = [];
  lastRoomState = null;
  focusedSlot = null;
  showLobby();
});

/**
 * Detecta bundle velho e recarrega.
 *
 * O index.html vai com no-store, mas o cliente do Discord pode entregar uma
 * cópia antiga assim mesmo — e o iframe fica preso num build anterior sem
 * nenhum sinal visível, o que já custou horas de diagnóstico enganoso.
 *
 * Comparamos o nome do próprio arquivo (que leva hash de conteúdo) com o que o
 * servidor diz ser o atual.
 */
async function checkVersion() {
  try {
    const mine = import.meta.url.split('/').pop().split('?')[0];
    const { asset } = await fetch(`${P}/api/version`, { cache: 'no-store' }).then((r) => r.json());
    if (!asset || asset === mine) return;

    // Se recarregar não resolveu, o HTML servido também está velho: avisa em
    // vez de entrar em laço de reload.
    if (sessionStorage.getItem('reloadedFor') === asset) {
      toast('Versão desatualizada e o cache não cede. Feche e abra a atividade novamente.', true);
      return;
    }
    sessionStorage.setItem('reloadedFor', asset);
    location.reload();
  } catch {
    // Diagnóstico é secundário: nunca deve impedir a sala de abrir.
  }
}

async function authDiscord() {
  const clientId = params.get('client_id') ?? import.meta.env.VITE_DISCORD_CLIENT_ID;
  if (!clientId) throw new Error('client_id ausente. Configure VITE_DISCORD_CLIENT_ID.');

  sdk = new DiscordSDK(clientId);
  await sdk.ready();

  const { code } = await sdk.commands.authorize({
    client_id: clientId,
    response_type: 'code',
    state: '',
    prompt: 'none',
    // Só precisamos de /users/@me. Menos escopo, menos atrito no consentimento.
    scope: ['identify'],
  });

  const { access_token } = await post(`${P}/api/token`, { code });
  await sdk.commands.authenticate({ access_token });

  return post(`${P}/api/session`, { access_token, instance_id: sdk.instanceId });
}


async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await r.json().catch(() => ({}));

  if (!r.ok) {
    // O status carrega significado (403 = senha, 429 = bloqueio, 404 = sala
    // fechou), então vai junto do erro em vez de virar texto.
    const err = new Error(data.error ?? `Servidor respondeu ${r.status}.`);
    err.status = r.status;
    err.detail = data.error;
    throw err;
  }
  return data;
}

// ----------------------------------------------------------------- websocket

function connect() {
  if (!roomTokens) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(
    `${proto}://${location.host}${P}/ws?t=${encodeURIComponent(roomTokens.viewerToken)}`
  );
  ws.binaryType = 'arraybuffer';

  ws.addEventListener('open', () => {
    reconnectDelay = 1000;
    $('grid').hidden = false;
    setEmpty('Ninguém na sala', 'Aguardando participantes.');

    // O apelido é do cliente, então precisa ser reenviado a cada conexão —
    // inclusive nas reconexões, senão o nome volta ao do Discord sozinho.
    const saved = storedName();
    if (saved && saved !== session.user.name) {
      session.user.name = saved;
      ws.send(JSON.stringify({ type: 'rename', name: saved }));
    }
  });

  ws.addEventListener('message', (e) => {
    // Primeiro byte do quadro é o slot: roteia para o decoder daquela pessoa.
    if (typeof e.data !== 'string') {
      streams.get(new DataView(e.data).getUint8(0))?.player.push(e.data);
      return;
    }

    const msg = JSON.parse(e.data);

    if (msg.type === 'state') {
      participants = msg.participants ?? [];
      lastRoomState = msg.room ?? null;

      // A senha da sala só aparece para quem a criou.
      $('roomPill').textContent = `${lastRoomState?.locked ? '🔒 ' : ''}${lastRoomState?.name ?? ''}`;
      $('roomSettings').hidden = lastRoomState?.ownerId !== session?.user?.id;
      $('roomSettings').classList.toggle('on', Boolean(lastRoomState?.locked));

      // Limpa o que sumiu sem stream-stop (queda abrupta, por exemplo).
      const live = new Set((msg.streams ?? []).map((s) => s.slot));
      for (const s of msg.streams ?? []) {
        const info = available.get(s.slot) ?? { userId: s.userId, config: null };
        info.watchers = s.watchers ?? [];
        available.set(s.slot, info);
      }
      for (const slot of [...available.keys()]) if (!live.has(slot)) available.delete(slot);
      for (const slot of [...streams.keys()]) if (!live.has(slot)) closeStream(slot);
      for (const slot of [...watching]) if (!live.has(slot)) watching.delete(slot);
      renderGrid();
      renderBar();
    } else if (msg.type === 'stream-start') {
      // Só anuncia; ninguém assiste até pedir.
      available.set(msg.slot, { userId: msg.userId, config: null });
      watching.delete(msg.slot);
      closeStream(msg.slot);
      renderGrid();
    } else if (msg.type === 'config') {
      const info = available.get(msg.slot);
      if (info) info.config = msg.config;
      if (watching.has(msg.slot)) {
        openStream(msg.slot, info?.userId ?? msg.slot);
        startStream(msg.slot, msg.config);
      }
    } else if (msg.type === 'stream-stop') {
      available.delete(msg.slot);
      watching.delete(msg.slot);
      endStream(msg.slot);
    } else if (msg.type === 'room-gone') {
      roomTokens = null;
      toast('A sala foi fechada.', true);
      showLobby();
    } else if (msg.type === 'error') {
      toast(msg.message, true);
    }
  });

  ws.addEventListener('close', () => {
    closeAllStreams();
    available.clear();
    watching.clear();
    participants = [];
    renderGrid();

    // Saímos da sala de propósito: nada a reconectar.
    if (!roomTokens) return;

    setEmpty('Reconectando…', 'A conexão com a sala caiu.');
    // Backoff — evita martelar o servidor se ele estiver fora do ar.
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
  });

  ws.addEventListener('error', () => ws.close());
}

// --------------------------------------------------------------------- ações

$('share').addEventListener('click', () => {
  if (!session) return;

  // Transmissão nascida aqui dentro: encerra direto.
  if (myBroadcast) {
    myBroadcast.stop();
    myBroadcast = null;
    renderBar();
    return;
  }

  // Transmissão numa aba externa: pede ao servidor que avise aquela aba.
  if (participants.some((p) => p.broadcasting && p.id === session.user.id)) {
    ws?.send(JSON.stringify({ type: 'stop-broadcast' }));
    return;
  }

  openModal('start');
});

/**
 * O mesmo modal serve para começar e para ajustar no ar. Em 'live' os campos
 * já vêm com os valores atuais e o botão aplica em vez de iniciar.
 */
let modalMode = 'start';

function openModal(mode) {
  modalMode = mode;
  const live = mode === 'live';

  $('modalTitle').textContent = live ? 'Ajustes da transmissão' : 'Compartilhar sua tela';
  $('modalSub').textContent = live
    ? 'Vale na hora, sem derrubar quem está assistindo.'
    : 'Escolha a tela e comece a transmitir.';
  $('modalGo').textContent = live ? 'Aplicar' : 'Compartilhar tela';
  $('modalSwap').hidden = !live;
  $('modalNote').hidden = live;

  if (live && myBroadcast) {
    const s = myBroadcast.getSettings();
    $('mQuality').value = String(s.bitrate);
    $('mFps').value = String(s.fps);
  }

  $('modal').hidden = false;
  wakeHud();
}

$('liveSettings').addEventListener('click', () => openModal('live'));

$('modalSwap').addEventListener('click', async () => {
  if (!myBroadcast) return;
  try {
    await myBroadcast.changeScreen();
    closeModal();
  } catch (err) {
    // Cancelar o seletor é rotina, não erro.
    if (err.name !== 'NotAllowedError') toast(err.message, true);
  }
});

const closeModal = () => {
  $('modal').hidden = true;
};

/**
 * Transmite a partir daqui mesmo, sem abrir aba.
 *
 * Só funciona se o Discord conceder `display-capture` ao iframe da Activity.
 * Retorna true quando o fluxo foi resolvido — transmitindo, ou a pessoa
 * cancelou o seletor — e false quando resta cair para a aba externa.
 *
 * NotAllowedError é ambíguo: vale tanto para "a plataforma bloqueou" quanto
 * para "a pessoa cancelou". O tempo separa os dois — bloqueio de política falha
 * na hora, sem nunca desenhar o seletor, enquanto cancelar exige que alguém
 * tenha visto a janela e clicado.
 */
async function broadcastFromHere() {
  if (!navigator.mediaDevices?.getDisplayMedia || !window.VideoEncoder) return false;

  if (!roomTokens) return false;
  const shareToken = new URL(roomTokens.shareUrl).searchParams.get('t');
  if (!shareToken) return false;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';

  const b = createBroadcaster({
    wsUrl: `${proto}://${location.host}${P}/ws?t=${encodeURIComponent(shareToken)}`,
    bitrate: Number($('mQuality').value),
    fps: Number($('mFps').value),
    onEnd: () => {
      myBroadcast = null;
      renderBar();
    },
  });

  const startedAt = performance.now();
  try {
    await b.start();
    myBroadcast = b;
    closeModal();
    renderBar();
    return true;
  } catch (err) {
    const showedPicker = performance.now() - startedAt > 250;
    if (err.name === 'NotAllowedError' && showedPicker) {
      closeModal();
      return true;
    }
    return false;
  }
}

$('modalCancel').addEventListener('click', closeModal);

// Clique no fundo fecha; dentro do card, não.
$('modal').addEventListener('click', (e) => {
  if (e.target === $('modal')) closeModal();
});

$('modalGo').addEventListener('click', async () => {
  // Ajuste no ar: aplica e fecha, sem tocar na captura.
  if (modalMode === 'live') {
    myBroadcast?.setQuality({
      bitrate: Number($('mQuality').value),
      fps: Number($('mFps').value),
    });
    closeModal();
    return;
  }

  // O clique é o gesto de usuário que getDisplayMedia exige, então é aqui que
  // dá para transmitir sem sair do Discord. A aba externa só entra se o iframe
  // não tiver permissão de captura.
  if (await broadcastFromHere()) return;

  closeModal();

  // As opções seguem na URL: a página de captura já abre configurada, sem
  // pedir as mesmas escolhas de novo.
  const url = new URL(roomTokens.shareUrl);
  url.searchParams.set('q', $('mQuality').value);
  url.searchParams.set('fps', $('mFps').value);

  if (inDiscord) {
    try {
      const res = await sdk.commands.openExternalLink({ url: url.toString() });
      // Clientes antigos devolvem null; só tratamos false como recusa explícita.
      if (res?.opened === false) {
        toast('Você recusou abrir o link. Sem isso não dá para capturar a tela.', true);
        return;
      }
    } catch (err) {
      toast(`Não foi possível abrir o link: ${err.message}`, true);
      return;
    }
  } else {
    window.open(url.toString(), '_blank');
  }
});

// ------------------------------------------------------- modais das salas

$('newRoom').addEventListener('click', () => {
  if (!session) return;
  $('createName').value = '';
  $('createPass').value = '';
  $('createModal').hidden = false;
  wakeHud();
  $('createName').focus();
});

$('createCancel').addEventListener('click', () => ($('createModal').hidden = true));
$('createModal').addEventListener('click', (e) => {
  if (e.target === $('createModal')) $('createModal').hidden = true;
});

$('createGo').addEventListener('click', async () => {
  const name = $('createName').value.trim();

  try {
    const tokens = await post(`${P}/api/rooms/create`, {
      identity: session.identity,
      name,
      password: $('createPass').value || null,
    });
    $('createModal').hidden = true;
    openRoom(tokens, {
      id: tokens.roomId,
      // O servidor decide o nome quando fica em branco.
      name: name || `Sala de ${session.user.name}`,
      owner: session.user.name,
    });
  } catch (err) {
    toast(err.message, true);
  }
});

$('joinCancel').addEventListener('click', () => ($('joinModal').hidden = true));
$('joinModal').addEventListener('click', (e) => {
  if (e.target === $('joinModal')) $('joinModal').hidden = true;
});
$('joinPass').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('joinGo').click();
});

$('joinGo').addEventListener('click', async () => {
  if (!joinTarget) return;
  $('joinModal').hidden = true;
  await enterRoom(joinTarget, $('joinPass').value);
});

// Ajustes da sala: só o dono muda a senha, e o servidor confere de novo.
$('roomCancel').addEventListener('click', () => ($('roomModal').hidden = true));
$('roomModal').addEventListener('click', (e) => {
  if (e.target === $('roomModal')) $('roomModal').hidden = true;
});

$('roomSave').addEventListener('click', async () => {
  try {
    const r = await post(`${P}/api/rooms/password`, {
      identity: session.identity,
      roomId: roomTokens.roomId,
      password: $('roomPass').value || '',
    });
    $('roomModal').hidden = true;
    toast(r.locked ? 'Sala protegida com senha.' : 'Senha removida.');
  } catch (err) {
    toast(err.message, true);
  }
});

function openRoomSettings() {
  $('roomSub').textContent = roomInfo?.name ?? '';
  $('roomPass').value = '';
  $('roomModal').hidden = false;
  wakeHud();
  $('roomPass').focus();
}

$('roomSettings').addEventListener('click', openRoomSettings);

// --------------------------------------------------------------------- HUD

const HUD_IDLE_MS = 2500;
let hudTimer = null;

/**
 * Mostra o HUD e reprograma o desaparecimento.
 *
 * Ele não some enquanto o mouse estiver sobre os controles ou o painel estiver
 * aberto — sumir debaixo do cursor é a forma mais rápida de irritar.
 */
function wakeHud() {
  $('hud').classList.remove('idle');
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => {
    const busy =
      $('hud').matches(':hover') ||
      !$('panel').hidden ||
      !inRoom() ||
      ['modal', 'profileModal', 'createModal', 'joinModal', 'roomModal'].some(
        (id) => !$(id).hidden
      );
    if (busy) return wakeHud();
    $('hud').classList.add('idle');
  }, HUD_IDLE_MS);
}

for (const evt of ['mousemove', 'mousedown', 'touchstart', 'keydown']) {
  window.addEventListener(evt, wakeHud, { passive: true });
}
wakeHud();

$('settings').addEventListener('click', () => {
  const panel = $('panel');
  panel.hidden = !panel.hidden;
  $('settings').classList.toggle('on', !panel.hidden);
  wakeHud();
});

$('fullscreen').addEventListener('click', () => {
  if (!streams.size) return;
  // Com vários no ar, alterna para o primeiro; clicar no tile escolhe outro.
  focusedSlot = focusedSlot !== null ? null : streams.keys().next().value;
  $('fullscreen').classList.toggle('on', focusedSlot !== null);
  renderGrid();
});

window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;

  // Fecha o modal aberto mais recente antes de mexer no modo ampliado.
  for (const id of ['profileModal', 'roomModal', 'joinModal', 'createModal', 'modal']) {
    if (!$(id).hidden) {
      $(id).hidden = true;
      return;
    }
  }

  // Esc sai do modo ampliado — é o reflexo de todo mundo.
  if (focusedSlot !== null && !document.fullscreenElement) {
    focusedSlot = null;
    $('fullscreen').classList.remove('on');
    renderGrid();
  }
});

/**
 * Diagnóstico: tenta capturar a tela direto de dentro do iframe.
 *
 * Se um dia o Discord conceder `display-capture` ao iframe da Activity, isso
 * funciona e a aba externa deixa de ser necessária.
 */
$('probe').addEventListener('click', async () => {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('getDisplayMedia nem existe neste contexto — iframe sem permissão.', true);
    return;
  }
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
    s.getTracks().forEach((t) => t.stop());
    toast('Funcionou! O iframe permite captura direta — dá para dispensar a aba externa.');
  } catch (err) {
    toast(`Bloqueado (${err.name}): ${err.message}`, true);
  }
});
