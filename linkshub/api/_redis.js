// Cliente Redis usando ioredis (TCP/TLS)
// Compatible con Redis Labs, Redis Cloud, Upstash (modo TCP)
// Usa la variable de entorno REDIS_URL

import Redis from 'ioredis';

let client = null;

function getClient() {
  if (client && client.status === 'ready') return client;

  const url = process.env.REDIS_URL;
  if (!url) {
    const found = [
      'REDIS_URL', 'UPSTASH_REDIS_REST_URL', 'KV_REST_API_URL',
    ].filter(v => !!process.env[v]);
    throw new Error(
      `[redis] Sin credenciales. Encontradas: [${found.join(', ') || 'ninguna'}]. ` +
      'Necesitás REDIS_URL.'
    );
  }

  client = new Redis(url, {
    tls: url.startsWith('rediss://') ? { rejectUnauthorized: true } : undefined,
    maxRetriesPerRequest: 3,
    connectTimeout: 10000,
    lazyConnect: false,
    enableReadyCheck: false,
  });

  client.on('error', (err) => {
    console.error('[redis] Error de conexión:', err.message);
  });

  return client;
}

export const redis = {
  set:      (key, value)           => getClient().set(key, value),
  setex:    (key, seconds, value)  => getClient().setex(key, seconds, value),
  get:      (key)                  => getClient().get(key),
  exists:   (key)                  => getClient().exists(key),
  del:      (key)                  => getClient().del(key),
  sadd:     (key, ...members)      => getClient().sadd(key, ...members),
  smembers: (key)                  => getClient().smembers(key),
  // Scan incremental — nunca bloquea el servidor como KEYS *
  scan:     (cursor, ...args)      => getClient().scan(cursor, ...args),
  // Info de memoria
  info:     (section)              => getClient().info(section),
};
