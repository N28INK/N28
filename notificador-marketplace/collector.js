/* Notificador Marketplace v0.5 — collector.js
 * Lee la lista de chats que se ve en la página (facebook.com/messages).
 * Lo cargan DOS caminos que comparten el mismo "mundo aislado" de la pestaña:
 *   - el content script (content_scripts en manifest.json), cada pocos segundos;
 *   - el background (chrome.scripting) cada minuto, por si Chrome durmió la pestaña.
 * Por eso todo el estado global se inicializa solo si no existe todavía.
 */
(() => {
  'use strict';
  if (typeof globalThis.mnCollect === 'function') return;

  // Líneas que no son parte del mensaje: hora relativa, "Activo ahora", marcas de no leído…
  const MONTH = '(?:ene|enero|feb|febrero|mar|marzo|abr|abril|may|mayo|jun|junio|jul|julio|ago|agosto|sep|sept|septiembre|oct|octubre|nov|noviembre|dic|diciembre|jan|january|february|march|apr|april|june|july|aug|august|september|october|november|dec|december)\\.?';
  const DAY = '(?:lun|lunes|mar|martes|mi[ée]|mi[ée]rcoles|jue|jueves|vie|viernes|s[áa]b|s[áa]bado|dom|domingo|mon|monday|tue|tuesday|wed|wednesday|thu|thursday|fri|friday|sat|saturday|sun|sunday)\\.?';
  const TIME_RE = new RegExp(
    '^(?:' + [
      '\\d+\\s*(?:s|seg|m|min|mins|h|hr|hrs|d|w|sem|mo|y|a)\\.?',
      '\\d+\\s*(?:segundos?|minutos?|horas?|d[ií]as?|semanas?|mes(?:es)?|a[ñn]os?|seconds?|minutes?|hours?|days?|weeks?|months?|years?)',
      'ahora|justo ahora|just now|now|ayer|yesterday',
      DAY,
      '\\d{1,2}\\s+(?:de\\s+)?' + MONTH + '(?:\\s+\\d{2,4})?',
      MONTH + '\\s+\\d{1,2}(?:,?\\s+\\d{2,4})?',
      '\\d{1,2}[:.]\\d{2}\\s*(?:a\\.?\\s?m\\.?|p\\.?\\s?m\\.?)?',
      '\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?'
    ].join('|') + ')$', 'i');
  const NOISE_RE = /^(?:·|•|activ[oa] ahora|active now|en l[ií]nea|online|mensaje no le[ií]do|mensajes no le[ií]dos|unread message|unread messages|no le[ií]do|sin leer|unread)$/i;
  const UNREAD_TEXT_RE = /\bunread\b|no le[ií]d[oa]s?|sin leer/i;
  const UNREAD_LINE_RE = /^(?:mensajes? no le[ií]dos?|unread messages?|no le[ií]d[oa]|sin leer|unread)$/i;
  const MINE_RE = /^(?:t[úu]|you|usted)\s*:/i;
  const BLUE_RE = /0,\s*132,\s*255|24,\s*119,\s*242|8,\s*102,\s*255|59,\s*89,\s*152|0,\s*100,\s*209/;

  if (typeof globalThis.mnLastCount !== 'number') globalThis.mnLastCount = 0;

  function threadId(href) {
    const m = String(href || '').match(/\/t\/(\d+)/);
    return m ? m[1] : null;
  }

  function cleanSnippet(lines) {
    const parts = [];
    for (let line of lines) {
      // "Hola, ¿sigue disponible? · 5 min" → "Hola, ¿sigue disponible?"
      line = line.replace(/\s*[·•]\s*([^·•]*)$/, (whole, tail) => (TIME_RE.test(tail.trim()) ? '' : whole)).trim();
      if (!line || TIME_RE.test(line) || NOISE_RE.test(line)) continue;
      parts.push(line);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  function looksUnread(link, name, lines) {
    const label = link.getAttribute('aria-label') || '';
    if (UNREAD_TEXT_RE.test(label) || lines.some((l) => UNREAD_LINE_RE.test(l))) return true;
    // Puntito azul de "no leído"
    for (const el of link.querySelectorAll('[aria-hidden="true"], span:empty, div:empty')) {
      const cs = getComputedStyle(el);
      const w = parseFloat(cs.width) || 0;
      const h = parseFloat(cs.height) || 0;
      if (w <= 0 || w > 14 || h <= 0 || h > 14) continue;
      const br = (cs.borderRadius || '').replace(/\s/g, '');
      const round = br === '50%' || (parseFloat(br) || 0) >= Math.min(w, h) / 2;
      if (round && BLUE_RE.test(cs.backgroundColor || '')) return true;
    }
    // Texto del mensaje en negrita. Se ignora el nombre: en algunos diseños va
    // siempre en negrita y daba falsos "no leído" (fallo de la v0.4).
    for (const sp of link.querySelectorAll('span')) {
      if (sp.children.length) continue;
      const t = (sp.textContent || '').trim();
      if (!t || t === name || TIME_RE.test(t) || NOISE_RE.test(t)) continue;
      if ((parseInt(getComputedStyle(sp).fontWeight, 10) || 400) >= 600) return true;
    }
    return false;
  }

  globalThis.mnCollect = function mnCollect() {
    const byId = new Map();
    const pageIsMarketplace = /\/marketplace\b/i.test(location.pathname);
    for (const link of document.querySelectorAll('a[href*="/t/"]')) {
      const href = link.getAttribute('href') || '';
      const tid = threadId(href);
      if (!tid || byId.has(tid)) continue;
      const fullText = (link.innerText || '').trim();
      const lines = fullText.split('\n').map((s) => s.trim()).filter(Boolean);
      if (lines.length < 2) continue; // sin nombre + mensaje no es una fila de la lista
      const name = lines[0].slice(0, 80);
      const text = cleanSnippet(lines.slice(1));
      if (!text) continue;
      byId.set(tid, {
        tid: tid,
        name: name,
        text: text,
        mine: MINE_RE.test(text),
        // Las filas de Marketplace se ven como "Nombre · Artículo"
        isMarketplace: pageIsMarketplace || /marketplace/i.test(href) || /marketplace/i.test(fullText) || /\s[·•]\s/.test(name),
        unread: looksUnread(link, lines[0], lines)
      });
    }
    const threads = Array.from(byId.values());
    const focused = document.visibilityState === 'visible' && document.hasFocus();
    // Primera vez que aparece la lista en esta página: solo memorizar, no avisar
    // de golpe de todos los chats viejos sin leer.
    const warmup = globalThis.mnLastCount === 0;
    globalThis.mnLastCount = threads.length;
    return {
      threads: threads,
      warmup: warmup,
      openTid: focused ? threadId(location.pathname) : null
    };
  };
})();
