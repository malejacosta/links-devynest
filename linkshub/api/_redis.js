// Cliente Redis sobre HTTP (Upstash REST API) — sin dependencias npm
//
// Soporta estas env vars (en orden de prioridad):
//   1. UPSTASH_REDIS_REST_URL  + UPSTASH_REDIS_REST_TOKEN  (REST directo)
//   2. KV_REST_API_URL         + KV_REST_API_TOKEN          (Vercel KV legacy)
//   3. REDIS_URL               (TCP URL de Upstash → se deriva REST automáticamente)
//      formato: rediss://default:TOKEN@host.upstash.io:6379

function getConfig() {
  // Prioridad 1: vars REST explícitas
  const restUrl   = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const restToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (restUrl && restToken) {
    return { url: restUrl, token: restToken };
  }

  // Prioridad 2: REDIS_URL — parsear URL TCP de Upstash para derivar REST
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    try {
      const parsed = new URL(redisUrl);
      // rediss://default:TOKEN@host.upstash.io:6379
      const host  = parsed.hostname;  // host.upstash.io
      const token = parsed.password;  // TOKEN
      if (host && token) {
        return { url: `https://${host}`, token };
      }
      throw new Error('No se pudo extraer host o token de REDIS_URL');
    } catch (e) {
      throw new Error(`[redis] REDIS_URL inválida: ${e.message}`);
    }
  }

  // Sin credenciales
  const found = [
    'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
    'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'REDIS_URL',
  ].filter(v => !!process.env[v]);

  throw new Error(
    `[redis] Sin credenciales Redis. Encontradas: [${found.join(', ') || 'ninguna'}]. ` +
    'Necesitás REDIS_URL o UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.'
  );
}

async function cmd(...args) {
  const { url, token } = getConfig();

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[redis] HTTP ${res.status}: ${text}`);
  }

  const json = await res.json();

  if (json.error) {
    throw new Error(`[redis] ${json.error}`);
  }

  return json.result;
}

export const redis = {
  set:    (key, value) => cmd('SET', key, value),
  get:    (key)        => cmd('GET', key),
  exists: (key)        => cmd('EXISTS', key),
};