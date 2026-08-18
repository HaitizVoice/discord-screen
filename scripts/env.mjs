/**
 * Leitura e escrita do arquivo .env, compartilhadas pelo assistente e pelo túnel.
 *
 * Escrita por chave, nunca reescrevendo o arquivo inteiro: o túnel troca só o
 * endereço público e não pode encostar nas credenciais que a pessoa digitou.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ARQUIVO = path.join(RAIZ, '.env');

/** @returns {Record<string,string>} vazio se o arquivo ainda não existe. */
export function lerEnv() {
  try {
    const pares = fs
      .readFileSync(ARQUIVO, 'utf8')
      .split('\n')
      .map((linha) => linha.trim())
      .filter((linha) => linha && !linha.startsWith('#') && linha.includes('='))
      .map((linha) => {
        const corte = linha.indexOf('=');
        return [linha.slice(0, corte).trim(), linha.slice(corte + 1).trim()];
      });
    return Object.fromEntries(pares);
  } catch {
    return {};
  }
}

/**
 * Grava as chaves recebidas, preservando o resto do arquivo.
 *
 * O arquivo é recriado com comentários fixos em vez de remendado linha a linha:
 * é uma dúzia de chaves, e um .env legível vale mais do que preservar a ordem
 * em que alguém digitou.
 */
export function gravarEnv(novos) {
  const v = { ...lerEnv(), ...novos };

  const linhas = [
    '# Configuração da Sala de Tela.',
    '# Criado por "npm run configurar" — rode de novo para mudar qualquer coisa.',
    '# Este arquivo tem senhas: não mande para ninguém nem publique no GitHub.',
    '',
    '# Assina o crachá de quem entra nas salas. Gerado sozinho, não precisa mexer.',
    `SESSION_SECRET=${v.SESSION_SECRET ?? ''}`,
    '',
    '# Porta em que o programa roda no seu computador.',
    `PORT=${v.PORT ?? '3001'}`,
    '',
    '# Endereço público pelo qual o Discord alcança o seu computador.',
    '# Atualizado sozinho toda vez que você roda "npm run tunel".',
    `PUBLIC_ORIGIN=${v.PUBLIC_ORIGIN ?? 'http://localhost:3001'}`,
    '',
    '# Credenciais da sua aplicação no site do Discord.',
    '# Vazias = o programa funciona só no navegador, fora do Discord.',
    `DISCORD_CLIENT_ID=${v.DISCORD_CLIENT_ID ?? ''}`,
    `DISCORD_CLIENT_SECRET=${v.DISCORD_CLIENT_SECRET ?? ''}`,
    '',
    '# Token do bot. Opcional: sem ele tudo funciona, menos a "Sala da call",',
    '# que precisa confirmar com o Discord quem está no canal de voz.',
    `DISCORD_BOT_TOKEN=${v.DISCORD_BOT_TOKEN ?? ''}`,
    '',
    '# Deixe "production" quando publicar de verdade.',
    `NODE_ENV=${v.NODE_ENV ?? 'development'}`,
    '',
  ];

  fs.writeFileSync(ARQUIVO, linhas.join('\n'));
}

export const cor = {
  fim: '\x1b[0m',
  forte: '\x1b[1m',
  fraco: '\x1b[2m',
  azul: '\x1b[38;5;69m',
  verde: '\x1b[32m',
  vermelho: '\x1b[31m',
  amarelo: '\x1b[33m',
};
