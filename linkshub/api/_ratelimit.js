// Rate limiter por IP usando Redis como contador con ventana deslizante.
// Protege endpoints de pago contra bots y abuso.
// Fail-open: si Redis falla, deja pasar la solicitud (mejor UX que bloquear clientes reales).

import { redis } from './_redis.js';

const WINDOW_SECONDS = 60; // ventana de 1 minuto

const LIMITS = {
  payment: 5,   // 5 intentos de pago por minuto por IP (suficiente para un humano)
  default: 60,  // endpoints generales — 60 req/min
};

/**
 * Verifica si una IP excedió el límite de solicitudes.
 * @param {object} req  - Request de Vercel (para leer x-forwarded-for)
 * @param {string} type - Tipo de límite: 'payment' | 'default'
 * @returns {boolean}   - true = permitido, false = bloqueado
 */
export async function checkRateLimit(req, type = 'default') {
  const rawIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown';

  // Sanitizar IP para usarla como clave Redis
  const safeIp = rawIp.replace(/[^a-zA-Z0-9.:_-]/g, '_');
  const key    = `rl:${type}:${safeIp}`;
  const max    = LIMITS[type] ?? LIMITS.default;

  try {
    const count = await redis.incr(key);
    // Solo setear expiración en el primer request (count === 1)
    if (count === 1) await redis.expire(key, WINDOW_SECONDS);

    if (count > max) {
      console.warn(`[ratelimit] Bloqueado — IP: ${rawIp}, tipo: ${type}, count: ${count}/${max}`);
      return false;
    }
    return true;
  } catch (e) {
    // Fail-open: si Redis no responde, no bloquear al cliente
    console.warn('[ratelimit] Error Redis, fail-open:', e.message);
    return true;
  }
}
