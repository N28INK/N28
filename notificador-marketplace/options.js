/* Notificador Marketplace v0.7 — options.js */
'use strict';

const DEFAULTS = {
  enabled: true, marketplaceOnly: false, pcNotify: true, channel: 'whatsapp',
  phone: '', apikey: '', tg_token: '', tg_chatid: ''
};
const $ = (id) => document.getElementById(id);

function currentChannel() {
  const r = document.querySelector('input[name="channel"]:checked');
  return r ? r.value : 'whatsapp';
}

function toggleSections() {
  const tg = currentChannel() === 'telegram';
  $('secWhatsapp').hidden = tg;
  $('secTelegram').hidden = !tg;
}

function status(msg, ok) {
  $('status').textContent = msg;
  $('status').className = 'result ' + (ok ? 'ok' : 'bad');
}

async function load() {
  const s = await chrome.storage.local.get('mn_settings');
  const cfg = Object.assign({}, DEFAULTS, s.mn_settings || {});
  $('phone').value = cfg.phone;
  $('apikey').value = cfg.apikey;
  $('tg_token').value = cfg.tg_token;
  $('tg_chatid').value = cfg.tg_chatid;
  $('enabled').checked = cfg.enabled !== false;
  $('marketplaceOnly').checked = cfg.marketplaceOnly === true;
  $('pcNotify').checked = cfg.pcNotify !== false;
  const radio = document.querySelector('input[name="channel"][value="' + (cfg.channel === 'telegram' ? 'telegram' : 'whatsapp') + '"]');
  if (radio) radio.checked = true;
  toggleSections();
}

// Devuelve un texto de error, o '' si la configuración del canal elegido está bien.
function validate(cfg) {
  if (cfg.channel === 'telegram') {
    if (!/^\d+:[\w-]{20,}$/.test(cfg.tg_token)) return 'El token del bot no tiene el formato correcto (números, dos puntos y letras).';
    if (!/^-?\d+$/.test(cfg.tg_chatid)) return 'Tu ID de Telegram debe ser solo números.';
  } else {
    if (!/^\d{8,15}$/.test(cfg.phone)) return 'El número debe llevar código de país y solo números (8 a 15 dígitos), sin + ni espacios.';
    if (!/^\d{4,}$/.test(cfg.apikey)) return 'La APIKEY de CallMeBot debe ser solo números.';
  }
  return '';
}

async function save() {
  const cfg = {
    channel: currentChannel(),
    phone: $('phone').value.replace(/\D/g, ''),
    apikey: $('apikey').value.trim(),
    tg_token: $('tg_token').value.trim(),
    tg_chatid: $('tg_chatid').value.trim(),
    enabled: $('enabled').checked,
    marketplaceOnly: $('marketplaceOnly').checked,
    pcNotify: $('pcNotify').checked
  };
  $('phone').value = cfg.phone;
  const err = validate(cfg);
  if (err) {
    status('❌ ' + err, false);
    return false;
  }
  await chrome.storage.local.set({ mn_settings: cfg });
  status('✅ Guardado.', true);
  return true;
}

$('save').addEventListener('click', save);

$('test').addEventListener('click', async () => {
  // Primero guarda (y espera a que termine) para que la prueba use los datos nuevos.
  if (!(await save())) return;
  $('test').disabled = true;
  status('⏳ Enviando prueba…', true);
  try {
    const r = await chrome.runtime.sendMessage({ type: 'MN_TEST' });
    status((r && r.ok ? '✅ ' : '❌ ') + ((r && r.message) || 'Sin respuesta.'), !!(r && r.ok));
  } catch (e) {
    status('❌ No se pudo pedir la prueba: ' + e, false);
  }
  $('test').disabled = false;
});

$('openInbox').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.facebook.com/messages/', pinned: true });
});

$('runDiag').addEventListener('click', async () => {
  $('diagOut').value = '⏳ Leyendo tus pestañas de Facebook…';
  try {
    const r = await chrome.runtime.sendMessage({ type: 'MN_DIAG' });
    let hint = '';
    if (!r.pestanas || !r.pestanas.length) hint = '⚠️ No hay ninguna pestaña de Facebook abierta.\n\n';
    else if (!r.pestanas.some((t) => t.pagina && t.pagina.scan && t.pagina.scan.threads && t.pagina.scan.threads.length)) {
      hint = '⚠️ Hay pestañas de Facebook pero no veo la lista de chats. Abre facebook.com/messages.\n\n';
    }
    $('diagOut').value = hint + JSON.stringify(r, null, 2);
    $('copyDiag').disabled = false;
  } catch (e) {
    $('diagOut').value = 'Error: ' + e;
  }
});

$('copyDiag').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('diagOut').value);
  $('copyDiag').textContent = 'Copiado ✓';
  setTimeout(() => { $('copyDiag').textContent = 'Copiar'; }, 1500);
});

document.querySelectorAll('input[name="channel"]').forEach((r) => r.addEventListener('change', toggleSections));

load();
