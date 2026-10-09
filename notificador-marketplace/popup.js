/* Notificador Marketplace v0.19 — popup.js */
'use strict';

const INBOX_URL = 'https://www.facebook.com/messages/';

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'hace ' + s + ' s';
  if (s < 3600) return 'hace ' + Math.round(s / 60) + ' min';
  if (s < 86400) return 'hace ' + Math.round(s / 3600) + ' h';
  return 'hace ' + Math.round(s / 86400) + ' días';
}

function setBox(id, text, kind) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = 'box ' + (kind || '');
}

async function refresh() {
  const d = await chrome.storage.local.get(['mn_settings', 'mn_status', 'mn_account', 'mn_log']);
  const cfg = d.mn_settings || {};
  const st = d.mn_status || {};
  const channel = cfg.channel === 'telegram' ? 'Telegram' : 'WhatsApp';
  const configured = cfg.channel === 'telegram' ? (cfg.tg_token && cfg.tg_chatid) : (cfg.phone && cfg.apikey);

  if (!configured) setBox('config', '⚠️ Falta configurar. Abre Configuración y elige WhatsApp o Telegram.', 'warn');
  else if (cfg.enabled === false) setBox('config', '⏸️ Avisos APAGADOS (' + channel + ').', 'warn');
  else if (st.lastError) setBox('config', '❌ Último envío falló: ' + st.lastError, 'bad');
  else setBox('config', '✅ Avisos activos por ' + channel + (cfg.marketplaceOnly ? ' (solo chats de Marketplace)' : '') + '.', 'ok');

  document.getElementById('mponly').hidden = cfg.marketplaceOnly !== true;
  // Respuestas desde Telegram
  const rbox = document.getElementById('reply');
  const rtext = document.getElementById('replyText');
  const ron = document.getElementById('replyOn');
  rbox.hidden = cfg.channel !== 'telegram' || !configured;
  if (!rbox.hidden) {
    if (cfg.replyEnabled === true) {
      rbox.className = 'box ' + (st.replyError ? 'bad' : 'ok');
      rtext.textContent = st.replyError
        ? '↩️ Respuestas desde Telegram: ⚠️ ' + st.replyError
        : '↩️ Respuestas desde Telegram activadas (' + (cfg.replySend === false ? 'solo escribe en el chat' : 'se envían solas') + '). Responde a un aviso en Telegram para contestar.';
      ron.hidden = true;
    } else {
      rbox.className = 'box';
      rtext.textContent = '↩️ Puedes contestar los chats desde Telegram (texto que tú escribes).';
      ron.hidden = false;
    }
  }
  const manual = String(cfg.accountName || '').trim();
  const found = d.mn_account && d.mn_account.name;
  if (manual) setBox('acct', '📘 Cuenta de Facebook en los avisos: ' + manual + ' (escrita por ti)', 'ok');
  else if (found) setBox('acct', '📘 Cuenta de Facebook en los avisos: ' + found, 'ok');
  else setBox('acct', '⚠️ No detecto el nombre de tu cuenta de Facebook. Abre facebook.com/messages y recarga la pestaña, o escríbelo en Configuración.', 'warn');

  const KINDS = { messages: 'Messenger', marketplace: 'bandeja de Marketplace' };
  // ¿La última vez que se miró no había ninguna pestaña de Facebook (y es más reciente que la última lectura)?
  const noTabs = st.fbTabs === 0 && (st.fbTabsAt || 0) >= (st.lastScanAt || 0);
  if (noTabs) {
    setBox('watch', '⚠️ No hay ninguna pestaña de Facebook abierta. Pulsa "Abrir mis chats de Facebook".', 'warn');
  } else if (st.lastScanAt && Date.now() - st.lastScanAt < 3 * 60 * 1000) {
    setBox('watch', '👀 Vigilando ' + st.threads + ' chats' + (KINDS[st.kind] ? ' (' + KINDS[st.kind] + ')' : '') + ': ' +
      (st.unread || 0) + ' sin leer, ' + (st.marketplace || 0) + ' de Marketplace. Revisado ' + ago(st.lastScanAt) + '.', 'ok');
  } else {
    setBox('watch', '⚠️ No veo tu lista de chats. Abre facebook.com/messages o facebook.com/marketplace/inbox y deja esa pestaña abierta.', 'warn');
  }
  // Últimos eventos (sin las lecturas de rutina): qué se avisó y por qué no se avisó.
  const evs = (d.mn_log || []).filter((e) => e.k !== 'scan').slice(-3);
  const box = document.getElementById('events');
  box.textContent = '';
  evs.forEach((e) => {
    const row = document.createElement('div');
    row.className = 'ev ' + e.k;
    row.textContent = new Date(e.t).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }) + '  ' + e.m;
    box.appendChild(row);
  });
  document.getElementById('last').textContent = st.lastAlertAt
    ? 'Último aviso: ' + (st.lastAlertName || '') + ', ' + ago(st.lastAlertAt) + '.'
    : '';
}

document.getElementById('test').addEventListener('click', async () => {
  const btn = document.getElementById('test');
  const out = document.getElementById('result');
  btn.disabled = true;
  out.className = 'result';
  out.textContent = '⏳ Enviando prueba…';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'MN_TEST' });
    out.textContent = (r && r.ok ? '✅ ' : '❌ ') + ((r && r.message) || 'Sin respuesta.');
    out.className = 'result ' + (r && r.ok ? 'ok' : 'bad');
  } catch (e) {
    out.textContent = '❌ No se pudo pedir la prueba: ' + e;
    out.className = 'result bad';
  }
  btn.disabled = false;
  document.getElementById('openDiag').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('options.html#diag') });
  window.close();
});

refresh();
});

document.getElementById('replyOn').addEventListener('click', async () => {
  const d = await chrome.storage.local.get('mn_settings');
  const cfg = d.mn_settings || {};
  cfg.replyEnabled = true;
  await chrome.storage.local.set({ mn_settings: cfg });
  await chrome.storage.local.remove(['mn_tg_init', 'mn_reply_until']);
  refresh();
});

document.getElementById('mpoff').addEventListener('click', async () => {
  const d = await chrome.storage.local.get('mn_settings');
  const cfg = d.mn_settings || {};
  cfg.marketplaceOnly = false;
  await chrome.storage.local.set({ mn_settings: cfg });
  refresh();
});

document.getElementById('openInbox').addEventListener('click', async () => {
  // Reutiliza una pestaña de chats si ya hay una; si no, la abre fijada.
  const tabs = await chrome.tabs.query({ url: 'https://www.facebook.com/messages/*' });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: INBOX_URL, pinned: true });
  }
  window.close();
});

document.getElementById('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

document.getElementById('openDiag').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('options.html#diag') });
  window.close();
});

refresh();
