// City Cars Houston TX — asistente de chat del inventario.
// Función serverless de Vercel (Node.js). Nunca se ejecuta en el navegador,
// así que aquí SÍ viven las API keys (ANTHROPIC_API_KEY, OPIK_API_KEY),
// siempre como variables de entorno del proyecto en Vercel — nunca en el código.
"use strict";

const Anthropic = require("@anthropic-ai/sdk");
const { Opik } = require("opik");
const VEHICLES = require("../js/vehicles.js");

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const MAX_TOKENS = 400;
const MAX_MESSAGES = 20; // ~10 turnos
const MAX_CHARS_PER_MESSAGE = 800;
const MAX_TOTAL_CHARS = 6000;
const REQUEST_TIMEOUT_MS = 20000;

let anthropic = null;
function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

// Cliente Opik reutilizado entre invocaciones "warm"; si falta la key, queda en null
// y el chat sigue funcionando sin trazas (la observabilidad nunca debe romper el producto).
let opikClient;
function getOpik() {
  if (opikClient !== undefined) return opikClient;
  if (!process.env.OPIK_API_KEY) { opikClient = null; return opikClient; }
  try {
    opikClient = new Opik({
      apiKey: process.env.OPIK_API_KEY,
      workspaceName: process.env.OPIK_WORKSPACE || "n28ink",
      projectName: process.env.OPIK_PROJECT_NAME || "city-cars-houston-chat",
    });
  } catch (e) {
    opikClient = null;
  }
  return opikClient;
}

function inventoryForPrompt(lang) {
  return VEHICLES.map(function (v) {
    return {
      id: v.id,
      vehicle: v.make + " " + v.model,
      type: v.type,
      color: v.color[lang],
      year: v.year,
      miles: v.miles,
      seats: v.seats[lang],
      threeRows: v.rows3,
      drive: v.drive || (lang === "en" ? "to be confirmed" : "por confirmar"),
      featuresVisibleInPhotos: v.seen[lang],
      idealFor: v.ideal[lang],
    };
  });
}

function systemPrompt(lang) {
  const inventory = JSON.stringify(inventoryForPrompt(lang));
  if (lang === "en") {
    return (
      "You are the chat assistant on the City Cars Houston TX website. Always reply in English, " +
      "in 2 to 4 sentences, warm and direct.\n\n" +
      "WHAT CITY CARS HOUSTON TX IS:\n" +
      "It is not a dealer or a lender. It is a bridge between Houston buyers and several licensed Texas " +
      "dealers. Approval, price, down payment, APR and terms are always decided by the dealer or lender, " +
      "never by City Cars Houston TX.\n\n" +
      "RULES YOU MUST NEVER BREAK:\n" +
      "1. Never state or invent prices, down payment amounts, monthly payments, APR or loan terms, even if " +
      "asked directly. If asked, explain the dealer confirms that over WhatsApp.\n" +
      "2. Never say things like \"everyone approved\", \"guaranteed approval\" or \"no matter your credit\". " +
      "Instead say something like: \"Many of our dealers work with ITIN, no credit or damaged credit.\"\n" +
      "3. Only talk about vehicles in the INVENTORY list below. Never invent vehicles, reviews, or how many " +
      "dealers are in the network. If asked about something outside that list, say so honestly.\n" +
      "4. Never ask for a Social Security number or for payments/deposits in chat. The only official WhatsApp " +
      "is (281) 602-7044 — mention it if asked about safety or scams.\n" +
      "5. For any real next step (scheduling, a quote, confirming availability, talking to a dealer), always " +
      "point to WhatsApp or the site's \"Build my plan\" button — you cannot schedule or confirm anything.\n\n" +
      "CURRENT INVENTORY (single source of truth, JSON):\n" + inventory
    );
  }
  return (
    "Eres el asistente de chat del sitio web de City Cars Houston TX. Responde siempre en español, " +
    "en 2 a 4 oraciones, con un tono cálido y directo.\n\n" +
    "QUÉ ES CITY CARS HOUSTON TX:\n" +
    "No es un dealer ni un prestamista. Es un puente entre compradores de Houston y varios dealers con " +
    "licencia en Texas. La aprobación, el precio, la inicial, el APR y los términos siempre los decide el " +
    "dealer o el financiador, nunca City Cars Houston TX.\n\n" +
    "REGLAS QUE NUNCA PUEDES ROMPER:\n" +
    "1. Nunca des ni inventes precios, montos de inicial (down payment), mensualidades, tasas (APR) ni " +
    "plazos, aunque te los pidan directamente. Si preguntan, explica que eso lo confirma el dealer por " +
    "WhatsApp.\n" +
    "2. Nunca digas frases como \"financiamos a todos\", \"aprobación garantizada\" o \"sin importar tu " +
    "crédito\". En su lugar di algo como: \"Muchos de nuestros dealers trabajan con ITIN, sin crédito o " +
    "crédito dañado.\"\n" +
    "3. Solo puedes hablar de los vehículos de la lista de INVENTARIO de abajo. Nunca inventes vehículos, " +
    "reseñas ni cuántos dealers hay en la red. Si preguntan por algo fuera de esa lista, dilo con honestidad.\n" +
    "4. Nunca pidas número de Social Security ni pagos o depósitos por chat. El único WhatsApp oficial es " +
    "(281) 602-7044 — menciónalo si preguntan por seguridad o estafas.\n" +
    "5. Para cualquier paso real (agendar, cotizar, confirmar disponibilidad, hablar con un dealer), dirige " +
    "siempre a WhatsApp o al botón \"Crea tu plan\" del sitio — tú no agendas ni confirmas nada.\n\n" +
    "INVENTARIO ACTUAL (única fuente de verdad, JSON):\n" + inventory
  );
}

