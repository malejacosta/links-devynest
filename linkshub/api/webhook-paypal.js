// Webhook de PayPal — backup para PAYMENT.CAPTURE.COMPLETED.
// La activación principal ocurre en /api/capture-paypal (flujo directo).
// Este webhook activa la sub si el usuario cerró el tab antes de que se capture.
// Configurar en: PayPal Developer Dashboard → Webhooks → PAYMENT.CAPTURE.COMPLETED
// URL: https://go.devynest.com/api/webhook-paypal
// Requiere env vars: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID

import { redis } from './_redis.js';
import { getAffiliate } from './_config.js';

const PLAN_SECONDS = 30 * 24 * 60 * 60;

const PAYPAL_BASE = process.env.PAYPAL_ENV === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

// Obtiene un access token de PayPal (Client Credentials).
async function getPayPalToken() {
  const creds = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString('base64');
  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`PayPal token error: HTTP ${r.status}`);
  return (await r.json()).access_token;
}

// Valida la firma del webhook usando la API oficial de PayPal.
// Requiere PAYPAL_WEBHOOK_ID (Dashboard PayPal → Webhooks → Webhook ID).
// El body se recibe como objeto JSON parseado por Vercel; PayPal's API lo acepta así.
async function validatePayPalSignature(req, event) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    console.error('[webhook-paypal] PAYPAL_WEBHOOK_ID no configurado — rechazando request');
    return false;
  }

  let accessToken;
  try {
    accessToken = await getPayPalToken();
  } catch (e) {
    console.error('[webhook-paypal] Error obteniendo token PayPal:', e.message);
    return false;
  }

  const verifyBody = {
    auth_algo:         req.headers['paypal-auth-algo'],
    cert_url:          req.headers['paypal-cert-url'],
    transmission_id:   req.headers['paypal-transmission-id'],
    transmission_sig:  req.headers['paypal-transmission-sig'],
    transmission_time: req.headers['paypal-transmission-time'],
    webhook_id:        webhookId,
    webhook_event:     event,
  };

  const r = await fetch(`${PAYPAL_BASE}/v1/notifications/verify-webhook-signature`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(verifyBody),
  });

  if (!r.ok) {
    console.warn('[webhook-paypal] Error en verificación de firma:', r.status);
    return false;
  }

  const result = await r.json();
  if (result.verification_status !== 'SUCCESS') {
    console.warn('[webhook-paypal] Firma inválida — verification_status:', result.verification_status);
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  // PayPal valida el endpoint con GET en configuración
  if (req.method === 'GET') return res.status(200).end();
  if (req.method !== 'POST') return res.status(200).end();

  const event = req.body;
  console.log('[webhook-paypal] event_type:', event?.event_type);

  // ── Validar firma antes de procesar cualquier lógica ─────────────────────
  try {
    const valid = await validatePayPalSignature(req, event);
    if (!valid) return res.status(401).end();
  } catch (e) {
    console.error('[webhook-paypal] Error en validación de firma:', e.message);
    return res.status(401).end();
  }

  if (event?.event_type !== 'PAYMENT.CAPTURE.COMPLETED') {
    return res.status(200).end();
  }

  try {
    const capture  = event.resource;
    const orderId  = capture?.supplementary_data?.related_ids?.order_id;
    const customId = capture?.custom_id; // uid del usuario, enviado en purchase_units[0].custom_id

    const uid = customId || (orderId ? await redis.get(`pp_order:${orderId}`).catch(() => null) : null);

    if (!uid) {
      console.warn('[webhook-paypal] No se encontró uid en evento:', JSON.stringify(capture).slice(0, 200));
      return res.status(200).end();
    }

    // Verificar si ya fue activado por capture-paypal (evitar doble activación)
    const existing = await redis.get(`sub:${uid}`).catch(() => null);
    if (existing) {
      const sub = JSON.parse(existing);
      if (sub.status === 'active') {
        console.log(`[webhook-paypal] Sub ya activa para uid: ${uid} — skip duplicado`);
        return res.status(200).end();
      }
    }

    const ref = await redis.get(`ref:${uid}`).catch(() => null);
    const affiliate = getAffiliate(ref);

    const sub = {
      status:          'active',
      uid,
      paymentProvider: 'paypal',
      orderId:         orderId || null,
      amount:          capture?.amount?.value || null,
      currency:        'BRL',
      country:         'BR',
      ref:             ref || null,
      affiliateType:   affiliate?.type || null,
      activatedAt:     new Date().toISOString(),
      expiresAt:       new Date(Date.now() + PLAN_SECONDS * 1000).toISOString(),
    };

    await redis.setex(`sub:${uid}`, PLAN_SECONDS, JSON.stringify(sub));
    if (ref) await redis.sadd(`aff:${ref}:users`, uid).catch(() => null);

    console.log(`[webhook-paypal] ✅ Sub activada via webhook backup — uid: ${uid}`);
  } catch (err) {
    console.error('[webhook-paypal] Error:', err.message);
  }

  return res.status(200).end();
}
