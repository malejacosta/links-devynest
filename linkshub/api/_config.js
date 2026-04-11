// ═══════════════════════════════════════════════════════════════════════════
// CONFIG CENTRAL — países, precios y afiliados
// Para agregar un país nuevo: agregar entrada en COUNTRIES, sin tocar más nada.
// ═══════════════════════════════════════════════════════════════════════════

export const COUNTRIES = {
  UY: {
    currency:       'UYU',
    currencySymbol: '$',
    price:          390,           // precio en moneda local (configurable)
    priceLabel:     '$390/mes',    // texto en paywall
    payment:        'mercadopago', // proveedor de pago
    language:       'es',
    locale:         'es-UY',
  },
  BR: {
    currency:       'BRL',
    currencySymbol: 'R$',
    price:          49,
    priceLabel:     'R$49/mês',
    payment:        'paypal',
    language:       'pt',
    locale:         'pt-BR',
  },
};

// Afiliados: código → configuración
// discount    : descuento que recibe el usuario referido (0–1)
// commission  : % del pago que cobrás al afiliado por cada usuario activo
// type        : 'recurring' = descuento indefinido | 'months' = solo N meses
export const AFFILIATES = {
  aislan: { discount: 0.25, type: 'recurring', commission: 0.30 }, // 30% de comisión
  carla:  { discount: 0.20, type: 'months', months: 6, commission: 0.20 }, // 20%
};

// Comisión por defecto para afiliados sin valor explícito
export const DEFAULT_COMMISSION = 0.20;

export function getCountry(code) {
  return COUNTRIES[code] || COUNTRIES.UY;
}

export function getAffiliate(code) {
  if (!code) return null;
  return AFFILIATES[code.toLowerCase()] || null;
}
