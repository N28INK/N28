# Publicar City Cars Houston en Cloudflare Pages

El sitio es estático: no tiene paso de compilación. Cloudflare publica **solo la carpeta `public/`**.
`CLAUDE.md` y esta guía quedan fuera y nunca se publican.

```
public/
├── index.html          → redirige a /es/
├── es/index.html       → sitio en español
├── es/privacidad/      → política de privacidad
├── en/index.html       → sitio en inglés
├── en/privacy/         → privacy policy
├── 404.html
├── app.js              → lógica + INVENTARIO (objeto VEHICLES)
├── styles.css
├── fonts/              → Overpass WOFF2 (licencia OFL)
├── img/                → fotos WebP (640 y 1200 px)
├── _headers            → cabeceras de seguridad (CSP, HSTS…)
├── _redirects          → / → /es/
└── robots.txt, favicon.svg
```

---

## 0. Antes de publicar (una sola vez)

1. **Pon tu dominio.** En los archivos HTML el dominio aparece como `https://tudominio.com`
   (canonical, hreflang, og:image). Reemplázalo por el tuyo, por ejemplo `https://citycarshouston.com`:
   ```bash
   grep -rl "tudominio.com" public | xargs sed -i 's#https://tudominio.com#https://TU-DOMINIO-REAL.com#g'
   ```
   (En Mac: `sed -i ''` en lugar de `sed -i`.)
2. **Textos legales.** Todo lo marcado `[REVISAR CON ABOGADO]` o `[COMPLETAR]` se ve en la página
   como etiqueta amarilla. Cuando el abogado lo apruebe, borra la etiqueta. Para encontrarlas todas:
   ```bash
   grep -rn "REVISAR CON ABOGADO\|COMPLETAR" public
   ```
3. **Inventario.** En `public/app.js`, objeto `VEHICLES`: cuando el dealer confirme año, millas y
   condición de un vehículo, corrige los datos y cambia `draft: true` a `draft: false`
   (así desaparece la etiqueta BORRADOR). Si un vehículo se vende, **bórralo de la lista el mismo día**.
4. **Email (opcional).** En `public/app.js`, `CONFIG.email`. Si queda vacío, no se muestra.

## 1. Crear el proyecto en Cloudflare Pages

**Opción A: conectado a GitHub (recomendado; cada push publica solo).**
1. Entra a <https://dash.cloudflare.com> → **Workers & Pages** → **Create** → pestaña **Pages** → **Connect to Git**.
2. Autoriza GitHub y elige el repositorio `n28ink/n28`.
3. Configuración de build:
   - **Production branch:** `main` (o la rama que quieras publicar).
   - **Framework preset:** `None`.
   - **Build command:** *(vacío)*.
   - **Build output directory:** `public`.
4. **Save and Deploy.** Te da una URL tipo `https://citycars-houston.pages.dev`.

**Opción B: subir la carpeta a mano (sin GitHub).**
1. **Workers & Pages** → **Create** → **Pages** → **Upload assets**.
2. Ponle nombre al proyecto y arrastra **el contenido** de la carpeta `public/`.
3. **Deploy site**. Para actualizar, repite la subida con la carpeta nueva.

## 2. Verificar en la URL `.pages.dev`

- Abre `https://TU-PROYECTO.pages.dev/`: debe llevarte a `/es/`.
- Abre DevTools → pestaña **Network** → recarga → toca el documento `/es/` → **Response Headers**:
  deben aparecer `content-security-policy`, `strict-transport-security`, `x-frame-options: DENY`, etc.
- Pestaña **Console**: sin errores.
- Prueba desde el celular: inventario → **Armar plan** → llenar → **Enviar mi plan por WhatsApp**.
- Prueba <https://securityheaders.com> con tu URL (debe salir A o A+).

## 3. Conectar tu dominio personalizado

1. En el proyecto de Pages → **Custom domains** → **Set up a custom domain**.
2. Escribe tu dominio (ej. `citycarshouston.com`) y luego repite para `www.citycarshouston.com`.
3. Cloudflare te dirá qué hacer según dónde esté tu dominio:
   - **Si el dominio ya usa los nameservers de Cloudflare:** crea los registros solo con **Activate domain**.
   - **Si el dominio está en otro registrador (GoDaddy, Namecheap, etc.):** lo más sencillo es
     **Add a site** en Cloudflare con tu dominio (plan Free) y cambiar los *nameservers* en tu
     registrador por los dos que te da Cloudflare. Espera a que diga **Active** (minutos a 24 h) y vuelve al paso 1.
     (Para `www` también basta un registro `CNAME www → TU-PROYECTO.pages.dev`, pero el dominio raíz
     necesita que la zona esté en Cloudflare.)
4. Espera a que el certificado SSL diga **Active**.
5. Redirige `www` al dominio principal (o al revés) para tener una sola dirección:
   **Rules** → **Redirect Rules** → plantilla *Redirect from WWW to root*.

## 4. Ajustes de seguridad en el panel de Cloudflare (zona del dominio)

- **SSL/TLS** → modo **Full (strict)**; **Edge Certificates** → **Always Use HTTPS: On**, **Minimum TLS 1.2**.
- **Security** → **Bots** → **Bot Fight Mode: On**.
- **DNS** → **DNSSEC: Enable** (y copia el registro DS en tu registrador si Cloudflare lo pide).
- **Correo**: si el dominio **no** envía email, agrega en DNS:
  - `TXT @  "v=spf1 -all"`
  - `TXT _dmarc  "v=DMARC1; p=reject;"`
  Si más adelante usas email con el dominio, cambia estos registros según tu proveedor.
- En tu **registrador**: activa **bloqueo de transferencia** (registrar lock).
- **Activa 2FA** en Cloudflare, en GitHub, en el registrador y en WhatsApp Business (verificación en dos pasos).

### Sobre HSTS
`_headers` envía `Strict-Transport-Security: max-age=31536000; includeSubDomains`.
Todos los subdominios del dominio deben funcionar con HTTPS. No se agregó `preload`: esa opción es
difícil de revertir y conviene activarla solo cuando el sitio lleve un tiempo estable.

## 5. Cómo actualizar el sitio

- **Cambiar un vehículo, texto o foto:** edita en `public/`, haz commit y push → Cloudflare publica solo (opción A).
- **Agregar un vehículo:**
  1. Pon 2 fotos en `public/img/` con nombre `modelo-version-color-1` y `-2`, en WebP a 640 y 1200 px de ancho
     (`nombre-1-640.webp`, `nombre-1-1200.webp`, …). Cualquier conversor a WebP sirve (por ejemplo squoosh.app).
  2. Copia un bloque del objeto `VEHICLES` en `public/app.js`, cambia `id`, `slug` (solo minúsculas y guiones), datos y fotos.
  3. Deja `draft: true` hasta confirmar año y millas con el dealer.
- **No pongas** precios, inicial, mensualidad, APR ni plazos en ningún texto ni mensaje (43 TAC §215.263 / Reg. Z).

## 6. Probar en local (opcional)

```bash
cd public && python3 -m http.server 8080
# abrir http://localhost:8080/es/
```
El servidor local no envía las cabeceras de `_headers`; esas solo aplican en Cloudflare.
