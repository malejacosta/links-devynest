// Limpieza de claves huérfanas lh:{id} que ya no están referenciadas por ningún pub:{uid}.
// Solo accesible con el email admin (query param ?email=...) para evitar uso no autorizado.

import { redis } from './_redis.js';

// Escanea todas las claves que coinciden con el patrón (usa SCAN incremental, seguro en producción)
async function scanKeys(pattern) {
  const keys = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Protección: solo admin
  const adminEmail = process.env.ADMIN_EMAIL;
  const email = req.query.email || req.body?.email;
  if (!adminEmail || !email || email.toLowerCase() !== adminEmail.toLowerCase()) {
    return res.status(403).json({ error: 'Acceso denegado.' });
  }

  try {
    // 1. Leer info de memoria antes de limpiar
    const infoRaw = await redis.info('memory');
    const usedMatch    = infoRaw.match(/used_memory_human:(\S+)/);
    const maxMatch     = infoRaw.match(/maxmemory_human:(\S+)/);
    const memBefore = usedMatch ? usedMatch[1] : '?';
    const memMax    = maxMatch  ? maxMatch[1]  : '?';

    // 2. Obtener todos los IDs activos (los que están en pub:{uid})
    const pubKeys = await scanKeys('pub:*');
    const activeIds = new Set();
    for (const pk of pubKeys) {
      const id = await redis.get(pk);
      if (id) activeIds.add(id);
    }
    console.log(`[cleanup] IDs activos (referenciados): ${[...activeIds].join(', ') || 'ninguno'}`);

    // 3. Obtener todas las claves lh:*
    const lhKeys = await scanKeys('lh:*');
    console.log(`[cleanup] Total claves lh:* encontradas: ${lhKeys.length}`);

    // 4. Separar huérfanas de activas
    const orphans = lhKeys.filter(k => {
      const id = k.replace('lh:', '');
      return !activeIds.has(id);
    });
    const kept = lhKeys.length - orphans.length;

    console.log(`[cleanup] Claves a eliminar (huérfanas): ${orphans.length}`);
    console.log(`[cleanup] Claves a conservar (activas):  ${kept}`);

    // Si es solo GET → solo reportar, no eliminar
    if (req.method === 'GET') {
      return res.status(200).json({
        memBefore, memMax,
        totalLhKeys: lhKeys.length,
        activeIds: [...activeIds],
        orphanCount: orphans.length,
        orphanKeys: orphans,
        keptCount: kept,
        note: 'Usá POST para ejecutar la limpieza real.',
      });
    }

    // POST → eliminar huérfanas en lotes de 50
    let deleted = 0;
    const batchSize = 50;
    for (let i = 0; i < orphans.length; i += batchSize) {
      const batch = orphans.slice(i, i + batchSize);
      if (batch.length > 0) {
        await redis.del(...batch);
        deleted += batch.length;
      }
    }

    // Leer memoria después
    const infoAfterRaw = await redis.info('memory');
    const usedAfterMatch = infoAfterRaw.match(/used_memory_human:(\S+)/);
    const memAfter = usedAfterMatch ? usedAfterMatch[1] : '?';

    console.log(`[cleanup] Eliminadas ${deleted} claves. Mem: ${memBefore} → ${memAfter}`);

    return res.status(200).json({
      ok: true,
      memBefore, memAfter, memMax,
      deletedCount: deleted,
      keptCount: kept,
      activeIds: [...activeIds],
    });
  } catch (err) {
    console.error('[cleanup] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
