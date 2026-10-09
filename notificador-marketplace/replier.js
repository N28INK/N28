/* Notificador Marketplace v0.19 — replier.js
 * Escribe (y envía) en un chat de Messenger un texto —y/o pega una foto— que TÚ
 * mandaste a mano en Telegram. Solo lo inyecta el background, en pestañas de
 * Facebook, cuando llega tu respuesta desde tu propio Telegram. No envía nada
 * por su cuenta.
 *
 * Pasos, y cada uno se comprueba antes de seguir:
 *   1. abrir el chat correcto (por su enlace /t/<id>) y confirmar que la dirección cambió;
 *   2. esperar a que la pantalla se quede quieta; si hay un TEXTO escrito en la caja
 *      que no sea nuestro, parar ahí (es un borrador tuyo: no se toca);
 *   3. si hay foto, pegarla (como si la copiaras y la pegaras en la caja);
 *   4. escribir el texto probando, en orden, hasta que la caja tenga EXACTAMENTE el
 *      mensaje. Con `humanMs` (lo normal desde v0.19) se escribe LETRA POR LETRA a
 *      ritmo humano (método H) de modo que todo el proceso —desde que empieza
 *      hasta que se pulsa Enviar— dure justo `humanMs` (el background sortea
 *      entre 10 y 20 s); si H falla se baja a A y C. Sin `humanMs`: A) execCommand
 *      de una vez (rápido), C) evento beforeinput de una vez, D) letra por letra con
 *      pausas cortas (probado en v0.14). Antes de pasar al siguiente método la caja
 *      se VACÍA y se comprueba que quedó vacía. El método rápido que funcionó se
 *      recuerda para la próxima vez;
 *   5. pulsar Enviar y confirmar. Si no se puede saber con certeza qué pasó, se
 *      detiene con "incierto" en vez de reintentar a ciegas (para no duplicar).
 * Si algo falla, no sigue: devuelve en qué paso falló. Si cambiaste de chat en Facebook
 * a mitad de camino, se aborta sin tocar nada (para no escribir en el chat equivocado).
 *
 * Qué se aprendió con un editor Lexical real (el que usa Messenger):
 *  - Mandar a la vez un `beforeinput` sintético con TODO el texto Y un
 *    `execCommand('insertText')` con el mismo texto lo inserta DOS veces (esa fue
 *    la falla de la v0.17). Por eso cada método usa UN solo mecanismo.
 *  - `execCommand('selectAll')` + `execCommand('delete')` NO vacía el editor;
 *    `selectAll` + `beforeinput deleteContentBackward` sí (por eso `clearVerified`
 *    prueba esa y, si hace falta, la otra, y comprueba que quedó vacío).
 *  - Escribir muchas letras seguidas sin ceder el turno pierde letras: el editor
 *    necesita un respiro entre una y otra (por eso el método D usa pausas).
 *
 * Límite conocido, sin forma de comprobarlo desde este entorno (no hay un
 * Facebook real a mano): identificar la vista previa de UNA foto recién pegada
 * se hace comparando qué miniaturas nuevas aparecen junto a la caja justo
 * después de pegarla (ver nearbyImages/preview más abajo), nunca por buscar
 * "cualquier imagen visible" en toda la conversación.
 */
