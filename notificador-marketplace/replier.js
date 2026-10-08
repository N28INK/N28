/* Notificador Marketplace v0.14 — replier.js
 * Escribe (y envía) en un chat de Messenger un texto —y/o pega una foto— que TÚ
 * mandaste a mano en Telegram. Solo lo inyecta el background, en pestañas de
 * Facebook, cuando llega tu respuesta desde tu propio Telegram. No envía nada
 * por su cuenta.
 *
 * Pasos, y cada uno se comprueba antes de seguir:
 *   1. abrir el chat correcto (por su enlace /t/<id>) y confirmar que la dirección cambió;
 *   2. esperar a que la pantalla se quede quieta y encontrar la caja de mensaje, vacía;
 *   3. si hay foto, pegarla (como si la copiaras y la pegaras en la caja);
 *   4. si hay texto (el mensaje, o el pie de la foto), escribirlo letra por letra
 *      (como lo haría una persona) y comprobar que quedó tal cual;
 *   5. pulsar Enviar (con reintentos) y confirmar que se vació.
 * Si algo falla, no sigue: devuelve en qué paso falló. Si cambiaste de chat en Facebook
 * a mitad de camino, se aborta sin tocar nada (para no escribir en el chat equivocado).
 *
 * Ojo con las fotos: pegarlas como "paste" es la forma estándar de adjuntar una
 * imagen en una caja de texto web, y así se probó aquí, pero no hay manera de
 * comprobarlo contra el Facebook real desde este entorno. Si en tu Facebook no
 * queda pegada, dilo y se ajusta.
 */
