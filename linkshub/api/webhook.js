// Webhook de Mercado Pago (Uruguay).
// Recibe notificaciones de pago, valida el estado y activa la suscripción en Redis.
// También registra el afiliado (ref) si corresponde.
// MP SIEMPRE debe recibir HTTP 200 — nunca retries si falla lógica interna.
// Requiere env var: MP_WEBHOOK_SECRET (Dashboard MP → Webhooks → Clave secreta)

import crypto from 'crypto';
import { redis } from './_redis.js';
import { getAffiliate } from './_config.js';

const PLAN_SECONDS = 30 * 24 * 60 * 60; // 30 días

// Valida la firma HMAC-SHA256 que Mercado Pago adjunta a cada notificación.
// String firmado: "id:{paymentId};request-id:{x-request-id};ts:{ts};"
// Ref: https://www.mercadopago.com.ar/developers/es/docs/your-integrations/notifications/webhooks
function validateMPSignature(req, paymentId) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) {
    console.error('[webhook-mp] MP_WEBHOOK_SECRET no configurado — rechazando request');
    return false;
  }
  const sig   = req.headers['x-signature']   || '';
  const reqId = req.headers['x-request-id']  || '';
  const ts    = sig.match(/ts=([^,]+)/)?.[1];
  const v1    = sig.match(/v1=([^,]+)/)?.[1];

  if (!ts || !v1) {
    console.warn('[webhook-mp] Header x-signature ausente o malformado');
    return false;
  }

  // paymentId viene de req.body.data.id — es el valor usado en el string firmado
  const signed = `id:${paymentId};request-id:${reqId};ts:${ts};`;
  const hash = crypto.createHmac('sha256', secret).update(signed).digest('hex');

  // Comparación en tiempo constante — previene timing attacks
  try {
    const hashBuf = Buffer.from(hash, 'hex');
    const v1Buf   = Buffer.from(v1,   'hex');
    if (hashBuf.length !== v1Buf.length || !crypto.timingSafeEqual(hashBuf, v1Buf)) {
      console.warn('[webhook-mp] Firma inválida — request rechazado');
      return false;
    }
  } catch (_) {
    console.warn('[webhook-mp] Firma inválida — error al comparar');
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  // MP envía GET para validar el endpoint (no fallar)
  if (req.method === 'GET') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { type, data } = req.body || {};

  // Solo procesar notificaciones de tipo "payment"
  if (type !== 'payment') return res.status(200).end();

  // paymentId = req.body.data.id — usado también en la validación de firma
  const paymentId = data?.id;
  if (!paymentId) return res.status(200).end();

  // ── Validar firma antes de procesar cualquier lógica ─────────────────────
  if (!validateMPSignature(req, paymentId)) {
    return res.status(401).end();
  }

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
