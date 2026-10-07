/* Notificador Marketplace v0.5 — service worker (background.js)
 * Recibe la lista de chats (del content script o de su propio despertador de
 * 1 minuto) y, cuando hay un mensaje nuevo sin leer, te avisa al teléfono por
 * WhatsApp (CallMeBot) o Telegram, y también con una notificación en el PC.
 */
'use strict';

const TAG = '[MN-bg]';
const DEFAULTS = {
  enabled: true, marketplaceOnly: false, pcNotify: true, channel: 'whatsapp',
  phone: '', apikey: '', tg_token: '', tg_chatid: ''
};
const ALARM = 'mn-keepalive';
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
  if (!a) await chrome.alarms.create(ALARM, { periodInMinutes: 1 });
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
  let listFound = false;
  for (const tab of tabs) {
    try {
      // Que Chrome no descargue la pestaña para ahorrar memoria.
      if (tab.autoDiscardable !== false) {
        await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
      }
      if (tab.discarded) {
        await chrome.tabs.reload(tab.id);
        continue;
      }
      const scan = await collectFromTab(tab.id);
      if (scan && scan.threads && scan.threads.length) {
        listFound = true;
        enqueue(scan);
      }
    } catch (e) {
      /* pestaña cargando o sin acceso: se intenta en el próximo minuto */
    }
  }
  await noteListPresence(listFound);
}

async function collectFromTab(tabId) {
  const call = () => chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: () => (typeof globalThis.mnCollect === 'function' ? globalThis.mnCollect() : null)
  });
  let res = await call();
  if (!res || !res[0] || res[0].result == null) {
    // Pestaña abierta antes de instalar/actualizar la extensión: inyectar el lector.
    await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['collector.js'] });
    res = await call();
  }
  return res && res[0] ? res[0].result : null;
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
  } else if (msg.type === 'MN_TEST') {
    handleTest().then(sendResponse, (e) => sendResponse({ ok: false, message: String(e) }));
    return true; // respuesta asíncrona
  }
});

chrome.notifications.onClicked.addListener((id) => {
  const m = /^mn-thread-(\d+)/.exec(id);
  if (m) chrome.tabs.create({ url: INBOX_URL + 't/' + m[1] + '/' });
  else if (id === 'mn-open-inbox') chrome.tabs.create({ url: INBOX_URL, pinned: true });
  chrome.notifications.clear(id);
});

async function getSettings() {
  const s = await chrome.storage.local.get('mn_settings');
  return Object.assign({}, DEFAULTS, s.mn_settings || {});
}

// Cola: el content script (cada 4 s, por pestaña) y el despertador llegan a la
// vez. Procesarlos uno detrás de otro evita avisos dobles y datos pisados.
let queue = Promise.resolve();
function enqueue(scan) {
  queue = queue.then(() => processScan(scan)).catch((e) => console.error(TAG, e));
  return queue;
}

// Núcleo: compara los chats con lo ya visto y avisa si hay algo nuevo.
async function processScan(scan) {
  const s = await getSettings();
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
    const cur = { text: th.text, at: now, alertAt: prev.alertAt || 0, handled: prev.handled || '' };
    seen[th.tid] = cur;

    if (th.mine) { cur.handled = ''; continue; } // respondiste tú: el próximo mensaje del cliente es nuevo
    if (!th.unread || cur.text === cur.handled) continue;
    if (scan.warmup ||                            // lista recién abierta: no avisar de chats viejos
        th.tid === scan.openTid ||                // lo estás mirando ahora mismo
        (s.marketplaceOnly && !th.isMarketplace)) {
      cur.handled = cur.text;
      continue;
    }
    // Varios mensajes seguidos del mismo chat: un aviso, y el resto queda
    // pendiente hasta que pase el tiempo de espera (si sigue sin leer).
    if (now - cur.alertAt < COOLDOWN_MS) continue;
    cur.alertAt = now;
    cur.handled = cur.text;
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
    '🔔 *Nuevo mensaje en ' + where + '*\n\n' +
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
  const r = await sendNotification(
    '✅ *Prueba del Notificador Marketplace*\n\nSi lees esto, los avisos a tu teléfono ya funcionan.', s
  );
  if (r.ok) {
    await setStatus({ lastError: '' });
    return { ok: true, message: 'Prueba enviada a ' + where + '. Revisa tu teléfono (puede tardar unos segundos).' };
  }
  await setStatus({ lastError: r.message });
  return { ok: false, message: r.message };
}
