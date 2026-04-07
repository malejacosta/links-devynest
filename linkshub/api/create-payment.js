// Crea una preferencia de pago en Mercado Pago.
// Devuelve la URL de checkout para redirigir al usuario.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { uid, email } = req.body || {};
  if (!uid) return res.status(400).json({ error: 'uid requerido' });

  try {
    const body = {
      items: [{
        title:       'DEVYNEST Links — Plan Mensual',
        description: 'Acceso mensual a tu página de contacto profesional',
        quantity:    1,
        unit_price:  380,
        currency_id: 'ARS',
      }],
      external_reference: uid,           // clave para identificar al usuario en el webhook
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
    console.log(`[create-payment] Preferencia creada — id: ${pref.id}, uid: ${uid}`);

    return res.status(200).json({
      checkoutUrl:  pref.init_point,   // URL de producción
      preferenceId: pref.id,
    });
  } catch (err) {
    console.error('[create-payment] Error:', err.message);
    return res.status(500).json({ error: 'Error interno.', detail: err.message });
  }
}
