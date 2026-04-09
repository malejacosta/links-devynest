// Crea una orden de pago en PayPal (Brasil).
// Retorna la URL de aprobación para redirigir al usuario.
// Requiere env vars: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET
// Opcional: PAYPAL_ENV=sandbox (default: producción)

import { redis } from './_redis.js';
import { getCountry, getAffiliate } from './_config.js';

const PAYPAL_BASE = process.env.PAYPAL_ENV === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

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
  const d = await r.json();
  return d.access_token;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { uid, email, ref } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'uid requerido' });

  const cfg = getCountry('BR');

  // Registrar ref del afiliado si es válido
  if (ref && getAffiliate(ref)) {
    try {
      await redis.set(`ref:${uid}`, ref.toLowerCase());
      console.log(`[create-payment-paypal] Afiliado registrado: uid=${uid}, ref=${ref}`);
    } catch (e) {
      console.warn('[create-payment-paypal] No se pudo guardar ref:', e.message);
    }
  }

  try {
    const token = await getPayPalToken();

    const order = {
      intent: 'CAPTURE',
      purchase_units: [{
        custom_id:   uid,  // para identificar al usuario en el webhook y la captura
        description: 'DEVYNEST Links — Plano Mensal',
        amount: {
          currency_code: cfg.currency,
          value:         cfg.price.toFixed(2),
        },
      }],
      application_context: {
        brand_name:  'DEVYNEST Links',
        landing_page: 'BILLING',
        user_action:  'PAY_NOW',
        return_url:   'https://go.devynest.com/?payment=success',
        cancel_url:   'https://go.devynest.com/?payment=failure',
      },
    };

    const r = await fetch(`${PAYPAL_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization:      `Bearer ${token}`,
        'Content-Type':     'application/json',
        'PayPal-Request-Id': `devynest-${uid}-${Date.now()}`,
      },
      body: JSON.stringify(order),
    });

    if (!r.ok) {
      const err = await r.text();
      console.error('[create-payment-paypal] Error PayPal:', r.status, err);
      return res.status(500).json({ error: 'Error al crear orden PayPal.', detail: err });
    }

    const data = await r.json();
    const approveLink = data.links?.find(l => l.rel === 'approve')?.href;

    if (!approveLink) {
      return res.status(500).json({ error: 'No se obtuvo URL de aprobación de PayPal.' });
    }

    // Guardar orderId → uid para captura posterior (TTL 1h)
    try {
      await redis.setex(`pp_order:${data.id}`, 3600, uid);
    } catch (e) {
      console.warn('[create-payment-paypal] No se pudo guardar order mapping:', e.message);
    }

    console.log(`[create-payment-paypal] Orden creada — id: ${data.id}, uid: ${uid}`);

    return res.status(200).json({
      checkoutUrl: approveLink,
      orderId:     data.id,
    });
  } catch (err) {
    console.error('[create-payment-paypal] Error:', err.message);
    return res.status(500).json({ error: 'Error interno.', detail: err.message });
  }
}
