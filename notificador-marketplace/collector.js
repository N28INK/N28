/* Notificador Marketplace v0.10 — collector.js
 * Lee la lista de chats que se ve en la página y el nombre de la cuenta de
 * Facebook que tiene la sesión iniciada. Sabe leer dos páginas:
 *   - facebook.com/messages (Messenger): filas con enlaces /t/<id>;
 *   - facebook.com/marketplace/inbox (bandeja de Marketplace): sin enlaces /t/,
 *     se lee el texto de cada fila ("Comprador", "· Artículo", mensaje, hora).
 * Lo cargan DOS caminos que comparten el mismo "mundo aislado" de la pestaña:
 *   - el content script (content_scripts en manifest.json), cada pocos segundos;
 *   - el background (chrome.scripting) cada 30 segundos, por si Chrome durmió la pestaña.
 * Por eso todo el estado global se inicializa solo si no existe todavía, y
 * la versión evita quedarse con un lector viejo tras actualizar la extensión.
 */
(() => {
  'use strict';
  if (globalThis.mnCollectVersion === 10) return;

  // Líneas que no son parte del mensaje: hora relativa, "Activo ahora", marcas de no leído…
  const MONTH = '(?:ene|enero|feb|febrero|mar|marzo|abr|abril|may|mayo|jun|junio|jul|julio|ago|agosto|sep|sept|septiembre|oct|octubre|nov|noviembre|dic|diciembre|jan|january|february|march|apr|april|june|july|aug|august|september|october|november|dec|december)\\.?';
  const DAY = '(?:lun|lunes|mar|martes|mi[ée]|mi[ée]rcoles|jue|jueves|vie|viernes|s[áa]b|s[áa]bado|dom|domingo|mon|monday|tue|tuesday|wed|wednesday|thu|thursday|fri|friday|sat|saturday|sun|sunday)\\.?';
  const TIME_RE = new RegExp(
    '^(?:' + [
      '(?:hace\\s+)?\\d+\\s*(?:s|seg|m|min|mins|h|hr|hrs|d|w|sem|mo|y|a)\\.?',
      '(?:hace\\s+)?(?:\\d+|un|una)\\s*(?:segundos?|minutos?|horas?|d[ií]as?|semanas?|mes(?:es)?|a[ñn]os?|seconds?|minutes?|hours?|days?|weeks?|months?|years?)',
      'ahora|justo ahora|just now|now|ayer|yesterday',
      DAY,
      '\\d{1,2}\\s+(?:de\\s+)?' + MONTH + '(?:\\s+\\d{2,4})?',
      MONTH + '\\s+\\d{1,2}(?:,?\\s+\\d{2,4})?',
      '\\d{1,2}[:.]\\d{2}\\s*(?:a\\.?\\s?m\\.?|p\\.?\\s?m\\.?)?',
      '\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?'
    ].join('|') + ')$', 'i');
  const NOISE_RE = /^(?:·|•|activ[oa] ahora|active now|en l[ií]nea|online|mensaje no le[ií]do|mensajes no le[ií]dos|unread message|unread messages|no le[ií]do|sin leer|unread)$/i;
  // Estado de conexión que Facebook pone en la fila ("Activo ahora", "Active 5m ago"): no es el nombre ni el mensaje.
  const ACTIVE_RE = /^(?:activ[oa]\s+(?:ahora|hace\s+\S.*)|active\s+(?:now|\S.*\s+ago)|en l[ií]nea|online)$/i;
  const UNREAD_TEXT_RE = /\bunread\b|no le[ií]d[oa]s?|sin leer/i;
  const UNREAD_LINE_RE = /^(?:mensajes? no le[ií]dos?|unread messages?|no le[ií]d[oa]|sin leer|unread)$/i;
  // "Unread message: Hola" / "Mensaje no leído: Hola": la etiqueta oculta de Facebook delante del texto.
  const UNREAD_PREFIX_RE = /^(?:unread messages?|mensajes? no le[ií]dos?|no le[ií]d[oa]s?)\s*:\s*/i;
  // Lo último lo hiciste tú: no es un mensaje del cliente.
  const MINE_RE = /^(?:(?:t[úu]|you|usted)\s*:|enviaste|you sent|reaccionaste|you reacted|t[úu] reaccionaste|le diste|you liked|anulaste|you unsent|eliminaste|you removed)/i;
  const BLUE_RE = /0,\s*132,\s*255|24,\s*119,\s*242|8,\s*102,\s*255|59,\s*89,\s*152|0,\s*100,\s*209/;
  const MP_PATH_RE = /\/marketplace\/inbox/i;
  const MP_INBOX_URL = 'https://www.facebook.com/marketplace/inbox/';

  if (typeof globalThis.mnLastCount !== 'number') globalThis.mnLastCount = 0;
  if (typeof globalThis.mnAccountTry !== 'number') {
    globalThis.mnAccount = null;
    globalThis.mnAccountTry = 0;
    globalThis.mnAccountFails = 0;
  }

  /* ---- Nombre de la cuenta de Facebook donde llegan los mensajes ----
   * Facebook deja los datos de quien inició sesión dentro de la propia página
   * (módulo "CurrentUserInitialData"). Se lee de ahí: no se hace ninguna petición.
   * Plan B: el número de usuario de la cookie c_user, buscado junto a un "name"
   * en los datos de la página. Si nada funciona, queda el nombre escrito a mano
   * en la Configuración.
   */
  const JSON_STR = '"((?:[^"\\\\]|\\\\.)*)"';
  const USER_DATA_RE = new RegExp('"CurrentUserInitialData"[^{]{0,60}\\{[^{}]{0,400}?"NAME":' + JSON_STR);

  function jsonText(raw) {
    try { return JSON.parse('"' + raw + '"'); } catch (e) { return raw; }
  }

  function cleanAccount(n) {
    return String(n || '')
      .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]+/g, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, 80);
  }

  function findAccount() {
    const cookie = /(?:^|;\s*)c_user=(\d+)/.exec(document.cookie || '');
    const uid = cookie ? cookie[1] : '';
    const byId = uid
      ? new RegExp('"name":' + JSON_STR + ',"id":"' + uid + '"|"id":"' + uid + '","name":' + JSON_STR)
      : null;
    let viaId = null;
    for (const sc of document.querySelectorAll('script[type="application/json"]')) {
      const t = sc.textContent;
      if (!t) continue;
      if (t.indexOf('"CurrentUserInitialData"') !== -1) {
        const m = USER_DATA_RE.exec(t);
        const name = m ? cleanAccount(jsonText(m[1])) : '';
        if (name) return { name: name, source: 'CurrentUserInitialData' };
      }
      if (byId && !viaId && t.indexOf('"id":"' + uid + '"') !== -1) {
        const m = byId.exec(t);
        const name = m ? cleanAccount(jsonText(m[1] || m[2])) : '';
        if (name) viaId = { name: name, source: 'id de usuario' };
      }
    }
    return viaId;
  }

  // Devuelve { name, source } o null. Una vez encontrado se recuerda (si cambian
  // de cuenta, Facebook recarga la página). Si no se encuentra, no se vuelve a
  // buscar en cada vuelta: cada 20 s al principio y cada 2 min después.
  globalThis.mnAccountInfo = function mnAccountInfo(force) {
    if (globalThis.mnAccount) return globalThis.mnAccount;
    const now = Date.now();
    const wait = globalThis.mnAccountFails < 5 ? 20 * 1000 : 120 * 1000;
    if (!force && now - globalThis.mnAccountTry < wait) return null;
    globalThis.mnAccountTry = now;
    let found = null;
    try { found = findAccount(); } catch (e) { found = null; }
    if (found) globalThis.mnAccount = found;
    else globalThis.mnAccountFails++;
    return found;
  };

  /* ---- Lectura de la lista de chats ---- */
  function threadId(href) {
    const m = String(href || '').match(/\/t\/(\d+)/);
    return m ? m[1] : null;
  }

  // "5 min" → 5, "2 h" → 120, "ahora" → 0. null si no es una hora relativa.
  // Sirve para notar que llegó OTRO mensaje igual: la hora del chat vuelve a "ahora".
  function ageMinutes(label) {
    const t = String(label || '').trim().toLowerCase();
    if (/^(?:ahora|justo ahora|just now|now)$/.test(t)) return 0;
    const m = /^(?:hace\s+)?(\d+|un|una)\s*(segundos?|seconds?|seg|min(?:utos?|utes?|s)?|mins?|horas?|hours?|hrs?|d[ií]as?|days?|semanas?|weeks?|sem|s|m|h|d|w)\.?$/.exec(t);
    if (!m) return null;
    const n = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : 1;
    const u = m[2];
    if (/^(?:s|seg|segundos?|seconds?)$/.test(u)) return 0;
    if (/^(?:m|min|mins|minutos?|minutes?)$/.test(u)) return n;
    if (/^(?:h|hr|hrs|horas?|hours?)$/.test(u)) return n * 60;
    if (/^(?:d|d[ií]as?|days?)$/.test(u)) return n * 1440;
    return n * 10080;
  }

  // Quita hora, "Activo ahora", etiquetas de no leído… y devuelve el texto del mensaje
  // (y la hora relativa de la fila, si se ve).
  function parseSnippet(lines) {
    const parts = [];
    let time = null;
    let unreadHint = false;
    for (let line of lines) {
      // "Hola, ¿sigue disponible? · 5 min" → "Hola, ¿sigue disponible?"
      line = line.replace(/\s*[·•]\s*([^·•]*)$/, (whole, tail) => {
        const t = tail.trim();
        // Hora conocida, o un final corto con números ("5 min", "12 sem.", "2d")
        if (TIME_RE.test(t) || (t.length <= 12 && /\d/.test(t))) {
          if (time === null) time = ageMinutes(t);
          return '';
        }
        return whole;
      }).trim();
      if (UNREAD_PREFIX_RE.test(line)) {
        unreadHint = true;
        line = line.replace(UNREAD_PREFIX_RE, '').trim();
      }
      if (!line || NOISE_RE.test(line)) continue;
      if (TIME_RE.test(line)) {
        if (time === null) time = ageMinutes(line);
        continue;
      }
      parts.push(line);
    }
    return {
      text: parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200),
      age: time,
      unreadHint: unreadHint
    };
  }

  function looksUnread(link, name, lines) {
    const label = link.getAttribute('aria-label') || '';
    if (UNREAD_TEXT_RE.test(label) || lines.some((l) => UNREAD_LINE_RE.test(l) || UNREAD_PREFIX_RE.test(l))) return true;
    // Puntito azul de "no leído"
    for (const el of link.querySelectorAll('[aria-hidden="true"], span:empty, div:empty')) {
      const cs = getComputedStyle(el);
      const w = parseFloat(cs.width) || 0;
      const h = parseFloat(cs.height) || 0;
      if (w <= 0 || w > 14 || h <= 0 || h > 14) continue;
      const br = (cs.borderRadius || '').replace(/\s/g, '');
      const round = br === '50%' || (parseFloat(br) || 0) >= Math.min(w, h) / 2;
      if (round && BLUE_RE.test(cs.backgroundColor || '')) return true;
    }
    // Texto del mensaje en negrita. Se ignora el nombre: en algunos diseños va
    // siempre en negrita y daba falsos "no leído" (fallo de la v0.4).
    for (const sp of link.querySelectorAll('span')) {
      if (sp.children.length) continue;
      const t = (sp.textContent || '').trim();
      if (!t || t === name || TIME_RE.test(t) || NOISE_RE.test(t)) continue;
      if ((parseInt(getComputedStyle(sp).fontWeight, 10) || 400) >= 600) return true;
    }
    return false;
  }

  // Messenger: cada chat es un enlace /t/<id>.
  function collectFromLinks() {
    const byId = new Map();
    const pageIsMarketplace = MP_PATH_RE.test(location.pathname) || /\/marketplace\b/i.test(location.pathname);
    for (const link of document.querySelectorAll('a[href*="/t/"]')) {
      const href = link.getAttribute('href') || '';
      const tid = threadId(href);
      if (!tid || byId.has(tid)) continue;
      const fullText = (link.innerText || '').trim();
      const lines = fullText.split('\n').map((s) => s.trim()).filter(Boolean).filter((l) => !ACTIVE_RE.test(l));
      if (lines.length < 2) continue; // sin nombre + mensaje no es una fila de la lista
      const name = lines[0].slice(0, 80);
      const sn = parseSnippet(lines.slice(1));
      if (!sn.text) continue;
      byId.set(tid, {
        tid: tid,
        pos: byId.size, // 0 = primera fila de la lista (la más reciente)
        name: name,
        text: sn.text,
        age: sn.age,
        src: 'enlaces',
        mine: MINE_RE.test(sn.text),
        // Las filas de Marketplace se ven como "Nombre · Artículo"
        isMarketplace: pageIsMarketplace || /marketplace/i.test(href) || /marketplace/i.test(fullText) || /\s[·•]\s/.test(name),
        unread: sn.unreadHint || looksUnread(link, lines[0], lines)
      });
    }
    return Array.from(byId.values());
  }

  /* Bandeja de Marketplace (facebook.com/marketplace/inbox). No usa enlaces /t/:
   * se lee el texto de la página. Cada chat son estas líneas seguidas:
   *     Comprador
   *     · Artículo            (empieza con "· ")
   *     Último mensaje
   *     Hora                  (puede faltar)
   * "Unread" / "No leído" aparece como una línea suelta justo antes del comprador
   * o dentro del bloque; se asigna a la fila a la que toca.
   */
  const MARKER_RE = /^(?:unread(?: messages?)?|(?:mensajes? )?no le[ií]d[oa]s?|sin leer)$/i;
  const CHIP_RE = /^(?:all|todos|unread|no le[ií]d[oa]s?|sin leer)$/i;
  const MP_SKIP_RE =/^(?:marketplace|browse all|notifications|inbox|marketplace access|buying|selling|create new listing|create multiple listings|location|categories|vehicles|property rentals|all|unread|filter by label|explorar todo|notificaciones|bandeja de entrada|comprar|vender|crear (?:un )?anuncio nuevo|ubicaci[oó]n|categor[ií]as|veh[ií]culos|todos|no le[ií]dos?)$/i;

  function hashId(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function collectFromMarketplaceText() {
    const raw = (document.body && document.body.innerText) || '';
    const lines = raw.split('\n')
      .map((s) => s.replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
    const rows = [];
    const used = new Set();
    for (let i = 0; i < lines.length - 2; i++) {
      const buyer = lines[i];
      const meta = lines[i + 1];
      if (MP_SKIP_RE.test(buyer) || MARKER_RE.test(buyer) || !/^[·•]\s+\S/.test(meta)) continue;
      const listing = meta.replace(/^[·•]\s*/, '');
      if (!listing || /^(?:within|dentro de)\b/i.test(listing)) continue;
      const sn = parseSnippet([lines[i + 2]]);
      let end = i + 2;
      let age = sn.age;
      if (lines[i + 3] && TIME_RE.test(lines[i + 3])) {
        end = i + 3;
        if (age === null) age = ageMinutes(lines[i + 3]);
      }
      const key = buyer + '|' + listing;
      if (used.has(key)) continue;
      used.add(key);
      if (!sn.text) continue;
      let unread = sn.unreadHint;
      for (let k = Math.max(0, i - 1); k <= end && !unread; k++) {
        // Un "No leídos" pegado a "Todos" es el filtro de arriba de la lista, no un chat sin leer.
        const chip = CHIP_RE.test(lines[k - 1] || '') || CHIP_RE.test(lines[k + 1] || '');
        if (MARKER_RE.test(lines[k]) && !chip) unread = true;
      }
      rows.push({
        tid: 'mp' + hashId(key),
        pos: rows.length,
        name: (buyer + ' · ' + listing).slice(0, 80),
        text: sn.text,
        age: age,
        src: 'texto',
        link: MP_INBOX_URL,
        mine: MINE_RE.test(sn.text),
        isMarketplace: true,
        unread: unread
      });
      i = end; // la siguiente fila empieza después de esta
    }
    return rows;
  }

  globalThis.mnCollect = function mnCollect() {
    const path = location.pathname;
    const kind = MP_PATH_RE.test(path) ? 'marketplace' : (/\/messages\b/.test(path) ? 'messages' : 'otra');
    let threads = collectFromLinks();
    let source = 'enlaces';
    if (kind === 'marketplace' && threads.length < 2) {
      let rows = [];
      try { rows = collectFromMarketplaceText(); } catch (e) { rows = []; }
      if (rows.length > threads.length) { threads = rows; source = 'texto'; }
    }
    const focused = document.visibilityState === 'visible' && document.hasFocus();
    // Primera vez que aparece la lista en esta página: solo memorizar, no avisar
    // de golpe de todos los chats viejos sin leer. Si la lista se vacía un instante
    // (Facebook la redibuja) NO se vuelve a empezar; solo al cambiar de tipo de página.
    if (globalThis.mnKind !== kind) {
      globalThis.mnKind = kind;
      globalThis.mnEverSeen = false;
    }
    const warmup = threads.length > 0 && !globalThis.mnEverSeen;
    if (threads.length) globalThis.mnEverSeen = true;
    globalThis.mnLastCount = threads.length;
    const acct = globalThis.mnAccountInfo(false);
    return {
      threads: threads,
      warmup: warmup,
      focused: focused,
      kind: kind,
      source: source,
      openTid: focused ? threadId(path) : null,
      account: acct ? acct.name : '',
      accountSource: acct ? acct.source : ''
    };
  };
  globalThis.mnCollectVersion = 10;
})();
