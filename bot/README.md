# Bot de Marketplace — vehículos financiados

Bot de Messenger/Marketplace para pre-calificar leads de vehículos financiados. Reutiliza la base del
bot BDC original (webhook de Meta + OpenRouter/Llama + notificación de leads por WhatsApp vía CallMeBot)
y le agrega funciones para responder bien a mensajes que llegan **desde Facebook Marketplace**.

**Regla de negocio (no negociable):** el bot nunca menciona, confirma ni estima precios, montos de
inicial (down payment), mensualidades, APR ni plazos. Si el cliente pregunta por números, se le ofrece
conectarlo con un especialista por WhatsApp. Esto se aplica en tres capas:

1. El `inventory.json` guarda `downPayment` por vehículo, pero `src/inventory.js` nunca lo expone: ni al
   modelo de IA, ni en las tarjetas, ni en la notificación de leads.
2. El *system prompt* (`src/systemPrompt.js`) prohíbe explícitamente mencionar montos y frases como
   "financiamos a todos" o "aprobación garantizada".
3. `src/guard.js` revisa cada respuesta de la IA antes de enviarla; si detecta un monto o una frase
   prohibida, descarta la respuesta completa y usa un mensaje seguro predefinido (evita frases a medio
   redactar).

## Qué se agregó respecto al bot original (upgrade Marketplace)

- **Detección de origen Marketplace/catálogo** (`referral` del webhook): si Meta indica de qué producto
  vino la conversación, el bot intenta enlazarlo con un vehículo del inventario por `id`. Para que esto
  funcione de forma confiable, sube tus vehículos a un catálogo de Facebook y usa el mismo `id` que
  aparece en `bot/data/inventory.json` (`V1`, `V2`, ...) como *Content ID/SKU* del producto.
- **Búsqueda por texto en el inventario** (`src/inventory.js#findVehicles`): si no hay `referral` (por
  ejemplo, mensajes que llegan desde la página normal de Messenger), el bot intenta identificar el
  vehículo por año/marca/modelo/color mencionados en el mensaje del cliente.
- **Respuesta rápida a "¿sigue disponible?"**: no pasa por el modelo de IA (más rápida y 100%
  consistente); confirma disponibilidad y envía una tarjeta con foto del vehículo.
- **Tarjetas de vehículo (Generic Template)**: foto + año/marca/modelo + tipo/millaje/color + botón para
  continuar por WhatsApp. Nunca incluye precio.
- **Botones/postbacks**: "¿Sigue disponible?" y "Hablar por WhatsApp" se resuelven sin usar la IA.
- **Contexto de vehículo persistente por cliente**: una vez identificado el vehículo (por referral o por
  texto), se recuerda durante toda la conversación y se lo pasa al modelo como contexto, para que no
  vuelva a preguntar lo que ya es visible en la publicación.
- **Notificación de leads con vehículo de interés** (sin monto) para que abras WhatsApp ya sabiendo qué
  auto preguntó el cliente.

## Configuración

```bash
cd bot
cp .env.example .env   # completa tus llaves reales, nunca subas .env a git
npm install
npm start
```

Variables requeridas: `VERIFY_TOKEN`, `PAGE_ACCESS_TOKEN`, `OPENROUTER_API_KEY`. El resto son opcionales
(ver `.env.example`).

El webhook queda expuesto en `POST/GET /webhook`, igual que el bot original (configúralo en el panel de
Meta for Developers apuntando a tu servidor público, con el mismo `VERIFY_TOKEN`).

## Nota sobre las fotos del inventario

Las fotos en `data/inventory.json` son links de descarga directa de Google Drive. Facebook necesita poder
descargarlas para mostrarlas en la tarjeta (`enviarTarjetaVehiculo`); si algún archivo es grande, Drive
puede mostrar una página de confirmación en vez de la imagen. Si ves que alguna tarjeta no carga la foto,
conviene re-alojar esas imágenes en un hosting que sirva la imagen directa (por ejemplo el mismo bucket o
CDN donde ya vive el inventario del sitio web).
