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

  // Resolver: si es hex → uso directo. Si es slug (letras/guiones) → buscar en Redis.
  let resolvedId = id;
  if (/^[a-f0-9]{10}$/.test(id)) {
    resolvedId = id;
  } else if (/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$|^[a-z0-9]{3,30}$/.test(id)) {
    const slugTarget = await redis.get(`slug:${id.toLowerCase()}`).catch(() => null);
    if (!slugTarget) {
      return res.status(404).json({ error: 'No se encontró ningún dato con ese ID.' });
    }
    resolvedId = slugTarget;
  } else {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const redisKey = `lh:${resolvedId}`;
  console.log(`[GET] id recibido del query: "${id}"`);
  console.log(`[GET] REDIS READ KEY: ${redisKey}`);

  let raw;
  try {
    raw = await redis.get(redisKey);
    console.log(`[GET] ¿encontrado en Redis? → ${raw !== null}`);
  } catch (err) {
    console.error('[GET] Error al leer Redis:', err.message);
    return res.status(500).json({ error: 'Error de conexión con Redis.' });
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

  // Incluir el id resuelto (hex) para que el frontend lo use en analytics
  return res.status(200).json({ ...entry, _id: resolvedId });
}
