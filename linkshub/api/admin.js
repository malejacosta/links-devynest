// API del panel admin.
// Acciones: list, activate, deactivate.
// Requiere Firebase ID token válido en header Authorization: Bearer <token>
// El email del token debe coincidir con ADMIN_EMAIL (env var).

import { redis } from './_redis.js';
import { verifyFirebaseToken, extractBearerToken } from './_auth.js';

const PLAN_SECONDS = 30 * 24 * 60 * 60; // 30 días

function isAdmin(email) {
  const adminEmail = process.env.ADMIN_EMAIL;
  return adminEmail && email && email.toLowerCase() === adminEmail.toLowerCase();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://go.devynest.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── Verificar admin via Firebase token ───────────────────────────────────
  const idToken = extractBearerToken(req);

  if (!idToken) {
    return res.status(401).json({ error: 'Token de autenticación requerido.' });
  }

  let firebaseUser;
  try {
    firebaseUser = await verifyFirebaseToken(idToken);
  } catch (e) {
    console.warn('[admin] Token inválido:', e.message);
    return res.status(401).json({ error: 'Token inválido o expirado.' });
  }

  if (!isAdmin(firebaseUser?.email)) {
    return res.status(403).json({ error: 'Acceso denegado.' });
  }

  // ── GET: listar usuarios ──────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const uids = await redis.smembers('users:index');

      const users = await Promise.all(uids.map(async (uid) => {
        const [userRaw, subRaw] = await Promise.all([
          redis.get(`user:${uid}`),
          redis.get(`sub:${uid}`),
        ]);

        const userInfo = userRaw ? JSON.parse(userRaw) : { uid, email: '—' };
        let subscription = { active: false };

        if (subRaw) {
          const sub = JSON.parse(subRaw);
          const expired = new Date(sub.expiresAt) < new Date();
          subscription = {
            active:    !expired,
            expiresAt: sub.expiresAt,
            paymentId: sub.paymentId,
          };
        }

        return { ...userInfo, subscription };
      }));

      // Ordenar: activos primero, luego por email
      users.sort((a, b) => {
        if (a.subscription.active !== b.subscription.active)
          return a.subscription.active ? -1 : 1;
        return (a.email || '').localeCompare(b.email || '');
      });

      return res.status(200).json({ users });
    } catch (err) {
      console.error('[admin] Error al listar:', err.message);
      return res.status(500).json({ error: 'Error al obtener usuarios.', detail: undefined });
    }
  }

  // ── POST: activate / deactivate ───────────────────────────────────────────
  if (req.method === 'POST') {
    const { action, targetUid } = req.body || {};

    if (!targetUid) return res.status(400).json({ error: 'targetUid requerido' });
    if (!['activate', 'deactivate'].includes(action)) {
      return res.status(400).json({ error: 'action debe ser activate o deactivate' });
    }

    try {
      if (action === 'activate') {
        // Obtener email del usuario para registrarlo correctamente
        const userRaw = await redis.get(`user:${targetUid}`);
        const userEmail = userRaw ? JSON.parse(userRaw).email : null;

        const sub = {
          status:          'active',
          uid:             targetUid,
          email:           userEmail,
          paymentId:       'manual',
          activatedAt:     new Date().toISOString(),
          expiresAt:       new Date(Date.now() + PLAN_SECONDS * 1000).toISOString(),
          activatedByAdmin: true,
        };
        await redis.setex(`sub:${targetUid}`, PLAN_SECONDS, JSON.stringify(sub));
        console.log(`[admin] ✅ Activado manualmente: ${targetUid} (${userEmail})`);
        return res.status(200).json({ ok: true, action: 'activated', expiresAt: sub.expiresAt });
      }

      if (action === 'deactivate') {
        await redis.del(`sub:${targetUid}`);
        console.log(`[admin] ❌ Desactivado: ${targetUid}`);
        return res.status(200).json({ ok: true, action: 'deactivated' });
      }
    } catch (err) {
      console.error('[admin] Error al ejecutar acción:', err.message);
      return res.status(500).json({ error: 'Error al ejecutar acción.', detail: undefined });
    }
  }

  return res.status(405).end();
}
