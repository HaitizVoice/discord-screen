import dotenv from 'dotenv';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import express from 'express';
import { WebSocketServer } from 'ws';

import { signToken, verifyToken } from './tokens.js';
import * as R from './rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  PUBLIC_ORIGIN = 'http://localhost:3001',
  PORT = 3001,
  NODE_ENV = 'development',
} = process.env;

const isProd = NODE_ENV === 'production';

const app = express();
app.use(express.json());

// Página de captura (broadcaster). Servida como página normal, fora do proxy.
// Nomes fixos (share.html/js/css), então nunca cachear: senão uma correção
// fica presa no navegador de quem transmite, sem jeito óbvio de perceber.
app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
  })
);

// Pipeline de transmissão compartilhado com a Activity. Ela o recebe pelo
// bundle do Vite; a página de captura importa daqui.
app.use(
  '/shared',
  express.static(path.join(__dirname, '..', 'shared'), {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
  })
);

// ------------------------------------------------------------------ OAuth

/** Troca o code do OAuth pelo access_token. O secret nunca sai do servidor. */
app.post('/api/token', async (req, res) => {
  const { code } = req.body ?? {};
  if (!code) return res.status(400).json({ error: 'code obrigatorio' });

  try {
    const r = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
      }),
    });

    const data = await r.json();
    if (!data.access_token) {
      console.error('[oauth] falhou:', data);
      return res.status(401).json({ error: 'troca de token falhou' });
    }
    res.json({ access_token: data.access_token });
  } catch (err) {
    console.error('[oauth] erro:', err);
    res.status(500).json({ error: 'erro interno' });
  }
});

/**
 * Identidade da pessoa nesta instância da Activity.
 *
 * Separada das salas de propósito: cada operação de sala valida este token
 * assinado em vez de bater no Discord de novo, o que custaria uma ida à rede a
 * cada clique.
 */
