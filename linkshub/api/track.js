// Registra vistas y clicks en páginas públicas.
// POST /api/track  { id, event: 'view'|'click', target? }
// Sin autenticación — llamado desde páginas públicas.
// Fail-silent: nunca rompe la experiencia del usuario.

import { redis } from './_redis.js';

const STAT_TTL = 365 * 24 * 60 * 60; // 1 año

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(200).end();

  const { id, event, target } = req.body || {};
  if (!id || !event) return res.status(200).end();
  if (!['view', 'click'].includes(event)) return res.status(200).end();

  // Validar que el id sea un hex de 10 chars (nunca slugs — siempre mandamos el hex desde el frontend)
  if (!/^[a-f0-9]{10}$/.test(id)) return res.status(200).end();

  try {
    if (event === 'view') {
      const key = `analytics:views:${id}`;
      await redis.incr(key);
      await redis.expire(key, STAT_TTL);
    } else if (event === 'click' && target) {
      // Sanitizar target para que sea seguro como parte de una clave Redis
      const safe = String(target).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
      const key = `analytics:clicks:${id}:${safe}`;
      await redis.incr(key);
      await redis.expire(key, STAT_TTL);
    }
  } catch (_) {
    // Siempre ignorar errores en tracking — nunca impactar al visitante
  }

  return res.status(200).end();
}
