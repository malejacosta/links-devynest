// Cliente Redis sobre HTTP (Upstash REST API) — sin dependencias npm
// Soporta las variantes de nombres de env vars de Vercel Marketplace:
//   - UPSTASH_REDIS_REST_URL  + UPSTASH_REDIS_REST_TOKEN  (Upstash directo)
//   - KV_REST_API_URL         + KV_REST_API_TOKEN          (Vercel KV legacy)

function getConfig() {
  const url =
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL;

  const token =
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    const found = [];
    if (process.env.UPSTASH_REDIS_REST_URL)   found.push('UPSTASH_REDIS_REST_URL');
    if (process.env.UPSTASH_REDIS_REST_TOKEN) found.push('UPSTASH_REDIS_REST_TOKEN');
    if (process.env.KV_REST_API_URL)          found.push('KV_REST_API_URL');
    if (process.env.KV_REST_API_TOKEN)        found.push('KV_REST_API_TOKEN');

    throw new Error(
      `[redis] Faltan env vars. Encontradas: [${found.join(', ') || 'ninguna'}]. ` +
      `Requeridas: UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (o KV_REST_API_URL + KV_REST_API_TOKEN)`
    );
  }

  return { url, token };
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
