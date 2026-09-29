# City Cars Houston — contexto para Claude Code

## Qué es el negocio
City Cars Houston NO es un dealer ni un prestamista. Es un puente entre compradores de Houston
(hispanos y angloparlantes) y muchos dealers con licencia en Texas. La página muestra un catálogo
amplio (trocas, SUV, sedanes) sin cotizaciones ni montos: solo la descripción de cada vehículo (año, millas, tipo, equipamiento).
Toda la conversión va a WhatsApp (+1 281 602 7044). No hay backend ni base de datos.

## Estado actual
- Sitio estático en `public/` (se publica solo esa carpeta). Ya publicado en Vercel bajo
  `https://n28-eight.vercel.app/` (Root Directory del proyecto Vercel = `public`); dominio propio
  pendiente de conectar. `public/vercel.json` reemplaza las cabeceras/redirects de `_headers` y
  `_redirects` (esos archivos son de Cloudflare Pages y Vercel los ignora; se dejaron por si en el
  futuro se publica ahí también). Ver `DEPLOY.md`.
  `/es/` y `/en/` con hreflang, `/es/privacidad/`, `/en/privacy/`, `404.html`, `_headers`, `_redirects`.
- JS dividido en tres scripts globales cargados en orden fijo con `defer` (`vehicles.js` → `i18n.js`
  → `app.js`; sin módulos ni bundler, para que siga siendo "sin build"):
  - `public/js/vehicles.js`: único archivo a editar para cambiar el INVENTARIO (variable `VEHICLES`).
  - `public/js/i18n.js`: textos ES/EN de la interfaz (variable `I18N`, indexada por `LANG` en app.js).
  - `public/js/app.js`: toda la lógica (menú, casos, inventario, ficha de especificaciones, plan).
  `public/css/styles.css`, fuente Overpass autoalojada en `public/fonts/`.
- Identidad "letrero de autopista de Texas" (aprobada por el dueño): verde #0F5A3C, amarillo #F5B700, asfalto #262C2F.
- `public/img/`: 16 vehículos × 2 fotos en WebP (640/1200 px). Pares verificados visualmente;
  Yukon renombrada a "azul" y Wrangler a "verde" (arena). El dueño confirmó tener permiso de los dealers.
  Los 6 vehículos CCH-11 a CCH-16 (Sierra Denali, CR-V, Ram Laramie, Silverado RST, Ram Big Horn,
  F-150 FX4) vienen de fotos del dueño con nombres de carpeta tipo "2018 GMC ... 3000 down payment":
  el monto de inicial y el "FINANCIADO" visible en algunas fotos del lote NO se usó en ningún texto
  del sitio, por la regla de "sin montos" (ver tarea 3 abajo).
- Horario: lunes a domingo, 9 am – 8 pm. Respuesta el mismo día por WhatsApp (confirmado por el dueño).
- Las tareas 1–8 de abajo están hechas. Los textos legales fueron revisados y aprobados por el dueño;
  ya no llevan la marca `[REVISAR CON ABOGADO]`. Sigue pendiente confirmar año/millas/condición de
  cada vehículo con el dealer y llenar los `[COMPLETAR]` de la política de privacidad.
- Nombre de marca definitivo en todo el sitio: "City Cars Houston TX".
- El inventario ya no usa el mecanismo `draft` (se quitó por decisión del dueño): los 16 vehículos se
  publican directamente, sin insignia de borrador.
- Ficha de especificaciones: modal accesible desde "Ver más" o al hacer clic en la foto de un vehículo
  (`openDetail()` en `public/js/app.js`), con galería ampliada, specs y botones de acción.
- Logo "puente" (`public/img/logo-puente.svg`) en el header de todas las páginas; menú hamburguesa
  (`#nav-toggle`) para el nav en pantallas ≤960px.
- El JS se reestructuró en `public/js/` (`vehicles.js`, `i18n.js`, `app.js`) y el CSS pasó a
  `public/css/styles.css`; sigue siendo HTML/CSS/JS plano sin build ni dependencias de runtime
  (probado con jsdom sirviendo `public/` por HTTP: las 4 páginas cargan sin errores de consola).
- **Asistente de chat del inventario (confirmado por el dueño en sesión, excepción puntual a "sin
  backend"/"sin dependencias sin preguntar")**: widget `public/js/chat-widget.js` (botón "Preguntar
  al asistente" en `/es/` y `/en/`) que llama a la función serverless `public/api/chat.js` (Node,
  Vercel), la cual usa la API de Anthropic (`ANTHROPIC_API_KEY`, modelo configurable vía
  `ANTHROPIC_MODEL`) y traza cada conversación con Opik (`OPIK_API_KEY`, workspace `n28ink`,
  proyecto `city-cars-houston-chat`). Las API keys viven solo como variables de entorno en Vercel
  (ver `DEPLOY.md` 1.1), nunca en el código ni en el repo. El prompt del asistente reusa
  `VEHICLES` (única fuente de verdad; se exporta también como CommonJS al final de
  `public/js/vehicles.js` para que `api/chat.js` lo lea) y tiene grabadas las mismas reglas del
  sitio: sin precios/inicial/APR/plazos, sin frases prohibidas, sin inventar vehículos/dealers,
  siempre canaliza a WhatsApp (281) 602-7044 para cualquier paso real. `public/package.json` trae
  las únicas dos dependencias de runtime del sitio (`@anthropic-ai/sdk`, `opik`), usadas solo por
  esa función; el resto del sitio sigue sin build ni dependencias.

