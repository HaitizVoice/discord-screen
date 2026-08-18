/**
 * Sobe o túnel que deixa este computador acessível de fora.
 *
 * Dois modos, e quem decide é o `.env`:
 *
 * - Com `TUNEL_CONFIG` apontando para um túnel próprio, o endereço é fixo. É o
 *   que evita ter que trocar o "Target" no portal do Discord a cada reinício —
 *   o último passo manual que sobrava.
 * - Sem ele, um túnel descartável, com endereço novo a cada execução. O
 *   endereço é gravado no `.env` na hora: copiá-lo à mão era o passo mais fácil
 *   de esquecer, e com o sintoma mais enganoso de todos — tudo abre normalmente
 *   e só o botão de compartilhar leva a uma aba morta.
 *
 * O binário é resolvido por ./cloudflared.mjs, que baixa o release oficial se
 * ainda não houver nenhum. Ninguém precisa instalar nada antes.
 */
import { spawn } from 'node:child_process';

import { lerEnv, gravarEnv, cor } from './env.mjs';
import { garantirCloudflared } from './cloudflared.mjs';

const env = lerEnv();
const PORTA = env.PORT || '3001';
const CONFIG = env.TUNEL_CONFIG || '';
const ENDERECO = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

// --no-autoupdate: o cloudflared se atualiza sozinho e reinicia no meio do
// caminho, derrubando o túnel sem explicação. Quem manda na versão aqui é o
// ./cloudflared.mjs.
const args = CONFIG
  ? ['--config', CONFIG, 'tunnel', '--no-autoupdate', 'run']
  : ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORTA}`];

let cloudflared;
try {
  cloudflared = await garantirCloudflared();
} catch (err) {
  console.log(`\n${cor.vermelho}  ${err.message}${cor.fim}\n`);
  process.exit(1);
}

console.log(`\n${cor.fraco}  Abrindo o túnel para localhost:${PORTA}…${cor.fim}`);
if (CONFIG) {
  console.log(`${cor.verde}  ${env.PUBLIC_ORIGIN || '(endereço definido no config do túnel)'}${cor.fim}`);
}
console.log(`${cor.fraco}  Deixe esta janela aberta enquanto estiver usando.${cor.fim}\n`);

// Sem shell: o caminho do binário vem resolvido, então não há .cmd no meio.
const tunel = spawn(cloudflared, args, { stdio: ['ignore', 'pipe', 'pipe'] });

let achado = null;

function observar(pedaco) {
  const texto = pedaco.toString();

  // O cloudflared escreve o essencial no stderr; sem repassar, um erro de rede
  // aqui vira uma janela parada sem explicação nenhuma.
  process.stderr.write(texto);

  // Só o túnel descartável anuncia endereço; o próprio já tem o dele no .env.
  const url = texto.match(ENDERECO)?.[0];
  if (!url || url === achado) return;

  achado = url;
  gravarEnv({ PUBLIC_ORIGIN: url });

  const dominio = url.replace('https://', '');
  console.log(`\n${cor.verde}${cor.forte}  Endereço do túnel: ${url}${cor.fim}`);
  console.log(`${cor.fraco}  Já guardei no .env — não precisa copiar.${cor.fim}\n`);
  console.log('  No site do Discord, em Activities → URL Mappings, o "Target" deve ser:');
  console.log(`\n      ${cor.verde}${dominio}${cor.fim}\n`);
  console.log(`${cor.fraco}  (esse endereço muda toda vez que este comando reinicia)${cor.fim}\n`);
}

tunel.stdout.on('data', observar);
tunel.stderr.on('data', observar);

tunel.on('error', (err) => {
  console.log(`\n${cor.vermelho}  Não consegui executar o cloudflared: ${err.message}${cor.fim}\n`);
  process.exit(1);
});

tunel.on('close', (codigo) => {
  if (!CONFIG && !achado) {
    console.log(`\n${cor.vermelho}  O túnel fechou sem gerar endereço (código ${codigo}).${cor.fim}`);
    console.log(`${cor.fraco}  Verifique sua conexão e rode "npm run tunel" de novo.${cor.fim}\n`);
  }
  process.exit(codigo ?? 0);
});

// Ctrl+C fecha os dois juntos; sem isto o cloudflared fica rodando escondido.
for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, () => tunel.kill());
}
