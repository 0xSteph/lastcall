/* new.js — create a plan (new.html) and hand out the links. */
(function () {
  "use strict";
  var LC = window.LC;
  var $ = function (id) { return document.getElementById(id); };
  var MAX_CONTACTS = 5;
  var e = LC.esc;

  // ---------- check-in time ----------
  var pad = function (n) { return String(n).padStart(2, "0"); };
  function toLocalInput(ms) {
    var d = new Date(ms);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + "T" + pad(d.getHours()) + ":" + pad(d.getMinutes());
  }
  function fromLocalInput(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v || "");
    if (!m) return NaN;
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  }
  function tonight() {
    var d = new Date();
    d.setHours(22, 0, 0, 0);
    if (d.getTime() - Date.now() < 15 * 60000) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  var quickSeconds = null; // a +1 h / +3 h chip: let the server count from its own clock
  function setCheckIn(ms, chip, seconds) {
    quickSeconds = seconds || null;
    $("checkInBy").value = toLocalInput(ms);
    document.querySelectorAll("[data-quick]").forEach(function (b) { b.setAttribute("aria-pressed", b === chip ? "true" : "false"); });
    updateHint();
  }
  function updateHint() {
    var t = fromLocalInput($("checkInBy").value);
    var hint = $("checkInHint");
    if (!t) { hint.textContent = ""; return; }
    var d = t - Date.now();
    if (d < 2 * 60000) hint.textContent = "Pick a time at least a couple of minutes from now.";
    else if (d > 7 * 86400000) hint.textContent = "Plans can last up to 7 days.";
    else hint.textContent = "That's " + LC.span(Math.round(d / 60000) * 60000) + " from now (" + LC.fmtWhen(t, Date.now()) + "). You can add time later.";
  }
  $("tonightChip").textContent = new Date(tonight()).getDate() === new Date().getDate() ? "Tonight 10 PM" : "Tomorrow 10 PM";
  document.querySelectorAll("[data-quick]").forEach(function (b) {
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", function () {
      var q = b.getAttribute("data-quick");
      if (q === "tonight") setCheckIn(tonight(), b);
      else setCheckIn(Date.now() + Number(q) * 60000, b, Number(q) * 60);
    });
  });
  $("checkInBy").addEventListener("input", function () {
    quickSeconds = null;
    document.querySelectorAll("[data-quick]").forEach(function (b) { b.setAttribute("aria-pressed", "false"); });
    updateHint();
  });
  $("checkInBy").min = toLocalInput(Date.now() + 2 * 60000);
  $("checkInBy").max = toLocalInput(Date.now() + 7 * 86400000 - 60000);
  setCheckIn(Date.now() + 3 * 3600000, document.querySelector('[data-quick="180"]'), 3 * 3600);

  // ---------- contacts ----------
  var rowSeq = 0;
  function contactRow() {
    var n = ++rowSeq;
    var div = document.createElement("div");
    div.className = "contact-row";
    div.innerHTML =
      '<div class="head"><b class="cnum"></b><button type="button" class="icon-btn remove" aria-label="Remove this contact">' + LC.icons.trash + "</button></div>" +
      '<div class="row-2">' +
      '<div class="field"><label class="label" for="cName' + n + '">Name</label><input class="input c-name" id="cName' + n + '" maxlength="40" required placeholder="Alex" autocomplete="off"></div>' +
      '<div class="field"><label class="label" for="cRel' + n + '">Relationship <span class="opt">(optional)</span></label><input class="input c-rel" id="cRel' + n + '" maxlength="40" placeholder="sister" autocomplete="off"></div>' +
      "</div>" +
      '<div class="field"><label class="label" for="cUrl' + n + '">How to reach them <span class="opt">(optional)</span></label>' +
      '<input class="input c-url" id="cUrl' + n + '" type="url" inputmode="url" maxlength="2048" placeholder="Leave blank to create a free ntfy push channel" autocomplete="off">' +
      '<span class="hint">Blank is easiest: you get a subscribe link to send them. Or paste an https ntfy.sh topic, Slack or Discord webhook URL.</span></div>';
    div.querySelector(".remove").addEventListener("click", function () {
      div.remove();
      renumber();
    });
    return div;
  }
  function renumber() {
    var rows = $("contacts").querySelectorAll(".contact-row");
    rows.forEach(function (r, i) {
      r.querySelector(".cnum").textContent = i === 0 ? "Contact 1 · alerted first" : "Contact " + (i + 1) + " · if nobody answers before";
      r.querySelector(".remove").hidden = rows.length === 1;
    });
    $("addContact").hidden = rows.length >= MAX_CONTACTS;
    $("addContact").innerHTML = LC.icons.plus + (rows.length ? "Add another contact" : "Add a contact");
  }
  $("addContact").addEventListener("click", function () {
    var r = contactRow();
    $("contacts").appendChild(r);
    renumber();
    r.querySelector(".c-name").focus();
  });
  $("contacts").appendChild(contactRow());
  renumber();

  // ---------- plans saved on this device ----------
  function renderSaved() {
    var list = LC.savedPlans().filter(function (p) { return Date.parse(p.checkInBy) > Date.now() - 2 * 86400000; });
    var el = $("saved");
    if (!list.length) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = '<p class="label">Your plans on this device</p><ul>' + list.map(function (p) {
      return '<li><a href="' + e(p.ownerUrl) + '">' + e(p.activity) + "<span>due " + e(LC.fmtWhen(p.checkInBy, Date.now())) + "</span></a></li>";
    }).join("") + "</ul>";
  }
  renderSaved();

  // ---------- submit ----------
  function fail(msg, field) {
    var box = $("formError");
    box.hidden = false;
    box.innerHTML = LC.icons.alert + "<span>" + e(msg) + "</span>";
    if (field) { field.setAttribute("aria-invalid", "true"); field.focus(); }
  }
  document.addEventListener("input", function (ev) { if (ev.target.removeAttribute) ev.target.removeAttribute("aria-invalid"); });

  function getLocation() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) return resolve(null);
      navigator.geolocation.getCurrentPosition(function (p) {
        resolve({ lat: Math.round(p.coords.latitude * 1e6) / 1e6, lng: Math.round(p.coords.longitude * 1e6) / 1e6, accuracy: Math.min(100000, Math.round(p.coords.accuracy || 0)) });
      }, function () { resolve(null); }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 });
    });
  }

  $("planForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    $("formError").hidden = true;
    var name = $("name").value.trim(), activity = $("activity").value.trim();
    if (!name) return fail("Add your first name so your contacts know who this is about.", $("name"));
    if (!activity) return fail("Say what you're doing, for example “Solo hike: Dipsea Trail loop”.", $("activity"));
    var t = fromLocalInput($("checkInBy").value);
    if (!t) return fail("Pick a check-in time.", $("checkInBy"));
    if (!quickSeconds && t - Date.now() < 90 * 1000) return fail("Pick a check-in time at least a couple of minutes from now.", $("checkInBy"));
    if (t - Date.now() > 7 * 86400000) return fail("Plans can last up to 7 days.", $("checkInBy"));
    var routeUrl = $("routeUrl").value.trim();
    if (routeUrl && !LC.isHttpUrl(routeUrl)) return fail("The route link should start with https://", $("routeUrl"));
    var contacts = [];
    var rows = $("contacts").querySelectorAll(".contact-row");
    for (var i = 0; i < rows.length; i++) {
      var cn = rows[i].querySelector(".c-name"), cu = rows[i].querySelector(".c-url");
      var c = { name: cn.value.trim(), relationship: rows[i].querySelector(".c-rel").value.trim() };
      var url = cu.value.trim();
      if (!c.name) return fail("Every contact needs a name.", cn);
      if (url) {
        if (!/^https:\/\//i.test(url)) return fail("Contact links must start with https:// (or leave it blank).", cu);
        c.notifyUrl = url;
      }
      contacts.push(c);
    }
    if (!contacts.length) return fail("Add at least one contact.", null);
    var ownerUrl = $("ownerNotifyUrl").value.trim();
    if (ownerUrl && !/^https:\/\//i.test(ownerUrl)) return fail("Your reminder link must start with https:// (or leave it blank).", $("ownerNotifyUrl"));

    var body = {
      name: name, activity: activity,
      remindMinutesBefore: Number($("remind").value), graceMinutes: Number($("grace").value), ackMinutes: Number($("ack").value),
      contacts: contacts
    };
    if (quickSeconds) body.checkInInSeconds = quickSeconds;
    else body.checkInBy = new Date(t).toISOString();
    var details = $("details").value.trim(), phone = $("phone").value.trim();
    if (details) body.details = details;
    if (routeUrl) body.routeUrl = routeUrl;
    if (phone) body.phone = phone;
    if (ownerUrl) body.ownerNotifyUrl = ownerUrl;
    try { body.timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (err) { /* default UTC */ }

    var btn = $("submitBtn");
    LC.setBusy(btn, true, $("useLocation").checked ? "Getting your location…" : "Starting your plan…");
    (($("useLocation").checked) ? getLocation() : Promise.resolve(null)).then(function (loc) {
      if (loc) body.location = loc;
      else if ($("useLocation").checked) LC.toast("Couldn't get your location; starting without it.", "error");
      return LC.api("/v1/plans", { method: "POST", body: body });
    }).then(function (res) {
      LC.setBusy(btn, false);
      LC.savePlan({ id: res.id, ownerUrl: res.ownerUrl, activity: activity, checkInBy: res.plan ? res.plan.checkInBy : body.checkInBy || new Date().toISOString() });
      showResult(res, body);
    }, function (err) {
      LC.setBusy(btn, false);
      fail(err.code === "rate_limited" ? "You've reached today's limit of plans from this network. Try again tomorrow." : err.message, null);
    });
  });

  // ---------- result ----------
  function linkBox(url, aria) {
    return '<div class="link-box"><span class="link-text">' + e(url) + "</span>" + LC.copyButton(url, "Copy", aria) + "</div>";
  }
  function messageFor(activity, when, c) {
    var msg = "I'm using Last Call for " + activity + ". If I don't check in by " + when + ", you'll get an alert.";
    if (c.subscribeUrl) msg += " Tap to subscribe: " + c.subscribeUrl;
    return msg;
  }

  function showResult(res, input) {
    var plan = res.plan || {};
    var checkInBy = plan.checkInBy || input.checkInBy || new Date(Date.now() + (input.checkInInSeconds || 0) * 1000).toISOString();
    var when = LC.fmtWhen(checkInBy, Date.now());
    var names = res.contacts.map(function (c) { return c.name; });
    var order = names.length > 1 ? names[0] + " hears first, then " + LC.listNames(names.slice(1)) + "." : names[0] + " gets an alert.";
    var html = '<div class="result-head"><div class="badge">' + LC.icons.checkBold + "</div>" +
      "<h1>You're all set, " + e(input.name) + ".</h1>" +
      "<p>Check in by <b>" + e(when) + "</b>. If you don't, " + e(order) + "</p></div>" +
      '<div class="result-grid">';

    html += '<div class="card share-card"><h2>Your check-in page</h2><div class="share-split">' +
      '<div class="qr-box">' + LC.qrSvg(res.ownerUrl, "QR code for your check-in page") + "</div><div style=\"display:grid;gap:12px\">" +
      "<p class=\"muted\">Open this on your phone and keep it handy. One tap on <b>I'm safe</b> is all it takes.</p>" +
      linkBox(res.ownerUrl, "Copy your check-in link") +
      '<div class="share-actions"><a class="btn btn-primary" href="' + e(res.ownerUrl) + '">Open my check-in page</a></div>' +
      '<p class="hint">Add it to your home screen: on iPhone tap Share, then Add to Home Screen; on Android tap the menu, then Add to home screen. Anyone with this link can check in for you, so keep it private.</p>' +
      "</div></div></div>";

    if (res.ownerSubscribeUrl) {
      html += '<div class="card share-card"><h2>Get your reminder as a push</h2><div class="share-split">' +
        '<div class="qr-box">' + LC.qrSvg(res.ownerSubscribeUrl, "QR code to subscribe to your reminders") + "</div><div style=\"display:grid;gap:12px\">" +
        "<p class=\"muted\">Install the free <b>ntfy</b> app (or use it in your browser), then open this link to subscribe. Your reminder and missed check-in ping arrive here with one-tap <b>I'm safe</b> and <b>+30 min</b> buttons.</p>" +
        linkBox(res.ownerSubscribeUrl, "Copy your subscribe link") +
        '<div class="share-actions"><a class="btn" href="' + e(res.ownerSubscribeUrl) + '" target="_blank" rel="noopener noreferrer">' + LC.icons.bell + "Subscribe in ntfy</a></div>" +
        "</div></div></div>";
    }

    html += '<div class="section-head" style="margin:14px 0 0"><h2 style="font-size:22px;font-weight:800">Tell your contacts</h2><p class="muted" style="margin-top:4px">Send each person their message so they can subscribe before you leave.</p></div>';
    res.contacts.forEach(function (c, i) {
      var inputC = (input.contacts && input.contacts[i]) || {};
      var msg = messageFor(input.activity, when, c);
      html += '<div class="card share-card"><h2>' + e(c.name) + " <small>" + e([inputC.relationship, i === 0 ? "alerted first" : "#" + (i + 1) + " in line"].filter(Boolean).join(" · ")) + "</small></h2>" +
        '<div class="message-box">' + e(msg) + "</div>" +
        '<div class="share-actions"><button type="button" class="btn btn-primary" data-share="' + i + '">' + LC.icons.share + "Share message</button>" + LC.copyButton(msg, "Copy message", "Copy the message for " + c.name) + "</div>" +
        '<details class="adv"><summary>Links for ' + e(c.name) + "</summary><div style=\"display:grid;gap:10px\">" +
        '<p class="hint">Their alert page (they get this in the alert itself, too):</p>' + linkBox(c.alertUrl, "Copy " + c.name + "'s alert link") +
        (c.subscribeUrl ? '<p class="hint">Their push subscribe link:</p>' + linkBox(c.subscribeUrl, "Copy " + c.name + "'s subscribe link") +
          '<div class="qr-box" style="width:150px">' + LC.qrSvg(c.subscribeUrl, "QR code for " + c.name + "'s subscribe link") + "</div>" : '<p class="hint">Alerts go to the link you gave for ' + e(c.name) + ".</p>") +
        "</div></details></div>";
      c._msg = msg;
    });
    html += '<div class="share-actions" style="justify-content:center;margin-top:8px"><a class="btn btn-primary btn-lg" href="' + e(res.ownerUrl) + '">Open my check-in page</a><a class="btn btn-lg" href="new.html">Plan another</a></div>' +
      LC.notEmergency + "</div>";

    $("formView").hidden = true;
    var rv = $("resultView");
    rv.hidden = false;
    rv.innerHTML = html;
    rv.querySelectorAll("[data-share]").forEach(function (b) {
      b.addEventListener("click", function () {
        var c = res.contacts[Number(b.getAttribute("data-share"))];
        LC.share(c._msg, "Last Call").then(function (how) {
          if (how === "copied") LC.toast("Message copied. Paste it to " + c.name + ".");
        }, function () { LC.toast("Couldn't share. Copy the message instead.", "error"); });
      });
    });
    window.scrollTo(0, 0);
  }

  LC.bindCopyButtons(document);
  window.LastCallNew = { showResult: showResult };
})();
