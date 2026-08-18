import crypto from 'node:crypto';

const SECRET = process.env.SESSION_SECRET || 'dev-inseguro-troque-isto';

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function hmac(data) {
  return crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
}

/**
 * Token assinado e curto, sem dependência externa.
 * Formato: <payload base64url>.<hmac base64url>
 *
 * `ttlSeconds` é opcional. Tokens de sala não expiram de propósito: a sala
 * fecha quando esvazia e o id dela é aleatório, então a própria vida da sala
 * já limita o token. Um prazo separado só criaria a chance de expirar no meio
 * de uma sessão. Já a identidade, que não está presa a nenhuma sala, expira.
 */
export function signToken(payload, ttlSeconds = null) {
  const claims = { ...payload };
  if (ttlSeconds) claims.exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  return (() => {
    const body = b64url(JSON.stringify(claims));
    return `${body}.${hmac(body)}`;
  })();
}

export function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;

  const expected = hmac(body);
  // Comparação em tempo constante — evita vazar o segredo por timing.
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return null;
  }

  // Sem `exp` o token não expira — ver a nota em signToken.
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}
