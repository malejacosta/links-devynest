// Monitoreo de errores — desactivado por ahora.
// Para activar en el futuro: implementar con sentry.io (plan gratuito disponible).
// Las funciones exportadas son no-op para no romper los imports existentes.

export function captureError(_err, _context = {}) {}
export function captureWarning(_message, _context = {}) {}
