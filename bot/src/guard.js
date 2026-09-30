// Ultima linea de defensa: revisa la respuesta que generó la IA antes de
// enviarla al cliente. Si detecta cualquier mención de montos, precio,
// inicial, mensualidad, APR o "aprobación garantizada", NO se intenta
// "editar" el texto (podria quedar una frase rota) — se descarta entero y
// se sustituye por una respuesta segura predefinida.

const AMOUNT_PATTERN = /\$\s?\d|\b\d{2,3}[.,]?\d{0,3}\s?(d[oó]lares|usd|dollars)\b|\bdown\s?payment\b.*\d|\binicial\b.*\d|\bmensualidad(es)?\b.*\d|\bmonthly\s+payment\b.*\d|\bapr\b|\b\d+\s?%/i;

const PROHIBITED_PHRASES = [
  /financiamos a todos/i,
  /aprobaci[oó]n garantizada/i,
  /sin importar tu cr[eé]dito/i,
  /everyone approved/i,
  /guaranteed approval/i
];

function containsBlockedContent(text) {
  if (!text) return false;
  if (AMOUNT_PATTERN.test(text)) return true;
  return PROHIBITED_PHRASES.some((re) => re.test(text));
}

const FALLBACK_RESPONSE =
  'Para hablar de números (inicial, mensualidades, etc.) prefiero confirmártelos directo y sin errores. ' +
  '¿Me compartes tu WhatsApp para conectarte ahí con la información exacta?';

function enforce(text) {
  return containsBlockedContent(text) ? FALLBACK_RESPONSE : text;
}

module.exports = { containsBlockedContent, enforce, FALLBACK_RESPONSE };