(() => {
  'use strict';
  if (globalThis.mnReplyVersion === 6) return;

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);

  async function waitFor(fn, ms, step) {
    const end = Date.now() + ms;
    for (;;) {
      let v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      if (Date.now() > end) return null;
      await wait(step || 150);
    }
  }

  function visible(el) {
    return !!(el && (el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length)));
  }

  const norm = (s) => String(s || '').replace(/[​ ]/g, ' ').replace(/\s+/g, ' ').trim();
  // Texto "canónico": conserva los saltos de línea (una línea por renglón no
  // vacío) e ignora espacios repetidos y caracteres invisibles. Así un mensaje
  // de varias líneas no se da por bueno si se perdieron los saltos.
  const canon = (s) => String(s || '').split('\n')
    .map((l) => l.replace(/[​ \s]+/g, ' ').trim())
    .filter(Boolean).join('\n');

  // La caja donde se escribe el mensaje: un div editable con role="textbox".
  // Se busca de nuevo cada vez que hace falta: al cambiar de chat, Facebook
  // reemplaza este nodo por otro, y seguir usando el viejo escribiría al vacío.
  function findComposer() {
    const cands = Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"], div[contenteditable="true"][aria-label]'))
      .filter(visible);
    if (!cands.length) return null;
    let best = null;
    let bestScore = -1;
    for (const el of cands) {
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      let score = 0;
      if (/mensaje|message|aa\b/.test(label)) score += 2;
      if (el.closest('[role="main"]')) score += 2;
      if (el.closest('[role="dialog"]')) score -= 2;
      // la caja del chat abierto está abajo del todo
      score += el.getBoundingClientRect().bottom / (window.innerHeight || 1);
      if (score > bestScore) { best = el; bestScore = score; }
    }
    return best;
  }

  const composerText = (c) => norm(c.innerText || c.textContent || '');
  const boxCanon = (c) => canon(c.innerText || c.textContent || '');

  // Con la pestaña en segundo plano (o la ventana minimizada), Chrome frena los
  // temporizadores de esa página: cada pausa pedida puede acabar tardando casi
  // un segundo real. Las pausas "de cortesía" (dar tiempo a que Facebook
  // redibuje) se recortan mientras eso pasa.
  const settle = (ms) => wait(document.visibilityState === 'hidden' ? Math.min(ms, 60) : ms);

  // Pone el cursor al final de la caja (sin necesitar un clic) y da un respiro
  // para que el editor se entere de dónde está la selección.
  async function placeCaret(c) {
    c.focus();
    try {
      const s = getSelection();
      const r = document.createRange();
      r.selectNodeContents(c);
      r.collapse(false);
      s.removeAllRanges();
      s.addRange(r);
    } catch (e) { /* si no se puede, el focus() ya basta en muchos editores */ }
    await settle(70);
  }

  // Salto de línea dentro de la caja (Mayús+Enter). Se prueba el evento de
  // teclado (lo que entiende Messenger); si la caja no cambió, el comando del
  // navegador (lo que entiende un editor simple).
  async function lineBreak(c) {
    const before = c.innerHTML.length;
    c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, shiftKey: true, bubbles: true, cancelable: true }));
    await settle(40);
    if (c.innerHTML.length === before) {
      document.execCommand('insertLineBreak');
      await settle(40);
    }
  }

  // Método A (el más rápido): todo el mensaje con execCommand, una vez por línea.
  async function insertA(c, text) {
    await placeCaret(c);
    const lines = String(text).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i) await lineBreak(c);
      if (lines[i]) document.execCommand('insertText', false, lines[i]);
    }
  }

  // Método C: todo el mensaje con un evento beforeinput (sin execCommand).
  async function insertC(c, text) {
    await placeCaret(c);
    const lines = String(text).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i) await lineBreak(c);
      if (lines[i]) c.dispatchEvent(new InputEvent('beforeinput', { data: lines[i], inputType: 'insertText', bubbles: true, cancelable: true }));
    }
  }

  // Ceder el turno SIN temporizadores: Chrome frena los temporizadores de una
  // pestaña oculta (a ~1 s cada uno), pero no los mensajes de un MessageChannel.
  const yieldTask = () => new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => { ch.port1.close(); resolve(); };
    ch.port2.postMessage(0);
  });
  // Espera hasta una hora de performance.now(); si ya pasó, no espera nada. (Si la
  // pestaña está frenada, se llega tarde y las letras siguientes salen seguidas
  // hasta alcanzar el horario: la duración total casi no cambia.)
  const sleepUntil = async (at) => { const d = at - performance.now(); if (d > 2) await wait(d); };

  // Plan de tecleo "humano" para que TODO dure `totalMs` (desde ahora hasta pulsar
  // Enviar): una pausa para "leer y pensar", las letras a ritmo irregular (más
  // lento tras una palabra, más tras una coma o un punto, alguna duda suelta) y
  // una pausa final para "releer" antes de enviar. Un mensaje corto no se teclea
  // más lento de la cuenta: lo que sobra se reparte en las pausas.
  //   due[k]  = ms (desde el inicio del plan) a los que sale el carácter k
  //             (los saltos de línea cuentan como un carácter);
  //   sendAt  = ms a los que se debe pulsar Enviar.
  const MAX_MS_PER_CHAR = 450; // tecleo muy pausado, de una sola mano
  const MIN_MS_PER_CHAR = 8;   // tope de velocidad para textos larguísimos
  function humanPlan(text, totalMs) {
    const toks = Array.from(String(text)); // por carácter real (un emoji no se parte en dos)
    const n = toks.length;
    totalMs = Math.max(0, totalMs);
    let lead = Math.min(rand(900, 2200), totalMs * 0.25);
    let trail = Math.min(rand(600, 1500), totalMs * 0.2);
    let span = totalMs - lead - trail;
    const gaps = Math.max(0, n - 1);
    const maxSpan = gaps * MAX_MS_PER_CHAR;
    if (span > maxSpan) { // mensaje corto: no se escribe lento, se espera más antes y después
      const extra = span - maxSpan;
      lead += extra * 0.7;
      trail += extra * 0.3;
      span = maxSpan;
    }
    span = Math.max(span, gaps * MIN_MS_PER_CHAR);
    const w = toks.map((ch, i) => {
      let x = rand(0.55, 1.7);
      const prev = i ? toks[i - 1] : '';
      if (prev === ' ') x *= rand(1.0, 1.6);
      if (/[,.;:!?¿¡]/.test(prev)) x *= rand(1.8, 3.2);
      if (prev === '\n') x *= rand(2, 3.5);
      if (Math.random() < 0.025) x += rand(4, 9); // una duda
      return x;
    });
    let sum = 0;
    for (let i = 1; i < n; i++) sum += w[i];
    const scale = sum ? span / sum : 0;
    const due = [];
    let t = lead;
    for (let i = 0; i < n; i++) { if (i) t += w[i] * scale; due.push(t); }
    const sendAt = Math.max(totalMs, t + trail * 0.5);
    return { due: due, sendAt: sendAt, start: performance.now() };
  }

  // Método D (letra por letra; probado en v0.14): con `plan` (método H) cada letra
  // sale a su hora; sin él, con un respiro corto entre una y otra. Devuelve false
  // si a mitad de camino cambió el chat o desapareció la caja, y 'rechazado' si
  // (en el modo con horario) la primera letra no aparece en la caja: así no se
  // gastan 10-20 s tecleando en un editor que no acepta este método.
  async function insertD(c, text, threadRe, plan) {
    await placeCaret(c);
    const lines = String(text).split('\n');
    const short = String(text).length <= 300;
    let k = 0; // posición en el plan (los saltos de línea cuentan)
    const alive = () => {
      if (!threadRe.test(location.pathname)) return false;
      if (!c.isConnected) { // Facebook rehízo la caja a mitad de camino: se busca la nueva (del mismo chat)
        const n = findComposer();
        if (!n) return false;
        c = n;
      }
      return true;
    };
    // Si algo le quitó el cursor a la caja (p. ej. Facebook enfocó otra cosa), se
    // devuelve al final del texto; si no, se escribiría en el vacío.
    const keepCaret = async () => {
      const s = getSelection();
      if (document.activeElement !== c || !s || !s.rangeCount || !c.contains(s.anchorNode)) await placeCaret(c);
    };
    for (let li = 0; li < lines.length; li++) {
      if (!alive()) return false;
      if (li) {
        if (plan) await sleepUntil(plan.start + plan.due[k]);
        if (!alive()) return false;
        await lineBreak(c);
        k++;
      }
      for (const ch of lines[li]) {
        if (plan) await sleepUntil(plan.start + plan.due[k]);
        if (!alive()) return false;
        if (plan) await keepCaret();
        c.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
        c.dispatchEvent(new InputEvent('beforeinput', { data: ch, inputType: 'insertText', bubbles: true, cancelable: true }));
        document.execCommand('insertText', false, ch);
        c.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true, cancelable: true }));
        k++;
        if (!plan) await wait(short ? rand(10, 24) : rand(5, 10));
        else {
          await (document.visibilityState === 'hidden' ? yieldTask() : wait(rand(6, 12)));
          if (k === 1 && !(await waitFor(() => boxCanon(c).length > 0, 1500, 40))) return 'rechazado';
        }
      }
    }
    return true;
  }

  // Vacía la caja y COMPRUEBA que quedó vacía. `selectAll` + `delete` por sí
  // solos no vacían un editor Lexical; `selectAll` + beforeinput de borrado sí
  // (y en un editor simple basta el `delete`). Devuelve true solo si de verdad
  // quedó vacía.
  async function clearVerified(c) {
    for (let i = 0; i < 3; i++) {
      if (!boxCanon(c)) return true;
      c.focus();
      document.execCommand('selectAll');
      await settle(80);
      c.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }));
      await settle(120);
      if (boxCanon(c)) {
        document.execCommand('delete');
        await settle(120);
      }
    }
    return !boxCanon(c);
  }

  // Pega una imagen en la caja, igual que si la copiaras de otra parte y
  // apretaras Ctrl+V: así es como una página web normalmente deja adjuntar una
  // foto sin usar el selector de archivos del sistema operativo (que la
  // extensión no puede manejar).
  async function pasteImage(c, dataUrl, mime) {
    c.focus();
    const resp = await fetch(dataUrl);
    const blob = await resp.blob();
    const ext = /png/i.test(mime) ? 'png' : (/gif/i.test(mime) ? 'gif' : (/webp/i.test(mime) ? 'webp' : 'jpg'));
    const file = new File([blob], 'foto.' + ext, { type: mime || blob.type || 'image/jpeg' });
    const dt = new DataTransfer();
    dt.items.add(file);
    c.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }

  // Miniaturas visibles MUY cerca de la caja (la caja y uno o dos contenedores
  // hacia arriba) — a propósito NO toda la conversación ni "role=main" entero,
  // porque ahí también están las fotos del anuncio de Marketplace, las de
  // mensajes anteriores y los avatares. Esto solo sirve para notar qué
  // miniatura NUEVA aparece justo después de que NOSOTROS pegamos una foto
  // (ver `preview` en mnReply); nunca se usa para decidir si hay "un borrador".
  function nearbyImages(c) {
    const scope = (c.parentElement && c.parentElement.parentElement) || c.parentElement || c;
    return new Set(Array.from(scope.querySelectorAll('img')).filter(visible));
  }

  /* ---- "borrador" que dejamos NOSOTROS mismos a medias ----
   * Si un intento anterior se quedó a medias (por ejemplo, Chrome frenó los
   * tiempos de esta pestaña y el intento tardó más de lo que el background
   * esperó), el texto puede quedar escrito en la caja. Se recuerda, por chat, qué
   * texto dejamos nosotros (el que íbamos a mandar y, si no pudimos vaciar la
   * caja, exactamente lo que quedó), para poder limpiarlo solos la próxima vez —
   * un borrador que tú escribiste a mano casi nunca coincide carácter por
   * carácter con eso, y se sigue respetando.
   */
  const OWN_DRAFT_TTL_MS = 10 * 60 * 1000; // más viejo que esto, no se confía en que sea nuestro
  const ownDraftKey = (tid) => 'mn_owndraft_' + tid;

  async function getOwnDraft(tid) {
    try {
      const k = ownDraftKey(tid);
      const d = await chrome.storage.session.get(k);
      const rec = d[k];
      if (rec && Date.now() - rec.at < OWN_DRAFT_TTL_MS) return rec;
    } catch (e) { /* sin esto, se trata como si no hubiera rastro (más conservador) */ }
    return null;
  }
  async function setOwnDraft(tid, text, hasImage, stage, leftover) {
    try { await chrome.storage.session.set({ [ownDraftKey(tid)]: { text: String(text || ''), leftover: leftover ? String(leftover) : '', hasImage: !!hasImage, stage: stage || 'empezando', at: Date.now() } }); } catch (e) { /* best-effort */ }
  }
  async function clearOwnDraft(tid) {
    try { await chrome.storage.session.remove(ownDraftKey(tid)); } catch (e) { /* best-effort */ }
  }

  // Método de escritura que funcionó la última vez: se prueba primero.
  const METHOD_KEY = 'mn_insert_method';
  async function methodOrder() {
    const def = ['A', 'C', 'D'];
    try {
      const d = await chrome.storage.local.get(METHOD_KEY);
      const m = d[METHOD_KEY] && d[METHOD_KEY].m;
      if (def.includes(m)) return [m].concat(def.filter((x) => x !== m));
    } catch (e) { /* sin memoria: orden por defecto */ }
    return def;
  }
  function rememberMethod(m) {
    try { chrome.storage.local.set({ [METHOD_KEY]: { m: m, at: Date.now() } }); } catch (e) { /* best-effort */ }
  }

  const SEND_LABEL = /^(?:enviar|send|press enter to send|presiona (?:intro|enter) para enviar|pulsa (?:intro|enter) para enviar)$/i;

  function findSendButton(c) {
    const cr = c.getBoundingClientRect();
    let best = null;
    let bestD = Infinity;
    for (const b of document.querySelectorAll('[role="button"][aria-label], button[aria-label]')) {
      if (!SEND_LABEL.test((b.getAttribute('aria-label') || '').trim()) || !visible(b)) continue;
      const r = b.getBoundingClientRect();
      const d = Math.abs(r.top - cr.top) + Math.abs(r.left - cr.right);
      if (d < bestD) { best = b; bestD = d; }
    }
    return best;
  }

  function pressEnter(c, extra) {
    const init = Object.assign({ key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }, extra || {});
    c.focus();
    c.dispatchEvent(new KeyboardEvent('keydown', init));
    c.dispatchEvent(new KeyboardEvent('keypress', init));
    c.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  const snip = (s, n) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

  async function run(opts, t0) {
    const marks = [];
    let lapAt = Date.now();
    const lap = (n) => { const now = Date.now(); marks.push(n + ' ' + ((now - lapAt) / 1000).toFixed(1) + 's'); lapAt = now; };
    const done = (r) => Object.assign(r, { tookMs: Date.now() - t0, etapas: marks.join(' · ') });
    const tid = String(opts && opts.tid || '').replace(/\D/g, '');
    const text = String(opts && opts.text || '').replace(/\r\n/g, '\n').trim();
    const want = canon(text);
    const image = opts && opts.image && opts.image.dataUrl ? opts.image : null;
    const send = !(opts && opts.send === false);
    // Duración total deseada (ms) de la respuesta de texto, desde que empieza hasta
    // que se pulsa Enviar. 0/ausente = rápido (v0.18).
    const humanMs = text ? Math.min(Math.max(0, Number(opts && opts.humanMs) || 0), 60000) : 0;
    // Tiempo máximo ANTES de enviar. Después de eso, si el background ya se
    // rindió, lo peor que puede pasar es que este envío salga igual; por eso
    // antes de tocar el botón se comprueba que todavía estamos a tiempo.
    const preSendBudget = (image ? 60000 : 30000) + humanMs;
    if (!tid || (!text && !image)) return done({ ok: false, stage: 'datos', detail: 'falta el chat, y no hay texto ni foto' });
    const threadRe = new RegExp('/t/' + tid + '(?:/|$|\\?)');

    // 1. el chat correcto
    if (!threadRe.test(location.pathname)) {
      const link = Array.from(document.querySelectorAll('a[href*="/t/' + tid + '"]'))
        .find((a) => threadRe.test(a.getAttribute('href') || ''));
      if (!link) return done({ ok: false, stage: 'abrir', detail: 'no encuentro ese chat en la lista de esta página' });
      link.click();
      const opened = await waitFor(() => threadRe.test(location.pathname), 8000);
      if (!opened) return done({ ok: false, stage: 'abrir', detail: 'no se abrió el chat' });
      // Tras alternar de chat, Facebook tarda un instante en reconstruir la
      // conversación; si se escribe antes de que se asiente, el texto puede
      // quedar en el chat anterior o perderse.
      await settle(500);
    }
    lap('abrir');

    // 2. la caja de mensaje. Solo se bloquea por TEXTO (no por imágenes).
    let composer = await waitFor(() => (threadRe.test(location.pathname) ? findComposer() : null), 10000);
    if (!composer) return done({ ok: false, stage: 'caja', detail: 'no encuentro la caja para escribir el mensaje' });
    await settle(300);
    if (!threadRe.test(location.pathname)) return done({ ok: false, stage: 'abrir', detail: 'el chat abierto cambió; no escribo nada' });
    composer = findComposer() || composer; // revalidar tras la espera
    const curCanon = boxCanon(composer);
    if (curCanon) {
      const own = await getOwnDraft(tid);
      const mine = own && (curCanon === canon(own.text) || (own.leftover && curCanon === canon(own.leftover)));
      if (!mine) {
        return done({ ok: false, stage: 'borrador', detail: 'ya hay un texto escrito en ese chat (un borrador); no lo piso' });
      }
      // Es justo lo que ESTE proceso dejó a medias en un intento anterior:
      // se vacía (comprobando que quedó vacío) y se sigue, en vez de negarse.
      if (!(await clearVerified(composer))) {
        return done({ ok: false, stage: 'borrador', detail: 'quedó texto de un intento anterior en esa caja y no pude borrarlo; bórralo a mano (Ctrl+A y Supr) y vuelve a mandarlo' });
      }
    }
    // A partir de aquí vamos a tocar la caja: se anota qué vamos a dejar, para
    // que si ESTE intento se queda a medias, el próximo lo reconozca y limpie.
    await setOwnDraft(tid, text, !!image, 'escribiendo');
    lap('caja');

    // 3. pegar la foto, si hay. `preview` solo se asigna cuando pegar la foto
    // hizo aparecer EXACTAMENTE una miniatura nueva cerca de la caja.
    let preview = null;
    let previewUnverified = false;
    if (image) {
      const before = nearbyImages(composer);
      try {
        await pasteImage(composer, image.dataUrl, image.mime);
      } catch (e) {
        return done({ ok: false, stage: 'imagen', detail: 'no pude pegar la foto en la caja de mensaje (' + shortErr(e) + ')' });
      }
      await settle(1100); // darle tiempo a Facebook de procesar el adjunto y mostrar su vista previa
      if (!threadRe.test(location.pathname)) return done({ ok: false, stage: 'abrir', detail: 'el chat abierto cambió justo al pegar la foto; no sigo' });
      composer = findComposer() || composer;
      const after = nearbyImages(composer);
      const added = Array.from(after).filter((img) => !before.has(img));
      if (added.length === 1) preview = added[0];
      else previewUnverified = true;
      lap('foto');
    }

    // 4. escribir el texto (el mensaje, o el pie de la foto): se prueba cada
    // método hasta que la caja tenga EXACTAMENTE el mensaje. Entre un método y
    // el siguiente la caja se vacía y se comprueba que quedó vacía.
    let usedMethod = null;
    let plan = null; // horario de tecleo del método H
    if (text) {
      // Con tiempo humano: primero letra por letra a ritmo humano (H); si Facebook
      // no lo acepta, A y C (rápidos) para que el mensaje salga igual.
      const order = humanMs ? ['H', 'A', 'C'] : await methodOrder();
      let lastSeen = '';
      for (let i = 0; i < order.length && !usedMethod; i++) {
        const m = order[i];
        if (!threadRe.test(location.pathname)) return done({ ok: false, stage: 'abrir', detail: 'el chat abierto cambió justo al escribir; no envío' });
        composer = findComposer() || composer;
        if (i > 0 && !(await clearVerified(composer))) {
          lastSeen = boxCanon(composer);
          await setOwnDraft(tid, text, !!image, 'sucio', lastSeen);
          return done({ ok: false, stage: 'escribir', detail: 'Facebook no aceptó el texto con el método ' + order[i - 1] + ' y no pude vaciar la caja para probar otro; bórrala a mano (Ctrl+A y Supr). Vi: «' + snip(lastSeen, 40) + '»' });
        }
        if (m === 'A') await insertA(composer, text);
        else if (m === 'C') await insertC(composer, text);
        else {
          const d = await insertD(composer, text, threadRe, m === 'H' ? (plan = humanPlan(text, humanMs - (Date.now() - t0))) : null);
          if (d === false) {
            lastSeen = boxCanon(composer);
            await setOwnDraft(tid, text, !!image, 'sucio', lastSeen);
            return done({ ok: false, stage: 'escribir', detail: 'cambiaste de chat en Facebook mientras escribía; dejé de escribir' });
          }
          // d === 'rechazado': la caja no aceptó la primera letra; abajo no coincidirá y se pasa al método siguiente.
        }
        if (!threadRe.test(location.pathname)) return done({ ok: false, stage: 'abrir', detail: 'el chat abierto cambió justo al terminar de escribir; no envío' });
        composer = findComposer() || composer;
        const matched = await waitFor(() => boxCanon(composer) === want, (m === 'D' || m === 'H') ? 1500 : 800, 50);
        lastSeen = boxCanon(composer);
        if (matched) usedMethod = m;
      }
      if (!usedMethod) {
        // Ningún método dejó el texto exacto: se vacía lo que haya y se avisa
        // con lo que se esperaba y lo que se vio (para poder diagnosticar).
        const cleaned = await clearVerified(composer);
        if (cleaned) await clearOwnDraft(tid);
        else await setOwnDraft(tid, text, !!image, 'sucio', lastSeen);
        return done({
          ok: false, stage: 'escribir',
          detail: 'Facebook no aceptó el texto en la caja (esperaba ' + want.length + ' caracteres, vi ' + lastSeen.length + (lastSeen ? ': «' + snip(lastSeen, 40) + '»' : '') + ')' +
            (cleaned ? '' : '. No pude vaciar la caja: bórrala a mano (Ctrl+A y Supr)')
        });
      }
      if (usedMethod !== 'H') rememberMethod(usedMethod); // H es el modo "humano"; la memoria es del modo rápido
      lap('escribir ' + usedMethod);
    }
    await setOwnDraft(tid, text, !!image, 'escrito');
    if (!send) return done({ ok: true, sent: false, stage: image ? 'listo-con-foto' : 'escrito', metodo: usedMethod });

    // Pausa de "releer" antes de enviar, para que la respuesta completa dure lo
    // sorteado (solo si se escribió a ritmo humano; si H falló y se usó otro
    // método, ya se pasó de la hora y no se espera más).
    if (plan && usedMethod === 'H') {
      await sleepUntil(plan.start + plan.sendAt);
      composer = findComposer() || composer; // por si Facebook rehízo la caja durante la pausa
      lap('releer');
    }

    // Si ya pasó demasiado tiempo, es mejor NO enviar: el background pudo
    // haberse rendido y avisado, y un envío tardío acabaría duplicando.
    if (Date.now() - t0 > preSendBudget) {
      if (await clearVerified(composer)) await clearOwnDraft(tid);
      else await setOwnDraft(tid, text, !!image, 'sucio', boxCanon(composer));
      return done({ ok: false, stage: 'tiempo', detail: 'tardé demasiado antes de enviar y por seguridad no lo envié (para no duplicarlo si ya me diste por perdido); vuelve a mandarlo' });
    }

    // 5. enviar. "Enviado" = la caja quedó vacía Y (si había foto con vista
    // previa identificada) esa vista previa desapareció. Si un método no
    // confirma el envío, solo se prueba OTRO método cuando la caja sigue
    // exactamente igual que antes de intentarlo — si quedó en un estado
    // intermedio (ni vacía ni igual), no se sabe qué pasó de verdad, y
    // reintentar a ciegas ahí es como puede acabar mandándose el mensaje dos
    // veces. En ese caso se para con "incierto" en vez de adivinar.
    if (!threadRe.test(location.pathname)) return done({ ok: false, stage: 'abrir', detail: 'el chat abierto cambió antes de enviar; dejé lo escrito sin enviar' });
    const sentNow = () => !composer.isConnected || (!boxCanon(composer) && (!preview || !preview.isConnected || !visible(preview)));
    const intact = () => composer.isConnected && boxCanon(composer) === want;

    let cleared = false;
    const btn = await waitFor(() => findSendButton(composer), 2000);
    if (btn) { btn.click(); cleared = await waitFor(sentNow, 7000, 100); }
    if (!cleared && (!btn || intact())) {
      composer = findComposer() || composer;
      pressEnter(composer);
      cleared = await waitFor(sentNow, 5000, 100);
    }
    if (!cleared && intact()) {
      composer = findComposer() || composer;
      pressEnter(composer, { keyCode: 13, which: 13 });
      cleared = await waitFor(sentNow, 5000, 100);
    }
    if (!cleared && intact()) {
      const btnAgain = findSendButton(composer);
      if (btnAgain) { btnAgain.click(); cleared = await waitFor(sentNow, 5000, 100); }
    }
    if (!cleared && image && previewUnverified && intact()) {
      // No se pudo identificar la vista previa de la foto para confirmar por
      // ahí: se le da a Facebook un margen razonable y, si al menos el TEXTO
      // ya se fue de la caja, se da por enviado (queda constancia de que esta
      // parte no se verificó del todo).
      await settle(1500);
      cleared = !composerText(composer);
    }
    lap('enviar');
    if (!cleared) {
      if (intact()) {
        return done({ ok: false, stage: 'enviar', detail: 'quedó escrito/pegado en el chat pero Facebook no lo envió', metodo: usedMethod });
      }
      // Ni se confirmó el envío ni la caja quedó igual que antes: no hay
      // certeza de qué pasó. No se reintenta (duplicaría si en realidad sí se
      // envió) y no se hereda este rastro como "nuestro" para la próxima vez.
      await clearOwnDraft(tid);
      return done({ ok: false, stage: 'incierto', detail: 'no pude confirmar si Facebook llegó a enviarlo; revisa ese chat a mano antes de volver a mandarlo (para no duplicarlo)', metodo: usedMethod });
    }
    // Darle un respiro a Facebook antes de que el background abra otro chat:
    // si se cambia de inmediato, un envío que aún no terminó de procesarse
    // (el "enviado" a veces llega un instante después de vaciar la caja) puede
    // mezclarse con el chat siguiente.
    await settle(600);
    await clearOwnDraft(tid); // se envió: no queda nada pendiente que cuidar en este chat
    return done({ ok: true, sent: true, stage: 'enviado', metodo: usedMethod, fotoSinVerificar: !!(image && previewUnverified) });
  }

  // Un solo envío a la vez por pestaña (hay una sola caja de mensaje): si llega
  // otra orden mientras una sigue en marcha —aunque el background ya la diera
  // por perdida—, se rechaza en vez de pelearse por la misma caja y duplicar.
  let running = null;
  const RUNNING_MAX_MS = 150 * 1000;

  /* opts: { tid: '123', text: 'Sí claro…', send: true, image: { dataUrl, mime } | null } */
  globalThis.mnReply = async function mnReply(opts) {
    const t0 = Date.now();
    if (running && t0 - running.at < RUNNING_MAX_MS) {
      return { ok: false, stage: 'ocupado', detail: 'sigo terminando la respuesta anterior en esta pestaña; espera unos segundos y revisa ese chat antes de volver a mandarlo', tookMs: 0, etapas: '' };
    }
    running = { at: t0 };
    try {
      return await run(opts, t0);
    } catch (e) {
      return { ok: false, stage: 'error', detail: 'error inesperado al contestar (' + shortErr(e) + ')', tookMs: Date.now() - t0, etapas: '' };
    } finally {
      running = null;
    }
  };

  function shortErr(e) {
    return String(e && e.message ? e.message : e).slice(0, 80);
  }

  globalThis.mnReplyVersion = 6;
})();
