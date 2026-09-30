require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Falta la variable de entorno ${name}. Copia .env.example a .env y completala.`);
  }
  return value;
}

const config = {
  verifyToken: required('VERIFY_TOKEN'),
  pageAccessToken: required('PAGE_ACCESS_TOKEN'),
  graphApiVersion: process.env.GRAPH_API_VERSION || 'v20.0',

  openRouterApiKey: required('OPENROUTER_API_KEY'),
  openRouterModel: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct',
  openRouterReferrer: process.env.OPENROUTER_REFERRER || 'https://example.com',
  openRouterTitle: process.env.OPENROUTER_TITLE || 'Bot Marketplace Vehiculos',

  callMeBotPhone: process.env.CALLMEBOT_PHONE || '',
  callMeBotApiKey: process.env.CALLMEBOT_API_KEY || '',

  contactWhatsappNumber: process.env.CONTACT_WHATSAPP_NUMBER || '',

  port: process.env.PORT || 3000
};

module.exports = config;
