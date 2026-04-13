// Webhook de PayPal — maneja el ciclo completo de suscripciones recurrentes.
//
// Eventos procesados:
//   BILLING.SUBSCRIPTION.ACTIVATED → primera activación (pago inicial procesado)
//   PAYMENT.SALE.COMPLETED         → renovación mensual automática
//   BILLING.SUBSCRIPTION.CANCELLED → usuario canceló → desactivar acceso
//   BILLING.SUBSCRIPTION.SUSPENDED → pago fallido tras reintentos → desactivar
//   PAYMENT.CAPTURE.COMPLETED      → backward compat (flujo one-time antiguo)
//
// Configurar en: PayPal Developer Dashboard → Webhooks
//   URL: https://go.devynest.com/api/webhook-paypal
//   Eventos a suscribir: los 5 de arriba
//
// Requiere env vars: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_WEBHOOK_ID

import { redis } from './_redis.js';
import { getAffiliate } from './_config.js';
import { captureError } from './_sentry.js';

const PLAN_SECONDS     = 30 * 24 * 60 * 60;   // 30 días
const SUB_MAPPING_TTL  = 365 * 24 * 60 * 60;  // 1 año (se renueva en cada pago)

const PAYPAL_BASE = process.env.PAYPAL_ENV === 'sandbox'
  ? 'https://api-m.sandbox.paypal.com'
  : 'https://api-m.paypal.com';

// ── Helpers ────────────────────────────────────────────────────────────────

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
async function validatePayPalSignature(req, event) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    console.error('[webhook-paypal] PAYPAL_WEBHOOK_ID no configurado — rechazando');
    return false;
  }
  let accessToken;
  try {
    accessToken = await getPayPalToken();
  } catch (e) {
    console.error('[webhook-paypal] Error obteniendo token:', e.message);
    return false;
  }
  const r = await fetch(`${PAYPAL_BASE}/v1/notifications/verify-webhook-signature`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_algo:         req.headers['paypal-auth-algo'],
      cert_url:          req.headers['paypal-cert-url'],
      transmission_id:   req.headers['paypal-transmission-id'],
      transmission_sig:  req.headers['paypal-transmission-sig'],
      transmission_time: req.headers['paypal-transmission-time'],
      webhook_id:        webhookId,
      webhook_event:     event,
    }),
  });
  if (!r.ok) {
    console.warn('[webhook-paypal] Error en verificación de firma:', r.status);
    return false;
  }
  const result = await r.json();
  if (result.verification_status !== 'SUCCESS') {
    console.warn('[webhook-paypal] Firma inválida — status:', result.verification_status);
    return false;
  }
  return true;
}

// Resuelve el uid a partir del recurso del evento.
// Prioridad: custom_id del recurso → pp_sub:{subscriptionId} en Redis
async function resolveUid(resource, subscriptionId) {
  if (resource?.custom_id) return resource.custom_id;
  if (subscriptionId) {
    const uid = await redis.get(`pp_sub:${subscriptionId}`).catch(() => null);
    if (uid) return uid;
  }
  return null;
}

// ── Handlers por tipo de evento ─────────────────────────────────────────────

