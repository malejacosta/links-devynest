// Endpoint de diagnóstico — ELIMINAR después de resolver el problema
import { redis } from './_redis.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // 1. Qué vars están configuradas
  const vars = [
    'REDIS_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN',
    'KV_REST_API_URL', 'KV_REST_API_TOKEN',
  ];
  const found   = vars.filter(v => !!process.env[v]);
  const missing = vars.filter(v => !process.env[v]);

  // 2. Mostrar host (sin token)
  let urlInfo = null;
  if (process.env.REDIS_URL) {
    try {
      const parsed = new URL(process.env.REDIS_URL);
      urlInfo = `${parsed.protocol}//${parsed.username}@${parsed.hostname}:${parsed.port}`;
    } catch (e) {
      urlInfo = `parse error: ${e.message}`;
    }
  }

  // 3. Ping via ioredis
  let pingResult = null;
  let pingError  = null;
  try {
    const result = await redis.get('__ping__');
    pingResult = result === null ? 'OK (key not found, pero Redis responde)' : result;
  } catch (e) {
    pingError = e.message;
  }

  return res.status(200).json({
    env: { found, missing },
    urlInfo,
    ping: pingResult,
    pingError,
  });
}
