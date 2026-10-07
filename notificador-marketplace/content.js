/* Notificador Marketplace v0.6 — content script (content.js)
 * Lee la lista de chats (con collector.js) y se la pasa al background, que
 * decide si avisa. Solo manda algo cuando la lista cambió, para no despertar
 * al background cada 4 segundos sin motivo.
 */
(() => {
  'use strict';
  const SCAN_MS = 4000;
  const HEARTBEAT_MS = 60 * 1000;
  let lastSig = '';
  let lastSentAt = 0;
  let timer = null;

  function report() {
    // Si recargaron/actualizaron la extensión, este script quedó huérfano: se apaga.
    if (!chrome.runtime || !chrome.runtime.id) {
      clearInterval(timer);
      return;
    }
    let scan;
    try {
      scan = globalThis.mnCollect();
    } catch (e) {
      return;
    }
    if (!scan.threads.length) return;
    const sig = JSON.stringify([scan.openTid, scan.threads]);
    const now = Date.now();
    if (sig === lastSig && !scan.warmup && now - lastSentAt < HEARTBEAT_MS) return;
    lastSig = sig;
    lastSentAt = now;
    try {
      chrome.runtime
        .sendMessage({ type: 'MN_THREADS', scan: scan })
        .catch(() => { /* el background despierta solo con la alarma */ });
    } catch (e) {
      clearInterval(timer);
    }
  }

  timer = setInterval(report, SCAN_MS);
  setTimeout(report, 1500);
  // Al volver a mostrar la ventana, revisar en el acto.
  document.addEventListener('visibilitychange', () => setTimeout(report, 500));

  // Chrome no congela una pestaña que tiene un "Web Lock" tomado. Así, con la
  // ventana minimizada, Facebook sigue recibiendo mensajes y la extensión puede leerlos.
  try {
    navigator.locks
      .request('mn-notificador-' + Math.random().toString(36).slice(2), () => new Promise(() => {}))
      .catch(() => {});
  } catch (e) {
    /* navegador sin Web Locks: queda el despertador del background */
  }
})();
