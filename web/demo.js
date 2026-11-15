/* demo.js — the three-phone, captioned, end-to-end demo (demo.html, demo.html?auto=1). */
(function () {
  "use strict";
  var LC = window.LC;
  var $ = function (id) { return document.getElementById(id); };
  var e = LC.esc;

  var AUTO = LC.params.auto === "1";
  var LW = 375, LH = 780; // logical size of the page inside each phone
  var DWELL = 3600; // time a story caption stays up before the next one
  var MIN_DWELL = 2500; // even status lines like "Creating…" stay at least this long
  var DEMO = {
    name: "Sam",
    activity: "Solo hike: Dipsea Trail loop",
    details: "**Route:** Dipsea Trail from Mill Valley toward Stinson Beach and back, about 14 km.\n" +
      "**Parked:** silver Subaru at the Old Mill Park lot.\n" +
      "**Gear:** water, headlamp, phone at 80%.",
    routeUrl: "https://www.openstreetmap.org/?mlat=37.8968&mlon=-122.5541#map=14/37.8968/-122.5541",
    phone: "+1 555 0100",
    checkInSeconds: 75,
    remindMinutesBefore: 1,
    graceMinutes: 0,
    ackMinutes: 1,
    contacts: [{ name: "Alex", relationship: "sister" }, { name: "Jordan", relationship: "friend" }],
    location: { lat: 37.8968, lng: -122.5541, accuracy: 25 }
  };

  var S = null; // current run
  var runSeq = 0;

  // ---------- captions ----------
  var cap = { active: "capA", shownAt: 0, current: null, queue: [] };
  function setTone(tone) { $("caption").setAttribute("data-tone", tone || "calm"); }
  function showBeat(b) {
    var outEl = $(cap.active), inId = cap.active === "capA" ? "capB" : "capA", inEl = $(inId);
    inEl.querySelector(".cap-line").innerHTML = lineHtml(b);
    inEl.querySelector(".cap-sub").innerHTML = b.sub || "";
    inEl.classList.add("in-start");
    inEl.classList.remove("out");
    void inEl.offsetWidth;
    inEl.classList.remove("in-start");
    inEl.removeAttribute("aria-hidden");
    outEl.classList.add("out");
    outEl.setAttribute("aria-hidden", "true");
    cap.active = inId;
    cap.current = b;
    cap.shownAt = Date.now();
    $("capKicker").textContent = b.kicker || "Last Call · live demo";
    setTone(b.tone);
    if (b.focus != null) spotlight(b.focus, b.tone);
    tickCaption();
  }
  function lineHtml(b) { return e(b.line).replace("{clock}", '<span class="clk"></span>'); }
  function queueBeat(b) {
    if (!b) return;
    cap.queue.push(b);
    pumpCaptions();
  }
  function pumpCaptions() {
    if (!cap.queue.length) return;
    if (cap.current && Date.now() - cap.shownAt < (cap.current.instant ? MIN_DWELL : DWELL)) return;
    showBeat(cap.queue.shift());
  }
  function sayNow(b) { cap.queue = []; b.instant = true; showBeat(b); }

  function tickCaption() {
    var clk = $(cap.active).querySelectorAll(".clk");
    if (!clk.length || !S || !S.view) return;
    var left = Date.parse(S.view.checkInBy) - LC.serverNow();
    for (var i = 0; i < clk.length; i++) clk[i].textContent = LC.clock(left);
  }

  // ---------- event -> caption beat ----------
  function contactLabel(c) { return c.name + (c.relationship ? " (" + c.relationship + ")" : ""); }
  function beatFor(ev, v, idx) {
    var d = ev.detail || {}, n = v.name, cs = v.contacts;
    var sosBefore = v.events.slice(0, idx).some(function (x) { return x.type === "sos"; });
    switch (ev.type) {
      case "created":
        return { tone: "calm", focus: 0, line: n + " is out on a solo hike. Check-in due in {clock}.",
          sub: e(n) + " told Last Call the route, the return time and who to tell: " + e(LC.listNames(cs.map(contactLabel))) + ", in that order." };
      case "reminder_sent":
        return { tone: "calm", focus: 0, line: "Check-in is close. Last Call nudges " + n + ".",
          sub: "A push with one-tap <b>I'm safe</b> and <b>+30 min</b>. " + (AUTO ? "In this story, " + e(n) + " doesn't answer." : "Tap I'm safe on " + e(n) + "'s phone to end it here, or let the clock run out.") };
      case "overdue":
        return { tone: "warn", focus: 0, line: n + " missed the check-in.",
          sub: v.graceMinutes > 0 ? e(n) + " gets an urgent ping. Contacts are alerted at " + e(LC.fmtTime(v.graceUntil)) + " unless " + e(n) + " checks in."
            : "The grace period is zero in this demo, so the first contact is alerted right away." };
      case "alerted": {
        if (d.sos || sosBefore) return null;
        var c = cs[d.index] || { name: d.name };
        if (d.index === 0) {
          return { tone: "alert", focus: 1, line: c.name + " is alerted.",
            sub: "An urgent push with " + e(n) + "'s plan, route and last known location. " + e(c.name) + " has " + e(LC.minutesLabel(v.ackMinutes)) + " to answer." };
        }
        var prev = cs[d.index - 1] || { name: "The previous contact" };
        return { tone: "alert", focus: d.index + 1, line: prev.name + " didn't answer in time; " + c.name + " is alerted.",
          sub: "Last Call goes down the list one person at a time until someone responds. " + e(prev.name) + " can still answer too." };
      }
      case "sos":
        return { tone: "alert", focus: 0, line: n + " pressed “I need help”.",
          sub: (d.note ? "“" + e(d.note) + "” " : "") + "Every contact is alerted at once, with " + e(n) + "'s last known location." };
      case "acknowledged":
        return { tone: "onit", focus: (d.index || 0) + 1, line: (d.name || "A contact") + ": “I'm on it.”",
          sub: (d.note ? "“" + e(d.note) + "” " : "") + "Escalation stops. " + e(n) + " and everyone else can see who is handling it." };
      case "unanswered":
        return { tone: "alert", focus: null, line: "Nobody has answered yet.", sub: "Everyone stays alerted and can still respond. This is when you pick up the phone." };
      case "extended":
        return { tone: "calm", focus: 0, line: n + " added " + (d.minutes || 30) + " minutes.", sub: "New check-in time " + e(LC.fmtTime(d.checkInBy)) + ". The reminder is armed again." };
      case "location":
        return idx === 0 ? null : { tone: null, focus: 0, line: n + " shared a new location.", sub: "Contacts see it on the map if they're alerted." };
      case "safe": {
        var told = cs.filter(function (c) { return c.state !== "standby"; }).map(function (c) { return c.name; });
        return { tone: "safe", focus: 0, line: n + " checked in safe.",
          sub: (d.note ? "“" + e(d.note) + "” " : "") + (told.length ? e(LC.listNames(told)) + " get an all clear. Nobody is left worrying." : "Nobody was alerted, so nobody had to worry.") };
      }
      case "closed":
        return { tone: "calm", focus: null, line: "The plan is closed.", sub: "" };
      default:
        return null;
    }
  }
  function finale(v) {
    return { tone: "safe", kicker: "Last Call", focus: null, line: v.name + " is safe. Everyone who was alerted knows.",
      sub: "If you don't check in, the people you trust find out." };
  }

  // ---------- phones ----------
  function spotlight(i, tone) {
    for (var k = 0; k < 3; k++) $("phone" + k).classList.toggle("spot", k === i);
    var colors = { alert: "var(--no)", warn: "var(--warn)", safe: "var(--ok)", onit: "var(--brand)" };
    $("phone" + i).style.setProperty("--spot", colors[tone] || "var(--brand)");
    if (!document.body.classList.contains("wide") && (!S || Date.now() - S.manualTabAt > 8000)) selectTab(i);
  }
  function selectTab(i) {
    for (var k = 0; k < 3; k++) {
      $("tab" + k).setAttribute("aria-selected", k === i ? "true" : "false");
      $("phone" + k).classList.toggle("active", k === i);
    }
    layout();
  }
  ["tab0", "tab1", "tab2"].forEach(function (t, i) {
    $(t).addEventListener("click", function () { if (S) S.manualTabAt = Date.now(); selectTab(i); });
  });

  function layout() {
    var wide = window.innerWidth >= 1000 && window.innerHeight >= 560;
    document.body.classList.toggle("wide", wide);
    var area = $("phonesArea");
    var phones = $("phones");
    if (phones.hidden) return;
    var w, h;
    if (wide) {
      var r = area.getBoundingClientRect();
      var labelH = 40, bezel = 18, gap = r.width > 1100 ? 28 : 20;
      phones.style.gap = gap + "px";
      var perW = (r.width - gap * 2) / 3 - bezel;
      var availH = r.height - labelH - bezel;
      w = Math.min(perW, availH * LW / LH, 440);
      h = w * LH / LW;
    } else {
      var cw = area.clientWidth;
      w = Math.min(cw - 12, 430);
      h = w * LH / LW;
    }
    w = Math.max(160, Math.floor(w));
    h = Math.floor(h);
    phones.style.setProperty("--screen-w", w + "px");
    phones.style.setProperty("--screen-h", h + "px");
    var scale = w / LW;
    phones.querySelectorAll("iframe").forEach(function (f) {
      f.style.width = LW + "px";
      f.style.height = Math.ceil(h / scale) + "px";
      f.style.transform = "scale(" + scale + ")";
    });
  }
  window.addEventListener("resize", function () { layout(); });

  function frameUrl(page, url) {
    var hash = "";
    try { hash = new URL(url).hash.slice(1); } catch (err) { hash = String(url).split("#")[1] || ""; }
    var extra = "&embed=1" + (LC.params.theme ? "&theme=" + encodeURIComponent(LC.params.theme) : "");
    return page + "#" + hash + extra;
  }
  function frameFor(i) { return $("screen" + i).querySelector("iframe"); }
  function post(i, msg) {
    var f = frameFor(i);
    if (f && f.contentWindow) {
      try { f.contentWindow.postMessage(Object.assign({ lc: true }, msg), location.origin); } catch (err) { /* frame gone */ }
    }
  }
  function refreshFrames() { for (var i = 0; i < 3; i++) post(i, { type: "refresh" }); }
  // A frame can miss one refresh (or poll just before a late event lands), so after
  // every change keep nudging all three for ~10 s. Extra loads are cheap and idempotent.
  var nudges = [];
  function refreshFramesForAWhile() {
    nudges.forEach(clearTimeout);
    nudges = [0, 1500, 3500, 6500, 10000].map(function (ms) { return setTimeout(refreshFrames, ms); });
  }

  window.addEventListener("message", function (ev) {
    if (ev.origin !== location.origin || !ev.data || !ev.data.lc) return;
    if (ev.data.type === "changed" && S) { S.poll.poke(); }
  });

  // ---------- run ----------
  function secretOf(url) { return new URLSearchParams(String(url).split("#")[1] || "").get("s"); }

  function resetUi() {
    cap.queue = [];
    $("demoTl").innerHTML = "";
    for (var i = 0; i < 3; i++) {
      $("screen" + i).innerHTML = "";
      $("pill" + i).innerHTML = "";
      $("phone" + i).classList.remove("spot");
      $("tdot" + i).className = "tdot";
    }
    $("stepper").innerHTML = "";
    $("capClock").hidden = true;
  }

  function start() {
    var run = { id: ++runSeq, view: null, seen: 0, created: null, poll: null, manualTabAt: 0, finaleShown: false, sig: "" };
    if (S && S.poll) S.poll.stop();
    S = run;
    resetUi();
    $("intro").hidden = true;
    $("replayBtn").hidden = true;
    sayNow({ tone: "calm", line: "Creating " + DEMO.name + "'s plan on the live API…", sub: "A real plan, real timers, real state machine. Nothing here is pre-recorded." });

    var body = {
      name: DEMO.name, activity: DEMO.activity, details: DEMO.details, routeUrl: DEMO.routeUrl, phone: DEMO.phone,
      checkInInSeconds: DEMO.checkInSeconds, // the server computes the deadline from its own clock
      remindMinutesBefore: DEMO.remindMinutesBefore, graceMinutes: DEMO.graceMinutes, ackMinutes: DEMO.ackMinutes,
      contacts: DEMO.contacts, location: DEMO.location
    };
    try { body.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (err) { /* UTC */ }

    return LC.api("/v1/plans", { method: "POST", body: body }).then(function (res) {
      if (run.id !== runSeq) return;
      run.created = res;
      run.ownerS = secretOf(res.ownerUrl);
      run.contactS = res.contacts.map(function (c) { return secretOf(c.alertUrl); });
      buildPhones(res);
      run.poll = LC.poller(function () { return pollOnce(run); }, 2000);
      handleView(res.plan, run);
      run.poll.start();
      $("replayBtn").hidden = false;
      $("replayBtn").innerHTML = LC.icons.refresh + "Replay";
    }, function (err) {
      if (run.id !== runSeq) return;
      sayNow({ tone: "error", line: "Couldn't start the demo.", sub: e(err.message) + (err.code === "rate_limited" ? "" : " Is the API running?") });
      $("replayBtn").hidden = false;
      $("replayBtn").innerHTML = LC.icons.refresh + "Try again";
    });
  }

  function buildPhones(res) {
    var c = res.contacts;
    var pages = [frameUrl("plan.html", res.ownerUrl), frameUrl("alert.html", c[0].alertUrl), frameUrl("alert.html", c[1].alertUrl)];
    var titles = [DEMO.name + "'s phone: the plan page", c[0].name + "'s phone: the alert page", c[1].name + "'s phone: the alert page"];
    for (var i = 0; i < 3; i++) {
      var f = document.createElement("iframe");
      f.title = titles[i];
      f.setAttribute("allow", "geolocation");
      f.setAttribute("scrolling", "no");
      f.src = pages[i];
      $("screen" + i).appendChild(f);
    }
    $("label0").textContent = DEMO.name;
    $("role0").textContent = "out alone, owner";
    for (var k = 0; k < 2; k++) {
      $("label" + (k + 1)).textContent = c[k].name;
      $("role" + (k + 1)).textContent = DEMO.contacts[k].relationship + ", contact #" + (k + 1);
      $("tabName" + (k + 1)).textContent = c[k].name;
    }
    $("tabName0").textContent = DEMO.name;
    document.body.classList.add("running");
    $("phones").hidden = false;
    $("tabs").hidden = false;
    $("side").hidden = false;
    $("stepper").hidden = false;
    $("links").innerHTML =
      '<li><a href="' + e(frameUrl("plan.html", res.ownerUrl).replace("&embed=1", "")) + '" target="_blank" rel="noopener">' + e(DEMO.name) + "'s plan page</a></li>" +
      c.map(function (x) { return '<li><a href="' + e(frameUrl("alert.html", x.alertUrl).replace("&embed=1", "")) + '" target="_blank" rel="noopener">' + e(x.name) + "'s alert page</a></li>"; }).join("");
    selectTab(0);
    layout();
    requestAnimationFrame(layout);
  }

  function pollOnce(run) {
    return LC.api("/v1/plans/" + encodeURIComponent(run.created.id) + "?s=" + encodeURIComponent(run.ownerS)).then(function (v) {
      if (run.id !== runSeq) return;
      setLive("ok");
      handleView(v, run);
    }, function () { if (run.id === runSeq) setLive("err"); });
  }

  function setLive(state) {
    $("live").className = "live" + (state === "err" ? " err" : state === "paused" ? " paused" : "");
    $("liveText").textContent = state === "err" ? "Reconnecting…" : state === "paused" ? "Finished" : "Live";
  }

  function handleView(v, run) {
    run = run || S;
    var prevSig = run.sig;
    run.view = v;
    run.sig = v.status + ":" + v.events.length;
    for (var i = run.seen; i < v.events.length; i++) queueBeat(beatFor(v.events[i], v, i));
    var fresh = v.events.length - run.seen;
    run.seen = v.events.length;
    if (prevSig !== run.sig) {
      if (prevSig) refreshFramesForAWhile();
      renderTimeline(v, fresh);
    }
    renderStatus(v);
    if (LC.isTerminal(v.status)) {
      if (run.poll) run.poll.stop();
      setLive("paused");
      if (!run.finaleShown) {
        run.finaleShown = true;
        // all_clear_sent events land a moment after "safe": poll a few more times
        [2000, 5000, 10000].forEach(function (ms) { setTimeout(function () { if (run.id === runSeq) pollOnce(run); }, ms); });
        if (v.status === "safe") setTimeout(function () { if (run.id === runSeq) queueBeat(finale(v)); }, 6500);
      }
    }
  }

  function renderTimeline(v, fresh) {
    var list = v.events.slice().reverse();
    $("demoTl").innerHTML = list.length ? list.map(function (ev, k) {
      var x = LC.eventView(ev, v);
      return '<li class="' + (x.tone ? "tl-" + x.tone : "") + (k < fresh && v.events.length > 1 ? " tl-new" : "") + '">' +
        '<span class="tl-icon">' + x.icon + "</span><div><div class=\"t1\">" + e(x.title) + "</div>" +
        '<div class="t2"><time datetime="' + e(ev.at) + '">' + e(LC.fmtTime(ev.at, true)) + "</time>" + (x.sub ? " · " + e(x.sub) : "") + "</div>" +
        (x.quote ? '<div class="t2">“' + e(x.quote) + "”</div>" : "") + "</div></li>";
    }).join("") : '<li class="empty">Waiting for the first event…</li>';
  }

  function stepState(v) {
    var ev = v.events, has = function (t, f) { return ev.some(function (x) { return x.type === t && (!f || f(x.detail || {})); }); };
    var cs = v.contacts;
    var steps = [
      { label: "Plan started", done: has("created") },
      { label: "Reminder", done: has("reminder_sent") },
      { label: "Missed check-in", done: has("overdue") },
      { label: (cs[0] ? cs[0].name : "Contact 1") + " alerted", done: has("alerted", function (d) { return d.index === 0; }) },
      { label: (cs[1] ? cs[1].name : "Contact 2") + " alerted", done: has("alerted", function (d) { return d.index === 1; }) },
      { label: "“I'm on it”", done: has("acknowledged") },
      { label: "Safe, all clear", done: has("safe") }
    ];
    var last = -1;
    steps.forEach(function (s, i) { if (s.done) last = i; });
    return steps.map(function (s, i) { return { label: s.label, cls: s.done ? (i === last ? "current" : "done") : i < last ? "skipped" : "" }; });
  }

  function renderStatus(v) {
    $("stepper").innerHTML = stepState(v).map(function (s) { return '<li class="' + s.cls + '">' + e(s.label) + "</li>"; }).join("");
    $("pill0").innerHTML = LC.statusPill(v.status);
    var tones = { brand: "t-brand", warn: "t-warn", no: "t-no", ok: "t-ok" };
    $("tdot0").className = "tdot " + (tones[LC.statusInfo(v.status).tone] || "");
    v.contacts.slice(0, 2).forEach(function (c, i) {
      $("pill" + (i + 1)).innerHTML = LC.contactChip(c);
      $("tdot" + (i + 1)).className = "tdot " + (c.allClearSent ? "t-ok" : c.state === "acknowledged" ? "t-brand" : c.state === "alerted" ? "t-no" : "");
    });
    tickClock();
  }

  // the big clock on the right of the caption
  function tickClock() {
    if (!S || !S.view) return;
    var v = S.view, now = LC.serverNow(), big = "", lbl = "", icon = null;
    var alerted = v.contacts.filter(function (c) { return c.state !== "standby"; });
    switch (v.status) {
      case "active": big = LC.clock(Date.parse(v.checkInBy) - now); lbl = "until check-in"; break;
      case "overdue": big = LC.clock(Date.parse(v.graceUntil) - now); lbl = "until contacts are alerted"; break;
      case "alerting": {
        var cur = alerted[alerted.length - 1], nxt = v.contacts[v.contacts.indexOf(cur) + 1];
        var at = cur && cur.alertedAt ? Date.parse(cur.alertedAt) + v.ackMinutes * 60000 : now;
        big = LC.clock(at - now);
        lbl = nxt ? "until " + nxt.name + " is alerted" : "for " + (cur ? cur.name : "them") + " to answer";
        break;
      }
      case "sos": big = "SOS"; lbl = "everyone alerted"; break;
      case "unanswered": big = "+" + LC.clock(now - Date.parse(v.checkInBy)); lbl = "overdue, no answer yet"; break;
      case "acknowledged": {
        var on = v.contacts.filter(function (c) { return c.state === "acknowledged"; }).map(function (c) { return c.name; });
        icon = LC.icons.hand; lbl = LC.listNames(on) + (on.length > 1 ? " are" : " is") + " on it"; break;
      }
      case "safe": icon = LC.icons.checkBold; lbl = v.name + " is safe"; break;
      default: $("capClock").hidden = true; return;
    }
    $("capClock").hidden = false;
    var html = icon || e(big);
    if ($("clockBig").innerHTML !== html) $("clockBig").innerHTML = html;
    if ($("clockLbl").textContent !== lbl) $("clockLbl").textContent = lbl;

    // ask the server right after a milestone instead of waiting for the next poll
    var ms = [];
    if (v.status === "active") { if (v.remindAt) ms.push(Date.parse(v.remindAt)); ms.push(Date.parse(v.checkInBy)); }
    if (v.status === "overdue") ms.push(Date.parse(v.graceUntil));
    if (v.status === "alerting" && alerted.length) ms.push(Date.parse(alerted[alerted.length - 1].alertedAt) + v.ackMinutes * 60000);
    for (var i = 0; i < ms.length; i++) {
      if (ms[i] > (S.poked || 0) && now >= ms[i] + 1300) { S.poked = ms[i]; if (S.poll) S.poll.poke(); break; }
    }
  }

  setInterval(function () {
    pumpCaptions();
    tickCaption();
    tickClock();
  }, 250);

  // ---------- scripted run for recording (?auto=1) ----------
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function waitFor(run, pred, timeoutMs) {
    var t0 = Date.now();
    return new Promise(function (resolve, reject) {
      (function check() {
        if (run.id !== runSeq) return reject(new Error("replaced"));
        if (run.view && pred(run.view)) return resolve(run.view);
        if (Date.now() - t0 > timeoutMs) return reject(new Error("timeout"));
        setTimeout(check, 200);
      })();
    });
  }
  function captionsIdle() { return new Promise(function (r) { (function c() { if (!cap.queue.length && Date.now() - cap.shownAt >= DWELL) r(); else setTimeout(c, 200); })(); }); }

  function tapThenCall(run, phoneIdx, action, note, call) {
    selectTab(phoneIdx);
    spotlight(phoneIdx, action === "safe" ? "safe" : "onit");
    post(phoneIdx, { type: "tap", action: action, note: note });
    return sleep(1000).then(function () {
      if (run.id !== runSeq) throw new Error("replaced");
      return call();
    }).then(function (v) {
      if (run.id !== runSeq) return;
      refreshFrames();
      return run.poll && run.poll.poke();
    });
  }

  function autoRun() {
    var started = start();
    var run = S;
    return started.then(function () {
      if (!run.created) throw new Error("not started");
      // the timers do the work: reminder, deadline, Alex times out, Jordan is alerted
      return waitFor(run, function (v) { return v.contacts[1] && v.contacts[1].state === "alerted"; }, 6 * 60000);
    }).then(function () { return captionsIdle(); }).then(function () { return sleep(4500); }).then(function () {
      return tapThenCall(run, 2, "ack", "On my way to the trailhead.", function () {
        return LC.api("/v1/plans/" + run.created.id + "/ack?c=1&s=" + encodeURIComponent(run.contactS[1]), { method: "POST", body: { note: "On my way to the trailhead." } });
      });
    }).then(function () {
      return waitFor(run, function (v) { return v.status === "acknowledged"; }, 30000);
    }).then(function () { return sleep(8000); }).then(function () {
      return tapThenCall(run, 0, "safe", null, function () {
        return LC.api("/v1/plans/" + run.created.id + "/checkin?s=" + encodeURIComponent(run.ownerS), { method: "POST", body: { action: "safe", note: "Phone died on the ridge. All good, back at the car." } });
      });
    }).catch(function (err) {
      if (err && err.message === "replaced") return;
      if (run.id === runSeq && err && err.status) sayNow({ tone: "error", line: "The scripted run hit a snag.", sub: e(err.message) });
    });
  }

  $("startBtn").addEventListener("click", function () { start(); });
  $("replayBtn").addEventListener("click", function () { if (AUTO) autoRun(); else start(); });

  window.LastCallDemo = { beatFor: beatFor, stepState: stepState, handleView: handleView, finale: finale };

  // intro caption
  showBeat({ tone: "calm", instant: true, line: "If you don't check in, the people you trust find out.",
    sub: AUTO ? "Watch a real plan miss its check-in. Sam's phone on the left, Sam's sister and friend on the right." :
      "Watch a real plan miss its check-in: Sam's phone and the phones of Sam's two contacts, side by side." });
  layout();
  if (AUTO) {
    $("intro").hidden = true;
    setTimeout(autoRun, 3000);
  }
})();