## Tareas pendientes (en este orden)
1. **Inventario real**: reemplaza los 6 vehículos de ejemplo por los 10 de `img/`
   (Tahoe RST rojo, Yukon Denali, Suburban LT gris, Wrangler Rubicon, Suburban RST negro,
   Telluride, Silverado Z71, Sierra SLT, Tahoe Z71, Silverado LT). Año y millas genéricos,
   marcados como borrador en un solo objeto de datos fácil de editar. Galería de 2 fotos por tarjeta.
   Optimiza las imágenes (WebP, ancho máx. 1200 px, `loading="lazy"`, `alt` descriptivo).
2. **Modelo "puente"**: reescribe los textos que hoy suenan a dealer/prestamista.
   Quitar o cambiar: "Reportamos tus pagos a los burós", "Placas y título por nuestra cuenta",
   "Firmamos en un punto de Houston", "Financiamiento interno". Posicionamiento:
   "Una conversación, muchos dealers" / "One conversation, many dealers".
   Añadir aviso: "City Cars Houston no es un concesionario ni un prestamista. Los vehículos los
   ofrecen y venden dealers con licencia en Texas. Aprobación, precio, inicial, APR y términos los
   decide el dealer o el financiador."
3. **SIN montos de inicial ni precios (decisión del dueño)**: eliminar cualquier cifra de
   down payment, precio, mensualidad, APR o plazo en TODO el sitio (hero, tarjetas, avisos del plan,
   mensajes de WhatsApp prellenados, metadatos). Quitar también la lógica que compara la inicial
   del cliente con la "anunciada". El cuestionario puede seguir preguntando el RANGO de inicial que
   el cliente tiene (es dato del cliente, no publicidad). El foco de cada vehículo es su
   DESCRIPCIÓN: año, millas, tipo (troca/SUV/sedán), pasajeros, tracción, equipamiento visible en
   las fotos (estribos, rines, 4x4, 3 filas, etc.) y un texto corto de para quién es ideal
   (familia, trabajo, primer carro). Datos genéricos marcados como borrador.
4. **Frases prohibidas** (43 TAC §215.247): nunca "financiamos a todos", "aprobación garantizada",
   "sin importar tu crédito", "everyone approved". Usar: "Muchos de nuestros dealers trabajan con
   ITIN, sin crédito o crédito dañado."
5. **Bilingüe ES/EN**: `/es/` y `/en/` (o toggle con URLs separadas + `hreflang`).
   Español primero; inglés escrito nativo para compradores con mal crédito, repos, bancarrota.
6. **Privacidad/consentimiento**: la pregunta de documentos (ITIN/matrícula/pasaporte) debe ser
   opcional, y añadir casilla separada: "Autorizo compartir esta información con dealers asociados".
   Añadir en el sitio: "Nunca pedimos número de Social ni depósitos por WhatsApp. Nuestro único
   WhatsApp oficial es (281) 602-7044."
7. **Seguridad y despliegue (Cloudflare Pages + dominio propio del dueño)**:
   - Estructura final lista para subir tal cual a Cloudflare Pages (sin build o con build simple).
   - Deja una guía `DEPLOY.md` con los pasos para publicar y conectar el dominio personalizado.
   - Separa el JS inline a `app.js` y el CSS a `styles.css`; autoaloja la fuente Overpass (WOFF2).
   - Crea `_headers` con: HSTS, CSP estricta (`default-src 'self'; img-src 'self' data:;
     script-src 'self'; style-src 'self'; font-src 'self'; frame-ancestors 'none';
     base-uri 'none'; form-action 'none'`), `X-Content-Type-Options: nosniff`,
     `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, `COOP: same-origin`.
   - Mantén: enlaces WhatsApp con `new URL()` + `searchParams`, `rel="noopener noreferrer"`,
     lista blanca de `?vehiculo=`, `textContent` (nunca `innerHTML` con datos del usuario).
8. **Verificación**: prueba el flujo inventario → plan → WhatsApp en 390 px y 1366 px,
   sin errores en consola, y con los payloads: `?vehiculo=<script>`, `?vehiculo=x%26text%3Dhack`.

## Reglas
- No agregar dependencias ni frameworks sin preguntar.
- No inventar datos de vehículos, reseñas ni número de dealers asociados.
- No usar logos de marcas (Chevrolet, GMC, Jeep, Kia) como elementos de marca.
- Cualquier texto legal *nuevo* lleva marca `[REVISAR CON ABOGADO]` hasta que el dueño lo confirme
  (los textos existentes ya fueron confirmados; ver "Estado actual").
