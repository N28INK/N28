# City Cars Houston — contexto para Claude Code

## Qué es el negocio
City Cars Houston NO es un dealer ni un prestamista. Es un puente entre compradores de Houston
(hispanos y angloparlantes) y muchos dealers con licencia en Texas. La página muestra un catálogo
amplio (trocas, SUV, sedanes) sin cotizaciones: solo año, millas y una referencia de inicial.
Toda la conversión va a WhatsApp (+1 281 602 7044). No hay backend ni base de datos.

## Estado actual
- `index.html`: sitio de un solo archivo (HTML + CSS + JS vanilla, sin dependencias).
  Identidad "letrero de autopista de Texas": verde #0F5A3C, amarillo #F5B700, asfalto #262C2F, fuente Overpass.
- `img/`: 20 fotos reales (2 por vehículo). Los nombres se asignaron según el orden de subida:
  VERIFICA visualmente cada par antes de usarlo.

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
- Cualquier texto legal lleva marca `[REVISAR CON ABOGADO]` hasta que el dueño lo confirme.
