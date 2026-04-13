// Crea una preferencia de pago en Mercado Pago (Uruguay).
// Lee la moneda y el precio desde _config.js — no está hardcodeado.
// También registra el afiliado (ref) si es válido.

import { redis } from './_redis.js';
import { getCountry, getAffiliate } from './_config.js';
import { verifyFirebaseToken, extractBearerToken } from './_auth.js';
import { checkRateLimit } from './_ratelimit.js';
import { captureError } from './_sentry.js';

// Orígenes permitidos: la app y la web de venta
const ALLOWED_ORIGINS = ['https://go.devynest.com', 'https://devynest.com', 'https://www.devynest.com'];

export default async function handler(req, res) {
  const origin = req.headers['origin'] || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  // Rate limiting — máx 5 intentos de pago por minuto por IP
  const allowed = await checkRateLimit(req, 'payment');
  if (!allowed) {
    return res.status(429).json({ error: 'Demasiadas solicitudes. Esperá un momento e intentá de nuevo.' });
  }

  const { uid: bodyUid, email, country = 'UY', ref } = req.body || {};

  // Si hay token Firebase, uid viene del token (más seguro que confiar en el body)
  let uid = bodyUid;
  const idToken = extractBearerToken(req);
  if (idToken) {
    try {
      const firebaseUser = await verifyFirebaseToken(idToken);
      uid = firebaseUser.localId;
    } catch (_) { /* token inválido — usar uid del body */ }
  }

  if (!uid) return res.status(400).json({ error: 'uid requerido' });

  const cfg = getCountry(country);

  if (cfg.payment !== 'mercadopago') {
    return res.status(400).json({ error: 'Este endpoint solo procesa MercadoPago. Usá /api/create-payment-paypal para Brasil.' });
  }

  // Registrar ref del afiliado solo si no hay uno existente (evita envenenamiento)
  if (ref && getAffiliate(ref)) {
    try {
      const existing = await redis.get(`ref:${uid}`).catch(() => null);
      if (!existing) {
        await redis.set(`ref:${uid}`, ref.toLowerCase());
        console.log(`[create-payment] Afiliado registrado: uid=${uid}, ref=${ref}`);
      } else {
        console.log(`[create-payment] Ref ya existe para uid=${uid} (${existing}) — no sobreescrito`);
      }
    } catch (e) {
      console.warn('[create-payment] No se pudo guardar ref:', e.message);
    }
  }

  try {
    const body = {
      items: [{
        title:       'DEVYNEST Links — Plan Mensual',
        description: 'Acceso mensual a tu página de contacto profesional',
        quantity:    1,
        unit_price:  cfg.price,
        currency_id: cfg.currency,
      }],
      external_reference: uid,
      metadata: { country, ref: ref || null },
      back_urls: {
        success: 'https://go.devynest.com/?payment=success',
        failure: 'https://go.devynest.com/?payment=failure',
        pending: 'https://go.devynest.com/?payment=pending',
      },
      auto_return:          'approved',
      statement_descriptor: 'DEVYNEST Links',
      notification_url:     'https://go.devynest.com/api/webhook',
    };

    if (email) body.payer = { email };

    const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${process.env.MP_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!mpRes.ok) {
      const err = await mpRes.text();
      console.error('[create-payment] MP error:', mpRes.status, err);
      return res.status(500).json({ error: 'Error al crear preferencia de pago.', detail: err });
    }

    const pref = await mpRes.json();
    console.log(`[create-payment] Preferencia creada — id: ${pref.id}, uid: ${uid}, country: ${country}, currency: ${cfg.currency}, price: ${cfg.price}`);

    return res.status(200).json({
      checkoutUrl:  pref.init_point,
      preferenceId: pref.id,
    });
  } catch (err) {
    console.error('[create-payment] Error:', err.message);
    captureError(err, { endpoint: 'create-payment', uid });
    return res.status(500).json({ error: 'Error interno.' });
  }
}
