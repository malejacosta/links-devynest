// Devuelve estadísticas reales de la página publicada del usuario autenticado.
// GET /api/stats  (requiere Authorization: Bearer <firebase_token>)

import { redis } from './_redis.js';
import { verifyFirebaseToken, extractBearerToken } from './_auth.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://go.devynest.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const idToken = extractBearerToken(req);
  if (!idToken) return res.status(401).json({ error: 'Autenticación requerida.' });

  let uid;
  try {
    const user = await verifyFirebaseToken(idToken);
    uid = user.localId;
  } catch (_) {
    return res.status(401).json({ error: 'Token inválido.' });
  }

  const pubId = await redis.get(`pub:${uid}`).catch(() => null);
  if (!pubId) return res.status(200).json({ views: 0, clicks: [], pubId: null });

  try {
    const views = parseInt(await redis.get(`analytics:views:${pubId}`).catch(() => '0') || '0');

    // Buscar todos los clicks para este id con scan (no KEYS — seguro en producción)
    const clicks = [];
    const prefix = `analytics:clicks:${pubId}:`;
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', prefix + '*', 'COUNT', '100');
      cursor = next;
      if (keys.length > 0) {
        const vals = await Promise.all(keys.map(k => redis.get(k).catch(() => '0')));
        keys.forEach((k, i) => {
          const target = k.slice(prefix.length);
          const count  = parseInt(vals[i] || '0');
          if (count > 0) clicks.push({ target, count });
        });
      }
    } while (cursor !== '0');

    clicks.sort((a, b) => b.count - a.count);

    return res.status(200).json({ views, clicks, pubId });
  } catch (err) {
    console.error('[stats] Error:', err.message);
    return res.status(500).json({ error: 'Error al obtener estadísticas.' });
  }
}
