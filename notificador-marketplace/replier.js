/* Notificador Marketplace v0.17 — replier.js
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
 *   4. insertar el texto (el mensaje, o el pie de la foto) de una sola vez, y si
 *      el editor no lo aceptó así, reintentar con métodos más lentos pero más
 *      compatibles, comprobando siempre que quedó tal cual;
 *   5. pulsar Enviar y confirmar. Si no se puede saber con certeza qué pasó, se
 *      detiene con "incierto" en vez de reintentar a ciegas (para no duplicar).
 * Si algo falla, no sigue: devuelve en qué paso falló. Si cambiaste de chat en Facebook
 * a mitad de camino, se aborta sin tocar nada (para no escribir en el chat equivocado).
 *
 * Límite conocido, sin forma de comprobarlo desde este entorno (no hay un
 * Facebook real a mano): identificar la vista previa de UNA foto recién pegada
 * se hace comparando qué miniaturas nuevas aparecen junto a la caja justo
 * después de pegarla (ver nearbyImages/preview más abajo), nunca por buscar
 * "cualquier imagen visible" en toda la conversación — eso fue lo que en la
 * v0.16 confundía fotos del anuncio o de mensajes viejos con un adjunto
 * pendiente y bloqueaba respuestas de texto sin motivo real.
 */
