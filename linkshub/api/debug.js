// Endpoint de diagnóstico — ELIMINAR después de resolver el problema
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // 1. Qué vars están configuradas
  const vars = [
    'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
    'KV_REST_API_URL', 'KV_REST_API_TOKEN',
    'KV_URL', 'REDIS_URL', 'REDIS_TOKEN',
  ];
  const found   = vars.filter(v => !!process.env[v]);
  const missing = vars.filter(v => !process.env[v]);

  // 2. Derivar credenciales REST (misma lógica que _redis.js)
  let url   = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  let token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  let urlSource = url
    ? (process.env.UPSTASH_REDIS_REST_URL ? 'UPSTASH_REDIS_REST_URL' : 'KV_REST_API_URL')
    : null;

  // Fallback: parsear REDIS_URL
  let parsedFromRedisUrl = false;
  if (!url && process.env.REDIS_URL) {
    try {
      const parsed = new URL(process.env.REDIS_URL);
      url   = `https://${parsed.hostname}`;
      token = parsed.password;
      urlSource = `REDIS_URL → https://${parsed.hostname}`;
      parsedFromRedisUrl = true;
    } catch (e) {
      urlSource = `REDIS_URL parse error: ${e.message}`;
    }
  }

  // 3. Ping
  let pingResult = null;
  let pingError  = null;
  if (url && token) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(['PING']),
      });
      const json = await r.json();
      pingResult = { status: r.status, result: json.result ?? json };
    } catch (e) {
      pingError = e.message;
    }
  } else {
    pingError = 'No se encontraron URL ni TOKEN para conectar.';
  }

  return res.status(200).json({
    env: { found, missing },
    urlSource,
    parsedFromRedisUrl,
    ping: pingResult,
    pingError,
  });
}
