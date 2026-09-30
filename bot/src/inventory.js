const fs = require('fs');
const path = require('path');

const RAW_INVENTORY = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'data', 'inventory.json'), 'utf8')
);

// Cada vehiculo recibe un id estable (V1, V2, ...) por posicion en el archivo.
// Este mismo id se puede usar como "Content ID" al subir el vehiculo a un
// catalogo de Facebook para que el webhook de Marketplace lo pueda enlazar
// automaticamente (ver README).
const VEHICLES = RAW_INVENTORY.map((v, i) => ({ id: `V${i + 1}`, ...v }));

// Vista "segura" de un vehiculo: NUNCA incluye downPayment ni ningun monto.
function toSafeVehicle(vehicle) {
  if (!vehicle) return null;
  const { downPayment, ...safe } = vehicle; // eslint-disable-line no-unused-vars
  return safe;
}

function getById(id) {
  return VEHICLES.find((v) => v.id === id) || null;
}

const STOPWORDS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'con', 'para', 'the', 'a', 'an',
  'still', 'available', 'disponible', 'esta', 'está', 'is', 'this', 'que', 'como'
]);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita acentos
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// Busca vehiculos que mejor calzan con un texto libre del cliente
// (ej. "el silverado negro del 2022 sigue disponible?").
// Devuelve un arreglo ordenado por score descendente (top primero).
function findVehicles(text, limit = 3) {
  const tokens = tokenize(text);
  if (tokens.length === 0) return [];

  const scored = VEHICLES.map((v) => {
    const haystack = tokenize(
      [v.year, v.make, v.model, v.title, v.bodyType, v.exteriorColor, v.interiorColor].join(' ')
    );
    let score = 0;
    for (const t of tokens) {
      if (haystack.includes(t)) score += 1;
    }
    return { vehicle: v, score };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.vehicle);
}

// Intenta resolver un vehiculo a partir del objeto "referral" que Meta
// adjunta cuando la conversacion inicia desde una tarjeta de Marketplace o
// un anuncio "click to Messenger" ligado a un catalogo de productos.
// El formato exacto que envia Meta varia segun el origen, por eso se
// revisan varias rutas posibles de forma defensiva.
function resolveVehicleFromReferral(referral) {
  if (!referral) return null;
  const candidateIds = [
    referral.product_id,
    referral.ref,
    referral.ads_context_data && referral.ads_context_data.product_id
  ].filter(Boolean);

  for (const candidate of candidateIds) {
    const byId = getById(String(candidate));
    if (byId) return byId;
  }
  return null;
}

function formatVehicleSummary(vehicle) {
  if (!vehicle) return '';
  const partes = [
    `${vehicle.year} ${vehicle.make} ${vehicle.model}`.trim(),
    vehicle.bodyType,
    vehicle.mileage ? `${Number(vehicle.mileage).toLocaleString('es-US')} millas` : null,
    vehicle.exteriorColor ? `exterior ${vehicle.exteriorColor}` : null,
    vehicle.interiorColor ? `interior ${vehicle.interiorColor}` : null
  ].filter(Boolean);
  return partes.join(' · ');
}

module.exports = {
  VEHICLES,
  toSafeVehicle,
  getById,
  findVehicles,
  resolveVehicleFromReferral,
  formatVehicleSummary
};
