# Publicar City Cars Houston en Vercel

El sitio es estático: no tiene paso de compilación. Vercel publica **solo la carpeta `public/`**.
`CLAUDE.md` y esta guía quedan fuera y nunca se publican.

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
│   └── app.js            → lógica: menú, inventario, plan, ficha de especificaciones
├── fonts/                → Overpass WOFF2 (licencia OFL)
├── img/                  → fotos WebP (640 y 1200 px)
├── vercel.json           → cabeceras de seguridad (CSP, HSTS…) y redirects
├── _headers, _redirects  → equivalentes para Cloudflare Pages (ver sección alternativa al final)
└── robots.txt, favicon.svg
```

Los tres scripts se cargan en orden fijo (`vehicles.js` → `i18n.js` → `app.js`) con `defer` en cada
HTML; los dos primeros solo declaran datos globales (`VEHICLES`, `I18N`) y no tienen lógica.

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

Cada push a la rama de producción vuelve a desplegar solo.

Si necesitas crear el proyecto desde cero:
1. <https://vercel.com/new> → importa el repositorio.
2. En **Configure Project**, cambia **Root Directory** a `public`.
3. **Deploy**. Te da una URL tipo `https://tu-proyecto.vercel.app`.

## 2. Verificar en la URL `.vercel.app`

- Abre `https://n28-eight.vercel.app/`: debe llevarte a `/es/`.
- Abre DevTools → pestaña **Network** → recarga → toca el documento `/es/` → **Response Headers**:
  deben aparecer `content-security-policy`, `strict-transport-security`, `x-frame-options: DENY`, etc.
  (vienen de `public/vercel.json`).
- Pestaña **Console**: sin errores.
- Prueba desde el celular: inventario → **Ver más** de un vehículo → **Enviar mensaje por WhatsApp**.
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
El servidor local no envía las cabeceras de `vercel.json`; esas solo aplican en Vercel.

---

## Alternativa: Cloudflare Pages

El repo conserva `public/_headers` y `public/_redirects` (equivalentes a `vercel.json` pero en
sintaxis de Cloudflare Pages) por si el sitio se migra o se publica también ahí. Para usarlos:

1. <https://dash.cloudflare.com> → **Workers & Pages** → **Create** → pestaña **Pages** →
   **Connect to Git**, elige el repositorio.
2. **Build output directory:** `public`, **Build command:** vacío, **Framework preset:** `None`.
3. Cloudflare Pages lee `_headers` y `_redirects` automáticamente; no hace falta tocar nada más.
