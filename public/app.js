(function () {
  "use strict";

  var LANG = document.documentElement.lang === "en" ? "en" : "es";

  var CONFIG = {
    // Número armado por partes para dificultar el scraping. Único WhatsApp oficial: (281) 602-7044.
    whatsapp: ["1", "281", "602", "7044"].join(""),
    email: "" // Poner aquí el email de dominio (ej. "hola@tudominio.com"). Vacío = no se muestra.
  };

  // =====================================================================
  //  INVENTARIO — el único lugar que hay que editar para cambiar carros.
  //  draft: true  → año, millas y condición son GENÉRICOS (BORRADOR).
  //                 Cambiar a false solo cuando el dealer confirme los datos.
  //  drive: "4x4" solo cuando las fotos lo confirman (Z71, Rubicon);
  //         null = "por confirmar".
  //  seats: rango según configuración de fábrica; confirmar con el dealer.
  //  dealer: nombre del dealer con licencia que lo ofrece ("" = no se muestra).
  //  No poner precios, inicial, mensualidad, APR ni plazos aquí.
  // =====================================================================
  var VEHICLES = [
    {
      id: "CCH-01", slug: "chevrolet-tahoe-rst-rojo", make: "Chevrolet", model: "Tahoe RST", type: "suv",
      color: { es: "Rojo", en: "Red" }, year: "2025", miles: "25,000", condition: "used", draft: true,
      seats: { es: "7 u 8 pasajeros", en: "7 or 8 seats" }, rows3: true, drive: null, dealer: "",
      photos: ["tahoe-rst-rojo-1", "tahoe-rst-rojo-2"],
      seen: { es: ["3 filas", "Estribos", "Rines negros", "Escape doble", "Vidrios polarizados"],
              en: ["3 rows", "Running boards", "Black wheels", "Dual exhaust", "Tinted windows"] },
      ideal: { es: "Familias que quieren espacio para todos y un look deportivo, en la ciudad y en la carretera.",
               en: "Families who want room for everyone and a sporty look, around town or on the highway." }
    },
    {
      id: "CCH-02", slug: "gmc-yukon-denali-azul", make: "GMC", model: "Yukon Denali", type: "suv",
      color: { es: "Azul oscuro", en: "Dark blue" }, year: "2022", miles: "45,000", condition: "used", draft: true,
      seats: { es: "7 u 8 pasajeros", en: "7 or 8 seats" }, rows3: true, drive: null, dealer: "",
      photos: ["yukon-denali-azul-1", "yukon-denali-azul-2"],
      seen: { es: ["3 filas", "Parrilla cromada", "Rines cromados", "Escape doble"],
              en: ["3 rows", "Chrome grille", "Chrome wheels", "Dual exhaust"] },
      ideal: { es: "Familias grandes que buscan comodidad y un toque de lujo en viajes largos.",
               en: "Big families who want comfort and a touch of luxury on long drives." }
    },
    {
      id: "CCH-03", slug: "chevrolet-suburban-lt-gris", make: "Chevrolet", model: "Suburban LT", type: "suv",
      color: { es: "Gris", en: "Gray" }, year: "2022", miles: "50,000", condition: "used", draft: true,
      seats: { es: "7 u 8 pasajeros", en: "7 or 8 seats" }, rows3: true, drive: null, dealer: "",
      photos: ["suburban-lt-gris-1", "suburban-lt-gris-2"],
      seen: { es: ["3 filas", "Estribos", "Rines plateados", "Parrilla cromada"],
              en: ["3 rows", "Running boards", "Silver wheels", "Chrome grille"] },
      ideal: { es: "Familias grandes que necesitan espacio de sobra para personas y maletas.",
               en: "Big families who need plenty of room for people and luggage." }
    },
    {
      id: "CCH-04", slug: "jeep-wrangler-rubicon-verde", make: "Jeep", model: "Wrangler Rubicon", type: "suv",
      color: { es: "Verde arena", en: "Sand green" }, year: "2024", miles: "15,000", condition: "used", draft: true,
      seats: { es: "5 pasajeros", en: "5 seats" }, rows3: false, drive: "4x4", dealer: "",
      photos: ["wrangler-rubicon-verde-1", "wrangler-rubicon-verde-2"],
      seen: { es: ["4 puertas", "Llantas todo terreno", "Llanta de refacción", "Ganchos de arrastre", "Techo duro"],
              en: ["4 doors", "All-terrain tires", "Spare tire", "Tow hooks", "Hard top"] },
      ideal: { es: "Aventuras de fin de semana: playa, lodo y caminos fuera del asfalto.",
               en: "Weekend adventures: the beach, mud and roads off the pavement." }
    },
    {
      id: "CCH-05", slug: "chevrolet-suburban-rst-negro", make: "Chevrolet", model: "Suburban RST", type: "suv",
      color: { es: "Negro", en: "Black" }, year: "2025", miles: "20,000", condition: "used", draft: true,
      seats: { es: "7 u 8 pasajeros", en: "7 or 8 seats" }, rows3: true, drive: null, dealer: "",
      photos: ["suburban-rst-negro-1", "suburban-rst-negro-2"],
      seen: { es: ["3 filas", "Estribos", "Rines bicolor", "Escape doble"],
              en: ["3 rows", "Running boards", "Two-tone wheels", "Dual exhaust"] },
      ideal: { es: "Familias grandes que viajan seguido y quieren espacio con estilo deportivo.",
               en: "Big families who travel a lot and want space with a sporty style." }
    },
    {
      id: "CCH-06", slug: "kia-telluride-plata", make: "Kia", model: "Telluride", type: "suv",
      color: { es: "Plata", en: "Silver" }, year: "2022", miles: "40,000", condition: "used", draft: true,
      seats: { es: "7 u 8 pasajeros", en: "7 or 8 seats" }, rows3: true, drive: null, dealer: "",
      photos: ["telluride-plata-1", "telluride-plata-2"],
      seen: { es: ["3 filas", "Rines negros", "Detalles en negro"],
              en: ["3 rows", "Black wheels", "Blacked-out trim"] },
      ideal: { es: "Familias que quieren 3 filas en una SUV más fácil de manejar y estacionar en la ciudad.",
               en: "Families who want 3 rows in an SUV that's easier to drive and park in the city." }
    },
    {
      id: "CCH-07", slug: "chevrolet-silverado-z71-negro", make: "Chevrolet", model: "Silverado Z71", type: "truck",
      color: { es: "Negro", en: "Black" }, year: "2020", miles: "70,000", condition: "used", draft: true,
      seats: { es: "5 o 6 pasajeros", en: "5 or 6 seats" }, rows3: false, drive: "4x4", dealer: "",
      photos: ["silverado-z71-negro-1", "silverado-z71-negro-2"],
      seen: { es: ["Cabina doble", "Estribos", "Viseras en ventanas", "Enganche de remolque", "Ganchos de arrastre"],
              en: ["Crew cab", "Running boards", "Window visors", "Tow hitch", "Tow hooks"] },
      ideal: { es: "Trabajo pesado, obra y caminos de terracería.",
               en: "Hard work, job sites and dirt roads." }
    },
    {
      id: "CCH-08", slug: "gmc-sierra-slt-blanca", make: "GMC", model: "Sierra SLT", type: "truck",
      color: { es: "Blanca", en: "White" }, year: "2023", miles: "35,000", condition: "used", draft: true,
      seats: { es: "5 o 6 pasajeros", en: "5 or 6 seats" }, rows3: false, drive: null, dealer: "",
      photos: ["sierra-slt-blanca-1", "sierra-slt-blanca-2"],
      seen: { es: ["Cabina doble", "Estribos", "Parrilla cromada", "Enganche de remolque"],
              en: ["Crew cab", "Running boards", "Chrome grille", "Tow hitch"] },
      ideal: { es: "Trabajo entre semana y familia el fin de semana, con un toque más elegante.",
               en: "Work during the week and family on the weekend, with a more polished look." }
    },
    {
      id: "CCH-09", slug: "chevrolet-tahoe-z71-negro", make: "Chevrolet", model: "Tahoe Z71", type: "suv",
      color: { es: "Negro", en: "Black" }, year: "2018", miles: "90,000", condition: "used", draft: true,
      seats: { es: "7 u 8 pasajeros", en: "7 or 8 seats" }, rows3: true, drive: "4x4", dealer: "",
      photos: ["tahoe-z71-negro-1", "tahoe-z71-negro-2"],
      seen: { es: ["3 filas", "Estribos", "Llantas todo terreno"],
              en: ["3 rows", "Running boards", "All-terrain tires"] },
      ideal: { es: "Familias que salen de la carretera: rancho, lago o caminos de tierra.",
               en: "Families who head off the highway: the ranch, the lake or dirt roads." }
    },
    {
      id: "CCH-10", slug: "chevrolet-silverado-lt-negro", make: "Chevrolet", model: "Silverado LT", type: "truck",
      color: { es: "Negro", en: "Black" }, year: "2023", miles: "30,000", condition: "used", draft: true,
      seats: { es: "5 o 6 pasajeros", en: "5 or 6 seats" }, rows3: false, drive: null, dealer: "",
      photos: ["silverado-lt-negro-1", "silverado-lt-negro-2"],
      seen: { es: ["Cabina doble", "Estribos", "Rines negros grandes", "Enganche de remolque"],
              en: ["Crew cab", "Running boards", "Large black wheels", "Tow hitch"] },
      ideal: { es: "El día a día y el trabajo, con un look moderno.",
               en: "Everyday driving and work, with a modern look." }
    }
  ];

  // ---------- Textos dinámicos ----------
  var T = {
    es: {
      types: { suv: "SUV", truck: "Troca" }, used: "Usado",
      miles: "millas", draft: "BORRADOR", draftTitle: "Año, millas y condición por confirmar con el dealer",
      drive: "Tracción", driveTbd: "por confirmar", seen: "Se ve en las fotos", ideal: "Ideal para",
      dealerGeneric: "La ofrece un dealer con licencia en Houston.", dealerNamed: "La ofrece: ",
      ask: "Preguntar", plan: "Armar plan", save: "Guardar ", photoOf: " de ", prev: "Foto anterior", next: "Foto siguiente",
      altFront: " — vista delantera", altBack: " — vista trasera",
      filters: [["todos", "Todos"], ["truck", "Trocas"], ["suv", "SUV"], ["rows3", "3 filas"], ["4x4", "4x4 confirmada"]],
      empty: "No hay vehículos con ese filtro por ahora.",
      favOne: "Guardaste 1: ", favMany: function (n) { return "Guardaste " + n + " vehículos"; },
      waGeneral: "Hola City Cars Houston, vi su página y quiero que me conecten con un dealer.",
      waCar: function (v) { return "Hola City Cars Houston, me interesa la " + v + ". ¿Está disponible? ¿Me pueden mandar más fotos y video?"; },
      waFavs: function (list) { return "Hola City Cars Houston, me interesan estos vehículos: " + list + ". ¿Siguen disponibles?"; },
      undecided: "Todavía no decido", choose: "Elige una opción",
      cases: [
        { id: "familia", label: "Somos familia grande", text: "Tahoe, Suburban, Yukon y Telluride de 3 filas, con espacio para toda la familia y las sillas de los niños.", action: "Ver 3 filas", filter: "rows3" },
        { id: "primer", label: "Es mi primer crédito", text: "Muchos de nuestros dealers trabajan con compradores sin crédito o con su primer crédito. Te decimos con quién conviene hablar.", action: "Arma tu plan", plan: true },
        { id: "trabajo", label: "La necesito para trabajar", text: "Trocas de cabina doble con enganche de remolque, listas para la obra.", action: "Ver trocas", filter: "truck" },
        { id: "itin", label: "Tengo ITIN o matrícula", text: "Muchos de nuestros dealers trabajan con ITIN, matrícula consular o pasaporte. La aprobación la decide el dealer o el financiador.", action: "Arma tu plan", plan: true },
        { id: "danado", label: "Mi crédito está dañado", text: "Crédito dañado, repo o bancarrota: algunos dealers trabajan con esas situaciones. Cuéntanos y te decimos con honestidad qué esperar.", action: "Arma tu plan", plan: true },
        { id: "efectivo", label: "Me pagan en efectivo", text: "Si te pagan en efectivo o trabajas por tu cuenta, hay formas de comprobar ingresos. Te orientamos por WhatsApp.", action: "Arma tu plan", plan: true }
      ],
      down: ["Menos de $1,000", "$1,000 a $2,500", "$2,500 a $5,000", "Más de $5,000", "Prefiero decirlo en el chat"],
      income: ["Menos de $2,000", "$2,000 a $3,000", "$3,000 a $4,500", "Más de $4,500", "Prefiero decirlo en el chat"],
      tenure: ["Menos de 6 meses", "6 meses a 1 año", "1 a 2 años", "Más de 2 años", "Trabajo por mi cuenta"],
      docs: [["id", "Texas ID o licencia de manejo"], ["alt", "Matrícula consular o pasaporte"], ["itin", "ITIN o Social Security"], ["ingresos", "Comprobante de ingresos"], ["domicilio", "Comprobante de domicilio"]],
      nextBtn: "Siguiente", lastBtn: "Ver mi mensaje",
      errDown: "Elige cuánto tienes para la inicial.", errIncome: "Elige tu ingreso mensual aproximado.", errTenure: "Elige el tiempo en tu trabajo actual.",
      errName: "Escribe tu nombre (solo letras, mínimo 2).", errCity: "Escribe tu ciudad (solo letras, mínimo 2).", errConsent: "Marca la casilla para aceptar la política de privacidad.",
      rows: ["Vehículo", "Tu caso", "Tu inicial", "Ingreso", "En tu trabajo", "Documentos", "Compartir con dealers"],
      msgRows: ["Vehículo", "Mi caso", "Tengo para la inicial", "Ingreso mensual", "En mi trabajo", "Documentos que tengo", "Autorizo compartir con dealers asociados"],
      noCase: "Sin indicar", noDocs: "Prefiero no decir", yes: "Sí", no: "Todavía no",
      noteNoId: "Si no tienes identificación a la mano, escríbenos igual: te decimos qué suelen aceptar los dealers en Texas.",
      noteShare: "No marcaste la autorización para compartir con dealers. Te contestamos igual y te pedimos permiso antes de pasar tus datos a un dealer.",
      noteDecide: "La aprobación, el precio, la inicial y los términos los decide el dealer o el financiador, no City Cars Houston.",
      msgHello: function (n, c) { return "Hola City Cars Houston, soy " + n + " de " + c + ". Armé mi plan en la página:"; },
      msgEnd: "¿Con qué dealers me pueden conectar?"
    },
    en: {
      types: { suv: "SUV", truck: "Truck" }, used: "Used",
      miles: "miles", draft: "DRAFT", draftTitle: "Year, mileage and condition to be confirmed with the dealer",
      drive: "Drive", driveTbd: "to be confirmed", seen: "Visible in the photos", ideal: "Great for",
      dealerGeneric: "Offered by a licensed Houston dealer.", dealerNamed: "Offered by: ",
      ask: "Ask about it", plan: "Build my plan", save: "Save ", photoOf: " of ", prev: "Previous photo", next: "Next photo",
      altFront: " — front view", altBack: " — rear view",
      filters: [["todos", "All"], ["truck", "Trucks"], ["suv", "SUVs"], ["rows3", "3 rows"], ["4x4", "Confirmed 4x4"]],
      empty: "Nothing matches that filter right now.",
      favOne: "You saved 1: ", favMany: function (n) { return "You saved " + n + " vehicles"; },
      waGeneral: "Hi City Cars Houston, I saw your website and I'd like to be matched with a dealer.",
      waCar: function (v) { return "Hi City Cars Houston, I'm interested in the " + v + ". Is it still available? Can you send more photos and a video?"; },
      waFavs: function (list) { return "Hi City Cars Houston, I'm interested in these vehicles: " + list + ". Are they still available?"; },
      undecided: "Not sure yet", choose: "Choose one",
      cases: [
        { id: "familia", label: "Big family", text: "Three-row Tahoe, Suburban, Yukon and Telluride, with room for the whole family and the car seats.", action: "See 3-row SUVs", filter: "rows3" },
        { id: "primer", label: "First car or no credit", text: "Many of our dealers work with first-time buyers and people with no credit history. We'll tell you who's worth talking to.", action: "Build my plan", plan: true },
        { id: "trabajo", label: "I need it for work", text: "Crew cab trucks with tow hitches, ready for the job site.", action: "See trucks", filter: "truck" },
        { id: "itin", label: "I have an ITIN", text: "Many of our dealers work with ITIN, consular ID or passport. Approval is up to the dealer or lender.", action: "Build my plan", plan: true },
        { id: "danado", label: "Bad credit, repo or bankruptcy", text: "Some dealers work with bad credit, past repos or bankruptcy. Tell us your story and we'll be straight with you about what to expect.", action: "Build my plan", plan: true },
        { id: "efectivo", label: "Paid in cash / self-employed", text: "If you're paid in cash or work for yourself, there are ways to show income. We'll walk you through it on WhatsApp.", action: "Build my plan", plan: true }
      ],
      down: ["Under $1,000", "$1,000 to $2,500", "$2,500 to $5,000", "Over $5,000", "I'd rather say in the chat"],
      income: ["Under $2,000", "$2,000 to $3,000", "$3,000 to $4,500", "Over $4,500", "I'd rather say in the chat"],
      tenure: ["Under 6 months", "6 months to 1 year", "1 to 2 years", "Over 2 years", "Self-employed"],
      docs: [["id", "Texas ID or driver's license"], ["alt", "Consular ID or passport"], ["itin", "ITIN or Social Security"], ["ingresos", "Proof of income"], ["domicilio", "Proof of address"]],
      nextBtn: "Next", lastBtn: "See my message",
      errDown: "Choose how much you have for a down payment.", errIncome: "Choose your approximate monthly income.", errTenure: "Choose how long you've been at your current job.",
      errName: "Enter your name (letters only, at least 2).", errCity: "Enter your city (letters only, at least 2).", errConsent: "Check the box to accept the privacy policy.",
      rows: ["Vehicle", "Your situation", "Down payment", "Income", "At your job", "Documents", "Share with dealers"],
      msgRows: ["Vehicle", "My situation", "I have for a down payment", "Monthly income", "At my job", "Documents I have", "I authorize sharing with partner dealers"],
      noCase: "Not specified", noDocs: "Prefer not to say", yes: "Yes", no: "Not yet",
      noteNoId: "If you don't have an ID handy, message us anyway: we'll tell you what Texas dealers usually accept.",
      noteShare: "You didn't check the box to share with dealers. We'll still reply, and we'll ask your permission before passing anything to a dealer.",
      noteDecide: "Approval, price, down payment and terms are set by the dealer or lender, not by City Cars Houston.",
      msgHello: function (n, c) { return "Hi City Cars Houston, I'm " + n + " from " + c + ". I built my plan on your website:"; },
      msgEnd: "Which dealers can you connect me with?"
    }
  }[LANG];

  var HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.5s-7.5-4.6-9.2-9.1C1.6 8.2 3.6 4.5 7.2 4.5c2 0 3.4 1 4.8 2.8 1.4-1.8 2.8-2.8 4.8-2.8 3.6 0 5.6 3.7 4.4 6.9-1.7 4.5-9.2 9.1-9.2 9.1Z" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
  var CHEV_L = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var CHEV_R = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_OK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICON_INFO = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M12 7.5v6M12 16.6v.1" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';

  // ---------- Utilidades seguras ----------
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]); }
    if (text != null) n.textContent = text;
    return n;
  }
  function icon(node, svg) { node.innerHTML = svg; return node; } // solo SVG estáticos de este archivo
  function clean(v, max) {
    return String(v == null ? "" : v).replace(/[\u0000-\u001F\u007F<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  }
  function waLink(text) {
    var u = new URL("https://wa.me/" + CONFIG.whatsapp);
    u.searchParams.set("text", String(text).slice(0, 1500)); // los datos del usuario ya pasaron por clean()
    return u.toString();
  }
  function store(key, val) {
    try {
      if (val === undefined) { var r = localStorage.getItem(key); return r ? JSON.parse(r) : null; }
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) { return null; }
    return null;
  }
  function fullName(v) { return v.make + " " + v.model; }
  function label(v) { return fullName(v) + " " + v.color[LANG].toLowerCase() + " (" + v.id + ")"; }
  // Lista blanca: solo acepta un slug o ID exacto del inventario
  function resolveVehicle(raw) {
    if (typeof raw !== "string" || !raw) return null;
    var s = raw.slice(0, 80).trim().toLowerCase();
    for (var i = 0; i < VEHICLES.length; i++) {
      if (VEHICLES[i].slug === s || VEHICLES[i].id.toLowerCase() === s) return VEHICLES[i];
    }
    return null;
  }

  // ---------- Enlaces de WhatsApp generales ----------
  document.querySelectorAll("[data-wa]").forEach(function (a) { a.href = waLink(T.waGeneral); });
  var yearEl = $("year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());
  var mailSlot = $("mail-slot");
  if (mailSlot) {
    if (CONFIG.email) { var m = el("a", null, CONFIG.email); m.href = "mailto:" + CONFIG.email; mailSlot.appendChild(m); }
    else mailSlot.remove();
  }

  var grid = $("grid");
  if (!grid) return; // páginas de texto (privacidad, 404): no hay más que hacer
  document.body.classList.add("has-bar");

  // ---------- Casos ----------
  var caseChips = $("case-chips"), casePanel = $("case-panel");
  function showCase(c) {
    caseChips.querySelectorAll(".chip").forEach(function (b) { b.setAttribute("aria-checked", String(b.dataset.id === c.id)); });
    casePanel.textContent = "";
    casePanel.appendChild(el("p", null, c.text));
    var btn = el("button", { type: "button", "class": "btn btn-sign" }, c.action);
    btn.addEventListener("click", function () {
      if (c.plan) { setPerfil(c.id); goPlan(); }
      else { setFilter(c.filter); $("inventario").scrollIntoView(); }
    });
    casePanel.appendChild(btn);
  }
  T.cases.forEach(function (c) {
    var b = el("button", { type: "button", "class": "chip", role: "radio", "aria-checked": "false", "data-id": c.id }, c.label);
    b.addEventListener("click", function () { showCase(c); });
    caseChips.appendChild(b);
  });
  showCase(T.cases[0]);

  // ---------- Inventario ----------
  var currentFilter = "todos";
  var favs = (store("cch:favs") || []).filter(function (s) { return resolveVehicle(s); });
  var filtersEl = $("filters");

  T.filters.forEach(function (f) {
    var b = el("button", { type: "button", "class": "chip", "aria-pressed": "false", "data-id": f[0] }, f[1]);
    b.addEventListener("click", function () { setFilter(f[0]); });
    filtersEl.appendChild(b);
  });
  function setFilter(id) {
    currentFilter = id;
    filtersEl.querySelectorAll(".chip").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.id === id)); });
    renderGrid();
  }
  function matches(v) {
    if (currentFilter === "todos") return true;
    if (currentFilter === "rows3") return v.rows3;
    if (currentFilter === "4x4") return v.drive === "4x4";
    return v.type === currentFilter;
  }

  function gallery(v) {
    var g = el("div", { "class": "gallery" });
    var slides = el("div", { "class": "slides", tabindex: "0", "aria-label": fullName(v) });
    v.photos.forEach(function (p, i) {
      var base = "/img/" + p;
      slides.appendChild(el("img", {
        src: base + "-640.webp",
        srcset: base + "-640.webp 640w, " + base + "-1200.webp 1200w",
        sizes: "(max-width: 700px) 100vw, 400px",
        width: "640", height: "427", loading: "lazy", decoding: "async",
        alt: fullName(v) + " " + v.color[LANG].toLowerCase() + (i === 0 ? T.altFront : T.altBack)
      }));
    });
    g.appendChild(slides);
    g.appendChild(el("span", { "class": "tag" }, T.types[v.type] + " • " + T.used));
    var fav = icon(el("button", { type: "button", "class": "fav", "aria-pressed": String(favs.indexOf(v.slug) > -1), "aria-label": T.save + fullName(v) }), HEART);
    fav.addEventListener("click", function () { toggleFav(v.slug, fav); });
    g.appendChild(fav);
    var prev = icon(el("button", { type: "button", "class": "gnav prev", "aria-label": T.prev }), CHEV_L);
    var next = icon(el("button", { type: "button", "class": "gnav next", "aria-label": T.next }), CHEV_R);
    var count = el("span", { "class": "count", "aria-hidden": "true" }, "1/" + v.photos.length);
    function index() { return Math.round(slides.scrollLeft / Math.max(slides.clientWidth, 1)); }
    function sync() {
      var i = index();
      prev.disabled = i <= 0; next.disabled = i >= v.photos.length - 1;
      count.textContent = (i + 1) + "/" + v.photos.length;
    }
    function go(d) { slides.scrollTo({ left: (index() + d) * slides.clientWidth, behavior: "smooth" }); }
    prev.addEventListener("click", function () { go(-1); });
    next.addEventListener("click", function () { go(1); });
    slides.addEventListener("scroll", function () { window.requestAnimationFrame(sync); }, { passive: true });
    slides.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
      if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
    });
    g.appendChild(prev); g.appendChild(next); g.appendChild(count);
    sync();
    return g;
  }

  function renderGrid() {
    grid.textContent = "";
    var list = VEHICLES.filter(matches);
    if (!list.length) { grid.appendChild(el("p", { "class": "lead" }, T.empty)); return; }
    list.forEach(function (v) {
      var card = el("article", { "class": "car", id: v.slug, "aria-label": fullName(v) });
      card.appendChild(gallery(v));

      var body = el("div", { "class": "car-body" });
      var head = el("div");
      head.appendChild(el("h3", null, fullName(v)));
      head.appendChild(el("p", { "class": "car-sub" }, v.color[LANG] + " • ID " + v.id));
      body.appendChild(head);

      var yl = el("p", { "class": "yearline" });
      yl.appendChild(el("span", null, v.year + " • " + v.miles + " " + T.miles));
      if (v.draft) yl.appendChild(el("span", { "class": "draft", title: T.draftTitle }, T.draft));
      body.appendChild(yl);

      var specs = el("ul", { "class": "specs" });
      [[v.seats[LANG], ""], [T.drive + ": ", v.drive || T.driveTbd], [T.types[v.type], ""]].forEach(function (s) {
        var li = el("li");
        if (s[1]) { li.appendChild(document.createTextNode(s[0])); li.appendChild(el("b", null, s[1])); }
        else li.appendChild(el("b", null, s[0]));
        specs.appendChild(li);
      });
      body.appendChild(specs);

      var seen = el("div", { "class": "seen" });
      seen.appendChild(el("p", null, T.seen));
      var ul = el("ul");
      v.seen[LANG].forEach(function (f) { ul.appendChild(el("li", null, f)); });
      seen.appendChild(ul);
      body.appendChild(seen);

      var ideal = el("p", { "class": "ideal" });
      ideal.appendChild(el("b", null, T.ideal));
      ideal.appendChild(document.createTextNode(v.ideal[LANG]));
      body.appendChild(ideal);
      body.appendChild(el("p", { "class": "dealer-line" }, v.dealer ? T.dealerNamed + v.dealer : T.dealerGeneric));

      var actions = el("div", { "class": "car-actions" });
      var ask = el("a", { "class": "btn btn-wa", target: "_blank", rel: "noopener noreferrer", "aria-label": T.ask + ": " + fullName(v) }, T.ask);
      ask.href = waLink(T.waCar(label(v)));
      var plan = el("button", { type: "button", "class": "btn btn-ghost", "aria-label": T.plan + ": " + fullName(v) }, T.plan);
      plan.addEventListener("click", function () { selectVehicle(v.slug); goPlan(); });
      actions.appendChild(ask); actions.appendChild(plan);
      body.appendChild(actions);
      card.appendChild(body);
      grid.appendChild(card);
    });
  }
  function toggleFav(slug, btn) {
    var i = favs.indexOf(slug);
    if (i > -1) favs.splice(i, 1); else favs.push(slug);
    btn.setAttribute("aria-pressed", String(i === -1));
    store("cch:favs", favs);
    renderFavbar();
  }
  function renderFavbar() {
    var bar = $("favbar");
    if (!favs.length) { bar.classList.remove("show"); return; }
    var vs = favs.map(resolveVehicle);
    $("favtext").textContent = vs.length === 1 ? T.favOne + fullName(vs[0]) : T.favMany(vs.length);
    $("favlink").href = waLink(T.waFavs(vs.map(label).join(", ")));
    bar.classList.add("show");
  }
  setFilter("todos");
  renderFavbar();

  // ---------- Arma tu plan ----------
  var form = $("planform"), steps = form.querySelectorAll(".step"), err = $("err");
  var current = 0;
  var selV = $("f-vehiculo");
  selV.appendChild(el("option", { value: "" }, T.undecided));
  VEHICLES.forEach(function (v) { selV.appendChild(el("option", { value: v.slug }, fullName(v) + " • " + v.color[LANG])); });
  function fillSelect(sel, list) {
    sel.appendChild(el("option", { value: "" }, T.choose));
    list.forEach(function (t, i) { sel.appendChild(el("option", { value: String(i) }, t)); });
  }
  fillSelect($("f-ingreso"), T.income);
  fillSelect($("f-empleo"), T.tenure);

  function addOption(container, type, name, value, text) {
    var wrap = el("label", { "class": "opt" });
    var input = el("input", { type: type, name: name, value: value });
    wrap.appendChild(input); wrap.appendChild(el("span", null, text));
    container.appendChild(wrap);
    return input;
  }
  T.cases.forEach(function (c) { addOption($("opt-perfil"), "radio", "perfil", c.id, c.label); });
  T.down.forEach(function (d, i) { addOption($("opt-inicial"), "radio", "inicial", String(i), d); });
  T.docs.forEach(function (d) { addOption($("opt-docs"), "checkbox", "docs", d[0], d[1]); });

  function setPerfil(id) { form.querySelectorAll('input[name="perfil"]').forEach(function (r) { r.checked = r.value === id; }); }
  function selectVehicle(slug) { var v = resolveVehicle(slug); selV.value = v ? v.slug : ""; }
  function goPlan() { $("result").hidden = true; form.hidden = false; showStep(0); $("plan").scrollIntoView(); }

  function showStep(n) {
    current = n;
    steps.forEach(function (s, i) { s.classList.toggle("active", i === n); });
    $("progress").querySelectorAll("li").forEach(function (li, i) {
      li.classList.toggle("done", i < n); li.classList.toggle("now", i === n);
    });
    $("back").classList.toggle("invisible", n === 0);
    $("next").textContent = n === steps.length - 1 ? T.lastBtn : T.nextBtn;
    err.textContent = "";
  }
  function checked(name) { var r = form.querySelector('input[name="' + name + '"]:checked'); return r ? r.value : ""; }
  var NAME_RE = /^[A-Za-zÀ-ÖØ-öø-ÿÑñ' .-]{2,80}$/;

  function validate(n) {
    if (n === 1) {
      if (!checked("inicial")) return { msg: T.errDown, focus: form.querySelector('input[name="inicial"]') };
      if ($("f-ingreso").value === "") return { msg: T.errIncome, focus: $("f-ingreso") };
      if ($("f-empleo").value === "") return { msg: T.errTenure, focus: $("f-empleo") };
    }
    if (n === 3) {
      if (!NAME_RE.test(clean($("f-nombre").value, 80))) return { msg: T.errName, focus: $("f-nombre") };
      if (!NAME_RE.test(clean($("f-ciudad").value, 60))) return { msg: T.errCity, focus: $("f-ciudad") };
      if (!$("f-consent").checked) return { msg: T.errConsent, focus: $("f-consent") };
    }
    return null;
  }

  $("back").addEventListener("click", function () { if (current > 0) showStep(current - 1); });
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var problem = validate(current);
    if (problem) { err.textContent = problem.msg; if (problem.focus) problem.focus.focus(); return; }
    if (current < steps.length - 1) {
      showStep(current + 1);
      var f = steps[current].querySelector("input,select"); if (f) f.focus({ preventScroll: true });
      return;
    }
    buildPlan();
  });
  $("edit").addEventListener("click", function () { $("result").hidden = true; form.hidden = false; showStep(0); });

  function pick(list, raw) { var i = Number(raw); return raw !== "" && i >= 0 && i < list.length ? list[i] : ""; }

  function buildPlan() {
    var v = resolveVehicle(selV.value);
    var perfil = T.cases.filter(function (c) { return c.id === checked("perfil"); })[0];
    var docIds = Array.prototype.map.call(form.querySelectorAll('input[name="docs"]:checked'), function (i) { return i.value; });
    var docs = T.docs.filter(function (d) { return docIds.indexOf(d[0]) > -1; }).map(function (d) { return d[1]; });
    var share = $("f-share").checked;
    var nombre = clean($("f-nombre").value, 80), ciudad = clean($("f-ciudad").value, 60);

    var values = [
      v ? label(v) : T.undecided,
      perfil ? perfil.label : T.noCase,
      pick(T.down, checked("inicial")),
      pick(T.income, $("f-ingreso").value),
      pick(T.tenure, $("f-empleo").value),
      docs.length ? docs.join(", ") : T.noDocs,
      share ? T.yes : T.no
    ];
    var dl = $("ticket"); dl.textContent = "";
    values.forEach(function (val, i) { dl.appendChild(el("dt", null, T.rows[i])); dl.appendChild(el("dd", null, val)); });

    var notes = $("notes"); notes.textContent = "";
    function note(kind, text) {
      var n = icon(el("div", { "class": "note " + kind }), kind === "ok" ? ICON_OK : ICON_INFO);
      n.appendChild(el("span", null, text));
      notes.appendChild(n);
    }
    if (docIds.length && docIds.indexOf("id") < 0 && docIds.indexOf("alt") < 0) note("warn", T.noteNoId);
    if (!share) note("warn", T.noteShare);
    note("ok", T.noteDecide);

    var msg = T.msgHello(nombre, ciudad) + "\n" +
      values.map(function (val, i) { return "• " + T.msgRows[i] + ": " + val; }).join("\n") +
      "\n" + T.msgEnd;
    $("preview").textContent = msg;
    $("send").href = waLink(msg);

    form.hidden = true;
    var res = $("result"); res.hidden = false; res.focus({ preventScroll: true }); res.scrollIntoView();
  }

  // Parámetro ?vehiculo= (lista blanca; cualquier otro valor se ignora)
  try {
    var pre = resolveVehicle(new URLSearchParams(location.search).get("vehiculo"));
    if (pre) { selectVehicle(pre.slug); window.setTimeout(function () { $("plan").scrollIntoView(); }, 50); }
  } catch (e) { /* valor inválido: se ignora */ }
  showStep(0);
})();
