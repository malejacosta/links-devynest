// Captura una orden de PayPal aprobada y activa la suscripción en Redis.
// Llamado desde el frontend cuando el usuario regresa de PayPal con ?token=...
// POST body: { token: paypalOrderId, uid: firebaseUid }

import { redis } from './_redis.js';
import { getAffiliate } from './_config.js';

const PAYPAL_BASE = process.env.PAYPAL_ENV === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

const PLAN_SECONDS = 30 * 24 * 60 * 60; // 30 días

async function getPayPalToken() {
  const creds = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString('base64');
  const r = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization:  `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) throw new Error(`PayPal token error: HTTP ${r.status}`);
  return (await r.json()).access_token;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://go.devynest.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { token: orderId, uid } = req.body || {};
  if (!orderId || !uid) return res.status(400).json({ error: 'orderId y uid requeridos' });

  // ── Verificar que la orden pertenece al uid que la reclama ────────────────
  // pp_order:{orderId} fue guardado en Redis por create-payment-paypal con TTL 1h
  const storedUid = await redis.get(`pp_order:${orderId}`).catch(() => null);
  if (!storedUid) {
    console.warn(`[capture-paypal] Orden no encontrada en Redis: ${orderId}`);
    return res.status(400).json({ error: 'Orden no encontrada o expirada.' });
  }
  if (storedUid !== uid) {
    console.warn(`[capture-paypal] uid mismatch: orden=${orderId}, esperado=${storedUid}, recibido=${uid}`);
    return res.status(403).json({ error: 'Esta orden no pertenece a este usuario.' });
  }

  try {
    const accessToken = await getPayPalToken();

    // Capturar la orden aprobada
    const captureRes = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!captureRes.ok) {
      const err = await captureRes.text();
      console.error('[capture-paypal] Error capturando orden:', captureRes.status, err);
      // Si ya fue capturada (ORDER_ALREADY_CAPTURED), tratar como éxito
      if (err.includes('ORDER_ALREADY_CAPTURED')) {
        console.log('[capture-paypal] Orden ya capturada — verificando sub existente');
      } else {
        return res.status(500).json({ error: 'Error al capturar el pago.', detail: err });
      }
    }

    const capture = captureRes.ok ? await captureRes.json() : null;

    // Solo activar si status COMPLETED (o si ya fue capturada anteriormente)
    if (capture && capture.status !== 'COMPLETED') {
      return res.status(400).json({ error: `Pago no completado. Estado: ${capture.status}` });
    }

    // Leer ref del afiliado si existe
    const ref = await redis.get(`ref:${uid}`).catch(() => null);
    const affiliate = getAffiliate(ref);

    const amount = capture?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value || null;

    const sub = {
      status:          'active',
      uid,
      paymentProvider: 'paypal',
      orderId,
      amount,
      currency:        'BRL',
      country:         'BR',
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

    // Limpiar el mapping temporal de orden
    await redis.del(`pp_order:${orderId}`).catch(() => null);

    console.log(`[capture-paypal] ✅ Suscripción activada — uid: ${uid}, ref: ${ref || 'none'}, expira: ${sub.expiresAt}`);

    return res.status(200).json({ ok: true, expiresAt: sub.expiresAt });
  } catch (err) {
    console.error('[capture-paypal] Error:', err.message);
    return res.status(500).json({ error: 'Error interno.', detail: err.message });
  }
}
