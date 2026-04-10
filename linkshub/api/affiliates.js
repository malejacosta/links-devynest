// Panel de afiliados — solo admin.
// GET /api/affiliates?email=admin@...         → resumen de todos los afiliados
// GET /api/affiliates?email=admin@...&ref=aislan → detalle del afiliado
//
// Estructura de datos en Redis:
//   ref:{uid}            → código del afiliado (quién lo refirió)
//   aff:{code}:users     → SET de UIDs de usuarios referidos por ese afiliado
//   sub:{uid}            → suscripción del usuario (incluye ref y affiliateType)

import { redis } from './_redis.js';
import { AFFILIATES } from './_config.js';
import { verifyFirebaseToken, extractBearerToken } from './_auth.js';

function isAdminEmail(email) {
  const adminEmail = process.env.ADMIN_EMAIL;
  return adminEmail && email && email.toLowerCase() === adminEmail.toLowerCase();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  // ── Verificar admin via Firebase token ───────────────────────────────────
  const idToken = extractBearerToken(req);
  if (!idToken) return res.status(401).json({ error: 'Token de autenticación requerido.' });

  let firebaseUser;
  try {
    firebaseUser = await verifyFirebaseToken(idToken);
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido o expirado.' });
  }
  if (!isAdminEmail(firebaseUser?.email)) {
    return res.status(403).json({ error: 'No autorizado' });
  }

  const { ref } = req.query;

  try {
    if (ref) {
      // ── Detalle de un afiliado específico ─────────────────────────────────
      const cfg = AFFILIATES[ref.toLowerCase()];
      if (!cfg) return res.status(404).json({ error: 'Afiliado no encontrado' });

      const uids = await redis.smembers(`aff:${ref}:users`).catch(() => []);

      const users = [];
      for (const uid of uids) {
        const [userData, subData] = await Promise.all([
          redis.get(`user:${uid}`).catch(() => null),
          redis.get(`sub:${uid}`).catch(() => null),
        ]);
        users.push({
          uid,
          email:     userData ? JSON.parse(userData).email : null,
          country:   userData ? JSON.parse(userData).country : null,
          sub:       subData  ? (({ status, expiresAt, activatedAt, amount, currency, paymentProvider }) =>
                      ({ status, expiresAt, activatedAt, amount, currency, paymentProvider })
                    )(JSON.parse(subData)) : null,
        });
      }

      return res.status(200).json({
        ref,
        config: cfg,
        userCount: users.length,
        users,
      });
    }

    // ── Resumen de todos los afiliados ────────────────────────────────────
    const summary = [];
    for (const [code, cfg] of Object.entries(AFFILIATES)) {
      const uids = await redis.smembers(`aff:${code}:users`).catch(() => []);
      summary.push({
        code,
        discount:    Math.round(cfg.discount * 100) + '%',
        type:        cfg.type,
        months:      cfg.months || null,
        userCount:   uids.length,
      });
    }

    return res.status(200).json({ affiliates: summary });
  } catch (err) {
    console.error('[affiliates] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
