// Webhook de PayPal — backup para PAYMENT.CAPTURE.COMPLETED.
// La activación principal ocurre en /api/capture-paypal (flujo directo).
// Este webhook activa la sub si el usuario cerró el tab antes de que se capture.
// Configurar en: PayPal Developer Dashboard → Webhooks → PAYMENT.CAPTURE.COMPLETED
// URL: https://go.devynest.com/api/webhook-paypal

import { redis } from './_redis.js';
import { getAffiliate } from './_config.js';

const PLAN_SECONDS = 30 * 24 * 60 * 60;

export default async function handler(req, res) {
  // PayPal valida el endpoint con GET en configuración
  if (req.method === 'GET') return res.status(200).end();
  if (req.method !== 'POST') return res.status(200).end();

  const event = req.body;
  console.log('[webhook-paypal] event_type:', event?.event_type);

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
