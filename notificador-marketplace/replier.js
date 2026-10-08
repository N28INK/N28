/* Notificador Marketplace v0.11 — replier.js
 * Escribe (y envía) en un chat de Messenger un texto que TÚ escribiste a mano en
 * Telegram. Solo lo inyecta el background, en pestañas de Facebook, cuando
 * llega tu respuesta desde tu propio Telegram. No envía nada por su cuenta.
 *
 * Pasos, y cada uno se comprueba antes de seguir:
 *   1. abrir el chat correcto (por su enlace /t/<id>) y confirmar que la dirección cambió;
 *   2. encontrar la caja de mensaje y confirmar que está VACÍA (no pisa borradores);
 *   3. escribir el texto y confirmar que quedó tal cual;
 *   4. pulsar Enviar y confirmar que la caja se vació.
 * Si algo falla, no sigue: devuelve en qué paso falló.
 */
(() => {
  'use strict';
  if (globalThis.mnReplyVersion === 1) return;

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

  const norm = (s) => String(s || '').replace(/[​ ]/g, ' ').replace(/\s+/g, ' ').trim();
  const squash = (s) => String(s || '').replace(/[​ \s]+/g, '');

  // La caja donde se escribe el mensaje: un div editable con role="textbox".
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

  // Facebook usa un editor propio: se escribe línea por línea con un primer
  // "keydown" de arranque y Mayús+Enter entre líneas (así se conservan los saltos).
  function typeInto(c, text) {
    c.focus();
    const lines = String(text).split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      c.dispatchEvent(new KeyboardEvent('keydown', { keyCode: i ? 13 : 0, key: i ? 'Enter' : '', shiftKey: true, bubbles: true, cancelable: true }));
      if (lines[i]) document.execCommand('insertText', false, lines[i]);
    }
  }

  // Plan B si el editor no aceptó el texto: simular que se pega.
  function pasteInto(c, text) {
    c.focus();
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    c.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
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

  function pressEnter(c) {
    const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    c.focus();
    c.dispatchEvent(new KeyboardEvent('keydown', init));
    c.dispatchEvent(new KeyboardEvent('keypress', init));
    c.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  /* opts: { tid: '123', text: 'Sí claro…', send: true } */
  globalThis.mnReply = async function mnReply(opts) {
    const tid = String(opts && opts.tid || '').replace(/\D/g, '');
    const text = String(opts && opts.text || '').replace(/\r\n/g, '\n').trim();
    const send = !(opts && opts.send === false);
    if (!tid || !text) return { ok: false, stage: 'datos', detail: 'falta el chat o el texto' };
    const threadRe = new RegExp('/t/' + tid + '(?:/|$|\\?)');

    // 1. el chat correcto
    if (!threadRe.test(location.pathname)) {
      const link = Array.from(document.querySelectorAll('a[href*="/t/' + tid + '"]'))
        .find((a) => threadRe.test(a.getAttribute('href') || ''));
      if (!link) return { ok: false, stage: 'abrir', detail: 'no encuentro ese chat en la lista de esta página' };
      link.click();
      const opened = await waitFor(() => threadRe.test(location.pathname), 8000);
      if (!opened) return { ok: false, stage: 'abrir', detail: 'no se abrió el chat' };
    }

    // 2. la caja de mensaje, vacía
    const composer = await waitFor(findComposer, 10000);
    if (!composer) return { ok: false, stage: 'caja', detail: 'no encuentro la caja para escribir el mensaje' };
    await wait(500);
    if (!threadRe.test(location.pathname)) return { ok: false, stage: 'abrir', detail: 'el chat abierto cambió; no escribo nada' };
    if (composerText(composer)) return { ok: false, stage: 'borrador', detail: 'ya hay un texto escrito en ese chat (un borrador); no lo piso' };

    // 3. escribir y comprobar que quedó igual
    typeInto(composer, text);
    await wait(300);
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
    if (!send) return { ok: true, sent: false, stage: 'escrito' };

    // 4. enviar y comprobar que la caja se vació
    const btn = findSendButton(composer);
    if (btn) btn.click(); else pressEnter(composer);
    let cleared = await waitFor(() => !composer.isConnected || !composerText(composer), 6000);
    if (!cleared && btn) {
      pressEnter(composer);
      cleared = await waitFor(() => !composer.isConnected || !composerText(composer), 4000);
    }
    if (!cleared) return { ok: false, stage: 'enviar', detail: 'el texto quedó escrito en el chat pero Facebook no lo envió' };
    return { ok: true, sent: true, stage: 'enviado' };
  };

  globalThis.mnReplyVersion = 1;
})();
