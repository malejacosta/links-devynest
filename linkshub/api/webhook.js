// Webhook de Mercado Pago (Uruguay).
// Recibe notificaciones de pago, valida el estado y activa la suscripción en Redis.
// También registra el afiliado (ref) si corresponde.
// MP SIEMPRE debe recibir HTTP 200 — nunca retries si falla lógica interna.

import { redis } from './_redis.js';
import { getAffiliate } from './_config.js';

const PLAN_SECONDS = 30 * 24 * 60 * 60; // 30 días

export default async function handler(req, res) {
  // MP envía GET para validar el endpoint (no fallar)
  if (req.method === 'GET') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { type, data } = req.body || {};

  // Solo procesar notificaciones de tipo "payment"
  if (type !== 'payment') return res.status(200).end();

  const paymentId = data?.id;
  if (!paymentId) return res.status(200).end();

  try {
    // Consultar el pago en la API de MP para obtener datos reales (no confiar solo en el webhook)
    const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
    });

    if (!mpRes.ok) {
      console.error(`[webhook] Error al consultar pago ${paymentId}: HTTP ${mpRes.status}`);
      return res.status(200).end();
    }

    const payment = await mpRes.json();
    console.log(`[webhook] Pago ${paymentId} — status: ${payment.status}, ref: ${payment.external_reference}`);

    if (payment.status === 'approved') {
      const uid = payment.external_reference;

      if (!uid) {
        console.error(`[webhook] Pago ${paymentId} aprobado pero sin external_reference`);
        return res.status(200).end();
      }

      // Leer afiliado registrado en el momento del pago
      const ref = await redis.get(`ref:${uid}`).catch(() => null);
      const affiliate = getAffiliate(ref);

      const sub = {
        status:          'active',
        uid,
        paymentProvider: 'mercadopago',
        email:           payment.payer?.email || null,
        paymentId:       payment.id,
        amount:          payment.transaction_amount,
        currency:        payment.currency_id,
        country:         payment.metadata?.country || 'UY',
        ref:             ref || null,
        affiliateType:   affiliate?.type || null,
        activatedAt:     new Date().toISOString(),
        expiresAt:       new Date(Date.now() + PLAN_SECONDS * 1000).toISOString(),
      };

      await redis.setex(`sub:${uid}`, PLAN_SECONDS, JSON.stringify(sub));

      // Registrar en tracking de afiliado
      if (ref) {
        await redis.sadd(`aff:${ref}:users`, uid).catch(() => null);
      }

      console.log(`[webhook] ✅ Suscripción activada — uid: ${uid}, ref: ${ref || 'none'}, expira: ${sub.expiresAt}`);
    }
  } catch (err) {
    console.error('[webhook] Error interno:', err.message);
    // No re-throw: MP siempre debe recibir 200
  }

  return res.status(200).end();
}
