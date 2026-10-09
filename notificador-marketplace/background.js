/* Notificador Marketplace v0.18 — service worker (background.js)
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
  replyEnabled: false, replySend: true
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
const COLLECTOR_VERSION = 11;                // versión de collector.js que espera este background
const MP_INBOX_URL = 'https://www.facebook.com/marketplace/inbox/';
const LOG_MAX = 200;                         // eventos que guarda el registro
const LOG_COLLAPSE_MS = 10 * 60 * 1000;      // una misma línea repetida se cuenta (×N) en vez de inundar el registro
const TITLE_BLINK_DEBOUNCE_MS = 20 * 1000;   // el título "parpadea" (va y vuelve) más rápido que esto: se ignora el repiqueteo
const FORGET_MS = 30 * 24 * 60 * 60 * 1000; // olvidar chats sin actividad en 30 días
const MAX_SEEN = 500;
const NO_LIST_WARN_MIN = 10;                 // avisar si 10 min sin ver la lista de chats
const NO_LIST_REPEAT_MS = 4 * 60 * 60 * 1000;

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
    if (st.lastGenericKey === gkey && Date.now() - (st.lastGenericAt || 0) < 90 * 1000) {
      await logEvent('title', 'Ya mandé el aviso general de este mismo cambio de título; no lo repito.');
      return;
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
            scan: typeof globalThis.mnCollect === 'function' ? globalThis.mnCollect() : 'sin lector'
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

// Núcleo: compara los chats con lo ya visto y avisa si hay algo nuevo.
async function processScan(scan) {
  const s = await getSettings();
  if (scan.account) await rememberAccount(scan.account, scan.accountSource);
  const threads = Array.isArray(scan.threads) ? scan.threads : [];
  if (!s.enabled || !threads.length) return;

  const data = await chrome.storage.local.get(['mn_seen', 'mn_active']);
  const seen = data.mn_seen || {};
  const activeMap = data.mn_active || {};
  const now = Date.now();
  const toAlert = [];
  let deliberateSkip = false; // la lista vio el mensaje y decidió no avisar (lo estás viendo, filtro Marketplace…)

  if (scan.warmup) {
    await logEvent('scan', 'Primera lectura de ' + kindName(scan.kind) + ': ' + threads.length +
      ' chats memorizados sin avisar (' + threads.filter((t) => t.unread && !t.mine).length + ' sin leer).');
  }

  for (const th of threads) {
    if (!th || !th.tid) continue;
    const known = !!seen[th.tid];
    const prev = seen[th.tid] || {};
    // "handled" = último texto del que ya avisamos (o que decidimos no avisar).
    const cur = {
      text: th.text, age: typeof th.age === 'number' ? th.age : null, at: now,
      alertAt: prev.alertAt || 0, handled: prev.handled || '', pending: !!prev.pending
    };
    seen[th.tid] = cur;
    const changed = prev.text !== cur.text; // incluye chat nunca visto
    // Mismo texto, pero la hora del chat volvió a "ahora": llegó OTRO mensaje igual
    // (por ejemplo dos "Hola" seguidos o dos "Envió una foto").
    const again = known && !changed && cur.age !== null && typeof prev.age === 'number' && cur.age < prev.age;
    if (changed || again) cur.pending = true;
    if (again) cur.handled = '';
    const fresh = changed || again;
    const who = '"' + shortText(th.name, 30) + '"';
    const skip = (why) => (fresh ? logEvent('skip', 'No aviso de ' + who + ': ' + why) : null);
    // Un chat al que le contestaste hace poco desde Telegram: estás en plena
    // conversación, así que cada respuesta del cliente se avisa completa y casi
    // sin espera, aunque tengas esa pestaña abierta o enfocada en el PC.
    const isActive = !!(activeMap[th.tid] && activeMap[th.tid] > now);

    if (th.mine) { cur.handled = ''; cur.pending = false; continue; } // respondiste tú
    if (cur.text === cur.handled) { cur.pending = false; continue; }
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
    if (scan.warmup) {                            // lista recién abierta: no avisar de chats viejos
      cur.handled = cur.text;
      cur.pending = false;
      continue;
    }
    if (th.tid === scan.openTid && !isActive) {   // lo estás mirando ahora mismo (salvo conversación activa)
      await skip('tienes ese chat abierto en pantalla.');
      deliberateSkip = true;
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
    // Varios mensajes seguidos del mismo chat: un aviso, y el resto queda
    // pendiente hasta que pase el tiempo de espera. En una conversación activa
    // (le acabas de contestar desde Telegram) la espera es mucho más corta,
    // para que cada respuesta del cliente llegue casi al instante.
    const cooldown = isActive ? ACTIVE_COOLDOWN_MS : COOLDOWN_MS;
    if (now - cur.alertAt < cooldown) {
      await skip('ya se avisó de este chat hace muy poco; se avisará del último mensaje enseguida.');
      continue;
    }
    cur.alertAt = now;
    cur.handled = cur.text;
    cur.pending = false;
    toAlert.push({ th: th, isActive: isActive });
  }

  // Limpieza para que el almacenamiento no crezca sin fin (la v0.4 nunca borraba).
  const ids = Object.keys(seen).filter((id) => now - (seen[id].at || 0) < FORGET_MS);
  ids.sort((a, b) => (seen[b].at || 0) - (seen[a].at || 0));
  const pruned = {};
  for (const id of ids.slice(0, MAX_SEEN)) pruned[id] = seen[id];

  const unreadCount = threads.filter((t) => t.unread && !t.mine).length;
  const mpCount = threads.filter((t) => t.isMarketplace).length;
  await chrome.storage.local.set({ mn_seen: pruned });
  await setStatus({
    lastScanAt: now, threads: threads.length, unread: unreadCount, marketplace: mpCount,
    kind: scan.kind || '', source: scan.source || ''
  });
  if (deliberateSkip) await setStatus({ lastSkipAt: now });

  for (const item of toAlert) await alertNewMessage(item.th, s, item.isActive);
}

async function setStatus(patch) {
  const d = await chrome.storage.local.get('mn_status');
  await chrome.storage.local.set({ mn_status: Object.assign({}, d.mn_status || {}, patch) });
}

async function alertNewMessage(th, s, isActive) {
  const where = th.isMarketplace ? 'Marketplace' : 'Messenger';
  const link = th.link || (INBOX_URL + 't/' + th.tid + '/');
  const text =
    (isActive ? '💬 *Respuesta de ' + th.name + '*\n' : '🔔 *Nuevo mensaje en ' + where + '*\n') +
    accountLine(await accountName(s)) + '\n' +
    (isActive ? '' : 'De: ' + th.name + '\n') +
    '"' + th.text + '"';
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
    notifyPC(id + Date.now(), 'Nuevo mensaje de ' + th.name, th.text);
  }
  const via = s.channel === 'telegram' ? 'Telegram' : 'WhatsApp';
  const r = await sendNotification(full, s);
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

/* ------------------- respuestas desde Telegram -------------------
 * Tú escribes A MANO en Telegram (con "Responder" sobre el aviso del chat) y la
 * extensión escribe ese texto en ese chat de Messenger y lo envía.
 *  - Nada se manda solo: no hay botones ni respuestas automáticas.
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
const MAX_TARGETS = 60;
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

async function downloadTelegramPhoto(s, fileId) {
  const url = await tgFileUrl(s, fileId);
  if (!url) return { error: 'Telegram no me dio la foto (el archivo puede haber expirado; vuelve a mandarla).' };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { error: 'Telegram respondió HTTP ' + res.status + ' al pedir la foto.' };
    const buf = await res.arrayBuffer();
    if (buf.byteLength > REPLY_MAX_IMAGE_BYTES) return { error: 'Esa foto es demasiado grande.' };
    const mime = res.headers.get('content-type') || 'image/jpeg';
    return { dataUrl: 'data:' + mime + ';base64,' + bytesToBase64(new Uint8Array(buf)), mime: mime };
  } catch (e) {
    return { error: 'No pude descargar la foto de Telegram: ' + shortText(e && e.message ? e.message : e, 80) };
  }
}

// Mensaje del bot para ti (confirmaciones y avisos de error). No es un aviso de chat.
function tgSay(s, text, replyTo) {
  return tgApi(s, 'sendMessage', {
    chat_id: String(s.tg_chatid).trim(),
    text: String(text).slice(0, 3500),
    reply_to_message_id: replyTo || undefined,
    allow_sending_without_reply: true,
    disable_web_page_preview: true
  }, 15000);
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

// Cada 30 s (alarma): si hay una ventana abierta se sigue escuchando; si no, una lectura rápida.
async function replyTick() {
  const s = await getSettings();
  if (!replyActive(s)) return;
  const d = await chrome.storage.local.get('mn_reply_until');
  if ((d.mn_reply_until || 0) > Date.now()) {
    replyUntil = d.mn_reply_until;
    if (!pollLoopOn) pollLoop().catch((e) => console.error(TAG, e));
  } else {
    await pollTelegram(0);
  }
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
  'La extensión lo escribe (o pega la foto) en ese chat de Facebook y te confirma.';

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
  const photos = Array.isArray(msg.photo) && msg.photo.length ? msg.photo : null;
  const text = String((photos ? msg.caption : msg.text) || '').trim();
  if (!text && !photos) { await tgSay(s, 'Solo puedo enviar texto o una foto. Escribe tu respuesta, o adjunta una imagen (puedes ponerle texto como pie).', msg.message_id); return; }
  if (!photos) {
    if (/^\/(?:start|ayuda|help)\b/i.test(text)) { await tgSay(s, REPLY_HELP, msg.message_id); return; }
    if (text.startsWith('/')) { await tgSay(s, 'No conozco ese comando.\n\n' + REPLY_HELP, msg.message_id); return; }
  }
  if (Date.now() / 1000 - (msg.date || 0) > REPLY_MAX_AGE_S) {
    await logEvent('reply', 'Ignoré un mensaje de Telegram (' + who0 + 'más de 30 minutos de antigüedad).');
    return;
  }
  if (text.length > REPLY_MAX_LEN) { await tgSay(s, 'Ese ' + (photos ? 'pie de foto' : 'mensaje') + ' es muy largo (máximo ' + REPLY_MAX_LEN + ' caracteres).', msg.message_id); return; }

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
  const r = await queueReply(async (wasBusy) => {
    if (wasBusy) {
      await tgSay(s, '⏳ En cola para ' + who + ': contesto en cuanto termine la respuesta anterior…', msg.message_id);
      await logEvent('reply', (photos ? 'Foto' : 'Respuesta') + ' a ' + who + ' puesta en cola (había otra en curso).');
    }
    return deliverReply(target, text, s, image);
  });
  const took = typeof r.tookMs === 'number' ? ' (' + (r.tookMs / 1000).toFixed(1) + ' s' + (r.etapas ? ': ' + r.etapas : '') + ')' : '';
  // Enviado, o sin saber si llegó: durante unos segundos no se acepta repetir lo mismo.
  if ((r.ok && r.sent) || r.stage === 'incierto') await noteSent(target.tid, sig);
  if (r.ok && r.sent) {
    const unverified = r.fotoSinVerificar ? ' (la foto no se pudo confirmar del todo; si ves que no llegó, vuelve a mandarla)' : '';
    await tgSay(s, who0 + '✅ ' + (photos ? 'Foto enviada' : 'Enviado') + ' a ' + who + (text ? ': «' + shortText(text, 120) + '»' : '') + unverified, msg.message_id);
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

async function runReply(tabId, tid, text, send, image) {
  // Una foto implica más pasos (pegarla, esperar su vista previa, confirmar el
  // envío) y, si la pestaña de Facebook está en segundo plano o la ventana
  // minimizada, Chrome frena sus temporizadores y todo tarda más de lo normal:
  // se le da más margen antes de darla por perdida.
  const replyTimeoutMs = image ? 100 * 1000 : 60 * 1000;
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
      args: [{ tid: tid, text: text, send: send, image: image || null }],
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
  const wake = await wakeTab(tab);
  try {
    let r = await runReply(tab.id, target.tid, text, send, image);
    if (!r.ok && r.stage === 'abrir') {
      // El chat no está en la lista de esa página: se abre por su dirección y se reintenta una vez.
      const loaded = waitTabComplete(tab.id, 25000);
      try { await chrome.tabs.update(tab.id, { url: 'https://www.facebook.com/messages/t/' + target.tid + '/' }); } catch (e) { /* ya se verá abajo */ }
      await loaded;
      await new Promise((res) => setTimeout(res, 2500));
      r = await runReply(tab.id, target.tid, text, send, image);
    }
    return r;
  } finally {
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

async function sendTelegram(text, s) {
  const token = String(s.tg_token || '').trim();
  const chatId = String(s.tg_chatid || '').trim();
  if (!/^\d+:[\w-]+$/.test(token) || !/^-?\d+$/.test(chatId)) {
    await notifyPC('mn-config', 'Notificador Marketplace',
      'Falta (o está mal escrito) el token de tu bot o tu ID de Telegram. Abre la Configuración de la extensión.');
    return { ok: false, reason: 'missing-config', message: 'Falta configurar Telegram (token o ID).' };
  }
  const r = await fetchText('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Telegram no usa el *negrita* de WhatsApp: texto plano, sin formato.
    body: JSON.stringify({ chat_id: chatId, text: text.replace(/\*/g, ''), disable_web_page_preview: true })
  });
  if (r.error) return { ok: false, reason: 'network', message: 'Sin conexión con Telegram: ' + r.error };
  let json = null;
  try { json = JSON.parse(r.body); } catch (e) { /* respuesta no JSON */ }
  if (json && json.ok === true) return { ok: true, message: '', messageId: json.result && json.result.message_id };
  let hint = '';
  if (r.status === 401 || r.status === 404) hint = ' (revisa el token del bot)';
  else if (r.status === 400 || r.status === 403) hint = ' (revisa tu ID y que le hayas escrito "hola" a tu bot)';
  return { ok: false, reason: 'api', message: 'Telegram respondió: ' + ((json && json.description) || 'HTTP ' + r.status) + hint };
}

// Manda el aviso por el canal elegido en la configuración
async function sendNotification(text, s) {
  s = s || await getSettings();
  return s.channel === 'telegram' ? sendTelegram(text, s) : sendWhatsApp(text, s);
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
