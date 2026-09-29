// City Cars Houston TX — inventario de vehículos.
// Único archivo a editar para agregar, quitar o corregir un carro.
// Variable global VEHICLES; se carga antes de i18n.js y app.js.
"use strict";

  // =====================================================================
  //  INVENTARIO — el único lugar que hay que editar para cambiar carros.
  //  drive: "4x4" solo cuando las fotos lo confirman (Z71, Rubicon);
  //         null = "por confirmar".
  //  seats: rango según configuración de fábrica; confirmar con el dealer.
  //  dealer: nombre del dealer con licencia que lo ofrece ("" = no se muestra).
  //  No poner precios, inicial, mensualidad, APR ni plazos aquí.
  // =====================================================================
  var VEHICLES = [
    {
      id: "CCH-01", slug: "chevrolet-tahoe-rst-rojo", make: "Chevrolet", model: "Tahoe RST", type: "suv",
      color: { es: "Rojo", en: "Red" }, year: "2025", miles: "25,000", condition: "used",
      seats: { es: "7 u 8 pasajeros", en: "7 or 8 seats" }, rows3: true, drive: null, dealer: "",
      photos: ["tahoe-rst-rojo-1", "tahoe-rst-rojo-2"],
      seen: { es: ["3 filas", "Estribos", "Rines negros", "Escape doble", "Vidrios polarizados"],
              en: ["3 rows", "Running boards", "Black wheels", "Dual exhaust", "Tinted windows"] },
      ideal: { es: "Familias que quieren espacio para todos y un look deportivo, en la ciudad y en la carretera.",
               en: "Families who want room for everyone and a sporty look, around town or on the highway." }
    },
    {
      id: "CCH-02", slug: "gmc-yukon-denali-azul", make: "GMC", model: "Yukon Denali", type: "suv",
      color: { es: "Azul oscuro", en: "Dark blue" }, year: "2022", miles: "45,000", condition: "used",
      seats: { es: "7 u 8 pasajeros", en: "7 or 8 seats" }, rows3: true, drive: null, dealer: "",
      photos: ["yukon-denali-azul-1", "yukon-denali-azul-2"],
      seen: { es: ["3 filas", "Parrilla cromada", "Rines cromados", "Escape doble"],
              en: ["3 rows", "Chrome grille", "Chrome wheels", "Dual exhaust"] },
      ideal: { es: "Familias grandes que buscan comodidad y un toque de lujo en viajes largos.",
               en: "Big families who want comfort and a touch of luxury on long drives." }
    },
    {
      id: "CCH-03", slug: "chevrolet-suburban-lt-gris", make: "Chevrolet", model: "Suburban LT", type: "suv",
      color: { es: "Gris", en: "Gray" }, year: "2022", miles: "50,000", condition: "used",
      seats: { es: "7 u 8 pasajeros", en: "7 or 8 seats" }, rows3: true, drive: null, dealer: "",
      photos: ["suburban-lt-gris-1", "suburban-lt-gris-2"],
      seen: { es: ["3 filas", "Estribos", "Rines plateados", "Parrilla cromada"],
              en: ["3 rows", "Running boards", "Silver wheels", "Chrome grille"] },
      ideal: { es: "Familias grandes que necesitan espacio de sobra para personas y maletas.",
               en: "Big families who need plenty of room for people and luggage." }
    },
    {
      id: "CCH-04", slug: "jeep-wrangler-rubicon-verde", make: "Jeep", model: "Wrangler Rubicon", type: "suv",
      color: { es: "Verde arena", en: "Sand green" }, year: "2024", miles: "15,000", condition: "used",
      seats: { es: "5 pasajeros", en: "5 seats" }, rows3: false, drive: "4x4", dealer: "",
      photos: ["wrangler-rubicon-verde-1", "wrangler-rubicon-verde-2"],
      seen: { es: ["4 puertas", "Llantas todo terreno", "Llanta de refacción", "Ganchos de arrastre", "Techo duro"],
              en: ["4 doors", "All-terrain tires", "Spare tire", "Tow hooks", "Hard top"] },
      ideal: { es: "Aventuras de fin de semana: playa, lodo y caminos fuera del asfalto.",
               en: "Weekend adventures: the beach, mud and roads off the pavement." }
    },
    {
      id: "CCH-05", slug: "chevrolet-suburban-rst-negro", make: "Chevrolet", model: "Suburban RST", type: "suv",
      color: { es: "Negro", en: "Black" }, year: "2025", miles: "20,000", condition: "used",
      seats: { es: "7 u 8 pasajeros", en: "7 or 8 seats" }, rows3: true, drive: null, dealer: "",
      photos: ["suburban-rst-negro-1", "suburban-rst-negro-2"],
      seen: { es: ["3 filas", "Estribos", "Rines bicolor", "Escape doble"],
              en: ["3 rows", "Running boards", "Two-tone wheels", "Dual exhaust"] },
      ideal: { es: "Familias grandes que viajan seguido y quieren espacio con estilo deportivo.",
               en: "Big families who travel a lot and want space with a sporty style." }
    },
    {
      id: "CCH-06", slug: "kia-telluride-plata", make: "Kia", model: "Telluride", type: "suv",
      color: { es: "Plata", en: "Silver" }, year: "2022", miles: "40,000", condition: "used",
      seats: { es: "7 u 8 pasajeros", en: "7 or 8 seats" }, rows3: true, drive: null, dealer: "",
      photos: ["telluride-plata-1", "telluride-plata-2"],
      seen: { es: ["3 filas", "Rines negros", "Detalles en negro"],
              en: ["3 rows", "Black wheels", "Blacked-out trim"] },
      ideal: { es: "Familias que quieren 3 filas en una SUV más fácil de manejar y estacionar en la ciudad.",
               en: "Families who want 3 rows in an SUV that's easier to drive and park in the city." }
    },
    {
      id: "CCH-07", slug: "chevrolet-silverado-z71-negro", make: "Chevrolet", model: "Silverado Z71", type: "truck",
      color: { es: "Negro", en: "Black" }, year: "2020", miles: "70,000", condition: "used",
      seats: { es: "5 o 6 pasajeros", en: "5 or 6 seats" }, rows3: false, drive: "4x4", dealer: "",
      photos: ["silverado-z71-negro-1", "silverado-z71-negro-2"],
      seen: { es: ["Cabina doble", "Estribos", "Viseras en ventanas", "Enganche de remolque", "Ganchos de arrastre"],
              en: ["Crew cab", "Running boards", "Window visors", "Tow hitch", "Tow hooks"] },
      ideal: { es: "Trabajo pesado, obra y caminos de terracería.",
               en: "Hard work, job sites and dirt roads." }
    },
    {
      id: "CCH-08", slug: "gmc-sierra-slt-blanca", make: "GMC", model: "Sierra SLT", type: "truck",
      color: { es: "Blanca", en: "White" }, year: "2023", miles: "35,000", condition: "used",
      seats: { es: "5 o 6 pasajeros", en: "5 or 6 seats" }, rows3: false, drive: null, dealer: "",
      photos: ["sierra-slt-blanca-1", "sierra-slt-blanca-2"],
      seen: { es: ["Cabina doble", "Estribos", "Parrilla cromada", "Enganche de remolque"],
              en: ["Crew cab", "Running boards", "Chrome grille", "Tow hitch"] },
      ideal: { es: "Trabajo entre semana y familia el fin de semana, con un toque más elegante.",
               en: "Work during the week and family on the weekend, with a more polished look." }
    },
    {
      id: "CCH-09", slug: "chevrolet-tahoe-z71-negro", make: "Chevrolet", model: "Tahoe Z71", type: "suv",
      color: { es: "Negro", en: "Black" }, year: "2018", miles: "90,000", condition: "used",
      seats: { es: "7 u 8 pasajeros", en: "7 or 8 seats" }, rows3: true, drive: "4x4", dealer: "",
      photos: ["tahoe-z71-negro-1", "tahoe-z71-negro-2"],
      seen: { es: ["3 filas", "Estribos", "Llantas todo terreno"],
              en: ["3 rows", "Running boards", "All-terrain tires"] },
      ideal: { es: "Familias que salen de la carretera: rancho, lago o caminos de tierra.",
               en: "Families who head off the highway: the ranch, the lake or dirt roads." }
    },
    {
      id: "CCH-10", slug: "chevrolet-silverado-lt-negro", make: "Chevrolet", model: "Silverado LT", type: "truck",
      color: { es: "Negro", en: "Black" }, year: "2023", miles: "30,000", condition: "used",
      seats: { es: "5 o 6 pasajeros", en: "5 or 6 seats" }, rows3: false, drive: null, dealer: "",
      photos: ["silverado-lt-negro-1", "silverado-lt-negro-2"],
      seen: { es: ["Cabina doble", "Estribos", "Rines negros grandes", "Enganche de remolque"],
              en: ["Crew cab", "Running boards", "Large black wheels", "Tow hitch"] },
      ideal: { es: "El día a día y el trabajo, con un look moderno.",
               en: "Everyday driving and work, with a modern look." }
    },
    {
      id: "CCH-11", slug: "gmc-sierra-denali-plata", make: "GMC", model: "Sierra 1500 Denali", type: "truck",
      color: { es: "Plata", en: "Silver" }, year: "2018", miles: "130,000", condition: "used",
      seats: { es: "5 o 6 pasajeros", en: "5 or 6 seats" }, rows3: false, drive: null, dealer: "",
      photos: ["sierra-denali-plata-1", "sierra-denali-plata-2"],
      seen: { es: ["Cabina doble", "Estribos", "Parrilla cromada", "Rines cromados", "Enganche de remolque"],
              en: ["Crew cab", "Running boards", "Chrome grille", "Chrome wheels", "Tow hitch"] },
      ideal: { es: "Trabajo entre semana y familia el fin de semana, con acabados de lujo.",
               en: "Work during the week and family on the weekend, with upscale trim." }
    },
    {
      id: "CCH-12", slug: "honda-crv-vino", make: "Honda", model: "CR-V", type: "suv",
      color: { es: "Rojo vino", en: "Wine red" }, year: "2018", miles: "100,000", condition: "used",
      seats: { es: "5 pasajeros", en: "5 seats" }, rows3: false, drive: null, dealer: "",
      photos: ["crv-vino-1", "crv-vino-2"],
      seen: { es: ["Quemacocos", "Rines de aluminio", "Parrilla cromada", "Asientos de piel"],
              en: ["Sunroof", "Alloy wheels", "Chrome grille", "Leather seats"] },
      ideal: { es: "Primer carro o manejo diario en la ciudad, fácil de estacionar.",
               en: "A first car or daily city driving, easy to park." }
    },
    {
      id: "CCH-13", slug: "ram-1500-laramie-gris", make: "Ram", model: "1500 Laramie", type: "truck",
      color: { es: "Gris", en: "Gray" }, year: "2019", miles: "147,000", condition: "used",
      seats: { es: "5 o 6 pasajeros", en: "5 or 6 seats" }, rows3: false, drive: null, dealer: "",
      photos: ["ram-laramie-gris-1", "ram-laramie-gris-2"],
      seen: { es: ["Cabina doble", "Rines de aluminio", "Parrilla cromada", "Espejos cromados"],
              en: ["Crew cab", "Alloy wheels", "Chrome grille", "Chrome mirrors"] },
      ideal: { es: "Viajes largos y trabajo, con espacio y comodidad de sobra.",
               en: "Long drives and work, with plenty of room and comfort." }
    },
    {
      id: "CCH-14", slug: "chevrolet-silverado-rst-negro", make: "Chevrolet", model: "Silverado 1500 RST", type: "truck",
      color: { es: "Negro", en: "Black" }, year: "2021", miles: "105,000", condition: "used",
      seats: { es: "5 o 6 pasajeros", en: "5 or 6 seats" }, rows3: false, drive: null, dealer: "",
      photos: ["silverado-rst-negro-1", "silverado-rst-negro-2"],
      seen: { es: ["Cabina doble", "Rines negros", "Parrilla en negro", "Enganche de remolque"],
              en: ["Crew cab", "Black wheels", "Blacked-out grille", "Tow hitch"] },
      ideal: { es: "Look deportivo todo en negro, para el trabajo y la ciudad.",
               en: "An all-black sporty look, for work and the city." }
    },
    {
      id: "CCH-15", slug: "ram-1500-bighorn-gris", make: "Ram", model: "1500 Big Horn", type: "truck",
      color: { es: "Gris", en: "Gray" }, year: "2022", miles: "84,000", condition: "used",
      seats: { es: "5 o 6 pasajeros", en: "5 or 6 seats" }, rows3: false, drive: null, dealer: "",
      photos: ["ram-bighorn-gris-1", "ram-bighorn-gris-2"],
      seen: { es: ["Cabina doble", "Rines de aluminio", "Escape doble", "Enganche de remolque"],
              en: ["Crew cab", "Alloy wheels", "Dual exhaust", "Tow hitch"] },
      ideal: { es: "Trabajo con remolque y viajes en carretera.",
               en: "Towing for work and highway trips." }
    },
    {
      id: "CCH-16", slug: "ford-f150-fx4-blanco", make: "Ford", model: "F-150 FX4", type: "truck",
      color: { es: "Blanco", en: "White" }, year: "2025", miles: "41,000", condition: "used",
      seats: { es: "5 o 6 pasajeros", en: "5 or 6 seats" }, rows3: false, drive: "4x4", dealer: "",
      photos: ["f150-fx4-blanco-1", "f150-fx4-blanco-2"],
      seen: { es: ["Cabina doble", "Estribos", "Rines negros", "Llantas todo terreno", "Paquete FX4"],
              en: ["Crew cab", "Running boards", "Black wheels", "All-terrain tires", "FX4 package"] },
      ideal: { es: "Trabajo pesado y caminos de terracería, prácticamente nueva.",
               en: "Heavy-duty work and dirt roads, practically new." }
    }
  ];

  // Permite reusar el mismo inventario desde public/api/chat.js (Node/CommonJS),
  // sin tocar el comportamiento en el navegador (module es undefined ahí).
  if (typeof module !== "undefined" && module.exports) { module.exports = VEHICLES; }
