import crypto from 'crypto';
import { redis } from './_redis.js';
import { verifyFirebaseToken, extractBearerToken } from './_auth.js';

// Las imágenes base64/blob: pueden pesar mucho y agotan la memoria Redis.
// Se descartan data: (base64) y blob: (URL temporal de objeto local) antes de guardar.
// El link público mostrará el avatar/fondo solo si llegó una URL https:// permanente.
function stripBase64Images(data) {
  if (!data || typeof data !== 'object') return data;
  const clean = { ...data };
  if (clean.profile) {
    clean.profile = { ...clean.profile };
    if (typeof clean.profile.avatarPhoto === 'string' &&
        (clean.profile.avatarPhoto.startsWith('data:') || clean.profile.avatarPhoto.startsWith('blob:'))) {
      console.log('[SAVE] avatarPhoto temporal eliminado (data:/blob:) para ahorrar memoria Redis');
      clean.profile.avatarPhoto = null;
    }
    if (typeof clean.profile.bgImage === 'string' &&
        (clean.profile.bgImage.startsWith('data:') || clean.profile.bgImage.startsWith('blob:'))) {
      console.log('[SAVE] bgImage temporal eliminado (data:/blob:) para ahorrar memoria Redis');
      clean.profile.bgImage = null;
    }
  }
  return clean;
}

// IDs de 8 bytes hex (16 chars) con crypto — más seguro y difícil de enumerar
function generateId() {
  return crypto.randomBytes(5).toString('hex'); // 10 hex chars
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://go.devynest.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido. Usá POST.' });
  }

  // ── Verificar autenticación ───────────────────────────────────────────────
  const idToken = extractBearerToken(req);
  if (!idToken) return res.status(401).json({ error: 'Autenticación requerida.' });

  let firebaseUser;
  try {
    firebaseUser = await verifyFirebaseToken(idToken);
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido o expirado.' });
  }
  // uid viene del token verificado — no del query param
  const uid = firebaseUser.localId;

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
    return res.status(500).json({ error: 'Error de conexión con Redis.', detail: undefined });
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
    return res.status(500).json({ error: 'Error al guardar en Redis.' });
  }

  // ── Registrar slug personalizado si fue enviado ─────────────────────────
  const rawSlug = (cleanData?.profile?.slug || '').trim().toLowerCase();
  const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$|^[a-z0-9]{3,30}$/;
  let registeredSlug = null;  // solo se devuelve si el slug fue efectivamente registrado
  if (rawSlug && SLUG_REGEX.test(rawSlug)) {
    try {
      // Limpiar slug anterior del usuario
      const oldSlug = await redis.get(`uid_slug:${uid}`).catch(() => null);
      if (oldSlug && oldSlug !== rawSlug) {
        await redis.del(`slug:${oldSlug}`).catch(() => null);
      }
      // Registrar nuevo slug (solo si está libre o ya le pertenece)
      const existingSlugOwner = await redis.get(`slug:${rawSlug}`).catch(() => null);
      if (!existingSlugOwner || existingSlugOwner === id) {
        await redis.set(`slug:${rawSlug}`, id);
        await redis.set(`uid_slug:${uid}`, rawSlug);
        registeredSlug = rawSlug;
        console.log(`[SAVE] Slug registrado: ${rawSlug} → ${id}`);
      } else {
        console.warn(`[SAVE] Slug "${rawSlug}" ya está tomado por otro usuario — se usará solo el ID hex`);
      }
    } catch (e) {
      console.warn('[SAVE] Error al registrar slug:', e.message);
    }
  }

  return res.status(200).json({ id, slug: registeredSlug, url: `/api/get?id=${id}` });
}
