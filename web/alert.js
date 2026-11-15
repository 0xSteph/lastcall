/* alert.js — a contact's alert page (alert.html#id=..&c=..&s=..). */
(function () {
  "use strict";
  var LC = window.LC;
  var $ = function (id) { return document.getElementById(id); };
  var id = LC.params.id, ci = LC.params.c, secret = LC.params.s;
  var view = null, mode = "", seenEvents = null;
  var sig = { details: "", people: "", tl: "", map: "", call: "" };
  var busy = false, lateLoads = false;

  var q = function () { return "?c=" + encodeURIComponent(ci) + "&s=" + encodeURIComponent(secret); };

  function showProblem(title, text) {
    $("loading").hidden = true;
    $("live-view").hidden = true;
    $("problem").hidden = false;
    $("problem").innerHTML = '<div class="problem-icon">' + LC.icons.link + "</div><h1>" + LC.esc(title) + "</h1><p>" + LC.esc(text) + "</p>";
  }

  function setLive(state) {
    var el = $("live");
    el.hidden = false;
    el.className = "live" + (state === "err" ? " err" : state === "paused" ? " paused" : "");
    $("liveText").textContent = state === "err" ? "Reconnecting…" : state === "paused" ? "Ended" : "Live";
  }

  function load() {
    return LC.api("/v1/plans/" + encodeURIComponent(id) + "/alert" + q()).then(function (v) {
      setLive("ok");
      render(v);
    }, function (err) {
      if (err.status === 401 || err.status === 404) {
        poll.stop();
        showProblem(err.status === 404 ? "This alert doesn't exist" : "This link isn't valid",
          err.status === 404 ? "The plan may have expired." : "Check that you opened the whole link you were sent.");
      } else {
        setLive("err");
        if (!view) showProblem("Can't reach Last Call", err.message);
      }
    });
  }
  var poll = LC.poller(load, 4000);

  // ---------- which screen ----------
  function modeFor(v) {
    var you = v.you ? v.you.state : "standby";
    if (v.status === "safe") return "safe";
    if (v.status === "closed") return "closed";
    if (v.status === "acknowledged") return "onit";
    if (v.status === "sos") return you === "acknowledged" ? "onit" : "urgent";
    if (v.status === "alerting" || v.status === "unanswered") return you === "alerted" ? "urgent" : you === "acknowledged" ? "onit" : "next";
    if (v.status === "overdue") return "late";
    return "standby";
  }

  function lastEvent(type) {
    var ev = (view && view.events) || [];
    for (var i = ev.length - 1; i >= 0; i--) if (ev[i].type === type) return ev[i];
    return null;
  }

  function render(v) {
    view = v;
    $("loading").hidden = true;
    $("problem").hidden = true;
    $("live-view").hidden = false;
    var m = modeFor(v);
    var changed = m !== mode;
    mode = m;
    var e = LC.esc, I = LC.icons, name = v.name;
    var hero = $("hero");
    var heroCls = "alert-hero mode-" + (m === "next" ? "late" : m);
    if (hero.className !== heroCls) hero.className = heroCls;

    var sos = !!lastEvent("sos"); // the owner pressed "I need help" at some point
    var kick, title, icon;
    switch (m) {
      case "standby": kick = "Standby · nothing to do"; title = "Nothing's wrong."; icon = I.shieldCheck; break;
      case "late": kick = "Check-in is late"; title = name + " is late checking in"; icon = I.clock; break;
      case "next": kick = "You're next in line"; title = name + " hasn't checked in"; icon = I.clock; break;
      case "urgent": kick = sos ? "SOS · urgent" : "Urgent alert"; title = sos ? name + " needs help now" : name + " hasn't checked in"; icon = sos ? I.siren : I.bellRing; break;
      case "onit": kick = sos ? "SOS · someone's on it" : "Someone's on it"; title = onItTitle(); icon = I.hand; break;
      case "safe": kick = "All clear"; title = name + " checked in safe"; icon = I.checkBold; break;
      default: kick = "Plan closed"; title = "This plan is closed"; icon = I.lock;
    }
    if (changed || $("heroTitle").textContent !== title) {
      $("heroIcon").innerHTML = icon;
      $("heroKick").textContent = kick;
      $("heroTitle").textContent = title;
      document.title = title + " · Last Call";
    }
    renderSub();

    // standby explainer
    var sb = $("standby");
    sb.hidden = m !== "standby";
    if (m === "standby") {
      var idx = v.you.index, before = v.contacts.slice(0, idx).map(function (c) { return c.name; });
      sb.innerHTML = "<span>You're one of <b>" + e(name) + "</b>'s trusted contacts" + (v.contacts.length > 1 ? " (#" + (idx + 1) + " of " + v.contacts.length + ")" : "") + ".</span>" +
        "<span>If " + e(name) + " doesn't check in, Last Call sends you an urgent alert" + (before.length ? " after " + e(LC.listNames(before)) + " has had " + e(LC.minutesLabel(v.ackMinutes)) + " to respond" : "") + ". There is nothing to do until then.</span>";
    }

    var showWorry = m === "late" || m === "next" || m === "urgent" || m === "onit";

    var ds = [v.activity, v.details, v.routeUrl, v.checkInBy, m === "standby"].join("|");
    if (ds !== sig.details) { sig.details = ds; $("details").innerHTML = detailsHtml(m); }
    $("planSec").hidden = m === "safe" || m === "closed";

    // location
    var loc = v.lastLocation;
    $("locSec").hidden = !(showWorry && loc);
    if (showWorry && loc) {
      var key = loc.lat + "," + loc.lng;
      if (key !== sig.map) {
        sig.map = key;
        var f = document.createElement("iframe");
        f.title = "Map of " + name + "'s last known location";
        f.loading = "lazy";
        f.referrerPolicy = "no-referrer";
        f.src = LC.osmEmbed(loc.lat, loc.lng);
        $("mapSlot").innerHTML = "";
        $("mapSlot").appendChild(f);
      }
      $("mapMeta").innerHTML = "<span>Shared " + e(LC.relTime(loc.at)) + (loc.accuracy ? " · within " + e(Math.round(loc.accuracy)) + " m" : "") + "</span>" +
        '<a href="' + e(LC.osmLink(loc.lat, loc.lng)) + '" target="_blank" rel="noopener noreferrer">Open in maps</a>';
    }

    // call + route
    var cr = $("callRow");
    var callHtml = "";
    var btns = [];
    if (v.phone) btns.push('<a class="btn btn-lg" href="' + e(LC.telHref(v.phone)) + '">' + I.phone + "Call " + e(name) + "</a>");
    if (v.routeUrl && LC.isHttpUrl(v.routeUrl)) btns.push('<a class="btn btn-lg" href="' + e(v.routeUrl) + '" target="_blank" rel="noopener noreferrer">' + I.route + "Route</a>");
    if (btns.length) callHtml = btns.join("");
    cr.hidden = !(showWorry && btns.length);
    cr.className = "app-section call-row" + (btns.length > 1 ? " two" : "");
    if (callHtml !== sig.call) { sig.call = callHtml; cr.innerHTML = callHtml; }

    // people
    $("peopleTitle").textContent = m === "standby" ? name + "'s contacts, in order" : "Who's been alerted";
    var ps = JSON.stringify(v.contacts) + v.you.index;
    if (ps !== sig.people) { sig.people = ps; $("people").innerHTML = LC.peopleHtml(v, { youIndex: v.you.index }); }

    // timeline (not while everything is fine)
    $("tlSec").hidden = m === "standby";
    var ts = v.events.length + ":" + v.status;
    if (m !== "standby" && ts !== sig.tl) {
      sig.tl = ts;
      $("timeline").innerHTML = LC.timelineHtml(v.events.filter(function (x) { return x.type !== "location"; }), v, { seen: seenEvents == null ? Infinity : seenEvents });
      seenEvents = v.events.filter(function (x) { return x.type !== "location"; }).length;
    }

    if (!$("noteSlot").innerHTML) $("noteSlot").innerHTML = LC.notEmergency;

    // the button
    var canAck = v.you.state === "alerted" && !LC.isTerminal(v.status);
    $("ackBar").hidden = !canAck;
    if (canAck && !busy) {
      var also = v.status === "acknowledged";
      var btn = $("ackBtn");
      var label = LC.icons.hand + (also ? "I'm on it too" : "I'm on it");
      if (btn.innerHTML !== label) btn.innerHTML = label;
      btn.className = "big-ack" + (also ? " secondary" : "");
    }

    if (LC.isTerminal(v.status)) {
      poll.stop();
      setLive("paused");
      // all_clear_sent lands a moment after "safe": look a few more times
      if (!lateLoads) { lateLoads = true; [2000, 5000, 10000].forEach(function (ms) { setTimeout(load, ms); }); }
    }
  }

  function onItTitle() {
    var on = view.contacts.filter(function (c) { return c.state === "acknowledged"; });
    var youOn = view.you.state === "acknowledged";
    if (youOn && on.length === 1) return "You're on it";
    var names = on.map(function (c) { return view.contacts.indexOf(c) === view.you.index ? "you" : c.name; });
    if (!names.length) return "Someone is on it";
    var s = LC.listNames(names);
    return s.charAt(0).toUpperCase() + s.slice(1) + (names.length > 1 ? " are on it" : " is on it");
  }

  // the line under the headline, with live minutes
  function renderSub() {
    var v = view, e = LC.esc, now = LC.serverNow(), html = "";
    var due = Date.parse(v.checkInBy), late = now - due;
    switch (mode) {
      case "standby":
        html = e(v.name) + "'s plan is active; check-in due <b>" + e(LC.fmtWhen(v.checkInBy)) + "</b>.";
        break;
      case "late":
        html = "Check-in was due " + e(LC.fmtTime(due)) + ". Last Call has pinged " + e(v.name) + ". " +
          (v.graceMinutes > 0 ? "Contacts are alerted at <b>" + e(LC.fmtTime(v.graceUntil)) + "</b> unless " + e(v.name) + " checks in." : "Contacts are being alerted now.");
        break;
      case "next": {
        var alerted = v.contacts.filter(function (c) { return c.state !== "standby"; });
        var cur = alerted[alerted.length - 1];
        var nextAt = cur && cur.alertedAt ? Date.parse(cur.alertedAt) + v.ackMinutes * 60000 : 0;
        html = e(LC.listNames(alerted.map(function (c) { return c.name; })) || "Another contact") + (alerted.length > 1 ? " were" : " was") + " alerted first. " +
          (v.status === "unanswered" ? "Nobody has answered yet." : nextAt && nextAt > now && v.contacts[v.you.index - 1] === cur
            ? "If nobody answers, you're alerted in <b>" + e(LC.clock(nextAt - now)) + "</b>."
            : "If nobody answers, you're alerted next.");
        break;
      }
      case "urgent":
        if (lastEvent("sos")) {
          var s = lastEvent("sos");
          html = e(v.name) + " pressed <b>I need help</b>" + (s ? " at " + e(LC.fmtTime(s.at)) : "") + ". Everyone was alerted at once." +
            (s && s.detail && s.detail.note ? "<br>“" + e(s.detail.note) + "”" : "") + (v.status === "unanswered" ? " Nobody has answered yet." : "");
        } else {
          html = "Overdue by <b>" + e(LC.span(late)) + "</b> · was due " + e(LC.fmtTime(due)) + "." +
            (v.status === "unanswered" ? " Nobody has answered yet." : "");
        }
        break;
      case "onit": {
        var a = lastEvent("acknowledged"), so = lastEvent("sos");
        html = (so && (!a || Date.parse(so.at) >= Date.parse(a.at)) ? "<b>" + e(v.name) + " pressed I need help at " + e(LC.fmtTime(so.at)) + ".</b> " : "") +
          (a ? "On it since " + e(LC.fmtTime(a.at)) + ". " : "") +
          (a && a.detail && a.detail.note ? "“" + e(a.detail.note) + "” " : "") +
          e(v.name) + " still hasn't checked in" + (late > 0 ? " (" + e(LC.span(late)) + " overdue)" : "") + ".";
        break;
      }
      case "safe": {
        var sf = lastEvent("safe");
        html = "at <b>" + e(LC.fmtWhen(v.safeAt)) + "</b>. No action needed. Thanks for being there." +
          (sf && sf.detail && sf.detail.note ? "<br>“" + e(sf.detail.note) + "”" : "");
        break;
      }
      default:
        html = "It ended " + e(LC.fmtWhen(v.closedAt)) + " without a safe check-in.";
    }
    var el = $("heroSub");
    if (el.innerHTML !== html) el.innerHTML = html;
  }

  function detailsHtml(m) {
    var v = view, e = LC.esc;
    var out = '<div><b style="font-size:17px;letter-spacing:-0.01em">' + e(v.activity) + "</b></div>";
    out += '<div class="kv"><span>Started ' + e(LC.fmtWhen(v.createdAt)) + "</span><span>Due back " + e(LC.fmtWhen(v.checkInBy)) + "</span></div>";
    if (v.details && m !== "standby") out += '<div class="md">' + LC.md(v.details) + "</div>";
    return out;
  }

  // ---------- I'm on it ----------
  $("ackBar").addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (busy) return;
    busy = true;
    var btn = $("ackBtn");
    LC.setBusy(btn, true, "Telling everyone…");
    var note = $("ackNote").value.trim();
    LC.api("/v1/plans/" + encodeURIComponent(id) + "/ack" + q(), { method: "POST", body: note ? { note: note } : {} }).then(function (v) {
      busy = false;
      LC.setBusy(btn, false);
      $("ackNote").value = "";
      render(v);
      LC.toast("Thanks. Everyone can see you're on it.");
      LC.tellParent({ type: "changed" });
    }, function (err) {
      busy = false;
      LC.setBusy(btn, false);
      LC.toast(err.message, "error");
      poll.poke();
    });
  });

  // ---------- demo.html hooks ----------
  LC.onParent({
    refresh: function () { load(); }, // also after the poller stopped on a final state
    tap: function (m) {
      if (m.note != null && $("ackNote")) $("ackNote").value = m.note;
      LC.tapEffect(document.querySelector('[data-action="' + m.action + '"]'));
    }
  });

  window.LastCallPage = { render: render, view: function () { return view; }, mode: function () { return mode; } };

  if (!id || !secret || ci == null || !/^\d+$/.test(String(ci))) {
    showProblem("This link is incomplete", "Open the full alert link you were sent.");
    return;
  }
  // a different link pasted into the same tab only changes the #fragment: start over
  window.addEventListener("hashchange", function () { location.reload(); });
  setInterval(function () { if (view && !document.hidden && !LC.isTerminal(view.status)) renderSub(); }, 1000);
  poll.start();
})();
