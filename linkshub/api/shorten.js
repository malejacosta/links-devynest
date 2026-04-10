// Solo permite acortar URLs del propio dominio — no funciona como proxy abierto.
const ALLOWED_HOSTS = ['go.devynest.com'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Falta el parámetro url' });

  // Validar que la URL pertenece al dominio permitido
  try {
    const parsed = new URL(url);
    if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
      return res.status(400).json({ error: 'URL no permitida.' });
    }
  } catch (_) {
    return res.status(400).json({ error: 'URL inválida.' });
  }

  try {
    const response = await fetch(
      'https://tinyurl.com/api-create.php?url=' + encodeURIComponent(url)
    );
    if (!response.ok) throw new Error('TinyURL error');
    const short = (await response.text()).trim();
    if (!short.startsWith('https://tinyurl.com')) throw new Error('Respuesta inválida');
    res.status(200).json({ short });
  } catch (e) {
    res.status(500).json({ error: 'No se pudo acortar el link' });
  }
}
