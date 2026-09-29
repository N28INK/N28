# Publicar City Cars Houston en Vercel

El sitio es estático (HTML/CSS/JS sin build) salvo por una sola pieza de backend: el asistente de
chat del inventario, que corre como función serverless en `public/api/chat.js`. Vercel publica
**solo la carpeta `public/`**. `CLAUDE.md` y esta guía quedan fuera y nunca se publican.

```
public/
├── index.html            → redirige a /es/
├── es/index.html         → sitio en español
├── es/privacidad/        → política de privacidad
├── en/index.html         → sitio en inglés
├── en/privacy/           → privacy policy
├── 404.html
├── css/styles.css        → todos los estilos
├── js/
│   ├── vehicles.js       → INVENTARIO (variable global VEHICLES) — único archivo a editar para cambiar carros
│   ├── i18n.js           → textos de la interfaz ES/EN (variable global I18N)
│   ├── app.js            → lógica: menú, inventario, plan, ficha de especificaciones
│   └── chat-widget.js    → widget del asistente de chat (llama a /api/chat)
├── api/
│   └── chat.js           → función serverless (Node): llama a Anthropic y traza con Opik
├── package.json          → dependencias solo de api/chat.js (@anthropic-ai/sdk, opik)
├── fonts/                → Overpass WOFF2 (licencia OFL)
├── img/                  → fotos WebP (640 y 1200 px)
├── vercel.json           → cabeceras de seguridad (CSP, HSTS…) y redirects
├── _headers, _redirects  → equivalentes para Cloudflare Pages (ver sección alternativa al final)
└── robots.txt, favicon.svg
```

Los cuatro scripts de frontend se cargan en orden fijo (`vehicles.js` → `i18n.js` → `app.js` →
`chat-widget.js`) con `defer` en cada HTML; los dos primeros solo declaran datos globales
(`VEHICLES`, `I18N`) y no tienen lógica. La API key de Anthropic y la de Opik **solo** viven en
`public/api/chat.js`, que corre en el servidor — nunca llegan al navegador.

Deploy actual: **https://n28-eight.vercel.app/** (proyecto de Vercel con **Root Directory = `public`**).
Dominio propio: pendiente de conectar.

---

## 0. Antes de publicar (una sola vez)

1. **Pon tu dominio.** En los archivos HTML el dominio aparece como `https://n28-eight.vercel.app`
   (canonical, hreflang, og:image). Cuando conectes un dominio propio, reemplázalo:
   ```bash
   grep -rl "n28-eight.vercel.app" public | xargs sed -i 's#https://n28-eight.vercel.app#https://TU-DOMINIO-REAL.com#g'
   ```
   (En Mac: `sed -i ''` en lugar de `sed -i`.)
2. **Textos legales.** Todo lo marcado `[REVISAR CON ABOGADO]` o `[COMPLETAR]` se ve en la página
   como etiqueta amarilla. Cuando el abogado/dueño lo apruebe, borra la etiqueta. Para encontrarlas todas:
   ```bash
   grep -rn "REVISAR CON ABOGADO\|COMPLETAR" public
   ```
   Pendiente hoy: los 4 `[COMPLETAR]` de `es/privacidad/` y `en/privacy/` (lista de dealers
   asociados, plazo de retención de conversaciones de WhatsApp, email y dirección postal).
3. **Inventario.** En `public/js/vehicles.js`: cuando el dealer confirme año, millas y condición de
   un vehículo, corrige los datos. Si un vehículo se vende, **bórralo de la lista el mismo día**.
4. **Email (opcional).** En `public/js/app.js`, `CONFIG.email`. Si queda vacío, no se muestra.

## 1. Proyecto en Vercel

El proyecto ya está creado y conectado al repositorio. Configuración clave:

- **Framework Preset:** Other (sitio estático, sin build).
- **Root Directory:** `public` (así Vercel sirve `public/index.html` como `/`, y lee
  `public/vercel.json` como la raíz del proyecto).
- **Build Command:** *(vacío)*.
- **Output Directory:** *(vacío / por defecto, ya que Root Directory ya apunta a `public`)*.

Cada push a la rama de producción vuelve a desplegar solo. Vercel detecta `public/package.json` y
corre `npm install` automáticamente para la función `public/api/chat.js` — no hace falta configurar
un Build Command.

Si necesitas crear el proyecto desde cero:
1. <https://vercel.com/new> → importa el repositorio.
2. En **Configure Project**, cambia **Root Directory** a `public`.
3. **Deploy**. Te da una URL tipo `https://tu-proyecto.vercel.app`.

## 1.1 Variables de entorno del asistente de chat

En el proyecto de Vercel → **Settings** → **Environment Variables**, agrega (nunca las pongas en el
código ni las compartas por chat/email):

| Variable | Obligatoria | Qué es |
|---|---|---|
| `ANTHROPIC_API_KEY` | Sí | Key de la API de Anthropic (console.anthropic.com). Sin ella, el chat responde "no disponible" pero el resto del sitio sigue funcionando normal. |
| `ANTHROPIC_MODEL` | No | ID del modelo (por defecto `claude-sonnet-5-5`). Cámbialo cuando Anthropic publique un modelo nuevo. |
| `OPIK_API_KEY` | Para trazas | Key del workspace de Opik (comet.com) donde se ven las conversaciones del asistente. Sin ella, el chat funciona igual pero sin observabilidad. |
| `OPIK_WORKSPACE` | No | Por defecto `n28ink`. |
| `OPIK_PROJECT_NAME` | No | Por defecto `city-cars-houston-chat` (así aparece el proyecto en el dashboard de Opik). |

