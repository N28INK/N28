const config = require('./config');
const { formatVehicleSummary } = require('./inventory');

// Notifica al dueño del bot por WhatsApp (via CallMeBot) cuando se captura
// un telefono de un lead calificado. Nunca incluye montos ni precios.
async function notificarLead(sender_psid, numeroCapturado, vehiculo) {
  if (!config.callMeBotPhone || !config.callMeBotApiKey) {
    console.warn('⚠️ CALLMEBOT_PHONE/CALLMEBOT_API_KEY no configurados; no se envía notificación.');
    return;
  }

  const lineaVehiculo = vehiculo ? `\n🚗 *Vehículo de interés:* ${formatVehicleSummary(vehiculo)}` : '';
  const expedienteLead =
    `🚨 *NUEVO LEAD MARKETPLACE* 🚨\n\n` +
    `👤 *ID de Facebook:* ${sender_psid}\n` +
    `📱 *Teléfono capturado:* ${numeroCapturado}` +
    lineaVehiculo;

  const url = new URL('https://api.callmebot.com/whatsapp.php');
  url.searchParams.set('phone', config.callMeBotPhone);
  url.searchParams.set('text', expedienteLead);
  url.searchParams.set('apikey', config.callMeBotApiKey);

  try {
    const res = await fetch(url);
    if (res.ok) {
      console.log('✅ Notificación de lead enviada por WhatsApp.');
    } else {
      console.error('❌ CallMeBot respondió con error al enviar la notificación.');
    }
  } catch (err) {
    console.error('❌ Error de conexión con CallMeBot:', err);
  }
}

module.exports = { notificarLead };
