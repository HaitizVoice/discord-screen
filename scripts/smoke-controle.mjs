/**
 * A conexão de controle sobrevive à sala?
 *
 * Era o bug: a aba de captura não conta para a sala estar viva — certo, senão
 * uma aba esquecida a manteria de pé para sempre — mas também não era fechada
 * quando a sala morria. Ficava aberta contra um objeto que ninguém alcança,
 * sem receber nada e sem `close` para disparar a reconexão.
 */
import WebSocket from 'ws';

const BASE = 'http://localhost:3001';
const WSB = 'ws://localhost:3001';
const api = async (p, b) =>
  (await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
  })).json();

let falhas = 0;
const check = (nome, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FALHOU'}  ${nome}${extra ? ` — ${extra}` : ''}`);
  if (!ok) falhas++;
};

const inst = `ctrl-${Date.now().toString(36)}`;
const me = await api('/api/session-dev', { instance_id: inst, name: 'Ctrl' });
const t = await api('/api/rooms/create', { identity: me.identity, name: 'Sala Ctrl' });
const shareToken = new URL(t.shareUrl).searchParams.get('t');

const ctrl = new WebSocket(`${WSB}/ws?t=${encodeURIComponent(shareToken)}&modo=controle`);
const recebidos = [];
let fechou = false;
ctrl.on('message', (d) => recebidos.push(JSON.parse(d.toString())));
ctrl.on('close', () => { fechou = true; });
await new Promise((r) => ctrl.on('open', r));

check('a aba de controle conecta', ctrl.readyState === WebSocket.OPEN);

// Ninguém assiste e ninguém transmite: a sala está vazia desde que nasceu.
// A carência é de 12s e a varredura roda a cada 4s, então 20s cobre com folga.
console.log('esperando a varredura fechar a sala vazia (20s)…');
await new Promise((r) => setTimeout(r, 20_000));

check('a aba foi avisada de que a sala fechou', recebidos.some((m) => m.type === 'room-gone'),
  `recebeu: ${JSON.stringify(recebidos.map((m) => m.type))}`);
check('o socket da aba foi fechado', fechou,
  fechou ? '' : `readyState=${ctrl.readyState} — ficaria surdo para sempre`);

// Uma conexão nova bate numa sala que não existe mais.
const zumbi = new WebSocket(`${WSB}/ws?t=${encodeURIComponent(shareToken)}&modo=controle`);
const doZumbi = [];
zumbi.on('message', (d) => doZumbi.push(JSON.parse(d.toString())));
await new Promise((r) => { zumbi.on('close', r); zumbi.on('error', r); setTimeout(r, 2000); });
check('reconectar na sala morta responde room-gone', doZumbi.some((m) => m.type === 'room-gone'),
  `recebeu: ${JSON.stringify(doZumbi.map((m) => m.type))}`);

console.log(falhas ? `\n${falhas} falha(s)` : '\nTudo passou');
process.exit(falhas ? 1 : 0);
