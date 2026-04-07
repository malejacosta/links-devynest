// Actualiza un registro existente en Redis sin generar un nuevo ID.
// El ID debe existir — nunca crea entradas nuevas.

import { redis } from './_redis.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { id } = req.query;
  const data = req.body;

  if (!id)   return res.status(400).json({ error: 'id requerido en query string' });
  if (!data) return res.status(400).json({ error: 'body vacío' });

  try {
    // Verificar que el ID existe antes de actualizar
    const exists = await redis.exists(`lh:${id}`);
    if (!exists) {
      return res.status(404).json({ error: `ID ${id} no encontrado. Generá el link primero.` });
    }

    // Leer entry actual para conservar createdAt
    let createdAt = new Date().toISOString();
    const current = await redis.get(`lh:${id}`);
    if (current) {
      try { createdAt = JSON.parse(current).createdAt || createdAt; } catch (_) {}
    }

    const entry = {
      data,
      createdAt,
      updatedAt: new Date().toISOString(),
    };

    await redis.set(`lh:${id}`, JSON.stringify(entry));
    console.log(`[update] Actualizado OK — ID: ${id}`);
    return res.status(200).json({ ok: true, id });
  } catch (err) {
    console.error('[update] Error:', err.message);
    return res.status(500).json({ error: 'Error al actualizar en Redis.', detail: err.message });
  }
}
