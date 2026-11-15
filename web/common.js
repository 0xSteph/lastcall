/* common.js — shared helpers for the Last Call web app (window.LC). Load after config.js. */
(function () {
  "use strict";

  var cfg = window.LASTCALL_CONFIG || {};
  var apiBase = String(cfg.apiBase || "").replace(/\/+$/, "") || location.origin;

  // ---------- URL params: #fragment (secrets) and ?query (presentation) ----------
  function params() {
    var out = {};
    var add = function (s) {
      new URLSearchParams(s).forEach(function (v, k) { out[k] = v; });
    };
    add(location.search.slice(1));
    add(location.hash.slice(1));
    return out;
  }
  var P = params();

  // theme override (?theme=dark|light) and embed mode (used by demo.html phone frames)
  var root = document.documentElement;
  if (P.theme === "dark" || P.theme === "light") root.setAttribute("data-theme", P.theme);
  var embedded = P.embed === "1";
  if (embedded) root.classList.add("embed");

  // ---------- storage (never throws) ----------
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { if (v == null || v === "") localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
    json: function (k, dflt) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? dflt : v; } catch (e) { return dflt; } }
  };

  // ---------- server clock (the API returns "now"; countdowns use it to correct skew) ----------
  var skew = 0;
  function serverNow() { return Date.now() + skew; }
  function noteServerTime(nowIso, t0, t1) {
    var s = Date.parse(nowIso);
    if (!s) return;
    skew = s - (t0 + t1) / 2;
  }

  // ---------- API ----------
  function ApiError(status, code, message) {
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.message = message;
  }
  ApiError.prototype = Object.create(Error.prototype);

  function api(path, opts) {
    opts = opts || {};
    var headers = {};
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    var t0 = Date.now();
    return fetch(apiBase + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      cache: "no-store"
    }).then(function (res) {
      return res.text().then(function (text) {
        var t1 = Date.now();
        var json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
        if (!res.ok) {
          var err = (json && json.error) || {};
          throw new ApiError(res.status, err.code || "http_" + res.status, err.message || "Request failed (" + res.status + ").");
        }
        var nowIso = json && (json.now || (json.plan && json.plan.now));
        if (nowIso) noteServerTime(nowIso, t0, t1);
        return json;
      });
    }, function () {
      throw new ApiError(0, "network", "Could not reach Last Call. Check your connection; we'll keep trying.");
    });
  }

  // ---------- formatting ----------
  var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function initial(name) { return esc(String(name || "?").trim().charAt(0).toUpperCase() || "?"); }

  function fmtTime(iso, withSeconds) {
    var t = typeof iso === "number" ? iso : Date.parse(iso);
    if (!t) return "";
    var o = { hour: "numeric", minute: "2-digit" };
    if (withSeconds) o.second = "2-digit";
    return new Date(t).toLocaleTimeString(undefined, o);
  }
  // "6:30 PM", "tomorrow 6:30 PM" or "Sat, Nov 21, 6:30 PM"
  function fmtWhen(iso, nowMs) {
    var t = typeof iso === "number" ? iso : Date.parse(iso);
    if (!t) return "";
    var d = new Date(t), n = new Date(nowMs || serverNow());
    var day = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var diff = Math.round((day(d) - day(n)) / 86400000);
    if (diff === 0) return fmtTime(t);
    if (diff === 1) return "tomorrow " + fmtTime(t);
    if (diff === -1) return "yesterday " + fmtTime(t);
    return d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }
  function relTime(iso, nowMs) {
    var t = Date.parse(iso);
    if (!t) return "";
    var diff = Math.round(((nowMs || serverNow()) - t) / 1000);
    var future = diff < 0;
    var s = Math.abs(diff);
    var out;
    if (s < 10) return future ? "in a few seconds" : "just now";
    if (s < 60) out = s + " s";
    else if (s < 3600) out = Math.floor(s / 60) + " min";
    else if (s < 86400) out = Math.floor(s / 3600) + " h";
    else out = Math.floor(s / 86400) + " d";
    return future ? "in " + out : out + " ago";
  }
  // countdown text: "1:15", "2:05:09" style becomes "2h 05m" above an hour
  function clock(ms) {
    if (!(ms > 0)) ms = 0;
    var s = Math.ceil(ms / 1000);
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d > 0) return d + "d " + h + "h";
    if (h > 0) return h + "h " + String(m).padStart(2, "0") + "m";
    return m + ":" + String(sec).padStart(2, "0");
  }
  // "12 min", "1 h 5 min", "45 s"
  function span(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + " s";
    var m = Math.floor(s / 60);
    if (m < 60) return m + " min";
    var h = Math.floor(m / 60), r = m % 60;
    if (h < 48) return h + " h" + (r ? " " + r + " min" : "");
    return Math.round(h / 24) + " days";
  }
  function minutesLabel(n) {
    n = Number(n) || 0;
    if (n === 0) return "none";
    if (n < 60) return n + " min";
    return n % 60 === 0 ? n / 60 + " h" : Math.floor(n / 60) + " h " + (n % 60) + " min";
  }
  function isHttpUrl(u) { return /^https?:\/\//i.test(String(u || "")); }
  function listNames(names) {
    names = names.filter(Boolean);
    if (names.length <= 1) return names.join("");
    return names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
  }
  function telHref(phone) { return "tel:" + String(phone || "").replace(/[^0-9+]/g, ""); }

  // ---------- maps (OpenStreetMap only) ----------
  function osmEmbed(lat, lng) {
    var d = 0.012;
    var bbox = [lng - d * 1.4, lat - d, lng + d * 1.4, lat + d].map(function (n) { return n.toFixed(5); }).join(",");
    return "https://www.openstreetmap.org/export/embed.html?bbox=" + bbox + "&layer=mapnik&marker=" + lat + "," + lng;
  }
  function osmLink(lat, lng) {
    return "https://www.openstreetmap.org/?mlat=" + lat + "&mlon=" + lng + "#map=15/" + lat + "/" + lng;
  }

  // ---------- plan status ----------
  var STATUS = {
    active: { label: "Active", tone: "brand" },
    overdue: { label: "Overdue", tone: "warn" },
    alerting: { label: "Alerting contacts", tone: "no" },
    sos: { label: "Help requested", tone: "no" },
    acknowledged: { label: "Someone's on it", tone: "brand" },
    unanswered: { label: "No answer yet", tone: "no" },
    safe: { label: "Safe", tone: "ok" },
    closed: { label: "Closed", tone: "muted" }
  };
  function statusInfo(s) { return STATUS[s] || { label: String(s || "Unknown"), tone: "muted" }; }
  function statusPill(s) { var i = statusInfo(s); return '<span class="pill pill-' + i.tone + '">' + esc(i.label) + "</span>"; }
  function isTerminal(s) { return s === "safe" || s === "closed"; }
  function isAlarm(s) { return s === "alerting" || s === "sos" || s === "unanswered"; }

  function contactChip(c) {
    if (c.allClearSent) return '<span class="pill pill-ok">All clear sent</span>';
    if (c.state === "acknowledged") return '<span class="pill pill-brand">On it</span>';
    if (c.state === "alerted") return '<span class="pill pill-no">Alerted</span>';
    return '<span class="pill pill-muted">Standby</span>';
  }
  function personClass(c) {
    if (c.state === "acknowledged") return "is-acknowledged" + (c.allClearSent ? " is-clear" : "");
    if (c.allClearSent) return "is-clear";
    if (c.state === "alerted") return "is-alerted";
    return "";
  }
  function peopleHtml(plan, opts) {
    opts = opts || {};
    return '<ol class="people">' + (plan.contacts || []).map(function (c, i) {
      var sub = [c.relationship || null, i === 0 ? "first to be alerted" : "#" + (i + 1) + " in line"];
      if (c.state === "alerted" && c.alertedAt) sub = ["alerted " + fmtTime(c.alertedAt)];
      if (c.state === "acknowledged" && c.acknowledgedAt) sub = ["on it since " + fmtTime(c.acknowledgedAt)];
      return '<li class="person ' + personClass(c) + '"><span class="avatar" aria-hidden="true">' + initial(c.name) + "</span>" +
        '<span class="who"><b>' + esc(c.name) + (opts.youIndex === i ? " (you)" : "") + "</b><small>" + esc(sub.filter(Boolean).join(" · ")) + "</small>" +
        (c.note ? '<span class="note">“' + esc(c.note) + "”</span>" : "") + "</span>" +
        contactChip(c) + "</li>";
    }).join("") + "</ol>";
  }

  // ---------- icons (inline SVG, stroke = currentColor) ----------
  function svg(paths, extra) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + (extra || "") + ">" + paths + "</svg>";
  }
  var icons = {
    check: svg('<path d="M20 6 9 17l-5-5"/>'),
    checkBold: svg('<path d="M20 6 9 17l-5-5"/>', ' stroke-width="3"'),
    x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
    clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    bell: svg('<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
    bellRing: svg('<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0M2 8c0-2.2.7-4.3 2-6M22 8a10 10 0 0 0-2-6"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    alert: svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>'),
    siren: svg('<path d="M7 18v-6a5 5 0 0 1 10 0v6"/><path d="M5 21a1 1 0 0 1-1-1v-1a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1a1 1 0 0 1-1 1zM21 12h1M18.5 4.5 18 5M2 12h1M12 2v1M4.9 4.9l.7.7M12 12v6"/>'),
    copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    share: svg('<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M16 6l-4-4-4 4M12 2v13"/>'),
    external: svg('<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
    pin: svg('<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>'),
    route: svg('<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>'),
    phone: svg('<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2Z"/>'),
    user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
    users: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>'),
    hand: svg('<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>'),
    shield: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>'),
    shieldCheck: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>'),
    moon: svg('<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>'),
    info: svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'),
    lock: svg('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
    link: svg('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'),
    refresh: svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
    play: svg('<path d="m6 3 14 9-14 9V3z"/>'),
    trash: svg('<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
    dot: svg('<circle cx="12" cy="12" r="3" fill="currentColor"/>'),
    flag: svg('<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/>')
  };
  var brandMark =
    '<svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#3346D3"/>' +
    '<path d="M9.6 14.2a9 9 0 0 1 12.8 0M6.4 10.6a13.6 13.6 0 0 1 19.2 0" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/>' +
    '<circle cx="16" cy="20.5" r="3.6" fill="#FFB020"/></svg>';

  // ---------- events / timeline ----------
  var CHANNEL = { ntfy: "ntfy push", slack: "Slack", discord: "Discord", webhook: "webhook" };
  function eventView(e, plan) {
    var d = e.detail || {};
    var name = (plan && plan.name) || "The owner";
    var via = d.channel ? "via " + (CHANNEL[d.channel] || d.channel) : "";
    switch (e.type) {
      case "created": return { icon: icons.flag, tone: "brand", title: name + " started the plan", sub: plan ? plan.activity : "" };
      case "reminder_sent": return { icon: icons.bell, tone: "", title: "Reminder sent to " + name, sub: "Check in soon" };
      case "extended": return { icon: icons.plus, tone: "brand", title: name + " added " + (d.minutes || "") + " min", sub: d.checkInBy ? "New check-in time " + fmtTime(d.checkInBy) : "" };
      case "location": return { icon: icons.pin, tone: "", title: name + " shared a location", sub: "" };
      case "overdue": return { icon: icons.clock, tone: "warn", title: name + " missed the check-in", sub: "" };
      case "owner_pinged": return { icon: icons.bell, tone: "warn", title: name + " was pinged", sub: "“You missed your check-in”" };
      case "alerted": return { icon: icons.bellRing, tone: "no", title: (d.name || "A contact") + " alerted" + (d.sos ? " (SOS)" : ""), sub: via + (d.ok === false ? " · delivery failed" : "") };
      case "acknowledged": return { icon: icons.hand, tone: "brand", title: (d.name || "A contact") + ": I'm on it", sub: "", quote: d.note || null };
      case "sos": return { icon: icons.siren, tone: "no", title: name + " asked for help", sub: "All contacts alerted at once", quote: d.note || null };
      case "unanswered": return { icon: icons.alert, tone: "no", title: "Nobody has answered yet", sub: "Everyone stays alerted" };
      case "safe": return { icon: icons.checkBold, tone: "ok", title: name + " checked in safe", sub: "", quote: d.note || null };
      case "all_clear_sent": return { icon: icons.check, tone: "ok", title: "All clear sent to " + (d.name || "contact"), sub: via };
      case "closed": return { icon: icons.lock, tone: "", title: "Plan closed", sub: "" };
      default: return { icon: icons.dot, tone: "", title: String(e.type || "event").replace(/_/g, " "), sub: "" };
    }
  }
  function timelineHtml(events, plan, opts) {
    opts = opts || {};
    var list = (events || []).map(function (e, i) { return { e: e, i: i }; });
    list.reverse(); // newest first
    var seen = opts.seen == null ? Infinity : opts.seen;
    return '<ol class="timeline">' + list.map(function (x) {
      var v = eventView(x.e, plan);
      return '<li class="' + (v.tone ? "tl-" + v.tone : "") + (x.i >= seen ? " tl-new" : "") + '">' +
        '<span class="tl-icon">' + v.icon + "</span>" +
        '<div class="tl-body"><div class="tl-title">' + esc(v.title) + "</div>" +
        '<div class="tl-sub">' + (v.sub ? esc(v.sub) + " · " : "") + '<time datetime="' + esc(x.e.at) + '">' + esc(fmtTime(x.e.at)) + "</time></div>" +
        (v.quote ? '<div class="tl-quote">“' + esc(v.quote) + "”</div>" : "") +
        "</div></li>";
    }).join("") + "</ol>";
  }

  // ---------- polling (pauses while the tab is hidden) ----------
  function poller(fn, ms) {
    var timer = null, running = false, again = false, stopped = true;
    function schedule() {
      clearTimeout(timer);
      if (stopped || document.hidden) return;
      timer = setTimeout(run, ms);
    }
    function run() {
      if (stopped) return;
      if (running) { again = true; return; }
      running = true;
      clearTimeout(timer);
      Promise.resolve().then(fn).catch(function () { /* fn reports its own errors */ }).then(function () {
        running = false;
        if (again) { again = false; run(); } else schedule();
      });
    }
    document.addEventListener("visibilitychange", function () {
      if (stopped) return;
      if (document.hidden) clearTimeout(timer); else run();
    });
    return {
      start: function () { stopped = false; run(); },
      poke: function () { if (!stopped) run(); },
      stop: function () { stopped = true; clearTimeout(timer); }
    };
  }

  // ---------- talking to demo.html (same origin only) ----------
  function inFrame() { try { return window.parent && window.parent !== window; } catch (e) { return false; } }
  function tellParent(msg) {
    if (!inFrame()) return;
    try { window.parent.postMessage(Object.assign({ lc: true }, msg), location.origin); } catch (e) { /* ignore */ }
  }
  function onParent(handlers) {
    window.addEventListener("message", function (ev) {
      if (ev.origin !== location.origin || !ev.data || !ev.data.lc || ev.source !== window.parent) return;
      var h = handlers[ev.data.type];
      if (h) h(ev.data);
    });
  }
  // visual "tap" on a button, for the scripted demo
  function tapEffect(el) {
    if (!el) return;
    el.classList.remove("demo-tap");
    void el.offsetWidth;
    el.classList.add("demo-tap");
    // scroll only this document (scrollIntoView would also scroll the demo page around the frame)
    var r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) window.scrollBy(0, r.top - (window.innerHeight - r.height) / 2);
    setTimeout(function () { el.classList.remove("demo-tap"); }, 1200);
  }

  // ---------- UI bits ----------
  function toast(msg, kind) {
    var host = document.querySelector(".toast-host");
    if (!host) {
      host = document.createElement("div");
      host.className = "toast-host";
      host.setAttribute("role", "status");
      host.setAttribute("aria-live", "polite");
      document.body.appendChild(host);
    }
    var t = document.createElement("div");
    t.className = "toast" + (kind === "error" ? " error" : "");
    t.textContent = msg;
    host.appendChild(t);
    setTimeout(function () { t.style.transition = "opacity .3s"; t.style.opacity = "0"; }, 2800);
    setTimeout(function () { t.remove(); }, 3200);
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { if (document.execCommand("copy")) resolve(); else reject(new Error("copy failed")); } catch (e) { reject(e); }
      ta.remove();
    });
  }
  function flashCopied(btn) {
    var label = btn.querySelector(".copy-label");
    var prev = label ? label.textContent : null;
    btn.classList.add("copied");
    if (label) label.textContent = "Copied";
    setTimeout(function () { btn.classList.remove("copied"); if (label) label.textContent = prev; }, 1600);
  }
  // <button data-copy="text"> anywhere under root
  function bindCopyButtons(root) {
    (root || document).addEventListener("click", function (ev) {
      var btn = ev.target.closest && ev.target.closest("[data-copy]");
      if (!btn) return;
      copyText(btn.getAttribute("data-copy")).then(function () { flashCopied(btn); },
        function () { toast("Could not copy. Select the text and copy it manually.", "error"); });
    });
  }
  function copyButton(text, label, aria) {
    return '<button type="button" class="copy-btn" data-copy="' + esc(text) + '" aria-label="' + esc(aria || "Copy") + '">' +
      icons.copy + '<span class="copy-label">' + esc(label || "Copy") + "</span></button>";
  }
  // Web Share API with a copy fallback. Resolves "shared" | "copied".
  function share(text, title) {
    if (navigator.share) {
      return navigator.share({ title: title || "Last Call", text: text }).then(function () { return "shared"; }, function (e) {
        if (e && e.name === "AbortError") return "cancelled";
        return copyText(text).then(function () { return "copied"; });
      });
    }
    return copyText(text).then(function () { return "copied"; });
  }

  function setBusy(btn, busy, text) {
    if (!btn) return;
    if (busy) {
      if (btn.dataset.busy === "1") return;
      btn.dataset.busy = "1";
      btn.dataset.label = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>' + esc(text || "Working…") + "</span>";
    } else {
      btn.dataset.busy = "";
      btn.disabled = false;
      if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
    }
  }

  function qrSvg(text, label) {
    try { return window.LastCallQR ? window.LastCallQR.toSvg(text, { margin: 2, label: label || "QR code" }) : ""; } catch (e) { return ""; }
  }
  function md(text) {
    if (!text) return "";
    return window.LastCallMarkdown ? window.LastCallMarkdown.render(text, { headingOffset: 2 }) : "<p>" + esc(text) + "</p>";
  }

  var notEmergency =
    '<p class="sos-note">' + icons.info + '<span><b>Last Call is not an emergency service.</b> If someone is in danger, call your local emergency number.</span></p>';

  // Remember plans created on this device (the owner link is the only key).
  var SAVED = "lastcall.plans";
  function savePlan(entry) {
    var list = store.json(SAVED, []).filter(function (p) { return p && p.id !== entry.id; });
    list.unshift(entry);
    store.set(SAVED, JSON.stringify(list.slice(0, 5)));
  }
  function savedPlans() { return store.json(SAVED, []).filter(function (p) { return p && p.ownerUrl && p.id; }); }

  window.LC = {
    apiBase: apiBase, api: api, ApiError: ApiError, params: P, embedded: embedded, store: store,
    serverNow: serverNow, skew: function () { return skew; },
    esc: esc, initial: initial, fmtTime: fmtTime, fmtWhen: fmtWhen, relTime: relTime, clock: clock, span: span,
    minutesLabel: minutesLabel, isHttpUrl: isHttpUrl, listNames: listNames, telHref: telHref,
    osmEmbed: osmEmbed, osmLink: osmLink,
    statusInfo: statusInfo, statusPill: statusPill, isTerminal: isTerminal, isAlarm: isAlarm,
    contactChip: contactChip, peopleHtml: peopleHtml,
    icons: icons, brandMark: brandMark, eventView: eventView, timelineHtml: timelineHtml,
    poller: poller, inFrame: inFrame, tellParent: tellParent, onParent: onParent, tapEffect: tapEffect,
    toast: toast, copyText: copyText, bindCopyButtons: bindCopyButtons, copyButton: copyButton, share: share,
    setBusy: setBusy, qrSvg: qrSvg, md: md, notEmergency: notEmergency, savePlan: savePlan, savedPlans: savedPlans
  };
})();