// BILLING.SUBSCRIPTION.ACTIVATED
// Primer pago procesado — activar suscripción 30 días.
async function handleSubscriptionActivated(resource) {
  const subscriptionId = resource?.id;
  const uid = await resolveUid(resource, subscriptionId);

  if (!uid) {
    console.warn('[webhook-paypal] ACTIVATED — no se encontró uid:', JSON.stringify(resource).slice(0, 200));
    return;
  }

  // Persistir el mapping subscriptionId → uid (necesario para renovaciones futuras)
  if (subscriptionId) {
    await redis.setex(`pp_sub:${subscriptionId}`, SUB_MAPPING_TTL, uid).catch(() => null);
  }

  // No duplicar si ya hay sub activa con este subscriptionId
  const existingRaw = await redis.get(`sub:${uid}`).catch(() => null);
  if (existingRaw) {
    const existing = JSON.parse(existingRaw);
    if (existing.status === 'active' && existing.subscriptionId === subscriptionId) {
      console.log(`[webhook-paypal] ACTIVATED duplicado — uid: ${uid}, skip`);
      return;
    }
  }

  const ref = await redis.get(`ref:${uid}`).catch(() => null);
  const affiliate = getAffiliate(ref);
  const amount = resource?.billing_info?.last_payment?.amount?.value
    || resource?.billing_info?.outstanding_balance?.value
    || null;

  const sub = {
    status:          'active',
    uid,
    paymentProvider: 'paypal',
    subscriptionId:  subscriptionId || null,
    amount:          amount ? parseFloat(amount) : null,
    currency:        'BRL',
    country:         'BR',
    ref:             ref || null,
    affiliateType:   affiliate?.type || null,
    activatedAt:     new Date().toISOString(),
    expiresAt:       new Date(Date.now() + PLAN_SECONDS * 1000).toISOString(),
  };

  await redis.setex(`sub:${uid}`, PLAN_SECONDS, JSON.stringify(sub));
  if (ref) await redis.sadd(`aff:${ref}:users`, uid).catch(() => null);

  console.log(`[webhook-paypal] ✅ ACTIVATED — uid: ${uid}, sub: ${subscriptionId}, expira: ${sub.expiresAt}`);
}

// PAYMENT.SALE.COMPLETED
// Renovación mensual automática — extender suscripción otros 30 días.
async function handleSaleCompleted(resource) {
  const subscriptionId = resource?.billing_agreement_id; // ID de la suscripción PayPal
  if (!subscriptionId) {
    // Puede ser un pago one-time sin suscripción — ignorar
    console.log('[webhook-paypal] SALE.COMPLETED sin billing_agreement_id — ignorado');
    return;
  }

  const uid = await resolveUid(resource, subscriptionId);
  if (!uid) {
    console.warn('[webhook-paypal] SALE.COMPLETED — uid no encontrado para sub:', subscriptionId);
    return;
  }

  // Renovar mapping TTL
  await redis.expire(`pp_sub:${subscriptionId}`, SUB_MAPPING_TTL).catch(() => null);

  const ref = await redis.get(`ref:${uid}`).catch(() => null);
  const affiliate = getAffiliate(ref);
  const amount = parseFloat(resource?.amount?.total || resource?.amount?.value || 0) || null;

  const sub = {
    status:          'active',
    uid,
    paymentProvider: 'paypal',
    subscriptionId:  subscriptionId || null,
    amount,
    currency:        resource?.amount?.currency || 'BRL',
    country:         'BR',
    ref:             ref || null,
    affiliateType:   affiliate?.type || null,
    renewedAt:       new Date().toISOString(),
    expiresAt:       new Date(Date.now() + PLAN_SECONDS * 1000).toISOString(),
  };

  // Preservar activatedAt si ya existía
  const existingRaw = await redis.get(`sub:${uid}`).catch(() => null);
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw);
      if (existing.activatedAt) sub.activatedAt = existing.activatedAt;
    } catch (_) {}
  }

  await redis.setex(`sub:${uid}`, PLAN_SECONDS, JSON.stringify(sub));
  if (ref) await redis.sadd(`aff:${ref}:users`, uid).catch(() => null);

  console.log(`[webhook-paypal] ✅ RENOVACIÓN — uid: ${uid}, sub: ${subscriptionId}, expira: ${sub.expiresAt}`);
}

// BILLING.SUBSCRIPTION.CANCELLED o SUSPENDED
// Usuario canceló o pagos fallaron — marcar como inactivo.
async function handleSubscriptionEnded(resource, eventType) {
  const subscriptionId = resource?.id;
  const uid = await resolveUid(resource, subscriptionId);

  if (!uid) {
    console.warn(`[webhook-paypal] ${eventType} — uid no encontrado para sub: ${subscriptionId}`);
    return;
  }

  const existingRaw = await redis.get(`sub:${uid}`).catch(() => null);
  if (!existingRaw) {
    console.log(`[webhook-paypal] ${eventType} — no hay sub en Redis para uid: ${uid}`);
    return;
  }

  let sub;
  try { sub = JSON.parse(existingRaw); } catch (_) { sub = {}; }

  sub.status      = eventType === 'BILLING.SUBSCRIPTION.CANCELLED' ? 'cancelled' : 'suspended';
  sub.cancelledAt = new Date().toISOString();
  sub.expiresAt   = new Date().toISOString(); // acceso termina inmediatamente

  // Guardar sin TTL activo (expiresAt ya está en el pasado, check-access lo rechazará)
  // Guardamos por 90 días para auditoría
  await redis.setex(`sub:${uid}`, 90 * 24 * 60 * 60, JSON.stringify(sub)).catch(() => null);

  console.log(`[webhook-paypal] ⛔ ${eventType} — uid: ${uid}, sub: ${subscriptionId}`);
}