(() => {
  'use strict';
  if (globalThis.mnReplyVersion === 4) return;

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);

  async function waitFor(fn, ms) {
    const end = Date.now() + ms;
    for (;;) {
      let v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      if (Date.now() > end) return null;
      await wait(150);
    }
  }

  function visible(el) {
    return !!(el && (el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length)));
  }

  const norm = (s) => String(s || '').replace(/[​ ]/g, ' ').replace(/\s+/g, ' ').trim();
  const squash = (s) => String(s || '').replace(/[​ \s]+/g, '');

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

  // Con la pestaña en segundo plano (o la ventana minimizada), Chrome frena los
  // temporizadores de esa página: cada pausa pedida puede acabar tardando casi
  // un segundo real. Las pausas "de cortesía" (dar tiempo a que Facebook
  // redibuje) se recortan mientras eso pasa.
  const settle = (ms) => wait(document.visibilityState === 'hidden' ? Math.min(ms, 60) : ms);

  function dispatchInsert(c, text) {
    c.dispatchEvent(new InputEvent('beforeinput', { data: text, inputType: 'insertText', bubbles: true, cancelable: true }));
    document.execCommand('insertText', false, text);
  }

  // Plan A: insertar todo el mensaje de una sola vez (rápido). Un "keydown" de
  // arranque por línea y Mayús+Enter entre líneas, igual que al pegar texto,
  // para que el editor de Facebook conserve los saltos de línea.
  function insertFast(c, text) {
    c.focus();
    const lines = String(text).split(/\r?\n/);
    for (let li = 0; li < lines.length; li++) {
      c.dispatchEvent(new KeyboardEvent('keydown', { keyCode: li ? 13 : 0, key: li ? 'Enter' : '', shiftKey: true, bubbles: true, cancelable: true }));
      if (lines[li]) dispatchInsert(c, lines[li]);
    }
  }

  // Plan B si el editor no aceptó la inserción rápida: escribir letra por
  // letra, con pausas (más lento, pero más compatible con editores que
  // esperan eventos de teclado uno a uno). Si a mitad de camino cambia el
  // chat abierto o la caja desaparece, se detiene ahí mismo.
  const HUMAN_MAX_MS = 20000;
  async function typeSlow(c, text, threadRe) {
    c.focus();
    const lines = String(text).split(/\r?\n/);
    const totalChars = text.length || 1;
    const budgetPerChar = Math.min(70, Math.max(10, HUMAN_MAX_MS / totalChars));
    for (let li = 0; li < lines.length; li++) {
      if (!threadRe.test(location.pathname) || !c.isConnected) return false;
      c.dispatchEvent(new KeyboardEvent('keydown', { keyCode: li ? 13 : 0, key: li ? 'Enter' : '', shiftKey: true, bubbles: true, cancelable: true }));
      const line = lines[li];
      for (let i = 0; i < line.length; i++) {
        if (!threadRe.test(location.pathname) || !c.isConnected) return false;
        const ch = line[i];
        c.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
        dispatchInsert(c, ch);
        c.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true, cancelable: true }));
        if (document.visibilityState === 'hidden') continue; // en segundo plano: sin pausas artificiales
        await wait(Math.min(rand(budgetPerChar * 0.5, budgetPerChar * 1.5), 200));
      }
    }
    return true;
  }

  // Plan C si lo anterior no cuadró: simular que se pega como del portapapeles.
  function pasteInto(c, text) {
    c.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    c.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
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

  function clearComposer(c) {
    try {
      c.focus();
      document.execCommand('selectAll');
      document.execCommand('delete');
    } catch (e) { /* nada que hacer */ }
  }

  /* ---- "borrador" que dejamos NOSOTROS mismos a medias ----
   * Si un intento anterior se quedó pegado (por ejemplo, Chrome frenó los
   * tiempos de esta pestaña por estar en segundo plano o la ventana minimizada,
   * y el intento tardó más de lo que el background esperó), el texto puede
   * quedar a medio escribir en la caja. El siguiente intento a ese mismo chat
   * lo veía como "un borrador tuyo" y se negaba a tocarlo para siempre. Aquí se
   * recuerda, por chat, qué texto dejamos nosotros la última vez, para poder
   * limpiarlo solos la próxima vez — un borrador de verdad (que tú escribiste
   * a mano) casi nunca coincide carácter por carácter con eso, y se sigue
   * respetando igual que antes.
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
  async function setOwnDraft(tid, text, hasImage, stage) {
    try { await chrome.storage.session.set({ [ownDraftKey(tid)]: { text: String(text || ''), hasImage: !!hasImage, stage: stage || 'empezando', at: Date.now() } }); } catch (e) { /* best-effort */ }
  }
  async function clearOwnDraft(tid) {
    try { await chrome.storage.session.remove(ownDraftKey(tid)); } catch (e) { /* best-effort */ }
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

  /* opts: { tid: '123', text: 'Sí claro…', send: true, image: { dataUrl, mime } | null } */
  globalThis.mnReply = async function mnReply(opts) {
    const t0 = Date.now();
    const tid = String(opts && opts.tid || '').replace(/\D/g, '');
    const text = String(opts && opts.text || '').replace(/\r\n/g, '\n').trim();
    const image = opts && opts.image && opts.image.dataUrl ? opts.image : null;
    const send = !(opts && opts.send === false);
    const done = (r) => Object.assign(r, { tookMs: Date.now() - t0 });
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
      // quedar en el chat anterior o perderse. Se espera a que la caja deje
      // de cambiar de identidad (DOM quieto) antes de seguir.
      await settle(500);
    }

    // 2. la caja de mensaje. Solo se bloquea por TEXTO (no por imágenes: ver la
    // nota al principio del archivo sobre por qué buscar "cualquier imagen" en
    // la conversación daba falsos positivos con fotos del anuncio o viejas).
    let composer = await waitFor(() => (threadRe.test(location.pathname) ? findComposer() : null), 10000);
    if (!composer) return done({ ok: false, stage: 'caja', detail: 'no encuentro la caja para escribir el mensaje' });
    await settle(300);
    if (!threadRe.test(location.pathname)) return done({ ok: false, stage: 'abrir', detail: 'el chat abierto cambió; no escribo nada' });
    composer = findComposer() || composer; // revalidar tras la espera
    const curText = composerText(composer);
    if (curText) {
      const own = await getOwnDraft(tid);
      if (own && squash(curText) === squash(own.text)) {
        // Es justo lo que ESTE proceso dejó a medias en un intento anterior
        // (coincide el texto exacto): se limpia y se sigue, en vez de negarse.
        clearComposer(composer);
        await settle(120);
      } else {
        return done({ ok: false, stage: 'borrador', detail: 'ya hay un texto escrito en ese chat (un borrador); no lo piso' });
      }
    }
    // A partir de aquí vamos a tocar la caja: se anota qué vamos a dejar, para
    // que si ESTE intento se queda a medias, el próximo lo reconozca y limpie.
    await setOwnDraft(tid, text, !!image, 'escribiendo');

    // 3. pegar la foto, si hay. `preview` solo se asigna cuando pegar la foto
    // hizo aparecer EXACTAMENTE una miniatura nueva cerca de la caja: si no se
    // puede identificar con esa certeza, se sigue igual, pero la confirmación
    // del paso 5 queda sin esa parte verificada (se avisa en el resultado).
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
    }

    // 4. insertar el texto (el mensaje, o el pie de la foto): rápido primero, y
    // solo si no cuadra se baja a métodos más lentos pero más compatibles.
    if (text) {
      insertFast(composer, text);
      await settle(150);
      if (!threadRe.test(location.pathname)) return done({ ok: false, stage: 'abrir', detail: 'el chat abierto cambió justo al escribir; no envío' });
      composer = findComposer() || composer;
      let matches = squash(composer.innerText || composer.textContent) === squash(text);
      if (!matches) {
        clearComposer(composer);
        await settle(150);
        const finished = await typeSlow(composer, text, threadRe);
        if (!finished) return done({ ok: false, stage: 'escribir', detail: 'cambiaste de chat en Facebook mientras escribía; dejé de escribir' });
        await settle(200);
        if (!threadRe.test(location.pathname)) return done({ ok: false, stage: 'abrir', detail: 'el chat abierto cambió justo al terminar de escribir; no envío' });
        composer = findComposer() || composer;
        matches = squash(composer.innerText || composer.textContent) === squash(text);
      }
      if (!matches) {
        clearComposer(composer);
        await settle(150);
        pasteInto(composer, text);
        await settle(350);
        matches = squash(composer.innerText || composer.textContent) === squash(text);
      }
      if (!matches) {
        clearComposer(composer);
        await clearOwnDraft(tid); // la caja quedó limpia: no hay nada que el próximo intento deba perdonar
        return done({ ok: false, stage: 'escribir', detail: 'Facebook no aceptó el texto en la caja' });
      }
    }
    await setOwnDraft(tid, text, !!image, 'escrito');
    if (!send) return done({ ok: true, sent: false, stage: image ? 'listo-con-foto' : 'escrito' });

    // 5. enviar. "Enviado" = la caja quedó vacía Y (si había foto con vista
    // previa identificada) esa vista previa desapareció. Si un método no
    // confirma el envío, solo se prueba OTRO método cuando la caja sigue
    // exactamente igual que antes de intentarlo — si quedó en un estado
    // intermedio (ni vacía ni igual), no se sabe qué pasó de verdad, y
    // reintentar a ciegas ahí es como puede acabar mandándose el mensaje dos
    // veces. En ese caso se para con "incierto" en vez de adivinar.
    if (!threadRe.test(location.pathname)) return done({ ok: false, stage: 'abrir', detail: 'el chat abierto cambió antes de enviar; dejé lo escrito sin enviar' });
    const sentNow = () => !composer.isConnected || (!composerText(composer) && (!preview || !preview.isConnected || !visible(preview)));
    const intact = () => composer.isConnected && squash(composerText(composer)) === squash(text);

    let cleared = false;
    const btn = await waitFor(() => findSendButton(composer), 2000);
    if (btn) { btn.click(); cleared = await waitFor(sentNow, 7000); }
    if (!cleared && (!btn || intact())) {
      composer = findComposer() || composer;
      pressEnter(composer);
      cleared = await waitFor(sentNow, 5000);
    }
    if (!cleared && intact()) {
      composer = findComposer() || composer;
      pressEnter(composer, { keyCode: 13, which: 13 });
      cleared = await waitFor(sentNow, 5000);
    }
    if (!cleared && intact()) {
      const btnAgain = findSendButton(composer);
      if (btnAgain) { btnAgain.click(); cleared = await waitFor(sentNow, 5000); }
    }
    if (!cleared && image && previewUnverified && intact()) {
      // No se pudo identificar la vista previa de la foto para confirmar por
      // ahí: se le da a Facebook un margen razonable y, si al menos el TEXTO
      // ya se fue de la caja, se da por enviado (queda constancia de que esta
      // parte no se verificó del todo).
      await settle(1500);
      cleared = !composerText(composer);
    }
    if (!cleared) {
      if (intact()) {
        return done({ ok: false, stage: 'enviar', detail: 'quedó escrito/pegado en el chat pero Facebook no lo envió' });
      }
      // Ni se confirmó el envío ni la caja quedó igual que antes: no hay
      // certeza de qué pasó. No se reintenta (duplicaría si en realidad sí se
      // envió) y no se hereda este rastro como "nuestro" para la próxima vez.
      await clearOwnDraft(tid);
      return done({ ok: false, stage: 'incierto', detail: 'no pude confirmar si Facebook llegó a enviarlo; revisa ese chat a mano antes de volver a mandarlo (para no duplicarlo)' });
    }
    // Darle un respiro a Facebook antes de que el background abra otro chat:
    // si se cambia de inmediato, un envío que aún no terminó de procesarse
    // (el "enviado" a veces llega un instante después de vaciar la caja) puede
    // mezclarse con el chat siguiente.
    await settle(1000);
    await clearOwnDraft(tid); // se envió: no queda nada pendiente que cuidar en este chat
    return done({ ok: true, sent: true, stage: 'enviado', fotoSinVerificar: !!(image && previewUnverified) });
  };

  function shortErr(e) {
    return String(e && e.message ? e.message : e).slice(0, 80);
  }

  globalThis.mnReplyVersion = 4;
})();
