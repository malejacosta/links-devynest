import { redis } from './_redis.js';

// Las imágenes base64 pueden pesar 200KB+ cada una y agotan la memoria Redis.
// Si el valor empieza con "data:", se descarta antes de guardar.
// El link público mostrará el avatar/fondo solo si el usuario usa una URL externa.
function stripBase64Images(data) {
  if (!data || typeof data !== 'object') return data;
  const clean = { ...data };
  if (clean.profile) {
    clean.profile = { ...clean.profile };
    if (typeof clean.profile.avatarPhoto === 'string' && clean.profile.avatarPhoto.startsWith('data:')) {
      console.log('[SAVE] avatarPhoto base64 eliminado para ahorrar memoria Redis');
      clean.profile.avatarPhoto = null;
    }
    if (typeof clean.profile.bgImage === 'string' && clean.profile.bgImage.startsWith('data:')) {
      console.log('[SAVE] bgImage base64 eliminado para ahorrar memoria Redis');
      clean.profile.bgImage = null;
    }
  }
  return clean;
}

function generateId() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido. Usá POST.' });
  }

  const { uid } = req.query;
  const data = req.body;

  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'El body debe ser un objeto JSON válido.' });
  }

  // Generar ID único (reintenta si ya existe)
  let id;
  let attempts = 0;
  try {
    do {
      id = generateId();
      attempts++;
      if (attempts > 20) {
        return res.status(500).json({ error: 'No se pudo generar un ID único.' });
      }
      const exists = await redis.exists(`lh:${id}`);
      if (exists === 0) break;
    } while (true);
  } catch (err) {
    console.error('[save] Error al verificar ID:', err.message);
    return res.status(500).json({ error: 'Error de conexión con Redis.', detail: err.message });
  }

  const cleanData = stripBase64Images(data);

  const entry = {
    data: cleanData,
    createdAt: new Date().toISOString(),
  };

  const redisKey = `lh:${id}`;
  const entrySize = JSON.stringify(entry).length;
  console.log(`[SAVE] uid recibido: ${uid || 'NINGUNO'}`);
  console.log(`[SAVE] ID generado: ${id}`);
  console.log(`[SAVE] REDIS WRITE KEY: ${redisKey}`);
  console.log(`[SAVE] profile.name en data: ${cleanData?.profile?.name || 'undefined'}`);
  console.log(`[SAVE] tamaño del entry (bytes): ${entrySize}`);

  try {
    await redis.set(redisKey, JSON.stringify(entry));
    if (uid) {
      await redis.set(`pub:${uid}`, id);
      console.log(`[SAVE] pub:${uid} → ${id}`);
    }
    console.log(`[SAVE] OK — clave escrita: ${redisKey}`);
  } catch (err) {
    console.error('[SAVE] Error al guardar:', err.message);
    return res.status(500).json({ error: 'Error al guardar en Redis.', detail: err.message });
  }

  return res.status(200).json({ id, url: `/api/get?id=${id}` });
}
