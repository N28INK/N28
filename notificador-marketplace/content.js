/* Notificador Marketplace v0.18 — content script (content.js)
 * Lee la lista de chats y el nombre de la cuenta de Facebook (con collector.js)
 * y se los pasa al background, que decide si avisa. Solo manda algo cuando la lista cambió, para no despertar
 * al background cada 4 segundos sin motivo.
 */
(() => {
  'use strict';
  const SCAN_MS = 4000;
  const HEARTBEAT_MS = 60 * 1000;
  let lastSig = '';
  let lastSentAt = 0;
  let lastAccount = '';
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
    // El nombre de la cuenta se avisa aparte: se detecta en cualquier página de
    // Facebook, aunque todavía no esté abierta la lista de chats.
    if (scan.account && scan.account !== lastAccount) {
      lastAccount = scan.account;
      try {
        chrome.runtime
          .sendMessage({ type: 'MN_ACCOUNT', name: scan.account, source: scan.accountSource })
          .catch(() => {});
      } catch (e) {
        clearInterval(timer);
        return;
      }
    }
    if (!scan.threads.length) return;
    const sig = JSON.stringify([scan.openTid, scan.account, scan.threads]);
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
