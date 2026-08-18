/**
 * Sobe o túnel e já grava o endereço no .env.
 *
 * O endereço muda a cada execução, e copiá-lo para o .env na mão era o passo
 * mais fácil de esquecer — com o sintoma mais enganoso de todos: tudo abre
 * normalmente e só o botão de compartilhar leva a uma aba morta.
 *
 * O binário vem por npx, sob demanda. É o que evita "instale o cloudflared"
 * como pré-requisito, que é onde muita gente para.
 */
import { spawn } from 'node:child_process';

import { lerEnv, gravarEnv, cor } from './env.mjs';

const PORTA = lerEnv().PORT || '3001';
const ENDERECO = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

console.log(`\n${cor.fraco}  Abrindo o túnel para localhost:${PORTA}…${cor.fim}`);
console.log(`${cor.fraco}  Na primeira vez isso baixa o cloudflared e demora um pouco.${cor.fim}`);
console.log(`${cor.fraco}  Deixe esta janela aberta enquanto estiver usando.${cor.fim}\n`);

// shell: true porque no Windows o npx é um .cmd, que não é executável direto.
const tunel = spawn('npx', ['-y', 'cloudflared', 'tunnel', '--url', `http://localhost:${PORTA}`], {
  shell: true,
});

let achado = null;

function observar(pedaco) {
  const texto = pedaco.toString();

  // O cloudflared escreve o essencial no stderr; sem repassar, um erro de rede
  // aqui vira uma janela parada sem explicação nenhuma.
  process.stderr.write(texto);

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

tunel.on('close', (codigo) => {
  if (!achado) {
    console.log(`\n${cor.vermelho}  O túnel fechou sem gerar endereço (código ${codigo}).${cor.fim}`);
    console.log(`${cor.fraco}  Verifique sua conexão e rode "npm run tunel" de novo.${cor.fim}\n`);
  }
  process.exit(codigo ?? 0);
});

// Ctrl+C fecha os dois juntos; sem isto o cloudflared fica rodando escondido.
for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, () => tunel.kill());
}
