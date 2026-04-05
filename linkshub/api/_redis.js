// Cliente Redis sobre HTTP (Upstash REST API) — sin dependencias npm
// Variables de entorno requeridas:
//   UPSTASH_REDIS_REST_URL   → ej: https://xxxx.upstash.io
//   UPSTASH_REDIS_REST_TOKEN → token de autenticación

async function cmd(...args) {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error('[redis] Faltan UPSTASH_REDIS_REST_URL o UPSTASH_REDIS_REST_TOKEN');
  }

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
    throw new Error(`[redis] Error: ${json.error}`);
  }

  return json.result;
}

export const redis = {
  set:    (key, value)  => cmd('SET', key, value),
  get:    (key)         => cmd('GET', key),
  exists: (key)         => cmd('EXISTS', key),
};
