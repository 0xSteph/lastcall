/* plan.js — the owner's check-in page (plan.html#id=..&s=..). */
(function () {
  "use strict";
  var LC = window.LC;
  var $ = function (id) { return document.getElementById(id); };
  var id = LC.params.id, secret = LC.params.s;
  var CIRC = 2 * Math.PI * 106;

  var view = null; // latest owner view
  var seenEvents = null;
  var sig = { people: "", tl: "", details: "", final: "" };
  var pokedFor = 0;
  var busy = false;

  var q = function () { return "?s=" + encodeURIComponent(secret); };

  function showProblem(title, text) {
    $("loading").hidden = true;
    $("live-view").hidden = true;
    $("final").hidden = true;
    $("problem").hidden = false;
    $("problem").innerHTML = '<div class="problem-icon">' + LC.icons.link + "</div><h1>" + LC.esc(title) + "</h1><p>" + LC.esc(text) + "</p>" +
      '<a class="btn btn-primary embed-hide" href="new.html">Plan an outing</a>';
  }

  // ---------- data ----------
  function load() {
    return LC.api("/v1/plans/" + encodeURIComponent(id) + q()).then(function (v) {
      setLive("ok");
      render(v);
    }, function (err) {
      if (err.status === 401 || err.status === 404) {
        poll.stop();
        showProblem(err.status === 404 ? "This plan doesn't exist" : "This link isn't valid",
          err.status === 404 ? "It may have expired. Plans are kept for at least 14 days." : "Check that you opened the whole link you were given.");
      } else {
        setLive("err");
        if (!view) showProblem("Can't reach Last Call", err.message);
      }
    });
  }
  var poll = LC.poller(load, 4000);

  function setLive(state) {
    var el = $("live");
    el.hidden = false;
    el.className = "live" + (state === "err" ? " err" : state === "paused" ? " paused" : "");
    $("liveText").textContent = state === "err" ? "Reconnecting…" : state === "paused" ? "Ended" : "Live";
  }

  // ---------- rendering ----------
  function lastEvent(type) {
    var ev = (view && view.events) || [];
    for (var i = ev.length - 1; i >= 0; i--) if (ev[i].type === type) return ev[i];
    return null;
  }
  function alertedNames() { return view.contacts.filter(function (c) { return c.state !== "standby"; }).map(function (c) { return c.name; }); }
  function onItNames() { return view.contacts.filter(function (c) { return c.state === "acknowledged"; }).map(function (c) { return c.name; }); }

  function render(v) {
    view = v;
    $("loading").hidden = true;
    $("problem").hidden = true;
    if (LC.isTerminal(v.status)) return renderFinal();
    $("final").hidden = true;
    $("live-view").hidden = false;
    document.body.classList.remove("final-safe-bg");

    $("whoKick").textContent = v.name + "'s plan";
    $("activity").textContent = v.activity;
    $("statusPill").innerHTML = LC.statusPill(v.status);
    document.title = LC.statusInfo(v.status).label + " · " + v.activity + " · Last Call";

    renderBanner();
    renderActions();
    tick();

    var ps = JSON.stringify(v.contacts);
    if (ps !== sig.people) { sig.people = ps; $("people").innerHTML = LC.peopleHtml(v); }

    var ds = [v.details, v.routeUrl, v.phone, JSON.stringify(v.lastLocation), v.graceMinutes, v.ackMinutes, v.remindAt].join("|");
    if (ds !== sig.details) { sig.details = ds; $("details").innerHTML = detailsHtml(); }

    var ts = v.events.length + ":" + v.status;
    if (ts !== sig.tl) {
      sig.tl = ts;
      $("timeline").innerHTML = LC.timelineHtml(v.events, v, { seen: seenEvents == null ? Infinity : seenEvents });
      seenEvents = v.events.length;
    }
    if (!$("noteLive").innerHTML) $("noteLive").innerHTML = LC.notEmergency;
  }

  function detailsHtml() {
    var v = view, bits = [];
    if (v.details) bits.push('<div class="md">' + LC.md(v.details) + "</div>");
    var kv = [];
    if (v.routeUrl && LC.isHttpUrl(v.routeUrl)) kv.push('<a href="' + LC.esc(v.routeUrl) + '" target="_blank" rel="noopener noreferrer">Route link</a>');
    if (v.phone) kv.push("<span>Phone shown to contacts: " + LC.esc(v.phone) + "</span>");
    if (v.lastLocation) kv.push('<a href="' + LC.esc(LC.osmLink(v.lastLocation.lat, v.lastLocation.lng)) + '" target="_blank" rel="noopener noreferrer">Last shared location</a> <span>(' + LC.esc(LC.relTime(v.lastLocation.at)) + ")</span>");
    kv.push("<span>Reminder: " + (v.remindAt ? LC.esc(LC.fmtWhen(v.remindAt)) : "off") + "</span>");
    kv.push("<span>Grace period: " + LC.esc(LC.minutesLabel(v.graceMinutes)) + "</span>");
    kv.push("<span>Each contact gets " + LC.esc(LC.minutesLabel(v.ackMinutes)) + " to answer</span>");
    bits.push('<div class="kv">' + kv.join("") + "</div>");
    return bits.join("");
  }

  function renderBanner() {
    var v = view, b = $("banner"), tone = "calm", html;
    var I = LC.icons, e = LC.esc;
    switch (v.status) {
      case "active": {
        var soon = v.remindAt && LC.serverNow() >= Date.parse(v.remindAt);
        tone = soon ? "brand" : "calm";
        html = (soon ? I.bell + "<span><b>Check in soon.</b> " : I.shieldCheck + "<span>") +
          "Tap <b>I'm safe</b> when you're back. If you don't by " + e(LC.fmtWhen(v.checkInBy)) + ", Last Call starts alerting " + e(v.contacts[0] ? v.contacts[0].name : "your contacts") + ".</span>";
        break;
      }
      case "overdue":
        tone = "warn";
        html = I.clock + "<span><b>You missed your check-in.</b> " + (v.graceMinutes > 0
          ? "Your contacts will be alerted at " + e(LC.fmtTime(v.graceUntil)) + " unless you check in."
          : "Your contacts are being alerted now.") + "</span>";
        break;
      case "alerting": {
        var names = alertedNames();
        tone = "no";
        html = I.bellRing + "<span><b>" + e(LC.listNames(names) || "Your contacts") + (names.length > 1 ? " have" : " has") + " been alerted.</b> If you're OK, tap I'm safe so they stop worrying.</span>";
        break;
      }
      case "sos":
        tone = "no";
        html = I.siren + "<span><b>Help requested.</b> All your contacts were alerted at once. If you're in danger, call your local emergency number.</span>";
        break;
      case "acknowledged": {
        var on = onItNames(), ack = lastEvent("acknowledged");
        tone = "brand";
        html = I.hand + "<span><b>" + e(LC.listNames(on) || "A contact") + (on.length > 1 ? " are" : " is") + " on it.</b>" +
          (ack && ack.detail && ack.detail.note ? " “" + e(ack.detail.note) + "”" : " They know you haven't checked in.") + " Tap I'm safe if you're OK.</span>";
        break;
      }
      case "unanswered":
        tone = "no";
        html = I.alert + "<span><b>Nobody has responded yet.</b> Every contact has been alerted. If you're in danger, call your local emergency number.</span>";
        break;
      default:
        html = "<span>" + e(LC.statusInfo(v.status).label) + "</span>";
    }
    var next = "banner tone-" + tone;
    if (b.className !== next) b.className = next;
    if (b.innerHTML !== html) b.innerHTML = html;
  }

  function renderActions() {
    var s = view.status;
    var canExtend = s === "active" || s === "overdue";
    $("extendBtn").hidden = !canExtend;
    $("extendNote").hidden = canExtend;
    $("extendBtn").parentNode.style.gridTemplateColumns = canExtend ? "" : "1fr";
    var sos = $("sosBtn");
    if (busy || !$("sosLabel")) return; // a request is in flight and owns the button's content
    if (s === "sos") {
      disarm();
      sos.disabled = true;
      $("sosLabel").innerHTML = LC.icons.siren + "<span>Help requested</span>";
      $("sosHint").textContent = "Everyone was alerted. Tap I'm safe once you're OK.";
    } else if (sos.disabled) {
      sos.disabled = false;
      $("sosLabel").textContent = "I need help";
      $("sosHint").textContent = "Hold for 2 seconds or tap twice. Alerts every contact at once.";
    }
  }

  // countdown ring, once a second (also called after every render)
  function tick() {
    if (!view || LC.isTerminal(view.status)) return;
    var v = view, now = LC.serverNow();
    var checkInBy = Date.parse(v.checkInBy), grace = Date.parse(v.graceUntil);
    var phase = "active", frac = 1, big = "", word = false, sub = "", time = "";
    switch (v.status) {
      case "active": {
        var ext = lastEvent("extended");
        var start = ext ? Date.parse(ext.at) : Date.parse(v.createdAt);
        var total = Math.max(1, checkInBy - start), left = checkInBy - now;
        frac = Math.max(0, Math.min(1, left / total));
        phase = v.remindAt && now >= Date.parse(v.remindAt) ? "soon" : "active";
        big = LC.clock(left);
        sub = left > 0 ? "until check-in" : "Checking in with the server…";
        time = "Due " + LC.fmtWhen(checkInBy);
        break;
      }
      case "overdue": {
        var g = Math.max(1, grace - checkInBy), gl = grace - now;
        frac = Math.max(0, Math.min(1, gl / g));
        phase = "overdue";
        big = LC.clock(gl);
        sub = "until your contacts are alerted";
        time = "Missed " + LC.fmtTime(checkInBy);
        break;
      }
      case "alerting":
      case "unanswered":
        phase = "alert";
        big = "+" + LC.clock(now - checkInBy);
        sub = v.status === "alerting" ? "overdue · alerting contacts" : "overdue · no answer yet";
        time = "Alerted: " + (LC.listNames(alertedNames()) || "…");
        break;
      case "sos":
        phase = "alert"; word = true;
        big = "SOS";
        sub = "Help requested";
        time = "All contacts alerted";
        break;
      case "acknowledged": {
        var on = onItNames();
        phase = "onit"; word = true;
        big = on[0] || "On it";
        sub = on.length > 1 ? "and " + (on.length - 1) + " more are on it" : "is on it";
        var a = lastEvent("acknowledged");
        time = a ? "since " + LC.fmtTime(a.at) : "";
        break;
      }
    }
    var wrap = $("ringWrap");
    var cls = "ring-wrap phase-" + phase;
    if (wrap.className !== cls) wrap.className = cls;
    $("ringBar").style.strokeDashoffset = String(CIRC * (1 - frac));
    var bigEl = $("ringBig");
    bigEl.classList.toggle("word", word || big.length > 7);
    if (bigEl.textContent !== big) bigEl.textContent = big;
    if ($("ringSub").textContent !== sub) $("ringSub").textContent = sub;
    if ($("ringTime").textContent !== time) $("ringTime").textContent = time;
    $("ringText").textContent = big + " " + sub;

    // ask the server as soon as a milestone passes, instead of waiting for the next poll
    var ms = milestones();
    for (var i = 0; i < ms.length; i++) {
      if (ms[i] > pokedFor && now >= ms[i] + 1200) { pokedFor = ms[i]; poll.poke(); break; }
    }
    if (v.status === "active") renderBanner();
  }

  // times at which the server state is expected to change
  function milestones() {
    var v = view, out = [];
    if (v.status === "active") {
      if (v.remindAt) out.push(Date.parse(v.remindAt));
      out.push(Date.parse(v.checkInBy));
    } else if (v.status === "overdue") out.push(Date.parse(v.graceUntil));
    else if (v.status === "sos") {
      var s = lastEvent("sos");
      if (s) out.push(Date.parse(s.at) + v.ackMinutes * 60000);
    }
    else if (v.status === "alerting") {
      var cur = null;
      v.contacts.forEach(function (c) { if (c.state !== "standby" && c.alertedAt) cur = c; });
      if (cur) out.push(Date.parse(cur.alertedAt) + v.ackMinutes * 60000);
    }
    return out.filter(Boolean).sort(function (a, b) { return a - b; });
  }

  // The API records all_clear_sent a moment after status becomes safe, so look again
  // a few times after reaching a final state instead of stopping cold.
  var lateLoads = false;
  function lateRefresh() {
    if (lateLoads) return;
    lateLoads = true;
    [2000, 5000, 10000].forEach(function (ms) { setTimeout(load, ms); });
  }

  function renderFinal() {
    poll.stop();
    lateRefresh();
    setLive("paused");
    $("live-view").hidden = true;
    var v = view, el = $("final"), e = LC.esc;
    var s = v.status + ":" + v.events.length;
    if (s === sig.final) return;
    var first = !sig.final;
    sig.final = s;
    el.hidden = false;
    el.className = "final" + (v.status === "closed" ? " closed" : "");
    document.title = (v.status === "safe" ? "Safe" : "Closed") + " · " + v.activity + " · Last Call";
    var html;
    if (v.status === "safe") {
      document.body.classList.add("final-safe-bg");
      var safe = lastEvent("safe");
      var told = v.contacts.filter(function (c) { return c.state !== "standby"; }).map(function (c) { return c.name; });
      html = '<div class="final-icon">' + LC.icons.checkBold + "</div>" +
        "<h2>You're checked in safe</h2>" +
        '<p class="when">' + e(v.activity) + " · " + e(LC.fmtWhen(v.safeAt)) + "</p>" +
        (safe && safe.detail && safe.detail.note ? '<p class="quote">“' + e(safe.detail.note) + "”</p>" : "") +
        '<p class="after">' + (told.length ? "All clear sent to " + e(LC.listNames(told)) + "." : "Nobody was alerted. Your contacts never had to worry.") + "</p>";
    } else {
      html = '<div class="final-icon">' + LC.icons.lock + "</div>" +
        "<h2>This plan is closed</h2>" +
        '<p class="when">' + e(v.activity) + " · closed " + e(LC.fmtWhen(v.closedAt)) + "</p>" +
        '<p class="after">It ended without a safe check-in. If you are OK, tell your contacts directly.</p>';
    }
    html += '<a class="btn btn-primary embed-hide" href="new.html">Plan another outing</a>' +
      '<div class="app-section" style="text-align:left"><h2>Timeline</h2>' + LC.timelineHtml(v.events, v, { seen: first ? Infinity : seenEvents }) + "</div>" +
      '<div class="app-section" style="text-align:left">' + LC.notEmergency + "</div>";
    seenEvents = v.events.length;
    el.innerHTML = html;
  }

  // ---------- actions ----------
  function checkin(body, okMsg, btn, busyText) {
    if (busy) return Promise.resolve();
    busy = true;
    LC.setBusy(btn, true, busyText);
    return LC.api("/v1/plans/" + encodeURIComponent(id) + "/checkin" + q(), { method: "POST", body: body }).then(function (v) {
      LC.setBusy(btn, false);
      busy = false;
      render(v);
      if (okMsg) LC.toast(typeof okMsg === "function" ? okMsg(v) : okMsg);
      LC.tellParent({ type: "changed" });
    }, function (err) {
      LC.setBusy(btn, false);
      busy = false;
      LC.toast(err.message, "error");
      poll.poke();
    });
  }

  $("safeBtn").addEventListener("click", function () {
    checkin({ action: "safe" }, "Checked in. Glad you're safe.", $("safeBtn"), "Checking in…");
  });
  $("extendBtn").addEventListener("click", function () {
    checkin({ action: "extend", minutes: 30 }, function (v) { return "Added 30 minutes. Check in by " + LC.fmtTime(v.checkInBy) + "."; }, $("extendBtn"), "Adding…");
  });

  function locate(opts) {
    return new Promise(function (resolve, reject) {
      if (!navigator.geolocation) return reject(new Error("Location isn't available in this browser."));
      navigator.geolocation.getCurrentPosition(function (p) {
        resolve({ lat: Math.round(p.coords.latitude * 1e6) / 1e6, lng: Math.round(p.coords.longitude * 1e6) / 1e6, accuracy: Math.min(100000, Math.round(p.coords.accuracy || 0)) });
      }, function (e) {
        reject(new Error(e && e.code === 1 ? "Location permission was denied." : "Couldn't get your location. Try again outdoors."));
      }, opts || { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
    });
  }
  function sendLocation(loc) {
    return LC.api("/v1/plans/" + encodeURIComponent(id) + "/location" + q(), { method: "POST", body: loc }).then(function (v) {
      render(v);
      LC.tellParent({ type: "changed" });
      return v;
    });
  }
  $("locBtn").addEventListener("click", function () {
    var btn = $("locBtn");
    LC.setBusy(btn, true, "Locating…");
    locate().then(sendLocation).then(function () {
      LC.setBusy(btn, false);
      LC.toast("Location shared with your contacts' alert pages.");
    }, function (err) {
      LC.setBusy(btn, false);
      LC.toast(err.message, "error");
    });
  });

  // SOS: press and hold 2 s, or tap once to arm and tap again within 5 s (no blocking browser dialog).
  var sos = $("sosBtn"), holdTimer = null, held = false, armTimer = null, armed = false;
  function arm() {
    armed = true;
    sos.classList.add("armed");
    $("sosLabel").textContent = "Tap again to alert everyone";
    $("sosHint").textContent = "Or wait and it cancels itself.";
    clearTimeout(armTimer);
    armTimer = setTimeout(disarm, 5000);
  }
  function disarm() {
    armed = false;
    clearTimeout(armTimer);
    sos.classList.remove("armed", "holding");
    if (!sos.disabled && $("sosLabel")) {
      $("sosLabel").textContent = "I need help";
      $("sosHint").textContent = "Hold for 2 seconds or tap twice. Alerts every contact at once.";
    }
  }
  function fireSos() {
    disarm();
    checkin({ action: "sos" }, "Help requested. All your contacts are being alerted.", sos, "Alerting everyone…").then(function () {
      // add a fresh location if the browser allows it, without delaying the alert
      locate({ enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }).then(sendLocation).catch(function () { /* optional */ });
    });
  }
  sos.addEventListener("pointerdown", function (ev) {
    if (sos.disabled || (ev.button != null && ev.button !== 0)) return;
    held = false;
    sos.classList.add("holding");
    clearTimeout(holdTimer);
    holdTimer = setTimeout(function () { held = true; sos.classList.remove("holding"); fireSos(); }, 2000);
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach(function (t) {
    sos.addEventListener(t, function () { clearTimeout(holdTimer); sos.classList.remove("holding"); });
  });
  sos.addEventListener("contextmenu", function (ev) { ev.preventDefault(); });
  sos.addEventListener("click", function () {
    if (sos.disabled) return;
    if (held) { held = false; return; }
    if (armed) fireSos(); else arm();
  });

  // ---------- demo.html hooks ----------
  LC.onParent({
    refresh: function () { load(); }, // also after the poller stopped on a final state
    tap: function (m) { LC.tapEffect(document.querySelector('[data-action="' + m.action + '"]')); }
  });

  window.LastCallPage = { render: render, tick: tick, view: function () { return view; } };

  if (!id || !secret) {
    showProblem("This link is incomplete", "Open the full plan link you got when you created the plan.");
    return;
  }
  // a different link pasted into the same tab only changes the #fragment: start over
  window.addEventListener("hashchange", function () { location.reload(); });
  setInterval(function () { if (!document.hidden) tick(); }, 1000);
  poll.start();
})();
