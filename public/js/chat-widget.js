// City Cars Houston TX — widget del asistente de chat (inventario).
// Se carga después de vehicles.js, i18n.js y app.js. No depende de ellos
// directamente (cada script vive en su propio ámbito), solo reusa las
// variables globales VEHICLES/I18N/LANG que ya existen en la página.
(function () {
  "use strict";

  if (typeof I18N === "undefined") return;
  var LANG = document.documentElement.lang === "en" ? "en" : "es";
  var T = I18N[LANG].chat;
  if (!T) return;

  var WHATSAPP = ["1", "281", "602", "7044"].join("");
  function waLink(text) {
    var u = new URL("https://wa.me/" + WHATSAPP);
    u.searchParams.set("text", String(text).slice(0, 1500));
    return u.toString();
  }

  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) { if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]); }
    if (text != null) n.textContent = text;
    return n;
  }

  var MAX_LEN = 800;
  var history = []; // { role: "user"|"assistant", content: string }
  var sending = false;

  // ---------- Estructura del widget ----------
  var launch = el("button", {
    type: "button", "class": "chat-launch", "aria-haspopup": "dialog",
    "aria-expanded": "false", "aria-controls": "chat-panel", "aria-label": T.launch
  }, T.launch);

  var panel = el("div", {
    "class": "chat-panel", id: "chat-panel", role: "dialog", "aria-modal": "false",
    "aria-labelledby": "chat-title", hidden: ""
  });

  var header = el("div", { "class": "chat-header" });
  header.appendChild(el("h2", { id: "chat-title" }, T.title));
  var closeBtn = el("button", { type: "button", "class": "chat-close", "aria-label": T.close }, "✕");
  header.appendChild(closeBtn);
  panel.appendChild(header);

  panel.appendChild(el("p", { "class": "chat-disclaimer" }, T.disclaimer));

  var log = el("div", { "class": "chat-log", role: "log", "aria-live": "polite" });
  panel.appendChild(log);

  var form = el("form", { "class": "chat-form" });
  var textarea = el("textarea", {
    "class": "chat-input", rows: "1", maxlength: String(MAX_LEN),
    placeholder: T.placeholder, "aria-label": T.placeholder
  });
  var sendBtn = el("button", { type: "submit", "class": "btn btn-sign chat-send" }, T.send);
  form.appendChild(textarea);
  form.appendChild(sendBtn);
  panel.appendChild(form);

  var waFooter = el("a", {
    "class": "chat-wa", target: "_blank", rel: "noopener noreferrer"
  }, T.toWhatsapp);
  panel.appendChild(waFooter);

  document.body.appendChild(launch);
  document.body.appendChild(panel);

  // ---------- Render ----------
  function bubble(role, text) {
    var b = el("div", { "class": "chat-msg " + (role === "user" ? "chat-msg-user" : "chat-msg-bot") });
    b.appendChild(el("p", null, text));
    log.appendChild(b);
    log.scrollTop = log.scrollHeight;
  }
  function note(text) {
    var n = el("div", { "class": "chat-note" }, text);
    log.appendChild(n);
    log.scrollTop = log.scrollHeight;
  }

  bubble("assistant", T.greeting);
  waFooter.href = waLink(I18N[LANG].waGeneral);

  // ---------- Abrir / cerrar ----------
  var lastFocus = null;
  function open() {
    lastFocus = document.activeElement;
    panel.hidden = false;
    launch.setAttribute("aria-expanded", "true");
    document.body.classList.add("chat-open");
    textarea.focus();
  }
  function close() {
    panel.hidden = true;
    launch.setAttribute("aria-expanded", "false");
    document.body.classList.remove("chat-open");
    if (lastFocus) lastFocus.focus();
  }
  launch.addEventListener("click", function () { panel.hidden ? open() : close(); });
  closeBtn.addEventListener("click", close);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !panel.hidden) close();
  });

  textarea.addEventListener("input", function () {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + "px";
  });
  textarea.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });

  // ---------- Envío ----------
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    if (sending) return;
    var text = textarea.value.trim().slice(0, MAX_LEN);
    if (!text) return;

    history.push({ role: "user", content: text });
    bubble("user", text);
    textarea.value = "";
    textarea.style.height = "auto";

    sending = true;
    sendBtn.disabled = true;
    sendBtn.textContent = T.sending;

    fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: history, lang: LANG })
    })
      .then(function (r) { if (!r.ok) throw new Error("bad_status"); return r.json(); })
      .then(function (data) {
        var reply = data && typeof data.text === "string" ? data.text.trim() : "";
        if (!reply) throw new Error("empty_reply");
        history.push({ role: "assistant", content: reply });
        bubble("assistant", reply);
      })
      .catch(function () {
        note(T.error);
      })
      .finally(function () {
        sending = false;
        sendBtn.disabled = false;
        sendBtn.textContent = T.send;
        textarea.focus();
      });
  });
})();
