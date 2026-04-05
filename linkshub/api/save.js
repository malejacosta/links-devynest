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

  // Generar ID único (reintenta si ya existe en Redis)
  let id;
  let attempts = 0;
  do {
    id = generateId();
    attempts++;
    if (attempts > 20) {
      return res.status(500).json({ error: 'No se pudo generar un ID único.' });
    }
  } while (await redis.exists(`lh:${id}`));

  const entry = {
    data,
    createdAt: new Date().toISOString(),
  };

  // Guardar en Redis — sin expiración (persistente)
  await redis.set(`lh:${id}`, JSON.stringify(entry));

  return res.status(200).json({ id, url: `/api/get?id=${id}` });
}