function clean(v, max) {
  return String(v == null ? "" : v).replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, max);
}

// Valida y sanea el body: solo turnos user/assistant, con límites de tamaño
// para no dejar pasar payloads gigantes ni abrir la puerta a costos descontrolados.
function parseMessages(body) {
  if (!body || !Array.isArray(body.messages)) return null;
  const raw = body.messages.slice(-MAX_MESSAGES);
  const out = [];
  let total = 0;
  for (const m of raw) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const content = clean(m.content, MAX_CHARS_PER_MESSAGE);
    if (!content) continue;
    total += content.length;
    if (total > MAX_TOTAL_CHARS) break;
    out.push({ role: m.role, content });
  }
  if (!out.length || out[out.length - 1].role !== "user") return null;
  return out;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const lang = req.body && req.body.lang === "en" ? "en" : "es";
  const messages = parseMessages(req.body);
  if (!messages) {
    return res.status(400).json({ error: "invalid_messages" });
  }

  const client = getAnthropic();
  if (!client) {
    return res.status(503).json({ error: "assistant_not_configured" });
  }

  const opik = getOpik();
  let trace = null;
  let llmSpan = null;
  if (opik) {
    try {
      trace = opik.trace({
        name: "chat-widget-message",
        input: { messages },
        tags: ["city-cars-houston", "chat-widget", lang],
        metadata: { lang },
      });
      llmSpan = trace.span({
        name: "anthropic-messages",
        type: "llm",
        input: { messages },
        model: MODEL,
        provider: "anthropic",
      });
    } catch (e) {
      trace = null;
      llmSpan = null;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);

  try {
    const response = await client.messages.create(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt(lang),
        messages: messages,
      },
      { signal: controller.signal }
    );
    clearTimeout(timeout);

    const text = (response.content || [])
      .filter(function (b) { return b.type === "text"; })
      .map(function (b) { return b.text; })
      .join("\n")
      .trim();

    if (llmSpan) {
      llmSpan.end({
        output: { text: text },
        usage: {
          promptTokens: response.usage && response.usage.input_tokens,
          completionTokens: response.usage && response.usage.output_tokens,
          totalTokens: response.usage && (response.usage.input_tokens + response.usage.output_tokens),
        },
      });
    }
    if (trace) trace.end({ output: { text: text } });

    return res.status(200).json({ text: text });
  } catch (err) {
    clearTimeout(timeout);
    if (llmSpan) llmSpan.end({ output: { error: String(err && err.message || err) } });
    if (trace) trace.end({ output: { error: String(err && err.message || err) } });
    return res.status(502).json({ error: "assistant_unavailable" });
  } finally {
    if (opik) {
      try { await opik.flush(); } catch (e) { /* la observabilidad nunca debe tumbar la respuesta */ }
    }
  }
};
