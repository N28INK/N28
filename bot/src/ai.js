const NodeCache = require('node-cache');
const config = require('./config');
const { buildSystemMessage, buildVehicleContextMessage } = require('./systemPrompt');
const { findVehicles } = require('./inventory');
const guard = require('./guard');

// Memoria por cliente (24h) — historial de chat + vehiculo de interes ya resuelto.
const clientesEstado = new NodeCache({ stdTTL: 86400, checkperiod: 120 });

const MAX_MENSAJES_HISTORIAL = 34; // + 1 system prompt

function getEstado(senderId) {
  let estado = clientesEstado.get(senderId);
  if (!estado) {
    estado = { historial: [buildSystemMessage()], vehiculo: null };
  }
  return estado;
}

function setEstado(senderId, estado) {
  clientesEstado.set(senderId, estado);
}

function clearEstado(senderId) {
  clientesEstado.del(senderId);
}

// Intenta identificar/actualizar el vehiculo de interes a partir del texto
// del cliente, sin pisar uno ya resuelto por el referral de Marketplace.
function actualizarVehiculoDesdeTexto(estado, texto) {
  if (estado.vehiculo) return estado;
  const candidatos = findVehicles(texto, 1);
  if (candidatos.length > 0) {
    estado.vehiculo = candidatos[0];
  }
  return estado;
}

async function generarRespuesta(senderId, mensajeUsuario) {
  try {
    let estado = getEstado(senderId);
    estado = actualizarVehiculoDesdeTexto(estado, mensajeUsuario);

    estado.historial.push({ role: 'user', content: mensajeUsuario });

    if (estado.historial.length > MAX_MENSAJES_HISTORIAL + 1) {
      const systemPrompt = estado.historial[0];
      estado.historial = [systemPrompt, ...estado.historial.slice(-MAX_MENSAJES_HISTORIAL)];
    }

    setEstado(senderId, estado);

    const mensajesParaModelo = [...estado.historial];
    const contextoVehiculo = buildVehicleContextMessage(estado.vehiculo);
    if (contextoVehiculo) {
      // Se inserta justo despues del system prompt, sin guardarlo en el
      // historial permanente (se reconstruye en cada llamada).
      mensajesParaModelo.splice(1, 0, contextoVehiculo);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.openRouterApiKey}`,
        'HTTP-Referer': config.openRouterReferrer,
        'X-Title': config.openRouterTitle,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.openRouterModel,
        messages: mensajesParaModelo,
        temperature: 0.6,
        max_tokens: 150
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    const data = await response.json();

    if (!response.ok) {
      console.error('❌ Error devuelto por OpenRouter:', data);
      return 'Comprendo. Para brindarte una atención más personalizada, ¿a qué número de WhatsApp puedo comunicarme?';
    }

    const respuestaIA = guard.enforce(
      data.choices?.[0]?.message?.content || 'Entendido. ¿Qué modelo tienes en mente?'
    );

    estado.historial.push({ role: 'assistant', content: respuestaIA });
    setEstado(senderId, estado);

    return respuestaIA;
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('⏳ OpenRouter tardó demasiado (Timeout).');
      return 'En este momento tenemos alto volumen de consultas. ¿Me facilitas tu WhatsApp para que te contactemos directo?';
    }
    console.error('❌ Error de red con OpenRouter:', error);
    return 'Tuvimos un pequeño inconveniente técnico. ¿Me facilitas tu WhatsApp para contactarte directamente?';
  }
}

module.exports = { generarRespuesta, getEstado, setEstado, clearEstado };
