import { redis } from './_redis.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido. Usá GET.' });
  }

  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'Falta el parámetro id.' });
  }

  const raw = await redis.get(`lh:${id}`);

  if (!raw) {
    return res.status(404).json({ error: 'No se encontró ningún dato con ese ID.' });
  }

  const entry = typeof raw === 'string' ? JSON.parse(raw) : raw;

  return res.status(200).json(entry);
}