// PAYMENT.CAPTURE.COMPLETED (backward compat — flujo de órdenes one-time)
async function handleCaptureCompleted(resource) {
  const orderId  = resource?.supplementary_data?.related_ids?.order_id;
  const customId = resource?.custom_id;

  const uid = customId || (orderId ? await redis.get(`pp_order:${orderId}`).catch(() => null) : null);

  if (!uid) {
    console.warn('[webhook-paypal] CAPTURE.COMPLETED — uid no encontrado');
    return;
  }

  // Verificar si ya fue activado por capture-paypal (evitar doble activación)
  const existingRaw = await redis.get(`sub:${uid}`).catch(() => null);
  if (existingRaw) {
    try {
      const existing = JSON.parse(existingRaw);
      if (existing.status === 'active') {
        console.log(`[webhook-paypal] CAPTURE ya activo para uid: ${uid} — skip`);
        return;
      }
    } catch (_) {}
  }

  const ref = await redis.get(`ref:${uid}`).catch(() => null);
  const affiliate = getAffiliate(ref);

  const sub = {
    status:          'active',
    uid,
    paymentProvider: 'paypal',
    orderId:         orderId || null,
    amount:          parseFloat(resource?.amount?.value || 0) || null,
    currency:        'BRL',
    country:         'BR',
    ref:             ref || null,
    affiliateType:   affiliate?.type || null,
    activatedAt:     new Date().toISOString(),
    expiresAt:       new Date(Date.now() + PLAN_SECONDS * 1000).toISOString(),
  };

  await redis.setex(`sub:${uid}`, PLAN_SECONDS, JSON.stringify(sub));
  if (ref) await redis.sadd(`aff:${ref}:users`, uid).catch(() => null);

  console.log(`[webhook-paypal] ✅ CAPTURE activado (backup) — uid: ${uid}`);
}

// ── Handler principal ───────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).end();
  if (req.method !== 'POST') return res.status(200).end();

  const event = req.body;
  console.log('[webhook-paypal] event_type:', event?.event_type);

  // Validar firma antes de procesar cualquier lógica
  try {
    const valid = await validatePayPalSignature(req, event);
    if (!valid) return res.status(401).end();
  } catch (e) {
    console.error('[webhook-paypal] Error en validación de firma:', e.message);
    return res.status(401).end();
  }

  try {
    const { event_type, resource } = event;

    switch (event_type) {
      case 'BILLING.SUBSCRIPTION.ACTIVATED':
        await handleSubscriptionActivated(resource);
        break;

      case 'PAYMENT.SALE.COMPLETED':
        await handleSaleCompleted(resource);
        break;

      case 'BILLING.SUBSCRIPTION.CANCELLED':
      case 'BILLING.SUBSCRIPTION.SUSPENDED':
        await handleSubscriptionEnded(resource, event_type);
        break;

      case 'PAYMENT.CAPTURE.COMPLETED':
        await handleCaptureCompleted(resource);
        break;

      default:
        // Ignorar silenciosamente otros eventos (ej. BILLING.SUBSCRIPTION.CREATED)
        console.log(`[webhook-paypal] Evento no procesado: ${event_type}`);
    }
  } catch (err) {
    console.error('[webhook-paypal] Error interno:', err.message);
    captureError(err, { endpoint: 'webhook-paypal', event_type: event?.event_type });
    // No retornar error — PayPal reintentaría innecesariamente
  }

  return res.status(200).end();
}
