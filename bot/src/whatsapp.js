const config = require('./config');

// Construye un link de WhatsApp seguro con new URL()/searchParams (nunca
// concatenando texto de usuario directo en la URL).
function buildWhatsappUrl(vehicle) {
  if (!config.contactWhatsappNumber) return null;
  const numero = config.contactWhatsappNumber.replace(/[^\d]/g, '');
  const url = new URL(`https://wa.me/${numero}`);
  const texto = vehicle
    ? `Hola, vengo de Marketplace y me interesa el ${vehicle.year} ${vehicle.make} ${vehicle.model}`
    : 'Hola, vengo de Facebook y me interesa un vehículo financiado';
  url.searchParams.set('text', texto);
  return url.toString();
}

module.exports = { buildWhatsappUrl };
