/**
 * Página de captura externa.
 *
 * Só existe como alternativa: quando o Discord não concede `display-capture` ao
 * iframe da Activity, a transmissão precisa nascer numa página top-level, onde
 * getDisplayMedia funciona sem restrição.
 *
 * Uma página, duas fontes. Tela e câmera são painéis independentes, cada um com
 * sua própria conexão e seu próprio ligar/desligar — abrir uma aba por fonte
 * dobraria as janelas que a pessoa precisa manter vivas, e nenhuma delas pode
 * ser fechada enquanto transmite.
 *
 * Toda a lógica de captura e codificação vive em /shared/broadcaster.js, a mesma
 * usada dentro da Activity — aqui é só a interface.
 */
import { createBroadcaster, supportError } from '/shared/broadcaster.js?v=5';

const $ = (id) => document.getElementById(id);

const query = new URLSearchParams(location.search);
const token = query.get('t');

const FONTES = ['tela', 'camera'];
const TITULO = document.title;

const paineis = {};

function readTokenPayload() {
  try {
    return JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

function falhar(titulo, msg) {
  $('roomLine').textContent = titulo;
  $('setup').hidden = true;
  for (const f of FONTES) $(`bloco-${f}`).hidden = true;
  const el = $('pageStatus');
  el.textContent = msg;
  el.className = 'status error';
}

// --------------------------------------------------------------- chamamento

let piscando = null;

/**
 * Destaca a fonte que a atividade pediu e chama pelo título.
 *
 * Uma aba em segundo plano não pode se trazer para a frente: `window.focus()` é
 * ignorado, e quem abriu esta página foi o navegador do sistema, não uma página
 * nossa que pudesse chamá-la de volta. O título é o único lugar onde ela ainda
 * aparece para quem está olhando outra coisa.
 */
function chamar(fonte) {
  for (const f of FONTES) $(`bloco-${f}`).classList.toggle('chamando', f === fonte);

  clearInterval(piscando);
  piscando = null;
  document.title = TITULO;
  if (!fonte) return;

  // Piscar só serve para quem não está olhando; com a aba à frente, o destaque
  // no bloco já diz qual é.
  if (!document.hidden) return;

  const aviso = fonte === 'camera' ? '● Ligar a câmera' : '● Compartilhar a tela';
  let ligado = false;
  piscando = setInterval(() => {
    ligado = !ligado;
    document.title = ligado ? aviso : TITULO;
  }, 1200);
}

// Visto o recado, para de piscar — o destaque no bloco continua dizendo qual é.
document.addEventListener('visibilitychange', () => {
  if (document.hidden || !piscando) return;
  clearInterval(piscando);
  piscando = null;
  document.title = TITULO;
});

/**
 * A atividade pediu uma fonte.
 *
 * Câmera dá para ligar daqui mesmo: getUserMedia não exige gesto do usuário
 * depois que a permissão foi concedida. Tela não — `getDisplayMedia` exige
 * ativação transitória e lança InvalidStateError sem ela, então o seletor só
 * abre a partir de um clique nesta página. O que resta é chamar e esperar.
 */
function atenderPedido(fonte) {
  const painel = paineis[fonte];
  if (!painel || painel.ativo()) return;

  chamar(fonte);
  if (fonte === 'camera') painel.ligar();
}

// ------------------------------------------------------------------ painel

function criarPainel(fonte) {
  const el = (sufixo) => $(`${fonte}-${sufixo}`);
  const camera = fonte === 'camera';

  let broadcaster = null;
  let curtas = 0;
  let ritmoAvisado = false;

  function setStatus(msg, kind = '') {
    const alvo = el('status');
    alvo.textContent = msg;
    alvo.className = `status ${kind}`;
  }

  /**
   * Avisa quando o computador não está entregando os quadros pedidos.
   *
   * O encoder por software (vp8, quando não há H264 por hardware) não acompanha
   * 60 fps em tela grande. O backpressure então descarta quadros — o que é a
   * decisão certa, porque fila no encoder vira atraso que nunca mais sai — mas
   * sem este aviso a pessoa escolhe 60, recebe 35 e não fica sabendo.
   */
  function conferirRitmo({ fps, seconds }) {
    const alvo = Number($('fps').value);
    if (ritmoAvisado || seconds < 4) return;

    curtas = fps < alvo * 0.7 ? curtas + 1 : 0;
    if (curtas < 4) return;

    ritmoAvisado = true;
    setStatus(
      `Seu computador está entregando ~${fps} dos ${alvo} quadros pedidos. ` +
        'Para uma imagem mais estável, pare e escolha uma taxa menor.',
      'aviso'
    );
  }

  function mostrarSetup() {
    el('preview').srcObject = null;
    el('live').hidden = true;
    el('setup').hidden = false;
    el('start').disabled = false;
  }

  async function ligar() {
    // Pedido repetido não reabre nada: a segunda conexão seria recusada pelo
    // servidor, e o seletor de tela abriria por cima do que já está no ar.
    if (broadcaster) return;

    curtas = 0;
    ritmoAvisado = false;
    el('start').disabled = true;
    setStatus(camera ? 'Aguardando a permissão da câmera…' : 'Aguardando você escolher a tela…');

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';

    broadcaster = createBroadcaster({
      wsUrl: `${proto}://${location.host}/ws?t=${encodeURIComponent(token)}&fonte=${fonte}`,
      bitrate: Number($('quality').value),
      fps: Number($('fps').value),
      audio: !camera && $('withAudio').checked,
      fonte,
      onStatus: (s) =>
        setStatus(
          `Codec: ${s.codec} · ${s.width}×${s.height} · captura ${s.direct ? 'direta' : 'via <video>'}`
        ),
      onStats: (s) => {
        el('viewers').textContent = s.viewers;
        el('fps').textContent = `${s.fps} fps`;
        el('bitrate').textContent = `${s.mbps.toFixed(1)} Mb/s`;
        el('elapsed').textContent =
          `${String(Math.floor(s.seconds / 60)).padStart(2, '0')}:${String(s.seconds % 60).padStart(2, '0')}`;
        conferirRitmo(s);
      },
      onAviso: (msg) => {
        setStatus(msg, 'aviso');
        // O aviso sozinho é um beco: o botão é a saída dele.
        if (!camera) $('somAba').hidden = false;
      },
      onEnd: (reason) => {
        broadcaster = null;
        mostrarSetup();
        setStatus(reason);
      },
      // O pedido chega por qualquer conexão viva; quem resolve é o painel da
      // fonte pedida, que pode não ser este.
      onPedido: atenderPedido,
    });

    try {
      const stream = await broadcaster.start();
      el('preview').srcObject = stream;
      el('preview').play().catch(() => {});
      el('setup').hidden = true;
      el('live').hidden = false;
      chamar(null);
    } catch (err) {
      broadcaster = null;
      el('start').disabled = false;
      // NotAllowedError quer dizer coisas diferentes nas duas fontes: na tela é
      // quase sempre cancelar o seletor; na câmera é a permissão negada.
      const negado = camera
        ? 'Acesso à câmera negado. Libere a permissão na barra de endereço e tente de novo.'
        : 'Você cancelou a seleção de tela.';
      setStatus(err.name === 'NotAllowedError' ? negado : err.message, 'error');
    }
  }

  el('start').addEventListener('click', ligar);
  el('stop').addEventListener('click', () =>
    broadcaster?.stop(camera ? 'Câmera desligada.' : 'Transmissão encerrada.')
  );

  return {
    ligar,
    setStatus,
    ativo: () => Boolean(broadcaster),
    parar: () => broadcaster?.stop(),
    trocarSom: () => broadcaster?.trocarSom(),
  };
}

// ------------------------------------------------------------------ arranque

const payload = token && readTokenPayload();
// requireChromium: nos demais navegadores a captura sai visivelmente pior.
const missing = supportError({ requireChromium: true });

if (!payload) {
  falhar('Link inválido.', 'Volte à atividade no Discord e clique em compartilhar novamente.');
  // `exp` é opcional: tokens de sala não expiram, a sala é que fecha.
} else if (payload.exp && payload.exp * 1000 < Date.now()) {
  falhar('Link expirado.', 'Gere um novo pela atividade.');
} else if (missing) {
  falhar('Navegador sem suporte.', missing);
} else {
  $('roomLine').textContent = `Transmitindo como ${payload.name}`;
  applyPresets();

  for (const f of FONTES) paineis[f] = criarPainel(f);

  // A atividade diz qual fonte motivou a abertura da aba. A tela espera o
  // clique; a câmera pode subir sozinha, mas só depois que a página apareceu —
  // pedir permissão numa aba que o navegador acabou de abrir em segundo plano
  // deixaria o pedido preso sem ninguém ver.
  const pedida = query.get('fonte');
  if (FONTES.includes(pedida)) atenderPedido(pedida);
}

/**
 * Aplica as opções escolhidas no modal da Activity, que chegam pela URL.
 *
 * Com elas definidas, os seletores saem de cena: repetir a mesma escolha aqui
 * só confundiria. Sem elas, a página segue mostrando os controles.
 */
function applyPresets() {
  const q = query.get('q');
  const fps = query.get('fps');
  const som = query.get('som');

  // O que vem da atividade é ponto de partida, não decisão final: a caixa fica
  // à vista. Ela sumia enquanto esta página só existia para o primeiro clique
  // — agora a tela também nasce daqui, com a aba já aberta, e aí a escolha do
  // som feita lá atrás pode não ser a que se quer agora.
  if (som !== null) $('withAudio').checked = som === '1';

  if (!q && !fps) return;

  if (q) $('quality').value = q;
  if (fps) $('fps').value = fps;

  for (const row of document.querySelectorAll('#setup .row')) row.hidden = true;

  // Sem " · com som": a caixa está à vista e pode ser trocada, então repetir o
  // estado dela aqui só criaria um rótulo que envelhece no primeiro clique.
  const mbps = (Number($('quality').value) / 1e6).toFixed(1).replace('.', ',');
  $('presetLine').textContent = `${mbps} Mb/s · ${$('fps').value} fps`;
  $('presetLine').hidden = false;
}

// Mantém o vídeo como está e troca só de onde vem o som — a única fonte que
// não carrega o Discord junto é uma aba.
$('somAba').addEventListener('click', async () => {
  if (!paineis.tela?.ativo()) return;
  try {
    await paineis.tela.trocarSom();
    paineis.tela.setStatus('Som ligado, vindo da aba escolhida.', 'ok');
    $('somAba').textContent = 'Trocar a aba do som';
  } catch (err) {
    // Cancelar a segunda janela é escolha, não falha.
    if (err.name !== 'NotAllowedError') paineis.tela.setStatus(err.message, 'error');
  }
});

window.addEventListener('beforeunload', () => {
  for (const f of FONTES) paineis[f]?.parar();
});
