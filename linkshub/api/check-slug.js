// Verifica si un slug personalizado está disponible.
// GET /api/check-slug?slug=miusuario
// Retorna { available: true/false, reason?: string }

import { redis } from './_redis.js';
import { verifyFirebaseToken, extractBearerToken } from './_auth.js';

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$|^[a-z0-9]{3,30}$/;
const RESERVED = new Set([
  'api','admin','login','logout','app','blog','help','about','contact',
  'terms','privacy','home','index','devynest','links','user','users',
  'public','static','assets','images','null','undefined','support',
  'pricing','plans','dashboard','settings','account','profile','page',
]);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://go.devynest.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  const { slug } = req.query;
  if (!slug) return res.status(400).json({ error: 'slug requerido' });

  const s = slug.toLowerCase().trim();

  if (!SLUG_REGEX.test(s)) {
    return res.status(200).json({
      available: false,
      reason: 'Solo letras minúsculas, números y guiones. Mínimo 3 caracteres.',
    });
  }

  if (RESERVED.has(s)) {
    return res.status(200).json({ available: false, reason: 'Este nombre está reservado.' });
  }

  // Si viene token, verificar que el slug no pertenezca al mismo usuario (permitir re-usar el propio)
  let ownUid = null;
  const idToken = extractBearerToken(req);
  if (idToken) {
    try {
      const u = await verifyFirebaseToken(idToken);
      ownUid = u.localId;
    } catch (_) {}
  }

  const existing = await redis.get(`slug:${s}`).catch(() => null);

  if (existing) {
    // Si el slug ya le pertenece al mismo usuario, está disponible para él
    if (ownUid) {
      const ownSlug = await redis.get(`uid_slug:${ownUid}`).catch(() => null);
      if (ownSlug === s) return res.status(200).json({ available: true, own: true });
    }
    return res.status(200).json({ available: false, reason: 'Este nombre ya está en uso.' });
  }

  return res.status(200).json({ available: true });
}
