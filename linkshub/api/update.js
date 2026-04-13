// Actualiza un registro existente en Redis sin generar un nuevo ID.
// El ID debe existir — nunca crea entradas nuevas.

import { redis } from './_redis.js';
import { verifyFirebaseToken, extractBearerToken } from './_auth.js';

function stripBase64Images(data) {
  if (!data || typeof data !== 'object') return data;
  const clean = { ...data };
  if (clean.profile) {
    clean.profile = { ...clean.profile };
    if (typeof clean.profile.avatarPhoto === 'string' &&
        (clean.profile.avatarPhoto.startsWith('data:') || clean.profile.avatarPhoto.startsWith('blob:'))) {
      console.log('[UPDATE] avatarPhoto temporal eliminado (data:/blob:) para ahorrar memoria Redis');
      clean.profile.avatarPhoto = null;
    }
    if (typeof clean.profile.bgImage === 'string' &&
        (clean.profile.bgImage.startsWith('data:') || clean.profile.bgImage.startsWith('blob:'))) {
      console.log('[UPDATE] bgImage temporal eliminado (data:/blob:) para ahorrar memoria Redis');
      clean.profile.bgImage = null;
    }
  }
  return clean;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://go.devynest.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { id } = req.query;
  const data = req.body;

  if (!id)   return res.status(400).json({ error: 'id requerido en query string' });
  if (!data) return res.status(400).json({ error: 'body vacío' });

  // Validar formato: acepta IDs hex de 10 chars (nuevo) y alfanuméricos de 6 chars (formato anterior)
  if (!/^[a-f0-9]{10}$/.test(id) && !/^[a-zA-Z0-9]{6}$/.test(id)) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  // ── Verificar autenticación — uid viene del token, no del query ──────────
  const idToken = extractBearerToken(req);
  if (!idToken) return res.status(401).json({ error: 'Autenticación requerida.' });

  let firebaseUser;
  try {
    firebaseUser = await verifyFirebaseToken(idToken);
  } catch (e) {
    return res.status(401).json({ error: 'Token inválido o expirado.' });
  }
  const uid = firebaseUser.localId;

  const redisKey = `lh:${id}`;
  console.log(`[UPDATE] id recibido del query: "${id}"`);
  console.log(`[UPDATE] uid recibido del query: ${uid || 'NINGUNO'}`);
  console.log(`[UPDATE] REDIS WRITE KEY: ${redisKey}`);
  console.log(`[UPDATE] profile.name en body: ${data?.profile?.name || 'undefined'}`);

  try {
    // Verificar que el ID existe antes de actualizar
    const exists = await redis.exists(redisKey);
    console.log(`[UPDATE] ¿existe ${redisKey}? → ${exists}`);
    if (!exists) {
      console.error(`[UPDATE] 404 — clave ${redisKey} no encontrada en Redis`);
      return res.status(404).json({ error: `ID ${id} no encontrado. Generá el link primero.` });
    }

    // ── Verificar ownership: pub:{uid} debe apuntar a este id ────────────────
    // Si pub:{uid} no existe (Redis eviccionó la clave), re-registrar automáticamente.
    // Si pub:{uid} apunta a otro id diferente, rechazar (otro usuario podría tener el ID).
    const ownerLinkId = await redis.get(`pub:${uid}`).catch(() => null);
    if (ownerLinkId && ownerLinkId !== id) {
      console.warn(`[UPDATE] Ownership check failed: uid=${uid} no es propietario de id=${id} (pub:${uid}=${ownerLinkId})`);
      return res.status(403).json({ error: 'No autorizado para actualizar este link.' });
    }
    // pub:{uid} no existía — reconectar automáticamente
    if (!ownerLinkId) {
      console.warn(`[UPDATE] pub:${uid} no encontrado — re-registrando para id=${id}`);
    }

    // Leer entry actual para conservar createdAt y linkId original
    let createdAt = new Date().toISOString();
    let originalLinkId = null;
    const current = await redis.get(redisKey);
    if (current) {
      try {
        const parsed = JSON.parse(current);
        createdAt = parsed.createdAt || createdAt;
        originalLinkId = parsed.data?.linkId || null;
        console.log(`[UPDATE] createdAt preservado: ${createdAt}`);
        console.log(`[UPDATE] linkId original: ${originalLinkId || 'ninguno'}`);
      } catch (_) {}
    }

    // Fusionar: datos nuevos del cliente + linkId original + limpiar base64
    const cleanData = stripBase64Images(data);
    const mergedData = { ...cleanData };
    if (originalLinkId && !mergedData.linkId) mergedData.linkId = originalLinkId;

    const entry = {
      data: mergedData,
      createdAt,
      updatedAt: new Date().toISOString(),
    };

    const entrySize = JSON.stringify(entry).length;
    console.log(`[UPDATE] tamaño del entry (bytes): ${entrySize}`);

    await redis.set(redisKey, JSON.stringify(entry));
    console.log(`[UPDATE] OK — clave sobreescrita: ${redisKey}`);

    if (uid) {
      await redis.set(`pub:${uid}`, id);
      console.log(`[UPDATE] pub:${uid} → ${id}`);
    }

    // ── Actualizar slug si fue enviado ──────────────────────────────────────
    const rawSlug = (mergedData?.profile?.slug || '').trim().toLowerCase();
    const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$|^[a-z0-9]{3,30}$/;
    let registeredSlug = null;  // solo se devuelve si el slug fue efectivamente registrado
    if (rawSlug && SLUG_REGEX.test(rawSlug)) {
      try {
        const oldSlug = await redis.get(`uid_slug:${uid}`).catch(() => null);
        if (oldSlug && oldSlug !== rawSlug) {
          await redis.del(`slug:${oldSlug}`).catch(() => null);
        }
        const existingSlugOwner = await redis.get(`slug:${rawSlug}`).catch(() => null);
        if (!existingSlugOwner || existingSlugOwner === id) {
          await redis.set(`slug:${rawSlug}`, id);
          await redis.set(`uid_slug:${uid}`, rawSlug);
          registeredSlug = rawSlug;
          console.log(`[UPDATE] Slug actualizado: ${rawSlug} → ${id}`);
        } else {
          // Slug tomado por otro usuario — devolver el slug actual del dueño si tiene uno
          const ownCurrentSlug = await redis.get(`uid_slug:${uid}`).catch(() => null);
          registeredSlug = ownCurrentSlug || null;
          console.warn(`[UPDATE] Slug "${rawSlug}" tomado por otro. Slug actual del usuario: ${registeredSlug || 'ninguno'}`);
        }
      } catch (e) {
        console.warn('[UPDATE] Error al actualizar slug:', e.message);
      }
    } else if (!rawSlug) {
      // Si se borra el slug, limpiar el registro
      try {
        const oldSlug = await redis.get(`uid_slug:${uid}`).catch(() => null);
        if (oldSlug) {
          await redis.del(`slug:${oldSlug}`).catch(() => null);
          await redis.del(`uid_slug:${uid}`).catch(() => null);
          console.log(`[UPDATE] Slug removido: ${oldSlug}`);
        }
      } catch (_) {}
    }

    return res.status(200).json({ ok: true, id, slug: registeredSlug });
  } catch (err) {
    console.error('[UPDATE] Error:', err.message);
    return res.status(500).json({ error: 'Error al actualizar en Redis.' });
  }
}