app.post('/api/session', async (req, res) => {
  const { access_token, instance_id } = req.body ?? {};
  if (!access_token || !instance_id) {
    return res.status(400).json({ error: 'access_token e instance_id obrigatorios' });
  }

  try {
    const me = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` },
    }).then((r) => r.json());

    if (!me?.id) return res.status(401).json({ error: 'token invalido' });

    res.json(issueIdentity(instance_id, me.id, me.global_name || me.username, me.avatar ?? null));
  } catch (err) {
    console.error('[session] erro:', err);
    res.status(500).json({ error: 'erro interno' });
  }
});

/**
 * Identidade de convidado: entra sem conta.
 *
 * O login do Discord é uma melhoria opcional, não um pedágio — exigir conta só
 * para assistir uma tela afastaria justamente quem recebeu um link.
 *
 * Validade longa de propósito: o id do convidado é o que amarra a posse das
 * salas que ele criou, e perder isso no meio do uso seria pior que o risco de
 * um token de convidado antigo, que não dá acesso a nada além do lobby público.
 */
/**
 * Identidade de teste com instância à escolha. Fora do ar em produção: poder
 * escolher a instância permitiria espiar as salas de qualquer canal de voz.
 */
app.post('/api/session-dev', (req, res) => {
  if (isProd) return res.status(404).end();
  const { instance_id = 'dev', name = 'Dev' } = req.body ?? {};
  res.json(issueIdentity(instance_id, `dev-${name}`, name, null));
});

app.post('/api/session-guest', (req, res) => {
  const raw = String(req.body?.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 32);
  const name = raw || `Convidado ${Math.floor(Math.random() * 9000 + 1000)}`;
  const uid = `guest-${crypto.randomBytes(8).toString('base64url')}`;
  res.json(issueIdentity(WEB_INSTANCE, uid, name, null, 30 * 24 * 60 * 60));
});

function issueIdentity(instance, uid, name, avatar, ttl = 8 * 60 * 60) {
  return {
    user: { id: uid, name, avatar },
    instance,
    identity: signToken({ instance, uid, name, av: avatar, scope: 'identity' }, ttl),
  };
}

/** Valida o token de identidade que acompanha toda operação de sala. */
function identityOf(req, res) {
  const payload = verifyToken(req.body?.identity);
  if (!payload || payload.scope !== 'identity') {
    res.status(401).json({ error: 'identidade invalida ou expirada' });
    return null;
  }
  return payload;
}

/**
 * Tokens de acesso a uma sala, emitidos depois de passar pela senha.
 *
 * Sem prazo de validade: quem entrou fica. A sala fecha ao esvaziar e o id é
 * aleatório, então o token morre junto com ela.
 */
function issueRoomTokens(roomId, me) {
  const base = { room: roomId, uid: me.uid, name: me.name, av: me.av ?? null };
  return {
    roomId,
    viewerToken: signToken({ ...base, role: 'viewer' }),
    shareUrl: `${PUBLIC_ORIGIN}/share.html?t=${encodeURIComponent(
      signToken({ ...base, role: 'broadcaster' })
    )}`,
  };
}

// ---------------------------------------------------------------------- salas

/**
 * Listar não exige login: dá para ver o lobby antes de entrar.
 *
 * Criar e entrar continuam exigindo identidade — sem isso não haveria dono de
 * sala nem nome de participante.
 */
app.post('/api/rooms/list', (req, res) => {
  const me = verifyToken(req.body?.identity);
  const instance = me?.scope === 'identity' ? me.instance : WEB_INSTANCE;
  res.json({ rooms: R.listRooms(instance) });
});

app.post('/api/rooms/create', (req, res) => {
  const me = identityOf(req, res);
  if (!me) return;

  const { room, error } = R.createRoom({
    instance: me.instance,
    name: req.body?.name,
    ownerId: me.uid,
    ownerName: me.name,
    password: req.body?.password || null,
  });
  if (error) return res.status(400).json({ error });

  console.log(`[room ${room.id}] criada por ${me.name}: "${room.name}"`);
  res.json(issueRoomTokens(room.id, me));
});

app.post('/api/rooms/join', (req, res) => {
  const me = identityOf(req, res);
  if (!me) return;

  const room = R.getRoom(req.body?.roomId);
  // Mesma instância: salas de um canal de voz não aparecem em outro.
  if (!room || room.instance !== me.instance) {
    return res.status(404).json({ error: 'Sala não existe mais.' });
  }

  const check = R.checkPassword(room, req.body?.password);
  if (!check.ok) {
    return res.status(check.reason === 'bloqueado' ? 429 : 403).json({
      error:
        check.reason === 'bloqueado'
          ? `Muitas tentativas. Tente de novo em ${check.seconds}s.`
          : 'Senha incorreta.',
      reason: check.reason,
    });
  }

  res.json(issueRoomTokens(room.id, me));
});

app.post('/api/rooms/password', (req, res) => {
  const me = identityOf(req, res);
  if (!me) return;

  const room = R.getRoom(req.body?.roomId);
  if (!room || room.instance !== me.instance) {
    return res.status(404).json({ error: 'Sala não existe mais.' });
  }

  const error = R.setPassword(room, me.uid, req.body?.password || null);
  if (error) return res.status(403).json({ error });

  res.json({ ok: true, locked: Boolean(room.password) });
});

// ------------------------------------------------- login web (fora do Discord)

// Quem entra pelo site não tem canal de voz, então todas essas pessoas
// compartilham um lobby só.
const WEB_INSTANCE = 'web';
const REDIRECT_URI = `${PUBLIC_ORIGIN}/auth/callback`;

app.get('/auth/login', (_req, res) => {
  const url = new URL('https://discord.com/oauth2/authorize');
  url.searchParams.set('client_id', DISCORD_CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify');
  res.redirect(url.toString());
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?erro=sem_codigo');

  try {
    const token = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: REDIRECT_URI,
        code: String(code),
      }),
    }).then((r) => r.json());

    if (!token.access_token) return res.redirect('/?erro=troca_falhou');

    const me = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    }).then((r) => r.json());

    if (!me?.id) return res.redirect('/?erro=perfil_falhou');

    const identity = issueIdentity(
      WEB_INSTANCE,
      me.id,
      me.global_name || me.username,
      me.avatar ?? null
    );

    // No fragmento, não na query: o fragmento não é enviado ao servidor nem
    // aparece em log de proxy. O cliente lê e limpa da barra de endereço.
    res.redirect(`/#identity=${encodeURIComponent(identity.identity)}`);
  } catch (err) {
    console.error('[auth] erro:', err);
    res.redirect('/?erro=interno');
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, rooms: R.stats() }));

/**
 * Nome do bundle atual, para a Activity detectar que está rodando uma versão
 * velha. O index.html é no-store, mas o cliente do Discord pode servir uma
 * cópia antiga mesmo assim — e aí o iframe fica preso num build anterior sem
 * nenhum sinal visível.
 */
app.get('/api/version', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const html = fs.readFileSync(path.join(clientDist, 'index.html'), 'utf8');
    res.json({ asset: html.match(/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1] ?? null });
  } catch {
    res.json({ asset: null });
  }
});

// Activity buildada (produção). Em dev o Vite serve o client na 5173.
const clientDist = path.join(__dirname, '..', 'client', 'dist');

app.use(
  express.static(clientDist, {
    setHeaders: (res, filePath) => {
      // Arquivos em /assets levam hash de conteúdo no nome — o Vite gera um
      // nome novo a cada build, então cachear para sempre é seguro.
      // O index.html aponta para eles e precisa ser sempre fresco.
      const hashed = filePath.includes(`${path.sep}assets${path.sep}`);
      res.setHeader(
        'Cache-Control',
        hashed ? 'public, max-age=31536000, immutable' : 'no-store'
      );
    },
  })
);

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(clientDist, 'index.html'), (err) => err && next());
});

