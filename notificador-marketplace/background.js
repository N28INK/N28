/* Notificador Marketplace v0.22 — service worker (background.js)
 * Recibe la lista de chats (del content script, de su propio despertador de
 * 30 segundos o del cambio de título de la pestaña) y, cuando hay un mensaje
 * nuevo sin leer, te avisa al teléfono por WhatsApp (CallMeBot) o Telegram,
 * con el nombre de la cuenta de Facebook que lo recibió, y también con una
 * notificación en el PC.
 */
'use strict';

const TAG = '[MN-bg]';
const DEFAULTS = {
  enabled: true, marketplaceOnly: false, pcNotify: true, channel: 'whatsapp',
  phone: '', apikey: '', tg_token: '', tg_chatid: '', accountName: '',
  replyEnabled: false, replySend: true,
  mirrorMine: true,       // lo que escribes tú en Facebook también aparece en Telegram (hilo completo)
  maxAgeMin: 120,         // no avisar de mensajes que llegaron hace más de tantos minutos
  refreshTo: 'auto'       // adónde vuelve el botón 🔄: 'auto' (la bandeja que usabas), 'marketplace' o 'messages'
};
const ALARM = 'mn-keepalive';
const ALARM_MIN = 0.5;                       // revisar cada 30 s (mínimo que permite Chrome)
const SCRIPT_TIMEOUT_MS = 10 * 1000;
const TITLE_RESCAN_MS = 6 * 1000;
const TOP_ROWS = 3;                          // filas de arriba de la lista = chats con actividad reciente
const FB_URLS = ['https://www.facebook.com/*', 'https://www.messenger.com/*'];
const INBOX_URL = 'https://www.facebook.com/messages/';
const COOLDOWN_MS = 60 * 1000;               // máx. 1 aviso por chat cada minuto (salvo chat "activo", ver ACTIVE_COOLDOWN_MS)
const ACTIVE_COOLDOWN_MS = 3 * 1000;         // chats con los que contestaste hace poco: casi sin espera entre avisos
const ACTIVE_CHAT_MS = 30 * 60 * 1000;       // minutos que un chat queda "activo" tras contestarlo desde Telegram
const COLLECTOR_VERSION = 14;                // versión de collector.js que espera este background
const MP_INBOX_URL = 'https://www.facebook.com/marketplace/inbox/';
const LOG_MAX = 200;                         // eventos que guarda el registro
const LOG_COLLAPSE_MS = 10 * 60 * 1000;      // una misma línea repetida se cuenta (×N) en vez de inundar el registro
const TITLE_BLINK_DEBOUNCE_MS = 20 * 1000;   // el título "parpadea" (va y vuelve) más rápido que esto: se ignora el repiqueteo
const FORGET_MS = 30 * 24 * 60 * 60 * 1000; // olvidar chats sin actividad en 30 días
const MAX_SEEN = 500;
const NO_LIST_WARN_MIN = 10;                 // avisar si 10 min sin ver la lista de chats
const NO_LIST_REPEAT_MS = 4 * 60 * 60 * 1000;
const ARRIVAL_TOL_MS = 2 * 60 * 1000;        // margen al comparar la hora de llegada de un mensaje con la última vez que miré la lista
const CATCHUP_GAP_MS = 5 * 60 * 1000;        // si la página se recargó hace menos de esto, lo que llegó mientras tanto SÍ se avisa
const DEDUPE_VIEWS_MS = 3 * 60 * 1000;       // el mismo mensaje visto en dos listas distintas (Messenger y bandeja de Marketplace) se avisa una vez
const GENERIC_REPEAT_MS = 30 * 60 * 1000;    // el aviso general del título no se repite para el mismo cambio en este tiempo
const THREAD_KEEP = 30;                      // mensajes que se recuerdan por chat para el /hilo
const THREAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_THREADS = 60;
const OWN_TG_TTL_MS = 2 * 60 * 1000;         // lo que mandaste por Telegram no se vuelve a mostrar como "escrito desde Facebook"

/* ------------------------- registro ------------------------- *
 * Guarda los últimos eventos (qué se leyó, por qué se avisó o NO se avisó, qué
 * respondió Telegram/WhatsApp). Se ve en Configuración -> Registro. Sirve para
 * encontrar el motivo cuando un aviso no llega. Nunca debe romper un aviso.
 */
let logChain = Promise.resolve();
function logEvent(kind, msg) {
  logChain = logChain.then(async () => {
    try {
      const d = await chrome.storage.local.get('mn_log');
      const log = d.mn_log || [];
      const text = String(msg).replace(/\s+/g, ' ').slice(0, 240);
      const now = Date.now();
      const last = log[log.length - 1];
      // La misma línea seguida (p. ej. el título parpadeando) se cuenta en vez
      // de repetirse: así el registro no se llena con 50 copias de lo mismo.
      if (last && last.k === kind && last.m === text && now - last.t < LOG_COLLAPSE_MS) {
        last.n = (last.n || 1) + 1;
        last.t = now;
      } else {
        log.push({ t: now, k: kind, m: text });
      }
      if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
      await chrome.storage.local.set({ mn_log: log });
    } catch (e) { /* el registro es opcional */ }
  });
  return logChain;
}

function shortText(t, n) {
  t = String(t || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function kindName(k) {
  return k === 'messages' ? 'Messenger' : (k === 'marketplace' ? 'bandeja de Marketplace' : 'otra página de Facebook');
}

/* ------------------------- despertador ------------------------- */
// Se asegura de que la alarma exista sin reiniciarla cada vez que el
// service worker despierta (la v0.4 la recreaba en cada arranque).
async function ensureAlarm() {
  const a = await chrome.alarms.get(ALARM);
  if (!a || a.periodInMinutes !== ALARM_MIN) await chrome.alarms.create(ALARM, { periodInMinutes: ALARM_MIN });
}
ensureAlarm();

// Por defecto, chrome.storage.session SOLO lo puede leer/escribir el
// background: replier.js (que corre dentro de la pestaña de Facebook) lo
// necesita para recordar, por chat, qué dejó a medias un intento anterior
// (ver "borrador" en replier.js). Sin esto, esa memoria nunca se guarda.
function allowSessionStorageInPages() {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});
}
allowSessionStorageInPages();

chrome.runtime.onInstalled.addListener((details) => {
  ensureAlarm();
  allowSessionStorageInPages();
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); allowSessionStorageInPages(); });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === ALARM) {
    keepaliveScan().catch((e) => console.error(TAG, e));
    replyTick().catch((e) => console.error(TAG, e));
  }
});

// Lee los chats directamente en cada pestaña de Facebook, aunque Chrome la
// haya dormido o la ventana esté minimizada.
async function keepaliveScan() {
  const s = await getSettings();
  if (!s.enabled) return;
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: FB_URLS });
  } catch (e) {
    return;
  }
  // Todas a la vez y con tiempo límite: una pestaña congelada ya no bloquea a las demás.
  const found = await Promise.all(tabs.map(scanTab));
  await setStatus({ fbTabs: tabs.length, fbTabsAt: Date.now() });
  const seenList = found.some(Boolean);
  if (!seenList) await logNoList(tabs);
  await noteListPresence(seenList);
}

// Cada 10 min como mucho: dice qué páginas de Facebook hay abiertas y que ninguna muestra chats.
let lastNoListLog = 0;
async function logNoList(tabs) {
  const now = Date.now();
  if (now - lastNoListLog < 10 * 60 * 1000) return;
  lastNoListLog = now;
  if (!tabs.length) {
    await logEvent('nolist', 'No hay ninguna pestaña de Facebook abierta.');
    return;
  }
  const where = tabs.map((t) => {
    try { return new URL(t.url).pathname.slice(0, 40); } catch (e) { return '?'; }
  }).join(', ');
  await logEvent('nolist', 'Hay ' + tabs.length + ' pestaña(s) de Facebook (' + where + ') pero ninguna muestra la lista de chats. Abre facebook.com/messages o facebook.com/marketplace/inbox.');
}

// Escanea una pestaña. Devuelve true si vio la lista de chats.
async function scanTab(tab) {
  try {
    // Que Chrome no descargue la pestaña para ahorrar memoria.
    if (tab.autoDiscardable !== false) {
      await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
    }
    if (tab.discarded) {
      await chrome.tabs.reload(tab.id);
      return false;
    }
    const scan = await collectFromTab(tab.id);
    if (scan && scan.threads && scan.threads.length) {
      await enqueue(scan);
      return true;
    }
  } catch (e) {
    /* pestaña cargando, congelada o sin acceso: se intenta en la próxima vuelta */
    await logTabError(e);
  }
  return false;
}

let lastTabErrLog = 0;
async function logTabError(e) {
  const now = Date.now();
  if (now - lastTabErrLog < 10 * 60 * 1000) return;
  lastTabErrLog = now;
  await logEvent('tab', 'No pude leer una pestaña de Facebook (es normal en alguna pestaña suelta; mientras otra sí muestre la lista, sigo vigilando): ' + shortText(e && e.message ? e.message : e, 80));
}

// executeScript en una pestaña congelada por Chrome puede no responder nunca
// (la v0.5 se quedaba esperando para siempre y dejaba de revisar).
function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

async function collectFromTab(tabId) {
  const call = () => withTimeout(chrome.scripting.executeScript({
    target: { tabId: tabId },
    args: [COLLECTOR_VERSION],
    func: (v) => (globalThis.mnCollectVersion === v ? globalThis.mnCollect() : null)
  }), SCRIPT_TIMEOUT_MS);
  let res = await call();
  if (!res || !res[0] || res[0].result == null) {
    // Pestaña abierta antes de instalar/actualizar la extensión: inyectar el lector.
    await withTimeout(chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['collector.js'] }), SCRIPT_TIMEOUT_MS);
    res = await call();
  }
  return res && res[0] ? res[0].result : null;
}

/* ---------------- plan B: el título de la pestaña ----------------
 * Con la ventana minimizada, Facebook a veces no redibuja la lista de chats,
 * pero SÍ cambia el título de la pestaña: "(1) Messenger | Facebook" o hace
 * parpadear "Carlos te envió un mensaje". Chrome nos avisa de ese cambio al
 * instante. Entonces: se relee la pestaña y, si la lista no muestra el mensaje
 * (no salió ningún aviso), se manda un aviso genérico igualmente.
 */
const FLASH_RE = /\b(?:te envi[oó] un mensaje|te ha enviado un mensaje|te escribi[oó]|sent you a message|messaged you|sent a message|nuevo mensaje|new message)/i;
const titleBusy = new Set();

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  // Página (re)cargada: el primer título solo sirve de referencia, no avisa.
  if (info.status === 'loading') chrome.storage.session.remove('mn_title_' + tabId).catch(() => {});
  if (!info.title || !tab || !/^https:\/\/www\.(facebook|messenger)\.com\//.test(tab.url || '')) return;
  onTitle(tab, info.title).catch((e) => console.error(TAG, e));
});
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove('mn_title_' + tabId).catch(() => {});
});

async function onTitle(tab, title) {
  const key = 'mn_title_' + tab.id;
  const d = await chrome.storage.session.get(key);
  const known = !!d[key];
  const prevCount = known ? d[key].count : 0;
  const lastAt = known ? (d[key].lastAt || 0) : 0;
  const flash = FLASH_RE.exec(title);
  const m = /^\((\d+)\)/.exec(title);
  const count = m ? parseInt(m[1], 10) : null;
  const now = Date.now();
  // Facebook hace parpadear el título alternando "(2) Messenger | Facebook" con
  // otra forma SIN el número entre paréntesis (la vista previa del mensaje, o el
  // título normal). Esa forma sin número no significa "ya no hay nada sin leer":
  // antes se tomaba como que el contador bajó a 0 y por eso cada parpadeo volvía
  // a parecer un mensaje nuevo. Ahora el contador nunca baja por un título sin
  // número; solo baja cuando de verdad vuelve a 0 chats sin leer (se ve en la lista).
  const status = (await chrome.storage.local.get('mn_status')).mn_status || {};
  const floor = Math.max(prevCount, status.unread || 0);
  const baseline = count !== null ? Math.max(count, floor) : floor;
  const rising = count !== null && count > floor;
  if (count !== null || !known) await chrome.storage.session.set({ [key]: { count: baseline, lastAt: lastAt } });
  if (!flash && !rising) return; // nada que no se supiera ya (incluye el parpadeo a la forma sin número)
  // El mismo aviso (parpadeo) puede repetirse varias veces por segundo: basta
  // con reaccionar una vez cada TITLE_BLINK_DEBOUNCE_MS.
  if (known && now - lastAt < TITLE_BLINK_DEBOUNCE_MS) return;
  await chrome.storage.session.set({ [key]: { count: baseline, lastAt: now } });
  if (titleBusy.has(tab.id)) return; // una revisión a la vez por pestaña
  titleBusy.add(tab.id);
  try {
    const s = await getSettings();
    if (!s.enabled) return;
    await logEvent('title', 'El título de la pestaña cambió a "' + shortText(title, 50) + '": releo la lista.');
    const since = Date.now();
    await scanTab(tab);
    await new Promise((r) => setTimeout(r, TITLE_RESCAN_MS));
    await scanTab(tab);
    await queue;
    const st = (await chrome.storage.local.get('mn_status')).mn_status || {};
    if ((st.lastListAlertAt || 0) >= since - COOLDOWN_MS) {
      await logEvent('title', 'Ya se había avisado por la lista; no mando aviso general.');
      return;
    }
    if ((st.lastSkipAt || 0) >= since) {
      await logEvent('title', 'La lista sí vio ese mensaje y decidió no avisar (el motivo está arriba); no mando aviso general.');
      return;
    }
    const name = flash ? title.slice(0, flash.index).replace(/^\(\d+\)\s*/, '').trim() : '';
    // El título parpadea y se repite: un solo aviso general por mensaje.
    const gkey = count + '|' + name;
    if (st.lastGenericKey === gkey && Date.now() - (st.lastGenericAt || 0) < GENERIC_REPEAT_MS) {
      await logEvent('title', 'Ya mandé el aviso general de este mismo cambio de título; no lo repito.');
      return;
    }
    // Si la lista ya avisó (o mostró) un mensaje de esa misma persona hace poco, el parpadeo
    // del título es el mismo mensaje: no se manda un segundo aviso.
    if (name) {
      const led = (await chrome.storage.local.get('mn_ledger')).mn_ledger || {};
      const fw = firstWord(name);
      if (fw && Object.keys(led).some((k) => k.split('|')[1] === fw && Date.now() - led[k].at < LEDGER_TTL_MS)) {
        await logEvent('title', 'Ya avisé hace poco de un mensaje de «' + shortText(name, 25) + '»; no mando aviso general.');
        return;
      }
    }
    await setStatus({ lastGenericKey: gkey, lastGenericAt: Date.now() });
    if (s.marketplaceOnly) {
      await logEvent('title', 'La lista no mostró el mensaje, así que no sé si es de Marketplace: mando aviso general (tienes activado "solo Marketplace").');
    }
    await alertGeneric(name, count, s);
  } finally {
    titleBusy.delete(tab.id);
  }
}

