import { redis } from './_redis.js';

function generateId() {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido. Usá POST.' });
  }

  const data = req.body;

  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'El body debe ser un objeto JSON válido.' });
  }

  // Generar ID único (reintenta si ya existe)
  let id;
  let attempts = 0;
  try {
    do {
      id = generateId();
      attempts++;
      if (attempts > 20) {
        return res.status(500).json({ error: 'No se pudo generar un ID único.' });
      }
      const exists = await redis.exists(`lh:${id}`);
      if (exists === 0) break;
    } while (true);
  } catch (err) {
    console.error('[save] Error al verificar ID:', err.message);
    return res.status(500).json({ error: 'Error de conexión con Redis.', detail: err.message });
  }

  const entry = {
    data,
    createdAt: new Date().toISOString(),
  };

  try {
    await redis.set(`lh:${id}`, JSON.stringify(entry));
    console.log(`[save] Guardado OK — ID: ${id}`);
  } catch (err) {
    console.error('[save] Error al guardar:', err.message);
    return res.status(500).json({ error: 'Error al guardar en Redis.', detail: err.message });
  }

  return res.status(200).json({ id, url: `/api/get?id=${id}` });
}
