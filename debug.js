// Endpoint de diagnóstico — ELIMINAR después de resolver el problema
// Solo revela NOMBRES de variables de entorno, nunca valores

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Qué vars Redis existen (nombres solamente)
  const redisVars = [
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'KV_REST_API_URL',
    'KV_REST_API_TOKEN',
    'KV_URL',
    'REDIS_URL',
    'REDIS_TOKEN',
  ];

  const found    = redisVars.filter(v => !!process.env[v]);
  const missing  = redisVars.filter(v => !process.env[v]);

  // Intentar un ping real a Redis con lo que esté configurado
  const url   = process.env.UPSTASH_REDIS_REST_URL
             || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN
             || process.env.KV_REST_API_TOKEN;

  let pingResult = null;
  let pingError  = null;

  if (url && token) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(['PING']),
      });
      const json = await r.json();
      pingResult = { status: r.status, result: json.result || json };
    } catch (err) {
      pingError = err.message;
    }
  } else {
    pingError = 'No se encontraron URL ni TOKEN para conectar.';
  }

  return res.status(200).json({
    env: { found, missing },
    urlSource: process.env.UPSTASH_REDIS_REST_URL
      ? 'UPSTASH_REDIS_REST_URL'
      : process.env.KV_REST_API_URL
        ? 'KV_REST_API_URL'
        : null,
    ping: pingResult,
    pingError,
  });
}
