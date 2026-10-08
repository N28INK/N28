/* Notificador Marketplace v0.8 — service worker (background.js)
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
  phone: '', apikey: '', tg_token: '', tg_chatid: '', accountName: ''
};
const ALARM = 'mn-keepalive';
const ALARM_MIN = 0.5;                       // revisar cada 30 s (mínimo que permite Chrome)
const SCRIPT_TIMEOUT_MS = 10 * 1000;
const TITLE_RESCAN_MS = 6 * 1000;
const TOP_ROWS = 3;                          // filas de arriba de la lista = chats con actividad reciente
const FB_URLS = ['https://www.facebook.com/*', 'https://www.messenger.com/*'];
const INBOX_URL = 'https://www.facebook.com/messages/';
const COOLDOWN_MS = 2 * 60 * 1000;          // máx. 1 aviso por chat cada 2 min
const FORGET_MS = 30 * 24 * 60 * 60 * 1000; // olvidar chats sin actividad en 30 días
const MAX_SEEN = 500;
const NO_LIST_WARN_MIN = 10;                 // avisar si 10 min sin ver la lista de chats
const NO_LIST_REPEAT_MS = 4 * 60 * 60 * 1000;

/* ------------------------- despertador ------------------------- */
// Se asegura de que la alarma exista sin reiniciarla cada vez que el
// service worker despierta (la v0.4 la recreaba en cada arranque).
async function ensureAlarm() {
  const a = await chrome.alarms.get(ALARM);
  if (!a || a.periodInMinutes !== ALARM_MIN) await chrome.alarms.create(ALARM, { periodInMinutes: ALARM_MIN });
}
ensureAlarm();

