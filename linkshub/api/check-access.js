// Verifica si un usuario tiene suscripción activa.
// El frontend envía el Firebase UID (no un secreto, es solo un identificador).

import { redis } from './_redis.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { uid } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'uid requerido' });

  try {
    const raw = await redis.get(`sub:${uid}`);

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
    });
  } catch (err) {
    console.error('[check-access] Error:', err.message);
    return res.status(500).json({ error: 'Error al verificar acceso.', detail: err.message });
  }
}
