// Utilidades de autenticación compartidas entre endpoints.
// Verifica Firebase ID tokens via la REST API pública — sin firebase-admin SDK.
// Requiere env var: FIREBASE_API_KEY

/**
 * Verifica un Firebase ID token y devuelve el usuario.
 * Lanza excepción si el token es inválido o expirado.
 * @returns {{ localId: string, email: string, ... }}
 */
export async function verifyFirebaseToken(idToken) {
  const apiKey = process.env.FIREBASE_API_KEY;
  if (!apiKey) throw new Error('FIREBASE_API_KEY no configurado');
  const r = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ idToken }),
    }
  );
  const data = await r.json();
  if (!r.ok || data.error) throw new Error('Token inválido');
  return data.users?.[0]; // { localId (uid), email, ... }
}

/**
 * Extrae el Bearer token del header Authorization.
 * Devuelve null si no está presente o tiene formato incorrecto.
 */
export function extractBearerToken(req) {
  const authHeader = req.headers['authorization'] || '';
  return authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
}
