const express = require('express');
const bodyParser = require('body-parser');
const config = require('./config');
const { enviarEscribiendo, enviarMensaje, enviarTarjetaVehiculo, enviarQuickReplies } = require('./messenger');
const { generarRespuesta, getEstado, setEstado, clearEstado } = require('./ai');
const { findVehicles, resolveVehicleFromReferral, getById, formatVehicleSummary } = require('./inventory');
const { notificarLead } = require('./leadNotifier');
const { buildWhatsappUrl } = require('./whatsapp');

const app = express();
app.use(bodyParser.json());

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const REGEX_TELEFONO = /(\+?1[\s-]?)?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}/g;
const REGEX_DISPONIBLE = /sigue disponible|todav[ií]a disponible|est[aá] disponible|still available|is (it|this) available/i;

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.verifyToken) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', (req, res) => {
  const body = req.body;

  if (body.object !== 'page') {
    res.sendStatus(404);
    return;
  }

  res.status(200).send('EVENT_RECEIVED');

  (async () => {
    try {
      for (const entry of body.entry || []) {
        for (const webhook_event of entry.messaging || []) {
          await manejarEvento(webhook_event);
        }
      }
    } catch (error) {
      console.error('❌ Error grave en el procesamiento de colas:', error);
    }
  })();
});

async function manejarEvento(webhook_event) {
  const sender_psid = webhook_event.sender?.id;
  if (!sender_psid) return;

  if (webhook_event.delivery || webhook_event.read || webhook_event.watermark) {
    return;
  }

  // Entrada directa desde una tarjeta de Marketplace / anuncio con catalogo.
  const referral = webhook_event.referral || webhook_event.message?.referral || webhook_event.postback?.referral;
  if (referral) {
    console.log(`ℹ️ Referral recibido de ${sender_psid}:`, JSON.stringify(referral));
    const vehiculoReferido = resolveVehicleFromReferral(referral);
    if (vehiculoReferido) {
      const estado = getEstado(sender_psid);
      estado.vehiculo = vehiculoReferido;
      setEstado(sender_psid, estado);
    }
  }

  if (webhook_event.postback) {
    await manejarPostback(sender_psid, webhook_event.postback);
    return;
  }

  if (webhook_event.message?.is_echo) return;

  const quickReplyPayload = webhook_event.message?.quick_reply?.payload;
  if (quickReplyPayload) {
    await manejarPostback(sender_psid, { payload: quickReplyPayload });
    return;
  }

  const textoCliente = webhook_event.message?.text;
  if (!textoCliente) {
    // Mensaje sin texto (ej. solo una foto). No hay dato util para procesar.
    return;
  }

  console.log(`💬 Cliente (${sender_psid}): ${textoCliente}`);
  await enviarEscribiendo(sender_psid);

  const coincideTelefono = textoCliente.match(REGEX_TELEFONO);
  if (coincideTelefono) {
    await capturarLead(sender_psid, coincideTelefono[0]);
    return;
  }

  if (REGEX_DISPONIBLE.test(textoCliente)) {
    const respondido = await responderDisponibilidad(sender_psid, textoCliente);
    if (respondido) return;
  }

  const respuestaBot = await generarRespuesta(sender_psid, textoCliente);
  const tiempoTipeo = Math.min(respuestaBot.length * 25, 5000);
  await delay(tiempoTipeo);
  await enviarMensaje(sender_psid, respuestaBot);
}

async function manejarPostback(sender_psid, postback) {
  const payload = postback.payload || '';
  console.log(`👆 Postback de ${sender_psid}: ${payload}`);

  if (payload.startsWith('CHECK_AVAILABLE_')) {
    const vehicleId = payload.replace('CHECK_AVAILABLE_', '');
    const vehiculo = getById(vehicleId);
    if (vehiculo) {
      await enviarMensaje(
        sender_psid,
        `¡Sí! El ${formatVehicleSummary(vehiculo)} sigue disponible. ¿Te gustaría coordinar para verlo?`
      );
    } else {
      await enviarMensaje(sender_psid, 'Déjame confirmarte la disponibilidad, ¿cuál vehículo te interesa?');
    }
    return;
  }

  if (payload === 'TALK_WHATSAPP' || payload === 'GET_STARTED') {
    const estado = getEstado(sender_psid);
    const url = buildWhatsappUrl(estado.vehiculo);
    await enviarMensaje(
      sender_psid,
      url
        ? `¡Con gusto! Escríbeme por WhatsApp aquí: ${url}`
        : '¡Con gusto! Cuéntame qué vehículo te interesa y para cuándo lo necesitas.'
    );
    return;
  }

  // Postback desconocido: iniciar conversacion normal.
  await enviarMensaje(sender_psid, 'Hola, ¿en qué vehículo estás interesado?');
}

// Responde de forma instantanea (sin pasar por el modelo) cuando el
// cliente pregunta "¿sigue disponible?", mostrando la tarjeta del vehiculo
// si ya se identificó (por referral o por mensajes previos).
async function responderDisponibilidad(sender_psid, textoCliente) {
  const estado = getEstado(sender_psid);
  let vehiculo = estado.vehiculo;

  if (!vehiculo) {
    const candidatos = findVehicles(textoCliente, 1);
    vehiculo = candidatos[0] || null;
  }

  if (!vehiculo) return false;

  estado.vehiculo = vehiculo;
  setEstado(sender_psid, estado);

  const whatsappUrl = buildWhatsappUrl(vehiculo);
  await enviarMensaje(sender_psid, `¡Sí! El ${formatVehicleSummary(vehiculo)} sigue disponible.`);
  await enviarTarjetaVehiculo(sender_psid, vehiculo, whatsappUrl);
  return true;
}

async function capturarLead(sender_psid, numeroCapturado) {
  console.log('\n==================================================');
  console.log('🚨 🎯 ¡LEAD CALIFICADO CAPTURADO! 🎯 🚨');
  console.log(`👤 ID de Facebook: ${sender_psid}`);
  console.log(`📱 Teléfono: ${numeroCapturado}`);
  console.log('==================================================\n');

  const estado = getEstado(sender_psid);
  notificarLead(sender_psid, numeroCapturado, estado.vehiculo);

  await delay(3500);
  await enviarMensaje(
    sender_psid,
    '¡Excelente! Hemos recibido tu información. Nuestro especialista se pondrá en contacto contigo por WhatsApp en breve para coordinar y enviarte las opciones disponibles.'
  );

  clearEstado(sender_psid);
}

module.exports = app;