async function alertGeneric(name, count, s) {
  const text =
    '🔔 *Nuevo mensaje en Facebook*\n' +
    accountLine(await accountName(s)) + '\n' +
    (name ? 'De: ' + name + '\n' : '') +
    (count ? 'Tienes ' + count + ' chat(s) sin leer.\n' : '') +
    (s.marketplaceOnly ? 'No pude ver de qué chat viene (puede no ser de Marketplace).\n' : '') +
    '\nResponder: ' + INBOX_URL;
  if (s.pcNotify) notifyPC('mn-open-inbox-' + Date.now(), 'Nuevo mensaje en Facebook', name ? 'De: ' + name : 'Tienes mensajes sin leer.');
  const via = s.channel === 'telegram' ? 'Telegram' : 'WhatsApp';
  const r = await sendNotification(text, s);
  if (r.ok) {
    await setStatus({ lastAlertAt: Date.now(), lastAlertName: name || 'Facebook', lastError: '' });
    await logEvent('ok', 'Aviso general enviado por ' + via + ' (cambió el título de la pestaña)' + (name ? ': ' + shortText(name, 30) : '') + '.');
  } else {
    await setStatus({ lastError: r.message });
    await logEvent('err', 'NO se pudo mandar el aviso general por ' + via + ': ' + shortText(r.message, 120));
  }
}

// Si nadie tiene abierta la lista de chats, no hay nada que vigilar:
// avisa (como mucho cada 4 h) para que no creas que está funcionando.
async function noteListPresence(found) {
  const d = await chrome.storage.local.get(['mn_nolist_min', 'mn_nolist_warned_at']);
  if (found) {
    if (d.mn_nolist_min) await chrome.storage.local.set({ mn_nolist_min: 0 });
    return;
  }
  const mins = (d.mn_nolist_min || 0) + 1;
  await chrome.storage.local.set({ mn_nolist_min: mins });
  const now = Date.now();
  if (mins >= NO_LIST_WARN_MIN && now - (d.mn_nolist_warned_at || 0) > NO_LIST_REPEAT_MS) {
    await chrome.storage.local.set({ mn_nolist_warned_at: now });
    await notifyPC(
      'mn-open-inbox',
      'Notificador Marketplace: no estoy vigilando',
      'No veo tu lista de chats abierta. Haz clic aquí para abrir facebook.com/messages (o abre facebook.com/marketplace/inbox) y déjala abierta.'
    );
  }
}

/* ------------------------- mensajes ------------------------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type || sender.id !== chrome.runtime.id) return;
  if (msg.type === 'MN_THREADS' && sender.tab && msg.scan) {
    enqueue(msg.scan);
    noteListPresence(true).catch(() => {});
  } else if (msg.type === 'MN_ACCOUNT' && sender.tab) {
    enqueueTask(() => rememberAccount(msg.name, msg.source));
  } else if (msg.type === 'MN_DIAG') {
    diagnose().then(sendResponse, (e) => sendResponse({ error: String(e) }));
    return true;
  } else if (msg.type === 'MN_TEST') {
    handleTest().then(sendResponse, (e) => sendResponse({ ok: false, message: String(e) }));
    return true; // respuesta asíncrona
  }
});

chrome.notifications.onClicked.addListener((id) => {
  const m = /^mn-thread-(\d+)/.exec(id);
  if (m) chrome.tabs.create({ url: INBOX_URL + 't/' + m[1] + '/' });
  else if (id.startsWith('mn-open-inbox-mp')) chrome.tabs.create({ url: MP_INBOX_URL });
  else if (id.startsWith('mn-open-inbox')) chrome.tabs.create({ url: INBOX_URL, pinned: true });
  chrome.notifications.clear(id);
});

// Lo que la extensión ve ahora mismo, para encontrar fallos con el Facebook real.
async function diagnose() {
  const s = await getSettings();
  const tabs = await chrome.tabs.query({ url: FB_URLS });
  const out = {
    version: chrome.runtime.getManifest().version,
    canal: s.channel, activados: s.enabled, soloMarketplace: s.marketplaceOnly,
    estado: (await chrome.storage.local.get('mn_status')).mn_status || {},
    pcNotify: s.pcNotify,
    respuestasDesdeTelegram: {
      activadas: s.replyEnabled === true, enviarSolo: s.replySend !== false,
      escuchandoHasta: (await chrome.storage.local.get('mn_reply_until')).mn_reply_until || 0,
      chatsRecordados: Object.keys((await chrome.storage.local.get('mn_replies')).mn_replies || {}).length
    },
    memoriaDeCompradores: await (async () => {
      const m = await chrome.storage.local.get(['mn_info', 'mn_prices']);
      return {
        chats: Object.keys(m.mn_info || {}).length,
        anunciosConPrecio: Object.keys(m.mn_prices || {}).length,
        ultimos: Object.values(m.mn_info || {}).slice(-3).map((x) => ({ nombreCompleto: x.full, anuncio: x.listing, precio: x.price }))
      };
    })(),
    sincronizacion: await (async () => {
      const m = await chrome.storage.local.get(['mn_marks', 'mn_home', 'mn_thread', 'mn_ledger']);
      const ago = (t) => (t ? Math.round((Date.now() - t) / 1000) + ' s' : null);
      const marks = {};
      Object.keys(m.mn_marks || {}).forEach((k) => { marks[k] = 'vista hace ' + ago(m.mn_marks[k]); });
      return {
        ultimaVezQueMireCadaLista: marks,
        bandejaQueRecuerdoParaRefrescar: m.mn_home ? m.mn_home.url : null,
        chatsConHilo: Object.keys(m.mn_thread || {}).length,
        avisosRecientesEnMemoria: Object.keys(m.mn_ledger || {}).length,
        limiteDeEdadMin: s.maxAgeMin, copiarLoQueEscriboEnFacebook: s.mirrorMine !== false, refrescarA: s.refreshTo
      };
    })(),
    registro: ((await chrome.storage.local.get('mn_log')).mn_log || []).slice(-30).map((e) =>
      new Date(e.t).toLocaleTimeString('es') + ' [' + e.k + '] ' + e.m),
    cuenta: {
      escritaAMano: cleanAccountName(s.accountName),
      detectada: (await chrome.storage.local.get('mn_account')).mn_account || null,
      seUsaraEnLosAvisos: await accountName(s)
    },
    pestanas: []
  };
  for (const tab of tabs) {
    const t = { url: (tab.url || '').replace(/\?.*$/, ''), titulo: tab.title, descargada: !!tab.discarded };
    try {
      const res = await withTimeout(chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const links = document.querySelectorAll('a[href*="/t/"]');
          const sample = Array.from(links).slice(0, 3).map((a) => ({
            href: (a.getAttribute('href') || '').slice(0, 60),
            texto: (a.innerText || '').slice(0, 160),
            aria: (a.getAttribute('aria-label') || '').slice(0, 80)
          }));
          // Por qué no se detecta la cuenta (sin mostrar números de usuario).
          const jsons = document.querySelectorAll('script[type="application/json"]');
          let trozo = '';
          for (const sc of jsons) {
            const t = sc.textContent || '';
            const i = t.indexOf('"CurrentUserInitialData"');
            if (i !== -1) { trozo = t.slice(i, i + 220).replace(/\d{6,}/g, '#'); break; }
          }
          if (typeof globalThis.mnAccountInfo === 'function') globalThis.mnAccountInfo(true);
          globalThis.mnDebugInfo = true; // que el lector devuelva también los textos que vio en la cabecera
          globalThis.mnInfoCache = null;
          const roles = {};
          ['row', 'listitem', 'option', 'grid', 'list', 'gridcell', 'link'].forEach((r) => {
            roles[r] = document.querySelectorAll('[role="' + r + '"]').length;
          });
          // En la bandeja de Marketplace no hay enlaces /t/: se ve el texto tal cual lo lee la extensión.
          const textoMuestra = /\/marketplace\/inbox/i.test(location.pathname)
            ? (document.body.innerText || '').split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 40).map((x) => x.slice(0, 80))
            : undefined;
          return {
            visible: document.visibilityState, enlacesT: links.length, muestra: sample,
            roles: roles, textoMuestra: textoMuestra,
            permisoNotificacionesDeFacebook: typeof Notification !== 'undefined' ? Notification.permission : 'n/a',
            cuentaDebug: { scriptsJson: jsons.length, cookieC_user: /(?:^|;\s*)c_user=\d+/.test(document.cookie || ''), trozoCurrentUserInitialData: trozo },
            scan: (() => { const x = typeof globalThis.mnCollect === 'function' ? globalThis.mnCollect() : 'sin lector'; globalThis.mnDebugInfo = false; globalThis.mnInfoCache = null; return x; })()
          };
        }
      }), SCRIPT_TIMEOUT_MS);
      const r = res && res[0] && res[0].result;
      if (r && r.scan && r.scan.threads) {
        r.scan.threads = r.scan.threads.slice(0, 8).map((th) => ({
          pos: th.pos, nombre: th.name, texto: th.text, sinLeer: th.unread, tuyo: th.mine, marketplace: th.isMarketplace
        }));
      }
      t.pagina = r;
    } catch (e) {
      t.error = String(e && e.message ? e.message : e);
    }
    out.pestanas.push(t);
  }
  return out;
}

async function getSettings() {
  const s = await chrome.storage.local.get('mn_settings');
  return Object.assign({}, DEFAULTS, s.mn_settings || {});
}

// Cola: el content script (cada 4 s, por pestaña) y el despertador llegan a la
// vez. Procesarlos uno detrás de otro evita avisos dobles y datos pisados.
let queue = Promise.resolve();
function enqueueTask(fn) {
  queue = queue.then(fn).catch((e) => console.error(TAG, e));
  return queue;
}
function enqueue(scan) {
  return enqueueTask(() => processScan(scan));
}

/* ---------------- nombre de la cuenta de Facebook ----------------
 * Se lee de la página (collector.js) y se guarda. Si lo escribiste a mano en la
 * Configuración, ese nombre manda sobre el detectado.
 */
function cleanAccountName(n) {
  return String(n || '')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 80);
}

async function rememberAccount(name, source) {
  name = cleanAccountName(name);
  if (!name) return;
  const d = await chrome.storage.local.get('mn_account');
  if (d.mn_account && d.mn_account.name === name) return; // sin cambios: no escribir en cada vuelta
  await chrome.storage.local.set({ mn_account: { name: name, source: String(source || '').slice(0, 40), at: Date.now() } });
}

async function accountName(s) {
  const manual = cleanAccountName(s && s.accountName);
  if (manual) return manual;
  const d = await chrome.storage.local.get('mn_account');
  return (d.mn_account && d.mn_account.name) || '';
}

// Línea "Cuenta de Facebook" para los avisos del teléfono ('' si no se conoce).
function accountLine(name) {
  const n = String(name || '').replace(/\*/g, '');
  return n ? '📘 Cuenta de Facebook: *' + n + '*\n' : '';
}

// Pide el nombre a cada pestaña de Facebook abierta (sin tocar la lista de chats).
async function accountFromTab(tabId) {
  const call = () => withTimeout(chrome.scripting.executeScript({
    target: { tabId: tabId },
    args: [COLLECTOR_VERSION],
    func: (v) => (globalThis.mnCollectVersion === v ? globalThis.mnAccountInfo(true) : undefined)
  }), SCRIPT_TIMEOUT_MS);
  let res = await call();
  if (!res || !res[0] || res[0].result === undefined) {
    await withTimeout(chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['collector.js'] }), SCRIPT_TIMEOUT_MS);
    res = await call();
  }
  return res && res[0] ? res[0].result : null;
}

async function refreshAccountFromTabs() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: FB_URLS });
  } catch (e) {
    return;
  }
  const found = await Promise.all(
    tabs.filter((t) => !t.discarded).map((t) => accountFromTab(t.id).catch(() => null))
  );
  const hit = found.find((a) => a && a.name);
  if (hit) await rememberAccount(hit.name, hit.source);
}

/* ---------------- comprador y anuncio ----------------
 * La lista de Facebook solo muestra el nombre de pila y el título del anuncio.
 * Con el chat abierto, collector.js lee además el nombre completo y el precio
 * (scan.info). Aquí se recuerdan por chat (y el precio, también por título de
 * anuncio) para que los avisos de ese comprador —y de otros que escriban por el
 * mismo anuncio— salgan con "Nombre Apellido • Anuncio" y su precio.
 */
