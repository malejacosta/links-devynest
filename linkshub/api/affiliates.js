// Panel de afiliados — solo admin.
// GET /api/affiliates          → resumen de todos los afiliados con comisiones
// GET /api/affiliates?ref=code → detalle de un afiliado específico
//
// Estructura Redis:
//   ref:{uid}           → código del afiliado que refirió al usuario
//   aff:{code}:users    → SET de UIDs referidos por este afiliado
//   sub:{uid}           → suscripción (status, expiresAt, amount, currency, email)
//   user:{uid}          → datos del usuario (email, country, lastSeen)

import { redis } from './_redis.js';
import { AFFILIATES, DEFAULT_COMMISSION } from './_config.js';
import { verifyFirebaseToken, extractBearerToken } from './_auth.js';

function isAdminEmail(email) {
  const adminEmail = process.env.ADMIN_EMAIL;
  return adminEmail && email && email.toLowerCase() === adminEmail.toLowerCase();
}

function isActive(sub) {
  if (!sub) return false;
  return sub.status === 'active' && new Date(sub.expiresAt) > new Date();
}

function commissionRate(code) {
  return AFFILIATES[code?.toLowerCase()]?.commission ?? DEFAULT_COMMISSION;
}

// Obtiene los datos completos de un usuario referido
async function getUserData(uid) {
  const [userRaw, subRaw] = await Promise.all([
    redis.get(`user:${uid}`).catch(() => null),
    redis.get(`sub:${uid}`).catch(() => null),
  ]);

  const user = userRaw ? JSON.parse(userRaw) : { uid, email: null };
  const sub  = subRaw  ? JSON.parse(subRaw)  : null;
  const active = isActive(sub);

  return {
    uid,
    email:       user.email   || null,
    country:     user.country || null,
    lastSeen:    user.lastSeen || null,
    active,
    expiresAt:   sub?.expiresAt   || null,
    activatedAt: sub?.activatedAt || null,
    amount:      sub?.amount      || null,
    currency:    sub?.currency    || null,
    paymentProvider: sub?.paymentProvider || null,
    commissionDue: active && sub?.amount
      ? parseFloat((sub.amount * commissionRate(null)).toFixed(2)) // se sobreescribe abajo con el rate correcto
      : 0,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://go.devynest.com');
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
      const code = ref.toLowerCase();
      const rate = commissionRate(code);
      const uids = await redis.smembers(`aff:${code}:users`).catch(() => []);

      const users = await Promise.all(uids.map(async uid => {
        const d = await getUserData(uid);
        // Aplicar la tasa correcta de este afiliado
        d.commissionDue = d.active && d.amount
          ? parseFloat((d.amount * rate).toFixed(2))
          : 0;
        return d;
      }));

      // Ordenar: activos primero, luego por email
      users.sort((a, b) => {
        if (a.active !== b.active) return a.active ? -1 : 1;
        return (a.email || '').localeCompare(b.email || '');
      });

      const summary = buildSummary(users, rate);

      return res.status(200).json({ ref: code, commissionRate: rate, summary, users });
    }

    // ── Resumen de TODOS los afiliados ────────────────────────────────────
    const results = [];

    for (const [code, cfg] of Object.entries(AFFILIATES)) {
      const rate = cfg.commission ?? DEFAULT_COMMISSION;
      const uids = await redis.smembers(`aff:${code}:users`).catch(() => []);

      const users = await Promise.all(uids.map(async uid => {
        const d = await getUserData(uid);
        d.commissionDue = d.active && d.amount
          ? parseFloat((d.amount * rate).toFixed(2))
          : 0;
        return d;
      }));

      results.push({
        code,
        commissionRate: rate,
        summary: buildSummary(users, rate),
        users: users.sort((a, b) => {
          if (a.active !== b.active) return a.active ? -1 : 1;
          return (a.email || '').localeCompare(b.email || '');
        }),
      });
    }

    return res.status(200).json({ affiliates: results });

  } catch (err) {
    console.error('[affiliates] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

// Construye el resumen de activos/inactivos y comisiones por moneda
function buildSummary(users, rate) {
  const activeUsers   = users.filter(u => u.active);
  const inactiveUsers = users.filter(u => !u.active);

  // Agrupar comisiones por moneda
  const byCurrency = {};
  for (const u of activeUsers) {
    if (!u.amount || !u.currency) continue;
    if (!byCurrency[u.currency]) byCurrency[u.currency] = { activeUsers: 0, grossAmount: 0, commissionDue: 0 };
    byCurrency[u.currency].activeUsers++;
    byCurrency[u.currency].grossAmount   = parseFloat((byCurrency[u.currency].grossAmount + u.amount).toFixed(2));
    byCurrency[u.currency].commissionDue = parseFloat((byCurrency[u.currency].commissionDue + u.amount * rate).toFixed(2));
  }

  return {
    totalUsers:    users.length,
    activeUsers:   activeUsers.length,
    inactiveUsers: inactiveUsers.length,
    byCurrency,   // { UYU: { activeUsers, grossAmount, commissionDue }, BRL: {...} }
  };
}