// -------------------------------------------------------------- WebSocket

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  // O proxy do Discord entrega o caminho com o prefixo /.proxy/.
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname.replace(/^\/\.proxy/, '');

  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }

  const payload = verifyToken(url.searchParams.get('t'));
  // scope 'identity' não dá acesso a sala nenhuma: só os tokens de sala servem.
  if (!payload || !payload.room) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, payload);
  });
});

wss.on('connection', (ws, _req, auth) => {
  const room = R.getRoom(auth.room);

  // A sala pode ter fechado entre a emissão do token e a conexão.
  if (!room) {
    R.sendJson(ws, { type: 'room-gone' });
    ws.close();
    return;
  }

  if (auth.role === 'broadcaster') {
    handleBroadcaster(ws, room, { id: auth.uid, name: auth.name, avatar: auth.av ?? null });
  } else {
    handleViewer(ws, room, auth);
  }
});

function handleBroadcaster(ws, room, info) {
  const entry = R.attachBroadcaster(room, ws, info);

  if (typeof entry === 'string') {
    R.sendJson(ws, { type: 'error', message: entry });
    ws.close();
    return;
  }

  console.log(`[room ${room.id}] broadcaster conectado: ${info.name} (slot ${entry.slot})`);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      R.pushChunk(room, entry, data);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.type === 'start') {
      R.startStream(room, entry);
      console.log(`[room ${room.id}] stream iniciada por ${info.name}`);
    } else if (msg.type === 'config' && msg.config) {
      R.setConfig(room, entry, msg.config);
      console.log(`[room ${room.id}] codec de ${info.name}: ${msg.config.codec}`);
    } else if (msg.type === 'stop') {
      R.stopStream(room, entry);
      console.log(`[room ${room.id}] stream parada por ${info.name}`);
    }
  });

  ws.on('close', () => {
    R.detachBroadcaster(room, ws);
    console.log(`[room ${room.id}] broadcaster saiu: ${info.name}`);
  });
}

function handleViewer(ws, room, auth) {
  R.attachViewer(room, ws, { id: auth.uid, name: auth.name, avatar: auth.av ?? null });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;

    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // Nome exibido escolhido pela pessoa. Nada é persistido: vale enquanto a
    // conexão durar, e some quando ela reabre a atividade.
    if (msg.type === 'rename') {
      R.rename(room, ws, msg.name);
      return;
    }

    if (msg.type === 'watch' && Number.isInteger(msg.slot)) {
      R.watch(room, ws, msg.slot);
      return;
    }

    if (msg.type === 'unwatch' && Number.isInteger(msg.slot)) {
      R.unwatch(room, ws, msg.slot);
      return;
    }

    // Encerrar a própria transmissão de dentro da Activity, sem ter que achar
    // a aba de captura. Cada um só encerra a sua.
    if (msg.type === 'stop-broadcast') {
      const entry = R.broadcasterOf(room, auth.uid);
      if (entry) {
        R.sendJson(entry.ws, { type: 'stop-request' });
        console.log(`[room ${room.id}] parada pedida por ${auth.name}`);
      }
    }
  });

  ws.on('close', () => R.detachViewer(room, ws));
  ws.on('error', () => R.detachViewer(room, ws));
}

// Derruba sockets mortos — sem isso o contador de viewers fica mentindo.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.__alive === false) {
      ws.terminate();
      continue;
    }
    ws.__alive = false;
    ws.ping();
  }
}, 30_000);

wss.on('connection', (ws) => {
  ws.__alive = true;
  ws.on('pong', () => {
    ws.__alive = true;
  });
});

wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`servidor  : http://localhost:${PORT}`);
  console.log(`publico   : ${PUBLIC_ORIGIN}`);
  console.log(`captura   : ${PUBLIC_ORIGIN}/share.html`);
  if (!DISCORD_CLIENT_ID) console.warn('aviso: DISCORD_CLIENT_ID nao configurado');

  // Erro fácil de cometer e difícil de diagnosticar: com PUBLIC_ORIGIN
  // apontando para o proxy, a página de captura abre dentro do sandbox do
  // Discord e getDisplayMedia volta a ser bloqueado.
  if (PUBLIC_ORIGIN.includes('discordsays.com')) {
    console.error(
      'ERRO: PUBLIC_ORIGIN aponta para o proxy do Discord.\n' +
        '      A pagina de captura precisa abrir fora do iframe.\n' +
        '      Use a URL do tunel (ex: https://algo.trycloudflare.com).'
    );
  }
});