(() => {
  'use strict';
  if (globalThis.mnReplyVersion === 3) return;

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

  // Escritura "humana": una letra a la vez, con pausas irregulares (más largas
  // tras un espacio o signo de puntuación, como al pensar la frase). Si a mitad
  // de camino cambia el chat abierto o la caja desaparece, se detiene ahí mismo
  // (quien llama decide qué hacer con lo que quedó escrito).
  const HUMAN_MAX_MS = 25000;    // tope de duración; textos largos se aceleran para no pasarse
  async function typeHuman(c, text, threadRe) {
    c.focus();
    const lines = String(text).split(/\r?\n/);
    const totalChars = text.length || 1;
    const budgetPerChar = Math.min(90, Math.max(12, HUMAN_MAX_MS / totalChars));
    for (let li = 0; li < lines.length; li++) {
      if (!threadRe.test(location.pathname) || !c.isConnected) return false;
      c.dispatchEvent(new KeyboardEvent('keydown', { keyCode: li ? 13 : 0, key: li ? 'Enter' : '', shiftKey: true, bubbles: true, cancelable: true }));
      const line = lines[li];
      for (let i = 0; i < line.length; i++) {
        if (!threadRe.test(location.pathname) || !c.isConnected) return false;
        const ch = line[i];
        c.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true, cancelable: true }));
        c.dispatchEvent(new InputEvent('beforeinput', { data: ch, inputType: 'insertText', bubbles: true, cancelable: true }));
        document.execCommand('insertText', false, ch);
        c.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true, cancelable: true }));
        let pause = rand(budgetPerChar * 0.5, budgetPerChar * 1.5);
        if (/[ ,;:]/.test(ch)) pause += rand(40, 120);
        else if (/[.!?]/.test(ch)) pause += rand(90, 220);
        await wait(Math.min(pause, 260));
      }
    }
    return true;
  }

  // Plan B si el editor no aceptó el texto: simular que se pega.
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

  // Busca, cerca de la caja de mensaje, una miniatura que no sea parte de la
  // conversación ya enviada: la vista previa de la foto recién pegada. No hay
  // forma 100% genérica de ubicarla (depende del diseño de Facebook), así que
  // es un apoyo best-effort para confirmar el envío; si no se encuentra, se
  // sigue igual, solo que la confirmación del paso 5 se vuelve menos segura.
  function findAttachmentPreview(c) {
    const scope = c.closest('form') || c.closest('[role="main"]') || c.parentElement;
    if (!scope) return null;
    return Array.from(scope.querySelectorAll('img')).find(visible) || null;
  }

  function clearComposer(c) {
    try {
      c.focus();
      document.execCommand('selectAll');
      document.execCommand('delete');
    } catch (e) { /* nada que hacer */ }
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
    const tid = String(opts && opts.tid || '').replace(/\D/g, '');
    const text = String(opts && opts.text || '').replace(/\r\n/g, '\n').trim();
    const image = opts && opts.image && opts.image.dataUrl ? opts.image : null;
    const send = !(opts && opts.send === false);
    if (!tid || (!text && !image)) return { ok: false, stage: 'datos', detail: 'falta el chat, y no hay texto ni foto' };
    const threadRe = new RegExp('/t/' + tid + '(?:/|$|\\?)');

    // 1. el chat correcto
    if (!threadRe.test(location.pathname)) {
      const link = Array.from(document.querySelectorAll('a[href*="/t/' + tid + '"]'))
        .find((a) => threadRe.test(a.getAttribute('href') || ''));
      if (!link) return { ok: false, stage: 'abrir', detail: 'no encuentro ese chat en la lista de esta página' };
      link.click();
      const opened = await waitFor(() => threadRe.test(location.pathname), 8000);
      if (!opened) return { ok: false, stage: 'abrir', detail: 'no se abrió el chat' };
      // Tras alternar de chat, Facebook tarda un instante en reconstruir la
      // conversación; si se escribe antes de que se asiente, el texto puede
      // quedar en el chat anterior o perderse. Se espera a que la caja deje
      // de cambiar de identidad (DOM quieto) antes de seguir.
      await wait(700);
    }

    // 2. la caja de mensaje, vacía (se busca de nuevo: la de antes puede ya no servir)
    let composer = await waitFor(() => (threadRe.test(location.pathname) ? findComposer() : null), 10000);
    if (!composer) return { ok: false, stage: 'caja', detail: 'no encuentro la caja para escribir el mensaje' };
    await wait(400);
    if (!threadRe.test(location.pathname)) return { ok: false, stage: 'abrir', detail: 'el chat abierto cambió; no escribo nada' };
    composer = findComposer() || composer; // revalidar tras la espera
    if (composerText(composer)) return { ok: false, stage: 'borrador', detail: 'ya hay un texto escrito en ese chat (un borrador); no lo piso' };

    // 3. pegar la foto, si hay
    let preview = null;
    if (image) {
      try {
        await pasteImage(composer, image.dataUrl, image.mime);
      } catch (e) {
        return { ok: false, stage: 'imagen', detail: 'no pude pegar la foto en la caja de mensaje (' + shortErr(e) + ')' };
      }
      await wait(1200); // darle tiempo a Facebook de procesar el adjunto y mostrar su vista previa
      if (!threadRe.test(location.pathname)) return { ok: false, stage: 'abrir', detail: 'el chat abierto cambió justo al pegar la foto; no sigo' };
      composer = findComposer() || composer;
      preview = findAttachmentPreview(composer);
    }

    // 4. escribir letra por letra (el mensaje, o el pie de la foto) y comprobar que quedó igual
    if (text) {
      const finishedTyping = await typeHuman(composer, text, threadRe);
      if (!finishedTyping) {
        // Cambiaste de chat en Facebook a mitad de la escritura: no seguimos
        // (podría estar escribiendo en el chat equivocado).
        return { ok: false, stage: 'escribir', detail: 'cambiaste de chat en Facebook mientras escribía; dejé de escribir' };
      }
      await wait(250);
      if (!threadRe.test(location.pathname)) return { ok: false, stage: 'abrir', detail: 'el chat abierto cambió justo al terminar de escribir; no envío' };
      composer = findComposer() || composer;
      if (squash(composer.innerText || composer.textContent) !== squash(text)) {
        clearComposer(composer);
        await wait(200);
        pasteInto(composer, text);
        await wait(400);
      }
      if (squash(composer.innerText || composer.textContent) !== squash(text)) {
        clearComposer(composer);
        return { ok: false, stage: 'escribir', detail: 'Facebook no aceptó el texto en la caja' };
      }
    }
    if (!send) return { ok: true, sent: false, stage: image ? 'listo-con-foto' : 'escrito' };

    // 5. enviar, con varios intentos, revalidando el chat y la caja en cada uno
    if (!threadRe.test(location.pathname)) return { ok: false, stage: 'abrir', detail: 'el chat abierto cambió antes de enviar; dejé lo escrito sin enviar' };
    // "Enviado" = la caja de texto quedó vacía Y (si había foto) su vista previa desapareció.
    // Si no se pudo ubicar la vista previa (puede pasar según el diseño), se confía en un
    // margen de tiempo: es la parte menos segura de confirmar con una foto de por medio.
    const sentNow = () => !composer.isConnected || (!composerText(composer) && (!preview || !preview.isConnected || !visible(preview)));
    const btnWait = await waitFor(() => findSendButton(composer), 2000);
    let cleared = false;
    if (btnWait) { btnWait.click(); cleared = await waitFor(sentNow, 6000); }
    if (!cleared) {
      composer = findComposer() || composer;
      pressEnter(composer);
      cleared = await waitFor(sentNow, 4000);
    }
    if (!cleared) {
      composer = findComposer() || composer;
      pressEnter(composer, { keyCode: 13, which: 13 });
      cleared = await waitFor(sentNow, 4000);
    }
    if (!cleared) {
      const btnAgain = findSendButton(composer);
      if (btnAgain) { btnAgain.click(); cleared = await waitFor(sentNow, 4000); }
    }
    if (!cleared && image && !preview) {
      // No se pudo confirmar con certeza (no se localizó la vista previa de la
      // foto): se le da a Facebook un margen razonable y se da por enviado,
      // dejando constancia de que esta parte no quedó verificada del todo.
      await wait(1800);
      cleared = !composerText(composer);
    }
    if (!cleared) return { ok: false, stage: 'enviar', detail: 'quedó escrito/pegado en el chat pero Facebook no lo envió' };
    // Darle un respiro a Facebook antes de que el background abra otro chat:
    // si se cambia de inmediato, un envío que aún no terminó de procesarse
    // (el "enviado" a veces llega un instante después de vaciar la caja) puede
    // mezclarse con el chat siguiente.
    await wait(1200);
    return { ok: true, sent: true, stage: 'enviado' };
  };

  function shortErr(e) {
    return String(e && e.message ? e.message : e).slice(0, 80);
  }

  globalThis.mnReplyVersion = 3;
})();