Después de agregarlas, vuelve a desplegar (Vercel → **Deployments** → ⋯ → **Redeploy**) para que la
función las tome.

## 2. Verificar en la URL `.vercel.app`

- Abre `https://n28-eight.vercel.app/`: debe llevarte a `/es/`.
- Abre DevTools → pestaña **Network** → recarga → toca el documento `/es/` → **Response Headers**:
  deben aparecer `content-security-policy`, `strict-transport-security`, `x-frame-options: DENY`, etc.
  (vienen de `public/vercel.json`).
- Pestaña **Console**: sin errores.
- Prueba desde el celular: inventario → **Ver más** de un vehículo → **Enviar mensaje por WhatsApp**.
- Abre el botón **"Preguntar al asistente"** (esquina inferior derecha) y haz una pregunta sobre el
  inventario (ej. "¿tienen una troca 4x4?"). Debe responder sin mencionar precios ni montos. Si dice
  que no está disponible, revisa que `ANTHROPIC_API_KEY` esté configurada (paso 1.1).
- Prueba <https://securityheaders.com> con tu URL (debe salir A o A+).

## 3. Conectar tu dominio personalizado

1. En el proyecto de Vercel → **Settings** → **Domains** → agrega tu dominio
   (ej. `citycarshouston.com`) y también `www.citycarshouston.com`.
2. Vercel te da los registros DNS a crear en tu registrador (o en Cloudflare DNS si lo usas):
   normalmente un `A`/`ALIAS` para el dominio raíz y un `CNAME` para `www`.
3. Espera a que el certificado SSL diga **Valid** (minutos a algunas horas).
4. Elige cuál de los dos (raíz o `www`) es el dominio principal; Vercel redirige el otro
   automáticamente.
5. Repite el paso 0.1 (reemplazar `n28-eight.vercel.app` por el dominio final en los HTML).

## 3.1 Vercel Web Analytics

Las 6 páginas HTML ya cargan `<script defer src="/_vercel/insights/script.js"></script>`
(el método sin build/sin npm para sitios estáticos; el paquete `@vercel/analytics` de npm es para
proyectos con bundler, no aplica aquí). Falta un paso manual en el dashboard:

1. En el proyecto de Vercel → pestaña **Analytics** → **Enable**.
2. Las estadísticas (vistas, países, dispositivos) aparecen ahí mismo a los pocos minutos de tráfico.
   El plan Hobby incluye un límite mensual de eventos; si se supera hace falta plan Pro.

## 4. Ajustes de seguridad

- Los headers de seguridad (CSP, HSTS, X-Frame-Options, Permissions-Policy, COOP,
  X-Content-Type-Options, Referrer-Policy) los aplica `public/vercel.json` en cada respuesta;
  no dependen de configuración manual en el panel.
- Si el dominio **no** envía email, agrega en tu proveedor de DNS:
  - `TXT @  "v=spf1 -all"`
  - `TXT _dmarc  "v=DMARC1; p=reject;"`
  Si más adelante usas email con el dominio, cambia estos registros según tu proveedor.
- En tu **registrador**: activa **bloqueo de transferencia** (registrar lock).
- **Activa 2FA** en Vercel, en GitHub, en el registrador y en WhatsApp Business
  (verificación en dos pasos).

## 5. Cómo actualizar el sitio

- **Cambiar un vehículo, texto o foto:** edita en `public/`, haz commit y push → Vercel publica solo.
- **Agregar un vehículo:**
  1. Pon 2 fotos en `public/img/` con nombre `modelo-version-color-1` y `-2`, en WebP a 640 y 1200 px de ancho
     (`nombre-1-640.webp`, `nombre-1-1200.webp`, …). Cualquier conversor a WebP sirve (por ejemplo squoosh.app).
  2. Copia un bloque del objeto `VEHICLES` en `public/js/vehicles.js`, cambia `id`, `slug` (solo minúsculas y guiones), datos y fotos.
- **No pongas** precios, inicial, mensualidad, APR ni plazos en ningún texto ni mensaje (43 TAC §215.263 / Reg. Z).

## 6. Probar en local (opcional)

```bash
cd public && python3 -m http.server 8080
# abrir http://localhost:8080/es/
```
El servidor local no envía las cabeceras de `vercel.json`; esas solo aplican en Vercel. El botón
del asistente aparece igual, pero el chat no responde (no hay función serverless en un servidor
estático); usa `vercel dev` desde la raíz del proyecto si necesitas probar `public/api/chat.js`
en local.

---

## Alternativa: Cloudflare Pages

El repo conserva `public/_headers` y `public/_redirects` (equivalentes a `vercel.json` pero en
sintaxis de Cloudflare Pages) por si el sitio se migra o se publica también ahí. El sitio estático
(inventario, plan, privacidad) funciona igual ahí. El asistente de chat **no**: `public/api/chat.js`
usa la firma de función serverless de Vercel (`module.exports = async (req, res) => …`); Cloudflare
Pages Functions usa otra firma (`onRequestPost({ request, env })`). Si migras a Cloudflare, habría
que reescribir ese único archivo para Pages Functions — el resto del sitio, incluido el widget del
navegador, no cambia. Para usarlo tal cual en Vercel:

1. <https://dash.cloudflare.com> → **Workers & Pages** → **Create** → pestaña **Pages** →
   **Connect to Git**, elige el repositorio.
2. **Build output directory:** `public`, **Build command:** vacío, **Framework preset:** `None`.
3. Cloudflare Pages lee `_headers` y `_redirects` automáticamente; no hace falta tocar nada más.
