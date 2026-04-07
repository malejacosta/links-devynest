// Sube una imagen a Vercel Blob y devuelve la URL pública permanente.
// Recibe el archivo como body binario (Content-Type: image/*).
// Query params: ?type=avatar|bg  (para organizar carpetas en Blob)
//
// Requiere BLOB_READ_WRITE_TOKEN en las variables de entorno de Vercel.
// Habilitarlo: Dashboard → proyecto → Storage → Create → Blob → Connect.

import { put } from '@vercel/blob';

// Límites por tipo (en bytes)
const MAX_SIZES = {
  avatar: 2 * 1024 * 1024,   // 2 MB
  bg:     4 * 1024 * 1024,   // 4 MB
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Image-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const imageType = req.query.type || req.headers['x-image-type'] || 'img';
  const contentType = req.headers['content-type'] || 'image/jpeg';

  // Solo aceptar imágenes
  if (!contentType.startsWith('image/')) {
    return res.status(400).json({ error: 'Solo se aceptan imágenes.' });
  }

  const ext = contentType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
  const filename = `devynest-links/${imageType}/${Date.now()}.${ext}`;

  // Leer el cuerpo binario como stream (req es un IncomingMessage)
  let buffer;
  try {
    buffer = await readBody(req);
  } catch (err) {
    console.error('[upload-image] Error leyendo body:', err.message);
    return res.status(500).json({ error: 'Error leyendo el archivo.' });
  }

  if (!buffer || buffer.length === 0) {
    return res.status(400).json({ error: 'Body vacío. Asegurate de enviar la imagen como body binario.' });
  }

  // Validar tamaño
  const maxSize = MAX_SIZES[imageType] || MAX_SIZES.bg;
  if (buffer.length > maxSize) {
    const mb = (maxSize / 1024 / 1024).toFixed(0);
    return res.status(413).json({ error: `Imagen demasiado grande. Máximo ${mb}MB.` });
  }

  console.log(`[upload-image] tipo=${imageType} | tamaño=${(buffer.length / 1024).toFixed(1)}KB | contentType=${contentType}`);

  try {
    const blob = await put(filename, buffer, {
      access: 'public',
      contentType,
    });
    console.log(`[upload-image] OK → ${blob.url}`);
    return res.status(200).json({ url: blob.url });
  } catch (err) {
    console.error('[upload-image] Error subiendo a Vercel Blob:', err.message);
    // Mensaje claro si falta el token de Blob
    if (err.message?.includes('BLOB_READ_WRITE_TOKEN')) {
      return res.status(500).json({
        error: 'Vercel Blob no está configurado.',
        detail: 'Ir a Vercel Dashboard → Storage → Create → Blob → Connect al proyecto.',
      });
    }
    return res.status(500).json({ error: 'Error al subir la imagen.', detail: err.message });
  }
}

// Lee todo el body como Buffer independientemente del content-type
function readBody(req) {
  return new Promise((resolve, reject) => {
    // Si el body ya fue parseado por el runtime (caso raro), usarlo
    if (req.body && Buffer.isBuffer(req.body)) {
      return resolve(req.body);
    }
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