const plainKey = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const mdSafe = (x) => String(x || '').replace(/[*_`\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
const INFO_TTL_MS = 90 * 24 * 60 * 60 * 1000;

async function learnInfo(info) {
  if (!info || !/^\d+$/.test(String(info.tid))) return;
  const full = cleanAccountName(info.full), listing = cleanAccountName(info.listing), price = cleanAccountName(info.price);
  if (!full && !listing && !price) return;
  const d = await chrome.storage.local.get(['mn_info', 'mn_prices']);
  const map = d.mn_info || {};
  const prices = d.mn_prices || {};
  const prev = map[info.tid] || {};
  const next = { full: full || prev.full || '', listing: listing || prev.listing || '', price: price || prev.price || '', at: Date.now() };
  const changed = prev.full !== next.full || prev.listing !== next.listing || prev.price !== next.price;
  if (!changed && next.at - (prev.at || 0) < 6 * 60 * 60 * 1000) return; // sin cambios: no escribir en cada vuelta
  map[info.tid] = next;
  if (next.listing && next.price) prices[plainKey(next.listing)] = { price: next.price, at: next.at };
  const keepNewest = (obj, max) => {
    const keys = Object.keys(obj).filter((k) => next.at - (obj[k].at || 0) < INFO_TTL_MS).sort((a, b) => obj[b].at - obj[a].at).slice(0, max);
    const out = {};
    keys.forEach((k) => { out[k] = obj[k]; });
    return out;
  };
  await chrome.storage.local.set({ mn_info: keepNewest(map, 400), mn_prices: keepNewest(prices, 200) });
  if (changed) {
    await logEvent('scan', 'Datos del chat ' + (next.full || '«' + shortText(listing, 20) + '»') + ': ' +
      (next.full ? 'nombre completo «' + shortText(next.full, 40) + '»' : 'sin apellido visible') +
      (next.listing ? ', anuncio «' + shortText(next.listing, 40) + '»' : '') + (next.price ? ', precio ' + next.price : '') + '.');
  }
}

// Completa th con el comprador (nombre completo si se conoce), el anuncio y el precio.
function enrichThread(th, infoMap, prices) {
  const parts = String(th.name || '').split(/\s[·•]\s/);
  const rowBuyer = parts[0].trim();
  const rowListing = parts.slice(1).join(' • ').trim();
  const info = infoMap[th.tid] || null;
  let buyer = rowBuyer;
  if (info && info.full) {
    const a = plainKey(info.full).split(' ')[0];
    const b = plainKey(rowBuyer).split(' ')[0];
    if (a && a === b && plainKey(info.full).length >= plainKey(rowBuyer).length) buyer = info.full; // es el mismo comprador
  }
  let listing = rowListing;
  if (info && info.listing && (!rowListing || plainKey(info.listing).startsWith(plainKey(rowListing).slice(0, 12)))) listing = info.listing;
  const known = listing ? prices[plainKey(listing)] : null;
  th.buyer = buyer;
  th.listing = th.isMarketplace ? listing : '';
  th.price = th.isMarketplace ? ((info && info.price) || (known && known.price) || '') : '';
  th.name = buyer + (th.listing ? ' · ' + th.listing : '');
}

/* ---------------- hora de llegada, mensajes viejos y avisos repetidos ----------------
 * Cada mensaje tiene una HORA DE LLEGADA: la que marca la lista de Facebook ("3 min",
 * "10:32"…) restada de ahora. Con ella:
 *  - el aviso dice a qué hora llegó el mensaje (y cuánto se retrasó, si fue tarde);
 *  - un mensaje que llegó hace más de «maxAgeMin» minutos, o que ya estaba en la lista
 *    ANTES de la última vez que la miré (p. ej. al cambiar de carpeta o bajar por la
 *    lista), NO se avisa: es viejo, no nuevo;
 *  - si la página se recarga (a mano o con el botón 🔄) y llegó algo mientras cargaba,
 *    eso sí se avisa (recuperación), pero nunca lo anterior;
 *  - los avisos de una misma pasada salen en orden de llegada (el más viejo primero);
 *  - el mismo mensaje visto en dos listas (Messenger y bandeja de Marketplace) se avisa una vez.
 */
function fmtClock(ms) {
  try { return new Date(ms).toLocaleTimeString('es-US', { hour: 'numeric', minute: '2-digit' }); } catch (e) { return new Date(ms).toTimeString().slice(0, 5); }
}
// "3:45 p. m." si es de hoy; si no, con el día.
function fmtWhen(ms, now) {
  if (new Date(ms).toDateString() === new Date(now || Date.now()).toDateString()) return fmtClock(ms);
  let day;
  try { day = new Date(ms).toLocaleDateString('es-US', { weekday: 'short', day: 'numeric', month: 'short' }); } catch (e) { day = new Date(ms).toDateString(); }
  return day + ', ' + fmtClock(ms);
}
function fmtAgo(min) {
  if (min < 1) return 'unos segundos';
  if (min < 60) return Math.round(min) + ' min';
  const h = Math.round(min / 6) / 10;
  return (h % 1 === 0 ? h.toFixed(0) : h.toFixed(1)) + ' h';
}
const firstWord = (x) => plainKey(x).split(' ')[0] || '';
const LEDGER_TTL_MS = 10 * 60 * 1000;
function ledgerKey(kind, th, body) {
  return kind + '|' + firstWord(th.buyer || th.name) + '|' + plainKey(th.listing || '').slice(0, 12) + '|' + plainKey(body).slice(0, 80);
}
function pruneLedger(ledger, now) {
  const ks = Object.keys(ledger).filter((k) => now - (ledger[k].at || 0) < LEDGER_TTL_MS).sort((a, b) => ledger[b].at - ledger[a].at).slice(0, 200);
  const out = {};
  ks.forEach((k) => { out[k] = ledger[k]; });
  return out;
}
// Lo último de la fila es tuyo ("Tú: Sí, sigue disponible" → "Sí, sigue disponible").
const mineBody = (t) => String(t || '').replace(/^(?:t[úu]|you|usted)\s*:\s*/i, '').trim();

// '' = vale la pena avisar; si no, el motivo de no hacerlo.
function staleReason(th, ctx) {
  if (typeof th.age !== 'number') return ''; // sin hora en la fila: se decide por posición/no leído, como siempre
  if (th.age > ctx.maxAge) return 'llegó hace ' + fmtAgo(th.age) + ' (más de ' + ctx.maxAge + ' min; se cambia en Configuración).';
  const tol = ARRIVAL_TOL_MS + (th.age >= 60 ? 60 * 60 * 1000 : 0); // "2 h" solo es exacto a la hora
  if (!ctx.sawChange && ctx.lastMark && ctx.arrivedAt < ctx.lastMark - tol) {
    return 'ya estaba en la lista antes de que la mirara (llegó a las ' + fmtClock(ctx.arrivedAt) + '): no es un mensaje nuevo.';
  }
  return '';
}

// Núcleo: compara los chats con lo ya visto y avisa si hay algo nuevo.
async function processScan(scan) {
  const s = await getSettings();
  if (scan.account) await rememberAccount(scan.account, scan.accountSource);
  const threads = Array.isArray(scan.threads) ? scan.threads : [];
  if (scan.info) await learnInfo(scan.info);
  if (!s.enabled || !threads.length) return;
  {
    const mem = await chrome.storage.local.get(['mn_info', 'mn_prices']);
    for (const th of threads) if (th && th.tid) enrichThread(th, mem.mn_info || {}, mem.mn_prices || {});
  }
  await rememberHome(scan);

  const data = await chrome.storage.local.get(['mn_seen', 'mn_active', 'mn_marks', 'mn_ledger', 'mn_tg_sent']);
  const seen = data.mn_seen || {};
  const activeMap = data.mn_active || {};
  const marks = data.mn_marks || {};
  const ledger = data.mn_ledger || {};
  const tgSent = data.mn_tg_sent || {};
  const now = Date.now();
  const markKey = scan.kind || 'otra';
  const lastMark = marks[markKey] || 0;       // la última vez que vi ESTA lista
  const maxAge = Math.max(5, Math.min(1440, parseInt(s.maxAgeMin, 10) || DEFAULTS.maxAgeMin));
  const mirrorOn = s.channel === 'telegram' && s.mirrorMine !== false;
  // Página recién cargada: normalmente solo se memoriza. Pero si la lista se vio hace
  // un momento (recarga, botón 🔄), lo que llegó mientras tanto sí se avisa.
  const catchUpOk = !!scan.warmup && lastMark > 0 && now - lastMark < CATCHUP_GAP_MS;
  const events = [];      // avisos por mandar: { kind: 'in' | 'out', th, at, … }
  const tOps = [];        // para el hilo (/hilo)
  const activate = [];    // chats que pasan a "conversación activa" (escribiste tú desde Facebook)
  let deliberateSkip = false; // la lista vio el mensaje y decidió no avisar (lo estás viendo, filtro Marketplace…)

  if (scan.warmup) {
    await logEvent('scan', 'Primera lectura de ' + kindName(scan.kind) + ': ' + threads.length +
      ' chats memorizados sin avisar (' + threads.filter((t) => t.unread && !t.mine).length + ' sin leer).' +
      (catchUpOk ? ' La lista se vio hace poco: aviso de lo que llegó mientras recargaba.' : ''));
  }

  for (const th of threads) {
    if (!th || !th.tid) continue;
    const known = !!seen[th.tid];
    const prev = seen[th.tid] || {};
    const hasAge = typeof th.age === 'number';
    const arrivedAt = hasAge ? now - th.age * 60000 : now; // cuándo llegó el último mensaje (a ±1 min)
    // "handled" = último texto del que ya avisamos (o que decidimos no avisar).
    const cur = {
      text: th.text, age: hasAge ? th.age : null, at: now,
      alertAt: prev.alertAt || 0, handled: prev.handled || '', pending: !!prev.pending,
      msgAt: prev.msgAt || arrivedAt, mirrored: prev.mirrored || ''
    };
    seen[th.tid] = cur;
    const changed = prev.text !== cur.text; // incluye chat nunca visto
    // Mismo texto, pero la hora del chat volvió a "ahora": llegó OTRO mensaje igual
    // (por ejemplo dos "Hola" seguidos o dos "Envió una foto"). Además de ver bajar la
    // hora, se compara la hora de llegada con la del mensaje anterior (margen 90 s).
    const minuteLabels = hasAge && typeof prev.age === 'number' && cur.age < 60 && prev.age < 60 && typeof prev.msgAt === 'number';
    const again = known && !changed && hasAge && typeof prev.age === 'number' &&
      (cur.age < prev.age || (minuteLabels && arrivedAt > prev.msgAt + 90 * 1000));
    if (changed || again) { cur.pending = true; cur.msgAt = arrivedAt; }
    if (again) cur.handled = '';
    const fresh = changed || again;
    const who = '"' + shortText(th.name, 30) + '"';
    const skip = (why) => (fresh ? logEvent('skip', 'No aviso de ' + who + ': ' + why) : null);
    // Un chat al que le contestaste hace poco (desde Telegram o escribiendo tú en
    // Facebook): estás en plena conversación, así que cada respuesta del cliente se
    // avisa completa y casi sin espera, aunque tengas esa pestaña abierta o enfocada.
    const isActive = !!(activeMap[th.tid] && activeMap[th.tid] > now);
    const warm = !!scan.warmup;
    // Con la página recién cargada solo cuenta lo que llegó DESPUÉS de la última lectura.
    const catchUp = warm && catchUpOk && hasAge && ((known && fresh) || arrivedAt >= lastMark - ARRIVAL_TOL_MS);
    const why = fresh || cur.pending
      ? staleReason(th, { maxAge: maxAge, lastMark: lastMark, arrivedAt: arrivedAt, sawChange: known && cur.pending })
      : '';

    if (th.mine) {                                  // lo último lo escribiste tú
      cur.handled = ''; cur.pending = false;
      if (!fresh || th.old === true || (warm && !catchUp)) continue;
      if (why) { await logEvent('skip', 'No muestro lo que escribiste en ' + who + ': ' + why); continue; }
      if (s.marketplaceOnly && !th.isMarketplace) continue;
      const body = mineBody(th.text);
      if (!body || cur.mirrored === cur.text) continue;
      cur.mirrored = cur.text;
      if (matchesTgSent(tgSent[th.tid], body, now)) continue; // lo mandaste TÚ desde Telegram: ya lo viste allí
      const key = ledgerKey('out', th, body);
      const dup = ledger[key];
      if (dup && dup.tid !== th.tid && now - dup.at < DEDUPE_VIEWS_MS) continue; // la otra lista ya lo mostró
      ledger[key] = { at: now, tid: th.tid };
      tOps.push({ tid: th.tid, name: th.name, w: 'y', t: body, at: arrivedAt });
      if (mirrorOn) {
        events.push({ kind: 'out', th: th, body: body, at: arrivedAt });
        if (/^\d+$/.test(String(th.tid))) activate.push(String(th.tid));
      }
      continue;
    }
    cur.mirrored = '';
    if (cur.text === cur.handled) { cur.pending = false; continue; }
    // Solo mensajes de las últimas 24 horas: si la fila marca una hora de hace más
    // de 1 día ("ayer", "lun", "3 oct", "2 sem"…) es un chat viejo (p. ej. apareció al
    // bajar por la lista) y no se avisa. Cuando llegue un mensaje nuevo, la fila vuelve
    // a decir "ahora" y ahí sí se avisa.
    if (th.old === true) {
      await skip('su último mensaje tiene más de 1 día (solo se avisa de mensajes de las últimas 24 horas).');
      cur.handled = cur.text;
      cur.pending = false;
      continue;
    }
    // Más viejo que el límite de Configuración, o ya estaba en la lista antes de que la mirara.
    if (why) {
      await skip(why);
      cur.handled = cur.text;
      cur.pending = false;
      continue;
    }
    // ¿Es un mensaje nuevo del cliente? Sirve cualquiera de las dos señales:
    //  - Facebook lo marca "sin leer" (punto azul / negrita), o
    //  - el texto cambió y el chat está arriba de la lista (los mensajes nuevos
    //    suben el chat). La v0.6 dependía solo de la marca "sin leer", que
    //    cambia con el diseño de Facebook, y por eso podía no avisar nunca.
    const top = typeof th.pos === 'number' && th.pos < TOP_ROWS;
    if (!th.unread && !(cur.pending && top)) {
      if (fresh && known) await skip('cambió pero no se ve sin leer ni subió a las primeras filas (puesto ' + (th.pos + 1) + ').');
      cur.pending = false;
      continue;
    }
    if (warm && !catchUp) {                       // lista recién abierta: no avisar de chats viejos
      cur.handled = cur.text;
      cur.pending = false;
      continue;
    }
    if (th.tid === scan.openTid && !isActive) {   // lo estás mirando ahora mismo (salvo conversación activa)
      await skip('tienes ese chat abierto en pantalla.');
      deliberateSkip = true;
      tOps.push({ tid: th.tid, name: th.name, w: 'c', t: th.text, at: arrivedAt });
      cur.handled = cur.text;
      cur.pending = false;
      continue;
    }
    if (th.src === 'texto' && scan.focused && !isActive) { // bandeja de Marketplace a la vista
      await skip('estás mirando la bandeja de Marketplace en pantalla.');
      deliberateSkip = true;
      cur.handled = cur.text;
      cur.pending = false;
      continue;
    }
    if (s.marketplaceOnly && !th.isMarketplace) {
      await skip('no es de Marketplace y tienes activado "solo Marketplace" en Configuración.');
      deliberateSkip = true;
      cur.handled = cur.text;
      cur.pending = false;
      continue;
    }
    // El mismo mensaje ya avisado desde OTRA lista (Messenger y bandeja de Marketplace
    // abiertas a la vez, cada una con su identificador del chat).
    const lkey = ledgerKey('in', th, th.text);
    const dup = ledger[lkey];
    if (dup && dup.tid !== th.tid && now - dup.at < DEDUPE_VIEWS_MS) {
      await skip('es el mismo mensaje del que ya avisé (lo vi en otra lista de Facebook que tienes abierta).');
      cur.handled = cur.text;
      cur.pending = false;
      continue;
    }
    // Varios mensajes seguidos del mismo chat: un aviso, y el resto queda
    // pendiente hasta que pase el tiempo de espera. En una conversación activa
    // (le acabas de contestar) la espera es mucho más corta, para que cada
    // respuesta del cliente llegue casi al instante.
    const cooldown = isActive ? ACTIVE_COOLDOWN_MS : COOLDOWN_MS;
    if (now - cur.alertAt < cooldown) {
      await skip('ya se avisó de este chat hace muy poco; se avisará del último mensaje enseguida.');
      continue;
    }
    cur.alertAt = now;
    cur.handled = cur.text;
    cur.pending = false;
    ledger[lkey] = { at: now, tid: th.tid };
    tOps.push({ tid: th.tid, name: th.name, w: 'c', t: th.text, at: arrivedAt });
    events.push({ kind: 'in', th: th, isActive: isActive, at: arrivedAt });
  }

  // Limpieza para que el almacenamiento no crezca sin fin (la v0.4 nunca borraba).
  const ids = Object.keys(seen).filter((id) => now - (seen[id].at || 0) < FORGET_MS);
  ids.sort((a, b) => (seen[b].at || 0) - (seen[a].at || 0));
  const pruned = {};
  for (const id of ids.slice(0, MAX_SEEN)) pruned[id] = seen[id];

  const unreadCount = threads.filter((t) => t.unread && !t.mine).length;
  const mpCount = threads.filter((t) => t.isMarketplace).length;
  marks[markKey] = now;
  await chrome.storage.local.set({ mn_seen: pruned, mn_marks: marks, mn_ledger: pruneLedger(ledger, now) });
  await setStatus({
    lastScanAt: now, threads: threads.length, unread: unreadCount, marketplace: mpCount,
    kind: scan.kind || '', source: scan.source || ''
  });
  if (deliberateSkip) await setStatus({ lastSkipAt: now });
  await appendThread(tOps);
  for (const tid of activate) await markActive(tid);

  // En el orden en que LLEGARON (el más viejo primero), no en el de la lista.
  events.sort((a, b) => a.at - b.at);
  for (const ev of events) {
    if (ev.kind === 'out') await mirrorOwn(ev.th, ev.body, s, ev.at);
    else await alertNewMessage(ev.th, s, ev.isActive, ev.at);
  }
}

// Dónde está la bandeja que vigilas (sin un chat abierto): el botón 🔄 vuelve ahí.
async function rememberHome(scan) {
  const path = String(scan.path || '');
  if (!/^\/(?:messages|marketplace\/inbox)/.test(path) || /\/t\/\d+/.test(path)) return;
  const url = 'https://www.facebook.com' + path;
  const d = await chrome.storage.local.get('mn_home');
  if (d.mn_home && d.mn_home.url === url && Date.now() - (d.mn_home.at || 0) < 10 * 60 * 1000) return;
  await chrome.storage.local.set({ mn_home: { url: url, at: Date.now() } });
}

async function setStatus(patch) {
  const d = await chrome.storage.local.get('mn_status');
  await chrome.storage.local.set({ mn_status: Object.assign({}, d.mn_status || {}, patch) });
}

/* ---------- hilo de la conversación ----------
 * Cada chat va guardando, en orden, lo que se dijo: lo del comprador, lo que tú escribes
 * en Facebook y lo que mandas desde Telegram. Sirve para (1) encadenar los mensajes en
 * Telegram (cada uno cita al anterior del mismo chat) y (2) el comando /hilo, que te
 * manda la conversación entera. Solo guarda lo que la extensión llegó a ver.
 */
const CHAIN_TTL_MS = 24 * 60 * 60 * 1000;
let threadChain = Promise.resolve();
function appendThread(ops) {
  if (!ops || !ops.length) return threadChain;
  threadChain = threadChain.then(async () => {
    try {
      const d = await chrome.storage.local.get('mn_thread');
      const map = d.mn_thread || {};
      const now = Date.now();
      for (const op of ops) {
        const e = map[op.tid] || { name: op.name, items: [], at: now };
        e.name = op.name || e.name;
        const last = e.items[e.items.length - 1];
        if (last && last.w === op.w && last.t === String(op.t).slice(0, 600) && Math.abs(last.at - op.at) < 90 * 1000) continue; // el mismo mensaje dos veces
        e.items.push({ w: op.w, t: String(op.t).slice(0, 600), at: op.at });
        e.items.sort((a, b) => a.at - b.at);
        if (e.items.length > THREAD_KEEP) e.items.splice(0, e.items.length - THREAD_KEEP);
        e.at = now;
        map[op.tid] = e;
      }
      for (const k of Object.keys(map)) if (now - (map[k].at || 0) > THREAD_TTL_MS) delete map[k];
      const ks = Object.keys(map);
      if (ks.length > MAX_THREADS) ks.sort((a, b) => map[a].at - map[b].at).slice(0, ks.length - MAX_THREADS).forEach((k) => { delete map[k]; });
      await chrome.storage.local.set({ mn_thread: map });
    } catch (e) { /* el hilo es opcional */ }
  });
  return threadChain;
}

// Último mensaje del bot en Telegram que pertenece a ese chat: el siguiente lo cita.
async function chainOf(tid) {
  const d = await chrome.storage.local.get('mn_chain');
  const e = (d.mn_chain || {})[String(tid)];
  return e && Date.now() - e.at < CHAIN_TTL_MS ? e.id : undefined;
}
async function rememberChain(tid, id) {
  if (!id || !tid) return;
  const d = await chrome.storage.local.get('mn_chain');
  const map = d.mn_chain || {};
  const now = Date.now();
  map[String(tid)] = { id: id, at: now };
  for (const k of Object.keys(map)) if (now - map[k].at > CHAIN_TTL_MS) delete map[k];
  await chrome.storage.local.set({ mn_chain: map });
}

// Lo que mandaste TÚ por Telegram a cada chat: cuando la lista de Facebook lo muestre
// como "Tú: …", no se vuelve a copiar a Telegram como si lo hubieras escrito en Facebook.
const PHOTO_ROW_RE = /\b(?:foto|photo|imagen|image|archivo|attachment|adjunto|pic)\b/i;
async function noteTgSent(tid, text, photo) {
  if (!tid) return;
  const d = await chrome.storage.local.get('mn_tg_sent');
  const map = d.mn_tg_sent || {};
  const now = Date.now();
  const list = (map[tid] || []).filter((e) => now - e.at < OWN_TG_TTL_MS * 5);
  list.push({ n: plainKey(text), photo: !!photo, at: now });
  map[tid] = list.slice(-10);
  for (const k of Object.keys(map)) if (!map[k].length || now - map[k][map[k].length - 1].at > OWN_TG_TTL_MS * 5) delete map[k];
  await chrome.storage.local.set({ mn_tg_sent: map });
}
function matchesTgSent(list, body, now) {
  if (!list || !list.length) return false;
  const b = plainKey(String(body).replace(/…$|\.\.\.$/, ''));
  return list.some((e) => {
    if (now - e.at > OWN_TG_TTL_MS) return false;
    if (e.photo && PHOTO_ROW_RE.test(body)) return true;
    if (!e.n || !b) return false;
    const k = Math.min(40, e.n.length, b.length);
    return e.n.slice(0, k) === b.slice(0, k);
  });
}

async function alertNewMessage(th, s, isActive, arrivedAt) {
  const now = Date.now();
  const at = arrivedAt || now;
  const where = th.isMarketplace ? 'Marketplace' : 'Messenger';
  const link = th.link || (INBOX_URL + 't/' + th.tid + '/');
  const buyer = mdSafe(th.buyer || th.name);
  // Marketplace: "Escribió / Nombre Apellido • Anuncio / $precio". Si no se conoce el
  // anuncio o el precio, esa línea simplemente no sale (nunca se inventa).
  const ad = th.isMarketplace && th.listing ? mdSafe(th.listing) : '';
  const price = th.isMarketplace && th.price ? mdSafe(th.price) : '';
  const whoBlock = buyer + (ad ? ' • ' + ad : '') + (price ? '\n' + price : '');
  // Hora en que LLEGÓ el mensaje; si el aviso salió tarde, también cuánto se retrasó.
  const lateMin = Math.round((now - at) / 60000);
  const clock = fmtClock(at) + (lateMin >= 3 ? ' (hace ' + fmtAgo(lateMin) + ')' : '');
  const text =
    (isActive ? '💬 *Respuesta de ' + buyer + '*' : '🔔 *Nuevo mensaje en ' + where + '*') + ' · ' + clock + '\n' +
    accountLine(await accountName(s)) + '\n' +
    (isActive ? (ad ? ad + (price ? ' • ' + price : '') + '\n' : '') : 'Escribió\n' + whoBlock + '\n\n') +
    '"' + th.text + '"';
  if (th.isMarketplace && !/\s/.test(buyer)) {
    await logEvent('scan', 'Todavía no sé el apellido de «' + shortText(buyer, 25) + '» (la lista de Facebook solo muestra el nombre de pila): se aprende al abrir ese chat una vez.');
  }
  const canReply = replyActive(s) && th.src !== 'texto' && /^\d+$/.test(String(th.tid));
  // Si puedes contestar con «Responder» (Telegram), el enlace al chat ya no
  // hace falta: se quita para que el aviso no se vea tan largo. Si no puedes
  // (WhatsApp, o un chat sin ID de hilo), el enlace sigue siendo la única
  // forma de llegar a ese chat, así que se mantiene.
  const full = canReply
    ? text + '\n\n↩️ Para contestar desde aquí: mantén pulsado este mensaje y elige «Responder».'
    : text + '\n\nResponder: ' + link;

  // El teléfono es lo importante: la notificación del PC va aparte, sin esperarla,
  // para que si Windows/Chrome la retrasan o la bloquean no se retrase el aviso.
  if (s.pcNotify) {
    const id = th.src === 'texto' ? 'mn-open-inbox-mp-' : 'mn-thread-' + th.tid + '-';
    notifyPC(id + Date.now(), 'Nuevo mensaje de ' + (th.buyer || th.name), fmtClock(at) + ' · ' + (ad ? ad + (price ? ' • ' + price : '') + ': ' : '') + th.text);
  }
  const via = s.channel === 'telegram' ? 'Telegram' : 'WhatsApp';
  // En Telegram cada mensaje cita al anterior de ese mismo chat: así se ve el hilo.
  const replyTo = s.channel === 'telegram' ? await chainOf(th.tid) : undefined;
  const r = await sendNotification(full, s, { replyTo: replyTo });
  if (r.ok && r.messageId) await rememberChain(th.tid, r.messageId);
  if (r.ok && canReply) {
    await rememberTarget(r.messageId, th);
    await startReplyWindow();
  }
  if (r.ok) {
    await setStatus({ lastAlertAt: Date.now(), lastListAlertAt: Date.now(), lastAlertName: th.name, lastError: '' });
    await logEvent('ok', 'Aviso enviado por ' + via + ': "' + shortText(th.name, 30) + '" — ' + shortText(th.text, 50));
  } else {
    await setStatus({ lastError: r.message });
    await logEvent('err', 'NO se pudo avisar por ' + via + ' de "' + shortText(th.name, 30) + '": ' + shortText(r.message, 120));
    if (r.reason !== 'missing-config') {
      notifyPC('mn-error-' + Date.now(), 'No se pudo avisar a tu teléfono', r.message);
    }
  }
}

// Lo que escribes TÚ en Facebook (en el PC o en el celular) también llega a Telegram,
// sin sonido, citando el mensaje anterior de ese chat, para que el hilo esté completo.
async function mirrorOwn(th, body, s, at) {
  const buyer = mdSafe(th.buyer || th.name);
  const ad = th.isMarketplace && th.listing ? mdSafe(th.listing) : '';
  const media = /^(?:enviaste|you sent|sent)\b/i.test(body);
  const text =
    '✍️ Tú, desde Facebook · ' + fmtClock(at) + '\n' +
    'Para ' + buyer + (ad ? ' • ' + ad : '') + '\n\n' +
    (media ? '📎 ' + body : '"' + body + '"');
  const r = await sendNotification(text, s, { replyTo: await chainOf(th.tid), silent: true });
  if (r.ok) {
    if (r.messageId) {
      await rememberTarget(r.messageId, th);
      await rememberChain(th.tid, r.messageId);
    }
    await logEvent('ok', 'Lo que escribiste en Facebook se copió a Telegram: "' + shortText(th.name, 30) + '" — ' + shortText(body, 50));
  } else {
    await setStatus({ lastError: r.message });
    await logEvent('err', 'NO se pudo copiar a Telegram lo que escribiste en "' + shortText(th.name, 30) + '": ' + shortText(r.message, 120));
  }
}

/* ------------------- respuestas desde Telegram -------------------
 * Tú escribes A MANO en Telegram (con "Responder" sobre el aviso del chat) y la
 * extensión escribe ese texto en ese chat de Messenger y lo envía.
 *  - Nada se manda solo: no hay respuestas automáticas (el único botón, 🔄, solo recarga Facebook).
 *  - Solo se obedecen mensajes de TU cuenta de Telegram (la del ID guardado).
 *  - El bot lee tus mensajes con getUpdates (sin servidor). Solo un programa a
 *    la vez puede leer un mismo bot.
 */
const REPLY_WINDOW_MS = 10 * 60 * 1000;   // tras un aviso, se escucha cada pocos segundos 10 min
const REPLY_RECENT_MS = 15 * 60 * 1000;   // un texto sin "Responder" va al único chat avisado en 15 min
const REPLY_MAX_AGE_S = 30 * 60;          // ignora mensajes de Telegram más viejos que 30 min
const REPLY_MAX_LEN = 1500;
const REPLY_PER_MIN = 5;
const REPLY_PER_HOUR = 40;
const MAX_TARGETS = 150;
const REPLY_MAX_IMAGE_BYTES = 8 * 1024 * 1024; // no todas las fotos de Telegram bajan comprimidas

let pollBusy = false;
let pollLoopOn = false;
let replyUntil = 0;
let lastStrangerLog = 0;
let lastPollErrKey = '';
let lastPollErrAt = 0;

function validTg(s) {
  return /^\d+:[\w-]+$/.test(String(s.tg_token || '').trim()) && /^-?\d+$/.test(String(s.tg_chatid || '').trim());
}

function replyActive(s) {
  return s.enabled !== false && s.replyEnabled === true && s.channel === 'telegram' && validTg(s);
}

async function tgApi(s, method, payload, timeoutMs) {
  const token = String(s.tg_token || '').trim();
  try {
    const res = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(timeoutMs || 20000)
    });
    const body = await res.text();
    let json = null;
    try { json = JSON.parse(body); } catch (e) { /* no era JSON */ }
    return { status: res.status, json: json };
  } catch (e) {
    return { status: 0, json: null, error: String(e && e.message ? e.message : e) };
  }
}

// Baja una foto que TÚ mandaste al bot de Telegram, para pegarla en el chat de
// Facebook. Telegram guarda los archivos un rato bajo una URL propia (getFile);
// se descarga aquí (el service worker sí puede) y se manda a la pestaña como
// un data: URL, porque el content script no puede pedirle nada a Telegram.
async function tgFileUrl(s, fileId) {
  const r = await tgApi(s, 'getFile', { file_id: fileId }, 15000);
  if (!r.json || !r.json.ok || !r.json.result || !r.json.result.file_path) return null;
  return 'https://api.telegram.org/file/bot' + String(s.tg_token).trim() + '/' + r.json.result.file_path;
}

function bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000; // de a trozos: con la foto entera, String.fromCharCode se queda sin pila
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Tipo real de una imagen por sus primeros bytes. Telegram a veces sirve el archivo
// como "application/octet-stream" y, con ese tipo, Facebook lo toma por un archivo
// cualquiera (descargable) en vez de por una foto.
function sniffImageMime(b) {
  if (b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b.length > 7 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b.length > 5 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length > 11 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return '';
}

async function downloadTelegramPhoto(s, fileId) {
  const url = await tgFileUrl(s, fileId);
  if (!url) return { error: 'Telegram no me dio la foto (el archivo puede haber expirado; vuelve a mandarla).' };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { error: 'Telegram respondió HTTP ' + res.status + ' al pedir la foto.' };
    const buf = await res.arrayBuffer();
    if (buf.byteLength > REPLY_MAX_IMAGE_BYTES) return { error: 'Esa foto es demasiado grande.' };
    const bytes = new Uint8Array(buf);
    const header = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const sniffed = sniffImageMime(bytes);
    if (!sniffed && !/^image\//.test(header)) return { error: 'Ese archivo no parece una imagen (JPG, PNG, GIF o WEBP).' };
    const mime = sniffed || header; // manda lo que dicen los bytes, no la cabecera
    return { dataUrl: 'data:' + mime + ';base64,' + bytesToBase64(bytes), mime: mime };
  } catch (e) {
    return { error: 'No pude descargar la foto de Telegram: ' + shortText(e && e.message ? e.message : e, 80) };
  }
}

// Mensaje del bot para ti (confirmaciones y avisos de error). No es un aviso de chat.
function tgSay(s, text, replyTo, extra) {
  return tgApi(s, 'sendMessage', Object.assign({
    chat_id: String(s.tg_chatid).trim(),
    text: String(text).slice(0, 3500),
    reply_to_message_id: replyTo || undefined,
    allow_sending_without_reply: true,
    disable_web_page_preview: true
  }, extra || {}), 15000);
}

// Igual que tgSay, pero el mensaje queda ligado a ESE chat: se puede contestar sobre
// él y el siguiente aviso de ese chat lo cita (hilo seguido).
async function tgSayAbout(s, target, text, replyTo) {
  const r = await tgSay(s, text, replyTo);
  const id = r && r.json && r.json.ok && r.json.result && r.json.result.message_id;
  if (id && target && target.tid) {
    await rememberTarget(id, target);
    await rememberChain(target.tid, id);
  }
  return r;
}

/* ---- botón 🔄 y menú del bot ----
 * Un teclado fijo con «🔄 Refrescar Marketplace» (se muestra una vez por versión; el
 * comando /teclado lo vuelve a poner) y el menú de comandos del bot.
 */
const KB_VERSION = 22;
const REFRESH_LABEL = '🔄 Refrescar Marketplace';
const KEYBOARD = { keyboard: [[{ text: REFRESH_LABEL }]], resize_keyboard: true, is_persistent: true };
const REFRESH_RE = /^(?:\/(?:refrescar|recargar|actualizar|refresh|reload)(?:@\w+)?|🔄\s*refrescar(?:\s+marketplace)?)(?:\s+(forzar|ya|force))?\s*$/i;
const HILO_RE = /^\/(?:hilo|historial|conversaci[oó]n|thread)(?:@\w+)?(?:\s|$)/i;
const KB_RE = /^\/(?:teclado|keyboard)(?:@\w+)?\s*$/i;

async function keyboardFor(s) {
  if (!replyActive(s)) return null;
  const d = await chrome.storage.local.get('mn_kb');
  return d.mn_kb === KB_VERSION ? null : KEYBOARD;
}

async function ensureBotMenu(s) {
  const d = await chrome.storage.local.get('mn_cmds');
  if (d.mn_cmds === KB_VERSION) return;
  const r = await tgApi(s, 'setMyCommands', {
    commands: [
      { command: 'refrescar', description: '🔄 Recargar Facebook y volver a la bandeja de Marketplace' },
      { command: 'pantalla', description: '📷 Captura del chat (responde a su aviso)' },
      { command: 'hilo', description: '🧵 Conversación completa del chat (responde a su aviso)' },
      { command: 'ayuda', description: 'Cómo contestar los chats' }
    ]
  }, 15000);
  if (r.json && r.json.ok) await chrome.storage.local.set({ mn_cmds: KB_VERSION });
}

// Cada aviso de chat que sale por Telegram guarda a qué chat pertenece (por el id del mensaje del bot).
async function rememberTarget(messageId, th) {
  if (!messageId || !th || !/^\d+$/.test(String(th.tid))) return;
  const d = await chrome.storage.local.get('mn_replies');
  const map = d.mn_replies || {};
  const now = Date.now();
  map[String(messageId)] = { tid: String(th.tid), name: th.name, at: now };
  const keep = Object.keys(map)
    .filter((k) => now - map[k].at < 24 * 60 * 60 * 1000)
    .sort((a, b) => map[b].at - map[a].at)
    .slice(0, MAX_TARGETS);
  const out = {};
  keep.forEach((k) => { out[k] = map[k]; });
  await chrome.storage.local.set({ mn_replies: out });
}

// Un chat al que le acabas de contestar desde Telegram queda "activo" un rato:
// sus próximas respuestas se avisan completas y casi sin espera (ver ACTIVE_COOLDOWN_MS
// en processScan), aunque tengas ese chat abierto o enfocado en el PC.
async function markActive(tid) {
  if (!/^\d+$/.test(String(tid))) return;
  const d = await chrome.storage.local.get('mn_active');
  const map = d.mn_active || {};
  const now = Date.now();
  map[String(tid)] = now + ACTIVE_CHAT_MS;
  for (const k of Object.keys(map)) if (map[k] < now) delete map[k];
  await chrome.storage.local.set({ mn_active: map });
}

// Cola: si llega una respuesta tuya de Telegram mientras otra todavía se está
// escribiendo en Facebook, espera su turno en vez de pisarla (dos "mnReply" a
// la vez en la misma pestaña es justo lo que hacía fallar el envío al alternar).
let replyChain = Promise.resolve();
let replyBusy = 0;
function queueReply(fn) {
  const wasBusy = replyBusy > 0;
  replyBusy++;
  const run = replyChain.then(() => fn(wasBusy), () => fn(wasBusy)).finally(() => { replyBusy--; });
  replyChain = run.catch(() => {});
  return run;
}

// Tras un aviso se escucha a Telegram con espera larga (respuesta casi inmediata) durante 10 min.
async function startReplyWindow() {
  replyUntil = Date.now() + REPLY_WINDOW_MS;
  await chrome.storage.local.set({ mn_reply_until: replyUntil });
  if (!pollLoopOn) pollLoop().catch((e) => console.error(TAG, e));
}

async function pollLoop() {
  pollLoopOn = true;
  try {
    while (Date.now() < replyUntil) {
      const s = await getSettings();
      if (!replyActive(s)) break;
      const t0 = Date.now();
      await pollTelegram(25);
      if (Date.now() - t0 < 1500) await new Promise((r) => setTimeout(r, 2500)); // por si falla o ya había otra lectura
    }
  } finally {
    pollLoopOn = false;
  }
}

// Cada 30 s (alarma): se sigue escuchando a Telegram TODO el tiempo (no solo tras un
// aviso), para que el botón 🔄, /pantalla, /hilo o una respuesta se atiendan al instante
// y no hasta 30 s después.
async function replyTick() {
  const s = await getSettings();
  if (!replyActive(s)) return;
  replyUntil = Math.max(replyUntil, Date.now() + 2 * 60 * 1000);
  await chrome.storage.local.set({ mn_reply_until: replyUntil });
  if (!pollLoopOn) pollLoop().catch((e) => console.error(TAG, e));
}

async function reportPollError(r) {
  const j = r.json || {};
  const desc = String(j.description || r.error || '');
  let msg = '';
  if (r.status === 409 && /webhook/i.test(desc)) msg = 'Este bot tiene un webhook activo (lo usa otro servicio): no puedo leer tus respuestas.';
  else if (r.status === 409) msg = 'Otro programa (u otro perfil de Chrome) está leyendo este mismo bot. Usa un bot distinto por perfil.';
  else if (r.status === 401 || r.status === 404) msg = 'Telegram rechazó el token del bot.';
  else if (r.status === 0) return; // sin red un momento: se reintenta solo
  else msg = 'Telegram respondió ' + r.status + ': ' + shortText(desc, 80);
  const now = Date.now();
  if (msg === lastPollErrKey && now - lastPollErrAt < 30 * 60 * 1000) return;
  lastPollErrKey = msg;
  lastPollErrAt = now;
  await setStatus({ replyError: msg });
  await logEvent('reply', 'No puedo leer tus respuestas de Telegram: ' + msg);
}

async function pollTelegram(timeoutSec) {
  if (pollBusy) return;
  const s = await getSettings();
  if (!replyActive(s)) return;
  pollBusy = true;
  try {
    const st = await chrome.storage.local.get(['mn_tg_offset', 'mn_tg_init']);
    if (!st.mn_tg_init) {
      // Primera vez: lo que ya estaba pendiente en Telegram se descarta, no se ejecuta.
      const r = await tgApi(s, 'getUpdates', { offset: -1, timeout: 0, allowed_updates: ['message'] }, 15000);
      if (r.json && r.json.ok) {
        const last = (r.json.result || []).slice(-1)[0];
        await chrome.storage.local.set({ mn_tg_init: true, mn_tg_offset: last ? last.update_id + 1 : 0 });
        await setStatus({ replyError: '' });
        await logEvent('reply', 'Respuestas desde Telegram activadas. Responde a un aviso para contestar ese chat.');
      } else {
        await reportPollError(r);
      }
      return;
    }
    await ensureBotMenu(s);
    const r = await tgApi(s, 'getUpdates', { offset: st.mn_tg_offset || 0, timeout: timeoutSec || 0, allowed_updates: ['message'] }, (timeoutSec || 0) * 1000 + 15000);
    if (!r.json || !r.json.ok) { await reportPollError(r); return; }
    if (lastPollErrKey) { lastPollErrKey = ''; await setStatus({ replyError: '' }); }
    const updates = r.json.result || [];
    if (!updates.length) return;
    // Primero se anota hasta dónde se leyó: así un mensaje NUNCA se ejecuta dos veces.
    await chrome.storage.local.set({ mn_tg_offset: Math.max.apply(null, updates.map((u) => u.update_id)) + 1 });
    for (const u of updates) {
      if (u.message) await handleTelegramMessage(u.message, s);
    }
  } finally {
    pollBusy = false;
  }
}

// ¿A qué chat va este mensaje tuyo de Telegram?
async function resolveTarget(msg) {
  const d = await chrome.storage.local.get('mn_replies');
  const map = d.mn_replies || {};
  if (msg.reply_to_message && msg.reply_to_message.message_id) {
    const t = map[String(msg.reply_to_message.message_id)];
    return t ? { target: t } : { error: 'No sé a qué chat corresponde ese mensaje (es muy viejo o no era un aviso de chat). Responde a un aviso reciente.' };
  }
  const now = Date.now();
  const byTid = new Map();
  Object.values(map)
    .filter((t) => now - t.at < REPLY_RECENT_MS)
    .sort((a, b) => a.at - b.at)
    .forEach((t) => byTid.set(t.tid, t));
  if (byTid.size === 1) return { target: Array.from(byTid.values())[0] };
  if (byTid.size === 0) return { error: 'No hay ningún aviso reciente. Mantén pulsado el aviso del chat que quieres contestar y elige «Responder».' };
  const names = Array.from(byTid.values()).map((t) => '«' + shortText(t.name, 25) + '»').join(', ');
  return { error: 'Tienes varios chats pendientes (' + names + '). Mantén pulsado el aviso del chat al que quieres contestar y elige «Responder».' };
}

async function replyAllowed() {
  const d = await chrome.storage.local.get('mn_reply_times');
  const now = Date.now();
  const times = (d.mn_reply_times || []).filter((t) => now - t < 60 * 60 * 1000);
  const lastMin = times.filter((t) => now - t < 60 * 1000).length;
  if (lastMin >= REPLY_PER_MIN) return { ok: false, why: 'Demasiados mensajes seguidos (máximo ' + REPLY_PER_MIN + ' por minuto). Espera un momento.' };
  if (times.length >= REPLY_PER_HOUR) return { ok: false, why: 'Llegaste al límite de ' + REPLY_PER_HOUR + ' respuestas por hora.' };
  times.push(now);
  await chrome.storage.local.set({ mn_reply_times: times });
  return { ok: true };
}

const REPLY_HELP =
  'Cómo contestar un chat desde aquí:\n' +
  '1. Mantén pulsado el aviso del chat y elige «Responder».\n' +
  '2. Escribe tu texto, o adjunta una foto (con o sin texto como pie), y envíalo.\n' +
  'La extensión lo escribe (o pega la foto) en ese chat de Facebook y te confirma.\n' +
  'Respondiendo al aviso de un chat también puedes usar:\n' +
  '• /pantalla → una captura de ese chat\n' +
  '• /hilo → toda la conversación (lo del comprador y lo tuyo, con horas)\n' +
  'Botón «🔄 Refrescar Marketplace» (o /refrescar): recarga Facebook y vuelve a la bandeja de Marketplace.\n' +
  'Lo que escribes tú directamente en Facebook también se copia aquí, en el mismo hilo.';

// Nombre para el registro y las confirmaciones cuando el chat configurado es un
// grupo (varias personas pueden contestar): "Juan", "@juanperez" o "alguien".
function senderName(msg) {
  const f = msg && msg.from;
  if (!f) return 'alguien';
  if (f.username) return '@' + f.username;
  const n = [f.first_name, f.last_name].filter(Boolean).join(' ').trim();
  return n || 'alguien';
}

/* ---- que una respuesta nunca se mande dos veces ----
 * Dos protecciones, por si Telegram vuelve a entregar un mensaje, el service
 * worker se reinicia a media operación, o tocas "enviar" dos veces seguidas:
 *  1. Cada mensaje de Telegram (chat + message_id) se atiende UNA sola vez.
 *  2. El mismo texto (o la misma foto) al mismo chat de Facebook no se repite
 *     dentro de DUP_WINDOW_MS después de que se envió o quedó "incierto".
 */
const DONE_MSGS_KEY = 'mn_done_msgs';
const RECENT_SENDS_KEY = 'mn_recent_sends';
const DUP_WINDOW_MS = 20 * 1000;

/* ---- cuánto tarda en "escribirse" cada respuesta de texto ----
 * Cada respuesta se teclea LETRA POR LETRA y todo el proceso (desde que empieza
 * hasta que se pulsa Enviar) dura un tiempo que se sortea, distinto cada vez,
 * entre TYPE_MIN_MS y TYPE_MAX_MS. Con las dos en 0 se contesta de inmediato
 * (el modo rápido de v0.18). Las fotos sin texto no esperan.
 */
const TYPE_MIN_MS = 10 * 1000;
const TYPE_MAX_MS = 20 * 1000;
function pickTypeMs() {
  const lo = Math.max(0, Math.min(TYPE_MIN_MS, TYPE_MAX_MS));
  const hi = Math.max(0, Math.max(TYPE_MIN_MS, TYPE_MAX_MS));
  return hi ? Math.round(lo + Math.random() * (hi - lo)) : 0;
}

async function alreadyHandled(chatId, messageId) {
  if (messageId === undefined || messageId === null) return false;
  const key = chatId + ':' + messageId;
  const d = await chrome.storage.local.get(DONE_MSGS_KEY);
  const map = d[DONE_MSGS_KEY] || {};
  if (map[key]) return true;
  const now = Date.now();
  map[key] = now;
  for (const k of Object.keys(map)) if (now - map[k] > 24 * 60 * 60 * 1000) delete map[k];
  const keys = Object.keys(map);
  if (keys.length > 300) keys.sort((a, b) => map[a] - map[b]).slice(0, keys.length - 300).forEach((k) => { delete map[k]; });
  await chrome.storage.local.set({ [DONE_MSGS_KEY]: map });
  return false;
}

function replySig(text, photos) {
  const last = photos && photos[photos.length - 1];
  return (last ? 'P:' + (last.file_unique_id || last.file_id) : '') + '|' + String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Milisegundos desde que se mandó lo mismo a ese chat, o 0 si no hay repetido reciente.
async function recentDuplicate(tid, sig) {
  const d = await chrome.storage.local.get(RECENT_SENDS_KEY);
  const rec = (d[RECENT_SENDS_KEY] || {})[tid];
  const ago = rec ? Date.now() - rec.at : 0;
  return rec && rec.sig === sig && ago < DUP_WINDOW_MS ? Math.max(ago, 1) : 0;
}

async function noteSent(tid, sig) {
  const d = await chrome.storage.local.get(RECENT_SENDS_KEY);
  const map = d[RECENT_SENDS_KEY] || {};
  const now = Date.now();
  map[tid] = { sig: sig, at: now };
  for (const k of Object.keys(map)) if (now - map[k].at > 5 * 60 * 1000) delete map[k];
  await chrome.storage.local.set({ [RECENT_SENDS_KEY]: map });
}

/* ---- /pantalla: una captura de ESE chat, bajo demanda ----
 * Responde a un aviso con /pantalla (o /captura): la extensión abre ese chat en
 * Facebook, captura lo que se ve de la conversación y te manda la imagen. Abrir
 * un chat lo marca como leído en Facebook (el comprador ve "Visto").
 */
const SCREEN_RE = /^\/(?:pantalla|captura|screen|screenshot)(?:@\w+)?(?:\s|$)/i;

async function tgSendPhoto(s, blob, caption, replyTo) {
  const fd = new FormData();
  fd.append('chat_id', String(s.tg_chatid).trim());
  fd.append('photo', blob, 'chat.jpg');
  fd.append('caption', String(caption || '').slice(0, 900));
  if (replyTo) { fd.append('reply_to_message_id', String(replyTo)); fd.append('allow_sending_without_reply', 'true'); }
  try {
    const res = await fetch('https://api.telegram.org/bot' + String(s.tg_token || '').trim() + '/sendPhoto', { method: 'POST', body: fd, signal: AbortSignal.timeout(30000) });
    let json = null;
    try { json = JSON.parse(await res.text()); } catch (e) { /* no era JSON */ }
    return { status: res.status, json: json };
  } catch (e) {
    return { status: 0, json: null, error: String(e && e.message ? e.message : e) };
  }
}

// data:image/jpeg;base64,… → Blob (sin pasar por fetch).
function dataUrlToBlob(dataUrl) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error('captura vacía');
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] });
}

// Recorta la captura a la zona de la conversación (sin la lista de otros chats).
async function cropShot(dataUrl, shown) {
  const whole = dataUrlToBlob(dataUrl);
  try {
    const bmp = await createImageBitmap(whole);
    const r = shown && shown.rect;
    let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height;
    if (r && shown.vw) {
      const k = bmp.width / shown.vw; // píxeles de la captura por píxel de la página
      sx = Math.max(0, Math.round(r.x * k));
      sy = Math.max(0, Math.round(r.y * k));
      sw = Math.min(bmp.width - sx, Math.round(r.w * k));
      sh = Math.min(bmp.height - sy, Math.round(r.h * k));
    }
    const cv = new OffscreenCanvas(sw, sh);
    cv.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
    return await cv.convertToBlob({ type: 'image/jpeg', quality: 0.85 });
  } catch (e) {
    return whole; // sin recorte, pero se manda
  }
}

async function captureChat(target) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: FB_URLS }); } catch (e) { tabs = []; }
  tabs = tabs.filter((t) => !t.discarded);
  if (!tabs.length) return { ok: false, detail: 'no hay ninguna pestaña de Facebook abierta. Abre facebook.com/messages y vuelve a pedirlo.' };
  tabs.sort((a, b) => (/\/messages\b/.test(b.url || '') ? 1 : 0) - (/\/messages\b/.test(a.url || '') ? 1 : 0));
  const tab = tabs[0];
  const wake = await wakeTab(tab);
  try {
    try {
      await withTimeout(chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['replier.js'] }), SCRIPT_TIMEOUT_MS);
    } catch (e) {
      return { ok: false, detail: 'no pude hablar con la pestaña de Facebook (' + shortText(e && e.message ? e.message : e, 60) + ').' };
    }
    const show = async () => {
      const res = await withTimeout(chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [{ tid: target.tid }], func: (o) => globalThis.mnShow(o) }), 45000);
      return (res && res[0] && res[0].result) || { ok: false, detail: 'la pestaña de Facebook no respondió.' };
    };
    let shown = await show();
    if (!shown.ok && shown.stage === 'abrir') {
      const loaded = waitTabComplete(tab.id, 25000);
      try { await chrome.tabs.update(tab.id, { url: 'https://www.facebook.com/messages/t/' + target.tid + '/' }); } catch (e) { /* ya se verá abajo */ }
      await loaded;
      await new Promise((r) => setTimeout(r, 2500));
      shown = await show();
    }
    if (!shown.ok) return { ok: false, detail: shown.detail || 'no pude abrir ese chat.' };
    await new Promise((r) => setTimeout(r, 400)); // que Chrome termine de pintar
    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 90 });
    } catch (e) {
      return { ok: false, detail: 'Chrome no me dejó capturar la pantalla (' + shortText(e && e.message ? e.message : e, 80) + ').' };
    }
    return { ok: true, blob: await cropShot(dataUrl, shown) };
  } catch (e) {
    return { ok: false, detail: 'falló la captura (' + shortText(e && e.message ? e.message : e, 80) + ').' };
  } finally {
    await restoreTab(wake);
  }
}

async function handleScreenRequest(msg, s, who0) {
  let allowed = false;
  try { allowed = await chrome.permissions.contains({ origins: ['<all_urls>'] }); } catch (e) { allowed = false; }
  if (!allowed) {
    await tgSay(s, '⚠️ /pantalla necesita un permiso de Chrome que todavía no diste. En el PC: abre las Opciones de la extensión → «Permitir capturas (/pantalla)» y acepta el aviso de Chrome.', msg.message_id);
    await logEvent('reply', 'Pidieron /pantalla pero falta el permiso de captura (Opciones → Permitir capturas).');
    return;
  }
  const res = await resolveTarget(msg);
  if (res.error) { await tgSay(s, '⚠️ ' + res.error, msg.message_id); return; }
  const rate = await replyAllowed();
  if (!rate.ok) { await tgSay(s, '⏳ ' + rate.why, msg.message_id); return; }
  const target = res.target;
  const who = '«' + shortText(target.name, 40) + '»';
  await logEvent('reply', who0 + 'pide una captura del chat de ' + who + '.');
  const r = await queueReply(async (wasBusy) => {
    if (wasBusy) await tgSay(s, '⏳ En cola: te mando la captura de ' + who + ' en cuanto termine la respuesta anterior…', msg.message_id);
    return captureChat(target);
  });
  if (r.ok) {
    const hora = new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
    const sent = await tgSendPhoto(s, r.blob, '📷 ' + who + ' — ' + hora, msg.message_id);
    if (sent.json && sent.json.ok) await logEvent('reply', 'Captura enviada del chat de ' + who + '.');
    else {
      await tgSay(s, who0 + '❌ Tomé la captura pero Telegram no la aceptó (' + shortText((sent.json && sent.json.description) || sent.error || ('HTTP ' + sent.status), 80) + ').', msg.message_id);
      await logEvent('reply', 'NO se pudo mandar la captura de ' + who + ': ' + shortText((sent.json && sent.json.description) || sent.error || sent.status, 100));
    }
  } else {
    await tgSay(s, who0 + '❌ No pude capturar el chat de ' + who + ': ' + r.detail, msg.message_id);
    await logEvent('reply', 'NO se pudo capturar ' + who + ': ' + shortText(r.detail, 100));
  }
  await startReplyWindow();
}

/* ---- 🔄 Refrescar: recarga Facebook y vuelve a la bandeja de Marketplace ----
 * El botón «🔄 Refrescar Marketplace» (o /refrescar) recarga la pestaña que vigila tus
 * chats y comprueba que de verdad quedó en la bandeja (y que ve los chats):
 *  - «auto» (lo normal): vuelve a la MISMA bandeja que estabas usando (Messenger o la
 *    bandeja de Marketplace); si estabas dentro de un chat o la página se desvió, regresa
 *    a la última bandeja que vio;
 *  - o fuerza «Bandeja de Marketplace» / «Messenger» según Configuración.
 * No toca otras pestañas de Facebook. Si no hay ninguna pestaña de bandeja, abre una.
 * Si hay un texto a medio escribir en el chat, NO recarga (lo perderías); con
 * «/refrescar forzar» sí. Corre en la misma cola que las respuestas, nunca encima de una.
 */
const isInboxUrl = (u) => /^https:\/\/www\.facebook\.com\/(?:messages|marketplace\/inbox)(?:[/?#]|$)/.test(u || '');
const REFRESH_WAIT_LOAD_MS = 30 * 1000;
const REFRESH_WAIT_LIST_MS = 25 * 1000;
let refreshing = false;
let lastRefreshAt = 0;

function inboxTarget(mode, tab, home) {
  if (mode === 'marketplace') return MP_INBOX_URL;
  if (mode === 'messages') return INBOX_URL;
  let path = '';
  try { path = new URL(tab.url).pathname; } catch (e) { path = ''; }
  // ya está en una bandeja (sin un chat abierto): se recarga esa misma
  if (/^\/(?:marketplace\/inbox|messages)/.test(path) && !/\/t\/\d+/.test(path)) return String(tab.url).split('#')[0];
  return (home && home.url) || INBOX_URL;
}

// Texto a medio escribir en la caja del chat (un borrador tuyo): recargar lo perdería.
async function tabDraft(tabId) {
  try {
    const res = await withTimeout(chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: () => {
        const boxes = Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"], div[contenteditable="true"][aria-label]'))
          .filter((b) => !/buscar|search/i.test(b.getAttribute('aria-label') || ''));
        for (const b of boxes) {
          const t = (b.innerText || '').replace(/[​\s]+/g, ' ').trim();
          if (t) return t.slice(0, 40);
        }
        return '';
      }
    }), 8000);
    return (res && res[0] && res[0].result) || '';
  } catch (e) {
    return ''; // pestaña dormida o sin acceso: no hay borrador que proteger
  }
}

// Espera a que la página recargada muestre la lista de chats. Cada lectura buena
// pasa por processScan (así lo que llegó mientras recargaba se avisa, y lo viejo no).
async function waitForList(tabId, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const scan = await collectFromTab(tabId);
      if (scan && scan.threads && scan.threads.length) {
        enqueue(scan);
        return scan;
      }
    } catch (e) { /* sigue cargando */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
}

async function refreshInbox(s, force) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: FB_URLS }); } catch (e) { tabs = []; }
  const inbox = tabs.filter((t) => isInboxUrl(t.url));
  const mem = await chrome.storage.local.get('mn_home');
  const mode = s.refreshTo === 'marketplace' || s.refreshTo === 'messages' ? s.refreshTo : 'auto';
  let tab = null;
  let created = false;

  if (!inbox.length) {
    const url = inboxTarget(mode, { url: '' }, mem.mn_home);
    try {
      tab = await chrome.tabs.create({ url: url, active: false, pinned: true });
    } catch (e) {
      // Chrome sigue abierto pero sin ninguna ventana: se abre una (sin quitarte el foco).
      try {
        const w = await chrome.windows.create({ url: url, focused: false });
        tab = w && w.tabs && w.tabs[0];
      } catch (e2) {
        return { ok: false, detail: 'no había ninguna pestaña de tus chats y no pude abrir una (' + shortText(e2 && e2.message ? e2.message : e2, 60) + ').' };
      }
      if (!tab) return { ok: false, detail: 'no había ninguna pestaña de tus chats y no pude abrir una.' };
    }
    created = true;
  } else {
    // La que ya muestra la bandeja que prefieres (si hay dos abiertas).
    const want = mode === 'marketplace' ? /\/marketplace\/inbox/ : (mode === 'messages' ? /\/messages/ : null);
    tab = (want && inbox.find((t) => want.test(t.url))) || inbox[0];
    if (!force) {
      const draft = await tabDraft(tab.id);
      if (draft) {
        return { ok: false, stage: 'borrador', detail: 'hay un texto escrito a medias en el chat de Facebook («' + shortText(draft, 30) + '…»). No recargo para que no lo pierdas: envíalo o bórralo y vuelve a pulsar 🔄, o escribe «/refrescar forzar» si no importa.' };
      }
    }
    const target = inboxTarget(mode, tab, mem.mn_home);
    const loaded = waitTabComplete(tab.id, REFRESH_WAIT_LOAD_MS);
    try {
      if (String(tab.url).split('#')[0] === target) await chrome.tabs.reload(tab.id);
      else await chrome.tabs.update(tab.id, { url: target });
    } catch (e) {
      return { ok: false, detail: 'Chrome no me dejó recargar la pestaña (' + shortText(e && e.message ? e.message : e, 60) + ').' };
    }
    await loaded;
  }
  if (created) await waitTabComplete(tab.id, REFRESH_WAIT_LOAD_MS);

  let scan = await waitForList(tab.id, REFRESH_WAIT_LIST_MS);
  let cur = null;
  try { cur = await chrome.tabs.get(tab.id); } catch (e) { cur = null; }
  let path = '';
  try { path = new URL(cur && cur.url).pathname; } catch (e) { path = ''; }
  // Facebook mandó la pestaña a otro sitio (inicio de sesión, verificación, el feed…): una vez más a la bandeja.
  if (!scan && cur && !/^\/(?:messages|marketplace\/inbox)/.test(path) && !/login|checkpoint|recover/i.test(path)) {
    const loaded2 = waitTabComplete(tab.id, REFRESH_WAIT_LOAD_MS);
    try { await chrome.tabs.update(tab.id, { url: inboxTarget(mode, { url: '' }, mem.mn_home) }); } catch (e) { /* se informa abajo */ }
    await loaded2;
    scan = await waitForList(tab.id, REFRESH_WAIT_LIST_MS);
    try { cur = await chrome.tabs.get(tab.id); path = new URL(cur.url).pathname; } catch (e) { /* nada */ }
  }
  if (!scan) {
    const why = /login|checkpoint|recover/i.test(path)
      ? 'Facebook está pidiendo iniciar sesión o verificar tu cuenta (página «' + shortText(path, 40) + '»). Entra en el PC y resuélvelo.'
      : 'recargué la página pero no veo la lista de chats (estoy en «' + shortText(path || '?', 40) + '»). Puede que Facebook siga cargando; revisa el PC.';
    return { ok: false, detail: why };
  }
  const marketplace = scan.threads.filter((t) => t.isMarketplace).length;
  return {
    ok: true, created: created, path: path, kind: scan.kind,
    threads: scan.threads.length, marketplace: marketplace,
    unread: scan.threads.filter((t) => t.unread && !t.mine).length
  };
}

async function handleRefreshRequest(msg, s, who0, force) {
  if (refreshing) { await tgSay(s, '⏳ Ya estoy refrescando Facebook; espera a que termine.', msg.message_id); return; }
  const since = Date.now() - lastRefreshAt;
  if (since < 15 * 1000) { await tgSay(s, '⏳ Acabo de refrescar hace ' + Math.max(1, Math.round(since / 1000)) + ' s. Espera un momento.', msg.message_id); return; }
  refreshing = true;
  try {
    await logEvent('reply', who0 + 'pide refrescar Facebook' + (force ? ' (forzado)' : '') + '.');
    const r = await queueReply(async (wasBusy) => {
      if (wasBusy) await tgSay(s, '⏳ Refresco Facebook en cuanto termine lo que estoy haciendo…', msg.message_id);
      return refreshInbox(s, force);
    });
    if (r.stage !== 'borrador') lastRefreshAt = Date.now(); // negarse por un borrador no cuenta como refresco
    if (r.ok) {
      const donde = r.kind === 'marketplace' ? 'Bandeja de Marketplace (facebook.com/marketplace/inbox)' : 'Messenger (facebook.com/messages)';
      await tgSay(s, who0 + '✅ Facebook actualizado · ' + fmtClock(Date.now()) + '\n' +
        '📍 ' + donde + '\n' +
        '💬 ' + r.threads + ' chats · ' + r.marketplace + ' de Marketplace · ' + r.unread + ' sin leer' +
        (r.created ? '\n(No había ninguna pestaña de tus chats: abrí una nueva y la fijé.)' : '') +
        (r.marketplace === 0 ? '\n⚠️ Veo chats pero ninguno de Marketplace: revisa en el PC que Facebook esté en la carpeta/bandeja de Marketplace.' : ''), msg.message_id);
      await logEvent('reply', 'Facebook refrescado: ' + (r.kind === 'marketplace' ? 'bandeja de Marketplace' : 'Messenger') + ', ' + r.threads + ' chats (' + r.marketplace + ' de Marketplace, ' + r.unread + ' sin leer).');
    } else {
      await tgSay(s, who0 + (r.stage === 'borrador' ? '⚠️ No recargué: ' : '❌ No pude refrescar Facebook: ') + r.detail, msg.message_id);
      await logEvent('reply', 'NO se pudo refrescar Facebook: ' + shortText(r.detail, 110));
    }
  } finally {
    refreshing = false;
  }
}

/* ---- /hilo: la conversación entera de ese chat ---- */
async function handleHiloRequest(msg, s, who0) {
  const res = await resolveTarget(msg);
  if (res.error) { await tgSay(s, '⚠️ ' + res.error, msg.message_id); return; }
  const t = res.target;
  const d = await chrome.storage.local.get('mn_thread');
  const e = (d.mn_thread || {})[t.tid];
  const head = '🧵 Hilo con «' + shortText(t.name, 60) + '»';
  if (!e || !e.items || !e.items.length) {
    await tgSay(s, head + '\n\nTodavía no he visto mensajes de este chat. El hilo se arma con lo que la extensión ve desde que vigila (mensajes del comprador, lo que escribes en Facebook y lo que mandas desde aquí).', msg.message_id);
    return;
  }
  const now = Date.now();
  const first = (firstWord(t.name) || 'comprador');
  const label = { c: '👤 ' + (String(t.name).split(/\s[·•]\s/)[0].trim().split(' ')[0] || first), y: '🧑 Tú (Facebook)', t: '📲 Tú (Telegram)' };
  const lines = e.items.map((it) => fmtWhen(it.at, now) + ' — ' + (label[it.w] || '•') + ': ' + it.t);
  let keep = [];
  let size = head.length + 120;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size + lines[i].length + 2 > 3300 && keep.length) break;
    keep.unshift(lines[i]);
    size += lines[i].length + 2;
  }
  const more = lines.length - keep.length;
  await tgSay(s, head + (more ? '\n(' + more + ' mensajes más antiguos no caben aquí)' : '') + '\n\n' + keep.join('\n\n') +
    '\n\n— Solo lo que la extensión llegó a ver; si mandaste varios mensajes seguidos en menos de unos segundos, la lista de Facebook solo muestra el último.', msg.message_id);
  await logEvent('reply', who0 + 'pide el hilo del chat de «' + shortText(t.name, 30) + '» (' + e.items.length + ' mensajes).');
}

async function handleTelegramMessage(msg, s) {
  const chatId = String(msg.chat && msg.chat.id);
  const fromId = String(msg.from && msg.from.id);
  const mine = String(s.tg_chatid).trim();
  const isGroup = !!(msg.chat && (msg.chat.type === 'group' || msg.chat.type === 'supergroup'));
  // El chat configurado tiene que ser ESE (no otro). Si es tu chat privado, además
  // tiene que ser TU cuenta la que escribe. Si en cambio pusiste ahí el ID de un
  // GRUPO, se confía en que solo metiste gente de confianza: cualquiera que esté
  // en ese grupo puede contestar (no hace falta que sea tu propia cuenta).
  if (chatId !== mine || (!isGroup && fromId !== mine)) {
    const now = Date.now();
    if (now - lastStrangerLog > 10 * 60 * 1000) {
      lastStrangerLog = now;
      await logEvent('reply', 'Ignoré un mensaje de otro chat de Telegram (no es el que configuraste).');
    }
    return;
  }
  const who0 = isGroup ? senderName(msg) + ': ' : '';
  if (await alreadyHandled(chatId, msg.message_id)) {
    await logEvent('reply', 'Ignoré un mensaje de Telegram que ya había atendido (' + who0 + 'id ' + msg.message_id + '): no se repite.');
    return;
  }
  // Una foto normal, o una imagen mandada "como archivo" (documento con tipo image/*).
  const photos = Array.isArray(msg.photo) && msg.photo.length ? msg.photo
    : (msg.document && /^image\/(?:jpeg|png|gif|webp)$/i.test(String(msg.document.mime_type || '')) ? [msg.document] : null);
  const text = String((photos ? msg.caption : msg.text) || '').trim();
  if (!text && !photos) { await tgSay(s, 'Solo puedo enviar texto o una foto. Escribe tu respuesta, o adjunta una imagen (puedes ponerle texto como pie).', msg.message_id); return; }
  if (!photos) {
    if (/^\/(?:start|ayuda|help)\b/i.test(text) || KB_RE.test(text)) {
      // La ayuda (y /teclado) vuelve a poner el botón 🔄 abajo.
      const r = await tgSay(s, REPLY_HELP, msg.message_id, { reply_markup: KEYBOARD });
      if (r.json && r.json.ok) await chrome.storage.local.set({ mn_kb: KB_VERSION });
      return;
    }
    if (text.startsWith('/') && !SCREEN_RE.test(text) && !REFRESH_RE.test(text) && !HILO_RE.test(text)) { await tgSay(s, 'No conozco ese comando.\n\n' + REPLY_HELP, msg.message_id); return; }
  }
  if (Date.now() / 1000 - (msg.date || 0) > REPLY_MAX_AGE_S) {
    await logEvent('reply', 'Ignoré un mensaje de Telegram (' + who0 + 'más de 30 minutos de antigüedad).');
    return;
  }
  if (text.length > REPLY_MAX_LEN) { await tgSay(s, 'Ese ' + (photos ? 'pie de foto' : 'mensaje') + ' es muy largo (máximo ' + REPLY_MAX_LEN + ' caracteres).', msg.message_id); return; }

  if (!photos) {
    const rm = REFRESH_RE.exec(text);
    if (rm) { await handleRefreshRequest(msg, s, who0, !!rm[1]); return; }
    if (HILO_RE.test(text)) { await handleHiloRequest(msg, s, who0); return; }
    if (SCREEN_RE.test(text)) { await handleScreenRequest(msg, s, who0); return; }
  }
  const res = await resolveTarget(msg);
  if (res.error) { await tgSay(s, '⚠️ ' + res.error, msg.message_id); return; }
  const sig = replySig(text, photos);
  const dupMs = await recentDuplicate(res.target.tid, sig);
  if (dupMs) {
    await tgSay(s, who0 + '⚠️ Ya le mandé ' + (photos ? 'esa misma foto' : 'ese mismo texto') + ' a «' + shortText(res.target.name, 40) + '» hace ' + Math.max(1, Math.round(dupMs / 1000)) + ' s; no lo repito para no duplicarlo. Si de verdad quieres mandarlo otra vez, espera unos segundos o cámbialo un poco.', msg.message_id);
    await logEvent('reply', who0 + 'repetido a «' + shortText(res.target.name, 30) + '» en menos de ' + (DUP_WINDOW_MS / 1000) + ' s: no se manda otra vez.');
    return;
  }
  const rate = await replyAllowed();
  if (!rate.ok) { await tgSay(s, '⏳ ' + rate.why, msg.message_id); return; }

  let image = null;
  if (photos) {
    // La más grande es la última del arreglo (Telegram las manda de menor a mayor).
    const dl = await downloadTelegramPhoto(s, photos[photos.length - 1].file_id);
    if (dl.error) { await tgSay(s, '❌ ' + dl.error, msg.message_id); return; }
    image = dl;
  }

  const target = res.target;
  await markActive(target.tid);
  const who = '«' + shortText(target.name, 40) + '»';
  // En un grupo, quién contestó queda en el registro y en la confirmación (para
  // que el equipo sepa quién le respondió a cuál comprador).
  await logEvent('reply', who0 + (photos ? 'manda una foto' : 'responde') + ' al chat de ' + who + (text ? ': "' + shortText(text, 50) + '"' : '') + '.');
  // Mientras se escribe y después, la lista de Facebook mostrará «Tú: …»: eso no se copia
  // a Telegram como si lo hubieras escrito en Facebook (ya lo tienes aquí).
  await noteTgSent(target.tid, text, !!photos);
  const r = await queueReply(async (wasBusy) => {
    if (wasBusy) {
      await tgSay(s, '⏳ En cola para ' + who + ': contesto en cuanto termine la respuesta anterior…', msg.message_id);
      await logEvent('reply', (photos ? 'Foto' : 'Respuesta') + ' a ' + who + ' puesta en cola (había otra en curso).');
    }
    return deliverReply(target, text, s, image);
  });
  const took = typeof r.tookMs === 'number' ? ' (' + (r.tookMs / 1000).toFixed(1) + ' s' + (r.etapas ? ': ' + r.etapas : '') + ')' : '';
  // Enviado, o sin saber si llegó: durante unos segundos no se acepta repetir lo mismo.
  if ((r.ok && r.sent) || r.stage === 'incierto') {
    await noteSent(target.tid, sig);
    await noteTgSent(target.tid, text, !!photos);
  }
  if (r.ok && r.sent) {
    const unverified = r.fotoSinVerificar ? ' (la foto no se pudo confirmar del todo; si ves que no llegó, vuelve a mandarla)' : '';
    await appendThread([{ tid: target.tid, name: target.name, w: 't', t: (photos ? '📷 ' : '') + (text || 'foto'), at: Date.now() }]);
    await tgSayAbout(s, target, who0 + '✅ ' + (photos ? 'Foto enviada' : 'Enviado') + ' a ' + who + (text ? ': «' + shortText(text, 120) + '»' : '') + unverified, msg.message_id);
    await logEvent('reply', (photos ? 'Foto enviada' : 'Respuesta enviada') + ' al chat de ' + who + took + (r.fotoSinVerificar ? ' [foto sin verificar]' : '') + '.');
  } else if (r.ok) {
    await tgSay(s, who0 + '✍️ Lo dejé listo en el chat de ' + who + ' pero NO lo envié (tienes apagado "enviar automáticamente"). Pulsa Enter en el PC.', msg.message_id);
    await logEvent('reply', (photos ? 'Foto dejada' : 'Respuesta escrita') + ' (sin enviar) en el chat de ' + who + took + '.');
  } else if (r.stage === 'incierto') {
    // No se sabe si Facebook llegó a mandarlo: NO se reintenta solo (duplicaría
    // si en realidad sí se envió). Se te avisa para que lo revises a mano.
    await tgSay(s, who0 + '⚠️ No estoy seguro de si le llegó a ' + who + ': ' + r.detail, msg.message_id);
    await logEvent('reply', 'Resultado incierto con ' + who + took + ': ' + shortText(r.detail, 100));
  } else {
    await tgSay(s, who0 + '❌ No pude ' + (photos ? 'mandar la foto a' : 'contestar a') + ' ' + who + ': ' + r.detail, msg.message_id);
    await logEvent('reply', 'NO se pudo ' + (photos ? 'mandar la foto a' : 'contestar a') + ' ' + who + ' (' + (r.stage || '?') + ')' + took + ': ' + shortText(r.detail, 100));
  }
  await startReplyWindow(); // la conversación sigue: se sigue escuchando 10 min más
}

function waitTabComplete(tabId, ms) {
  return new Promise((resolve) => {
    let done = false;
    let tm = null;
    const on = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    function finish() {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(on);
      clearTimeout(tm);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(on);
    tm = setTimeout(finish, ms);
  });
}

async function runReply(tabId, tid, text, send, image, humanMs) {
  // Una foto implica más pasos (pegarla, esperar su vista previa, confirmar el
  // envío) y, si la pestaña de Facebook está en segundo plano o la ventana
  // minimizada, Chrome frena sus temporizadores y todo tarda más de lo normal:
  // se le da más margen antes de darla por perdida.
  // (Y el tiempo "humano" de escritura, que puede llegar a 20 s, se suma.)
  const replyTimeoutMs = (image ? 100 * 1000 : 60 * 1000) + (humanMs || 0);
  // 1) Cargar el script en la pestaña. Si esto falla, todavía no se tocó nada.
  try {
    await withTimeout(chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['replier.js'] }), SCRIPT_TIMEOUT_MS);
  } catch (e) {
    return { ok: false, stage: 'script', detail: 'no pude hablar con la pestaña de Facebook (' + shortText(e && e.message ? e.message : e, 60) + ').' };
  }
  // 2) Ejecutar la respuesta.
  try {
    const res = await withTimeout(chrome.scripting.executeScript({
      target: { tabId: tabId },
      args: [{ tid: tid, text: text, send: send, image: image || null, humanMs: humanMs || 0 }],
      func: (o) => globalThis.mnReply(o)
    }), replyTimeoutMs);
    return (res && res[0] && res[0].result) || { ok: false, stage: 'script', detail: 'la pestaña de Facebook no respondió.' };
  } catch (e) {
    if (/timeout/i.test(String(e && e.message))) {
      // Un timeout NO prueba que Facebook no recibió el mensaje: la pestaña pudo
      // seguir trabajando y enviarlo después de que nos rindiéramos. Se reporta
      // como "incierto" (no como fallo) para que no se reenvíe a ciegas.
      return {
        ok: false, stage: 'incierto',
        detail: 'se agotó el tiempo esperando a Facebook, y puede que el mensaje sí haya salido. Revisa ese chat antes de volver a mandarlo. (Si la ventana de Chrome estaba minimizada o esa pestaña en segundo plano, tarda más.)'
      };
    }
    return { ok: false, stage: 'script', detail: 'no pude hablar con la pestaña de Facebook (' + shortText(e && e.message ? e.message : e, 60) + ').' };
  }
}

// Una pestaña en segundo plano (o la ventana minimizada) hace que Chrome frene
// sus temporizadores: escribir y enviar se vuelve mucho más lento, y con dos o
// tres chats alternando esa lentitud se nota todavía más. Mientras se contesta,
// se trae esa pestaña al frente un instante (nada más mientras dura el envío) y
// al terminar se deja todo exactamente como estaba (misma pestaña activa, misma
// ventana minimizada si lo estaba).
async function wakeTab(tab) {
  const st = { minimizedWindowId: null, prevActiveTabId: null };
  try {
    const win = await chrome.windows.get(tab.windowId);
    if (win.state === 'minimized') {
      st.minimizedWindowId = tab.windowId;
      await chrome.windows.update(tab.windowId, { state: 'normal' });
    }
    if (!tab.active) {
      const [prevActive] = await chrome.tabs.query({ windowId: tab.windowId, active: true });
      if (prevActive && prevActive.id !== tab.id) st.prevActiveTabId = prevActive.id;
      await chrome.tabs.update(tab.id, { active: true });
    }
  } catch (e) { /* si no se puede, se sigue igual (más lento, pero no se rompe nada) */ }
  return st;
}
async function restoreTab(st) {
  try {
    if (st.prevActiveTabId) await chrome.tabs.update(st.prevActiveTabId, { active: true });
    if (st.minimizedWindowId) await chrome.windows.update(st.minimizedWindowId, { state: 'minimized' });
  } catch (e) { /* no pasa nada si la ventana ya se cerró, etc. */ }
}

async function deliverReply(target, text, s, image) {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: FB_URLS }); } catch (e) { tabs = []; }
  tabs = tabs.filter((t) => !t.discarded);
  if (!tabs.length) {
    return { ok: false, stage: 'pestaña', detail: 'no hay ninguna pestaña de Facebook abierta. Abre facebook.com/messages y vuelve a mandarlo.' };
  }
  // Mejor una pestaña que ya esté en Messenger.
  tabs.sort((a, b) => (/\/messages\b/.test(b.url || '') ? 1 : 0) - (/\/messages\b/.test(a.url || '') ? 1 : 0));
  const tab = tabs[0];
  const send = s.replySend !== false;
  // El tiempo de esta respuesta se sortea una vez (si es solo una foto, no hay texto que teclear).
  const humanMs = text ? pickTypeMs() : 0;
  const wake = await wakeTab(tab);
  // Mientras dura la respuesta (hasta ~20 s sin llamadas a Chrome) se le da un
  // toque al service worker para que Chrome no lo apague a medias.
  const ping = setInterval(() => { try { chrome.runtime.getPlatformInfo().catch(() => {}); } catch (e) { /* nada */ } }, 10000);
  try {
    let r = await runReply(tab.id, target.tid, text, send, image, humanMs);
    if (!r.ok && r.stage === 'abrir') {
      // El chat no está en la lista de esa página: se abre por su dirección y se reintenta una vez.
      const loaded = waitTabComplete(tab.id, 25000);
      try { await chrome.tabs.update(tab.id, { url: 'https://www.facebook.com/messages/t/' + target.tid + '/' }); } catch (e) { /* ya se verá abajo */ }
      await loaded;
      await new Promise((res) => setTimeout(res, 2500));
      r = await runReply(tab.id, target.tid, text, send, image, humanMs);
    }
    return r;
  } finally {
    clearInterval(ping);
    await restoreTab(wake);
  }
}

async function notifyPC(id, title, message) {
  try {
    await chrome.notifications.create(id, {
      type: 'basic',
      iconUrl: 'icon128.png',
      title: String(title).slice(0, 120),
      message: String(message || ' ').slice(0, 300),
      priority: 2
    });
  } catch (e) {
    console.error(TAG, 'no se pudo mostrar la notificación del PC', e);
  }
}

// fetch con tiempo límite y 1 reintento si falla la red o el servidor (5xx).
async function fetchText(url, opts) {
  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 5000));
    try {
      const res = await fetch(url, Object.assign({ signal: AbortSignal.timeout(20000) }, opts || {}));
      const body = await res.text();
      if (res.status >= 500) { lastErr = 'HTTP ' + res.status; continue; }
      return { status: res.status, body: body };
    } catch (e) {
      lastErr = String(e && e.message ? e.message : e);
    }
  }
  return { status: 0, body: '', error: lastErr };
}

function stripHtml(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

async function sendWhatsApp(text, s) {
  const phone = String(s.phone || '').replace(/\D/g, '');
  const apikey = String(s.apikey || '').trim();
  if (!phone || !apikey) {
    await notifyPC('mn-config', 'Notificador Marketplace',
      'Falta tu número de WhatsApp y la clave (APIKEY) de CallMeBot. Abre la Configuración de la extensión.');
    return { ok: false, reason: 'missing-config', message: 'Falta configurar WhatsApp.' };
  }
  const url = new URL('https://api.callmebot.com/whatsapp.php');
  url.searchParams.set('phone', '+' + phone);
  url.searchParams.set('text', text);
  url.searchParams.set('apikey', apikey);

  const r = await fetchText(url.toString());
  if (r.error) return { ok: false, reason: 'network', message: 'Sin conexión con CallMeBot: ' + r.error };
  // CallMeBot responde "Message queued" cuando lo acepta (la v0.4 buscaba
  // "message sent" y daba por fallido cada envío correcto).
  const ok = r.status === 200 && /message (queued|sent)/i.test(r.body);
  return { ok: ok, reason: ok ? '' : 'api', message: ok ? '' : 'CallMeBot respondió: ' + stripHtml(r.body || 'HTTP ' + r.status) };
}

async function sendTelegram(text, s, opts) {
  opts = opts || {};
  const token = String(s.tg_token || '').trim();
  const chatId = String(s.tg_chatid || '').trim();
  if (!/^\d+:[\w-]+$/.test(token) || !/^-?\d+$/.test(chatId)) {
    await notifyPC('mn-config', 'Notificador Marketplace',
      'Falta (o está mal escrito) el token de tu bot o tu ID de Telegram. Abre la Configuración de la extensión.');
    return { ok: false, reason: 'missing-config', message: 'Falta configurar Telegram (token o ID).' };
  }
  // Telegram no usa el *negrita* de WhatsApp: texto plano, sin formato.
  const payload = { chat_id: chatId, text: text.replace(/\*/g, ''), disable_web_page_preview: true };
  if (opts.replyTo) { payload.reply_to_message_id = opts.replyTo; payload.allow_sending_without_reply = true; }
  if (opts.silent) payload.disable_notification = true;
  const kb = await keyboardFor(s);
  if (kb) payload.reply_markup = kb;
  const r = await fetchText('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (r.error) return { ok: false, reason: 'network', message: 'Sin conexión con Telegram: ' + r.error };
  let json = null;
  try { json = JSON.parse(r.body); } catch (e) { /* respuesta no JSON */ }
  if (json && json.ok === true) {
    if (kb) await chrome.storage.local.set({ mn_kb: KB_VERSION });
    return { ok: true, message: '', messageId: json.result && json.result.message_id };
  }
  let hint = '';
  if (r.status === 401 || r.status === 404) hint = ' (revisa el token del bot)';
  else if (r.status === 400 || r.status === 403) hint = ' (revisa tu ID y que le hayas escrito "hola" a tu bot)';
  return { ok: false, reason: 'api', message: 'Telegram respondió: ' + ((json && json.description) || 'HTTP ' + r.status) + hint };
}

// Manda el aviso por el canal elegido en la configuración
async function sendNotification(text, s, opts) {
  s = s || await getSettings();
  return s.channel === 'telegram' ? sendTelegram(text, s, opts) : sendWhatsApp(text, s);
}

async function handleTest() {
  const s = await getSettings();
  const where = s.channel === 'telegram' ? 'tu Telegram' : 'tu WhatsApp';
  await refreshAccountFromTabs().catch(() => {});
  const acct = await accountName(s);
  const r = await sendNotification(
    '✅ *Prueba del Notificador Marketplace*\n' +
    (accountLine(acct) || '📘 Cuenta de Facebook: (sin detectar)\n') +
    '\nSi lees esto, los avisos a tu teléfono ya funcionan.', s
  );
  if (r.ok) {
    await setStatus({ lastError: '' });
    return {
      ok: true,
      message: 'Prueba enviada a ' + where + '. Revisa tu teléfono (puede tardar unos segundos). ' +
        (acct
          ? 'Cuenta de Facebook en los avisos: ' + acct + '.'
          : '⚠️ No pude detectar el nombre de tu cuenta de Facebook: abre facebook.com/messages o escríbelo en "Nombre de tu cuenta".')
    };
  }
  await setStatus({ lastError: r.message });
  return { ok: false, message: r.message };
}

// Al despertar el service worker (arranque de Chrome, alarma, mensaje de la pestaña) se
// vuelve a escuchar a Telegram enseguida, sin esperar a la próxima alarma de 30 s.
replyTick().catch((e) => console.error(TAG, e));
