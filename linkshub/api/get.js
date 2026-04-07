import { redis } from './_redis.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método no permitido. Usá GET.' });
  }

  // Evitar que el navegador o CDN cacheen datos del link público
  res.setHeader('Cache-Control', 'no-store');

  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ error: 'Falta el parámetro id.' });
  }

  const redisKey = `lh:${id}`;
  console.log(`[GET] id recibido del query: "${id}"`);
  console.log(`[GET] REDIS READ KEY: ${redisKey}`);

  let raw;
  try {
    raw = await redis.get(redisKey);
    console.log(`[GET] ¿encontrado en Redis? → ${raw !== null}`);
  } catch (err) {
    console.error('[GET] Error al leer Redis:', err.message);
    return res.status(500).json({ error: 'Error de conexión con Redis.', detail: err.message });
  }

  if (!raw) {
    console.error(`[GET] 404 — clave ${redisKey} no existe`);
    return res.status(404).json({ error: 'No se encontró ningún dato con ese ID.' });
  }

  let entry;
  try {
    entry = JSON.parse(raw);
    console.log(`[GET] updatedAt en entry: ${entry.updatedAt || 'no existe (creado sin update)'}`);
    console.log(`[GET] profile.name devuelto: ${entry.data?.profile?.name || 'undefined'}`);
  } catch (err) {
    console.error('[GET] Error al parsear JSON:', err.message);
    return res.status(500).json({ error: 'Error al procesar los datos guardados.' });
  }

  return res.status(200).json(entry);
}
