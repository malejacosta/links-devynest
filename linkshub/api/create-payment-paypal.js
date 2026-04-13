// Crea una SUSCRIPCIÓN recurrente en PayPal (Brasil).
// Usa la API de Billing Subscriptions (no Orders) para cobro mensual automático.
//
// Requiere env vars:
//   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET
//   PAYPAL_PLAN_ID   → ID del plan mensual creado en el Dashboard de PayPal
//   PAYPAL_ENV=sandbox (opcional, default: producción)
//
// Para crear el plan una sola vez: Dashboard PayPal → Catálogo de productos → Planes
// Precio: R$49.00 BRL / mensual → obtenés un ID tipo P-XXXXXXXXXXXXXXXXXXXXXXXX

import { redis } from './_redis.js';
import { getAffiliate } from './_config.js';
import { verifyFirebaseToken, extractBearerToken } from './_auth.js';
import { checkRateLimit } from './_ratelimit.js';
import { captureError } from './_sentry.js';

const ALLOWED_ORIGINS = ['https://go.devynest.com', 'https://devynest.com', 'https://www.devynest.com'];

const PAYPAL_BASE = process.env.PAYPAL_ENV === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

// TTL para el mapping subscriptionId → uid (1 año, se renueva en cada pago)
const SUB_MAPPING_TTL = 365 * 24 * 60 * 60;

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

  if (!process.env.PAYPAL_PLAN_ID) {
    console.error('[create-payment-paypal] PAYPAL_PLAN_ID no configurado');
    return res.status(500).json({ error: 'Configuración de pago incompleta. Contactá al administrador.' });
  }

  const { uid: bodyUid, email, ref } = req.body || {};

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

  // Registrar ref del afiliado solo si no hay uno existente (evita envenenamiento)
  if (ref && getAffiliate(ref)) {
    try {
      const existing = await redis.get(`ref:${uid}`).catch(() => null);
      if (!existing) {
        await redis.set(`ref:${uid}`, ref.toLowerCase());
        console.log(`[create-payment-paypal] Afiliado registrado: uid=${uid}, ref=${ref}`);
      } else {
        console.log(`[create-payment-paypal] Ref ya existe para uid=${uid} (${existing}) — no sobreescrito`);
      }
    } catch (e) {
      console.warn('[create-payment-paypal] No se pudo guardar ref:', e.message);
    }
  }

  try {
    const token = await getPayPalToken();

    // Crear suscripción recurrente (no orden one-time)
    const subscriptionBody = {
      plan_id:   process.env.PAYPAL_PLAN_ID,
      custom_id: uid,   // ← clave: vuelve en todos los webhooks de esta suscripción
      subscriber: {
        ...(email ? { email_address: email } : {}),
      },
      application_context: {
        brand_name:            'DEVYNEST Links',
        shipping_preference:   'NO_SHIPPING',
        user_action:           'SUBSCRIBE_NOW',
        payment_method: {
          payer_selected:    'PAYPAL',
          payee_preferred:   'IMMEDIATE_PAYMENT_REQUIRED',
        },
        return_url: 'https://go.devynest.com/?payment=success',
        cancel_url: 'https://go.devynest.com/?payment=failure',
      },
    };

    const r = await fetch(`${PAYPAL_BASE}/v1/billing/subscriptions`, {
      method: 'POST',
      headers: {
        Authorization:      `Bearer ${token}`,
        'Content-Type':     'application/json',
        'PayPal-Request-Id': `devynest-sub-${uid}-${Date.now()}`,
        'Prefer':            'return=representation',
      },
      body: JSON.stringify(subscriptionBody),
    });

    if (!r.ok) {
      const err = await r.text();
      console.error('[create-payment-paypal] Error PayPal:', r.status, err);
      return res.status(500).json({ error: 'Error al crear suscripción PayPal.', detail: err });
    }

    const data = await r.json();
    const approveLink = data.links?.find(l => l.rel === 'approve')?.href;

    if (!approveLink) {
      console.error('[create-payment-paypal] No se obtuvo URL de aprobación:', JSON.stringify(data));
      return res.status(500).json({ error: 'No se obtuvo URL de aprobación de PayPal.' });
    }

    // Guardar subscriptionId → uid para que el webhook pueda identificar al usuario
    if (data.id) {
      try {
        await redis.setex(`pp_sub:${data.id}`, SUB_MAPPING_TTL, uid);
        console.log(`[create-payment-paypal] Mapping guardado: pp_sub:${data.id} → ${uid}`);
      } catch (e) {
        console.warn('[create-payment-paypal] No se pudo guardar sub mapping:', e.message);
      }
    }

    console.log(`[create-payment-paypal] Suscripción creada — id: ${data.id}, uid: ${uid}`);

    return res.status(200).json({
      checkoutUrl:    approveLink,
      subscriptionId: data.id,
    });
  } catch (err) {
    console.error('[create-payment-paypal] Error:', err.message);
    captureError(err, { endpoint: 'create-payment-paypal', uid });
    return res.status(500).json({ error: 'Error interno.' });
  }
}
