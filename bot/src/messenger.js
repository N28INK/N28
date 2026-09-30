const config = require('./config');

const GRAPH_URL = `https://graph.facebook.com/${config.graphApiVersion}/me/messages?access_token=${config.pageAccessToken}`;

async function llamarGraphAPI(body) {
  try {
    const response = await fetch(GRAPH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('❌ Error de Meta:', errorData);
    }
    return response.ok;
  } catch (error) {
    console.error('❌ Error de red hacia Meta:', error);
    return false;
  }
}

function enviarEscribiendo(sender_psid) {
  return llamarGraphAPI({ recipient: { id: sender_psid }, sender_action: 'typing_on' });
}

function enviarMensaje(sender_psid, texto) {
  return llamarGraphAPI({ recipient: { id: sender_psid }, message: { text: texto } });
}

function enviarQuickReplies(sender_psid, texto, opciones) {
  return llamarGraphAPI({
    recipient: { id: sender_psid },
    message: {
      text: texto,
      quick_replies: opciones.map((o) => ({
        content_type: 'text',
        title: o.title,
        payload: o.payload
      }))
    }
  });
}

// Tarjeta de vehiculo para respuestas de Marketplace: foto + datos +
// boton para continuar por WhatsApp. Nunca incluye precio ni inicial.
function enviarTarjetaVehiculo(sender_psid, vehicle, whatsappUrl) {
  const foto = vehicle.photos && vehicle.photos[0];
  const subtitulo = [
    vehicle.bodyType,
    vehicle.mileage ? `${Number(vehicle.mileage).toLocaleString('es-US')} millas` : null,
    vehicle.exteriorColor
  ]
    .filter(Boolean)
    .join(' · ');

  const buttons = [
    {
      type: 'postback',
      title: '¿Sigue disponible?',
      payload: `CHECK_AVAILABLE_${vehicle.id}`
    }
  ];
  if (whatsappUrl) {
    buttons.push({ type: 'web_url', title: 'Hablar por WhatsApp', url: whatsappUrl });
  }

  return llamarGraphAPI({
    recipient: { id: sender_psid },
    message: {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'generic',
          elements: [
            {
              title: `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
              subtitle: subtitulo,
              image_url: foto,
              buttons
            }
          ]
        }
      }
    }
  });
}

module.exports = {
  enviarEscribiendo,
  enviarMensaje,
  enviarQuickReplies,
  enviarTarjetaVehiculo
};
