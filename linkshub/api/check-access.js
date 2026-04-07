// Verifica si un usuario tiene suscripción activa.
// Admins bypasean el check de pago.
// Registra cada usuario en el índice para el panel admin.

import { redis } from './_redis.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { uid, email } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'uid requerido' });

  // ── Admin bypass ──────────────────────────────────────────────────────────
  const adminEmail = process.env.ADMIN_EMAIL;
  if (adminEmail && email && email.toLowerCase() === adminEmail.toLowerCase()) {
    const pubId = await redis.get(`pub:${uid}`).catch(() => null);
    return res.status(200).json({ active: true, isAdmin: true, pubId: pubId || null });
  }

  // ── Registrar usuario en índice (para panel admin) ────────────────────────
  if (uid && email) {
    try {
      await redis.sadd('users:index', uid);
      // Solo actualizar si no existe o para refrescar lastSeen
      await redis.set(`user:${uid}`, JSON.stringify({
        uid,
        email,
        lastSeen: new Date().toISOString(),
      }));
    } catch (e) {
      // No bloquear el flujo si falla el registro
      console.warn('[check-access] No se pudo registrar usuario:', e.message);
    }
  }

  // ── Verificar suscripción ─────────────────────────────────────────────────
  try {
    const [raw, pubId] = await Promise.all([
      redis.get(`sub:${uid}`),
      redis.get(`pub:${uid}`).catch(() => null),
    ]);

    if (!raw) {
      return res.status(200).json({ active: false, reason: 'no_subscription' });
    }

    const sub = JSON.parse(raw);
    const expired = new Date(sub.expiresAt) < new Date();

    if (expired) {
      return res.status(200).json({ active: false, reason: 'expired', expiresAt: sub.expiresAt });
    }

    return res.status(200).json({
      active:    true,
      expiresAt: sub.expiresAt,
      email:     sub.email,
      pubId:     pubId || null,
    });
  } catch (err) {
    console.error('[check-access] Error:', err.message);
    return res.status(500).json({ error: 'Error al verificar acceso.', detail: err.message });
  }
}