chrome.runtime.onInstalled.addListener((details) => {
  ensureAlarm();
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(ensureAlarm);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === ALARM) {
    keepaliveScan().catch((e) => console.error(TAG, e));
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
  await noteListPresence(found.some(Boolean));
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
  }
  return false;
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
    func: () => (globalThis.mnCollectVersion === 8 ? globalThis.mnCollect() : null)
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
  const flash = FLASH_RE.exec(title);
  const m = /^\((\d+)\)/.exec(title);
  const count = m ? parseInt(m[1], 10) : 0;
  // El título parpadeante no trae el "(N)": no tocar el contador con él.
  if (!flash) await chrome.storage.session.set({ [key]: { count: count } });
  if (!flash && (!known || count <= prevCount)) return;
  if (titleBusy.has(tab.id)) return; // el parpadeo cambia el título cada segundo
  titleBusy.add(tab.id);
  try {
    const s = await getSettings();
    if (!s.enabled) return;
    const since = Date.now();
    await scanTab(tab);
    await new Promise((r) => setTimeout(r, TITLE_RESCAN_MS));
    await scanTab(tab);
    await queue;
    const st = (await chrome.storage.local.get('mn_status')).mn_status || {};
    if ((st.lastAlertAt || 0) >= since - COOLDOWN_MS) return; // ya se avisó por la lista
    if (s.marketplaceOnly) return; // sin la lista no se sabe si es de Marketplace
    const name = flash ? title.slice(0, flash.index).replace(/^\(\d+\)\s*/, '').trim() : '';
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
    '\nResponder: ' + INBOX_URL;
  if (s.pcNotify) await notifyPC('mn-open-inbox-' + Date.now(), 'Nuevo mensaje en Facebook', name ? 'De: ' + name : 'Tienes mensajes sin leer.');
  const r = await sendNotification(text, s);
  if (r.ok) await setStatus({ lastAlertAt: Date.now(), lastAlertName: name || 'Facebook', lastError: '' });
  else await setStatus({ lastError: r.message });
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
      'No veo tu lista de chats abierta. Haz clic aquí para abrir facebook.com/messages y déjala abierta.'
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
          return {
            visible: document.visibilityState, enlacesT: links.length, muestra: sample,
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
    func: () => (globalThis.mnCollectVersion === 8 ? globalThis.mnAccountInfo(true) : undefined)
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

  const data = await chrome.storage.local.get('mn_seen');
  const seen = data.mn_seen || {};
  const now = Date.now();
  const toAlert = [];

  for (const th of threads) {
    if (!th || !th.tid) continue;
    const prev = seen[th.tid] || {};
    // "handled" = último texto del que ya avisamos (o que decidimos no avisar).
    const cur = {
      text: th.text, at: now, alertAt: prev.alertAt || 0,
      handled: prev.handled || '', pending: !!prev.pending
    };
    seen[th.tid] = cur;
    const changed = prev.text !== cur.text; // incluye chat nunca visto
    if (changed) cur.pending = true;

    if (th.mine) { cur.handled = ''; cur.pending = false; continue; } // respondiste tú
    if (cur.text === cur.handled) { cur.pending = false; continue; }
    // ¿Es un mensaje nuevo del cliente? Sirve cualquiera de las dos señales:
    //  - Facebook lo marca "sin leer" (punto azul / negrita), o
    //  - el texto cambió y el chat está arriba de la lista (los mensajes nuevos
    //    suben el chat). La v0.6 dependía solo de la marca "sin leer", que
    //    cambia con el diseño de Facebook, y por eso podía no avisar nunca.
    const top = typeof th.pos === 'number' && th.pos < TOP_ROWS;
    if (!th.unread && !(cur.pending && top)) { cur.pending = false; continue; }
    if (scan.warmup ||                            // lista recién abierta: no avisar de chats viejos
        th.tid === scan.openTid ||                // lo estás mirando ahora mismo
        (s.marketplaceOnly && !th.isMarketplace)) {
      cur.handled = cur.text;
      cur.pending = false;
      continue;
    }
    // Varios mensajes seguidos del mismo chat: un aviso, y el resto queda
    // pendiente hasta que pase el tiempo de espera.
    if (now - cur.alertAt < COOLDOWN_MS) continue;
    cur.alertAt = now;
    cur.handled = cur.text;
    cur.pending = false;
    toAlert.push(th);
  }

  // Limpieza para que el almacenamiento no crezca sin fin (la v0.4 nunca borraba).
  const ids = Object.keys(seen).filter((id) => now - (seen[id].at || 0) < FORGET_MS);
  ids.sort((a, b) => (seen[b].at || 0) - (seen[a].at || 0));
  const pruned = {};
  for (const id of ids.slice(0, MAX_SEEN)) pruned[id] = seen[id];

  const unreadCount = threads.filter((t) => t.unread && !t.mine).length;
  const mpCount = threads.filter((t) => t.isMarketplace).length;
  await chrome.storage.local.set({ mn_seen: pruned });
  await setStatus({ lastScanAt: now, threads: threads.length, unread: unreadCount, marketplace: mpCount });

  for (const th of toAlert) await alertNewMessage(th, s);
}

async function setStatus(patch) {
  const d = await chrome.storage.local.get('mn_status');
  await chrome.storage.local.set({ mn_status: Object.assign({}, d.mn_status || {}, patch) });
}

async function alertNewMessage(th, s) {
  const where = th.isMarketplace ? 'Marketplace' : 'Messenger';
  const link = INBOX_URL + 't/' + th.tid + '/';
  const text =
    '🔔 *Nuevo mensaje en ' + where + '*\n' +
    accountLine(await accountName(s)) + '\n' +
    'De: ' + th.name + '\n' +
    '"' + th.text + '"\n\n' +
    'Responder: ' + link;

  if (s.pcNotify) {
    await notifyPC('mn-thread-' + th.tid + '-' + Date.now(), 'Nuevo mensaje de ' + th.name, th.text);
  }
  const r = await sendNotification(text, s);
  if (r.ok) {
    await setStatus({ lastAlertAt: Date.now(), lastAlertName: th.name, lastError: '' });
  } else {
    await setStatus({ lastError: r.message });
    if (r.reason !== 'missing-config') {
      await notifyPC('mn-error-' + Date.now(), 'No se pudo avisar a tu teléfono', r.message);
    }
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
  if (json && json.ok === true) return { ok: true, message: '' };
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
