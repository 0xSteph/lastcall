// DOM-free sanity checks for the web pages. Run: node --test mock/
//
// 1. Every page loads config.js first, only local scripts, and every element id
//    a page script looks up with $("...") exists in its HTML.
// 2. Every page's scripts run top to bottom inside a vm sandbox with a
//    permissive fake DOM (no jsdom, no dependencies), then the render paths are
//    driven with real API responses from the mock server for every plan state.
//    This catches syntax errors, undefined globals and exceptions in render code.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { createMockServer } from "./server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(here, "..", "web");
const read = (f) => fs.readFileSync(path.join(WEB, f), "utf8");
const PAGES = ["index.html", "new.html", "plan.html", "alert.html", "demo.html"];

// ---------- a fake DOM where everything exists ----------
function stub(name = "el") {
  const props = new Map();
  const fn = function () { return stub(name + "()"); };
  return new Proxy(fn, {
    get(t, k) {
      if (props.has(k)) return props.get(k);
      if (k === Symbol.toPrimitive) return (hint) => (hint === "number" ? 0 : "");
      if (k === Symbol.iterator) return function* () {};
      if (k === "then") return undefined; // never look like a promise
      if (k === "length") return 0;
      if (k === "toString" || k === "valueOf") return () => "";
      if (typeof k === "symbol") return undefined;
      const child = stub(name + "." + String(k));
      props.set(k, child);
      return child;
    },
    set(t, k, v) { props.set(k, v); return true; },
    apply() { return stub(name + "()"); },
    construct() { return stub("new " + name); },
  });
}

function sandbox(url, fetchImpl) {
  const loc = new URL(url);
  const byId = new Map();
  const listeners = [];
  const document = stub("document");
  document.getElementById = (id) => { if (!byId.has(id)) byId.set(id, stub("#" + id)); return byId.get(id); };
  document.querySelector = (s) => stub("qs(" + s + ")");
  document.querySelectorAll = () => [];
  document.createElement = (t) => stub("<" + t + ">");
  document.addEventListener = () => {};
  document.hidden = false;
  const storage = new Map();
  const ctx = {
    document,
    location: { href: loc.href, hash: loc.hash, search: loc.search, origin: loc.origin, pathname: loc.pathname },
    navigator: {},
    localStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: (k) => storage.delete(k) },
    fetch: fetchImpl,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: () => 0,
    addEventListener: (t, f) => listeners.push([t, f]),
    matchMedia: () => ({ matches: false }),
    scrollTo: () => {},
    innerWidth: 1920, innerHeight: 1080, isSecureContext: true,
    URL, URLSearchParams, Intl, Date, Math, JSON, Promise, Object, Array, String, Number, Boolean, RegExp, Error, Map, Set,
    TextEncoder, console,
  };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.parent = ctx;
  vm.createContext(ctx);
  return ctx;
}

function scriptsOf(html) {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map((m) => {
    const src = m[1].match(/src="([^"]+)"/);
    return src ? { src: src[1] } : { inline: m[2] };
  });
}

async function runPage(page, url, fetchImpl) {
  const ctx = sandbox(url, fetchImpl);
  for (const s of scriptsOf(read(page))) {
    const code = s.src ? read(s.src) : s.inline;
    vm.runInContext(code, ctx, { filename: s.src || page + " (inline)" });
  }
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  return ctx;
}

// ---------- real responses from the mock ----------
let server, base;
const views = { owner: {}, contact: {} };
let created;

before(async () => {
  server = createMockServer({ quiet: true, plansPerDay: 1000 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const j = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  };
  const plan = async () => {
    const res = await j("POST", "/v1/plans", {
      name: "Sam", activity: "Solo hike", details: "**Car:** blue\n- water\n- headlamp", routeUrl: "https://example.com/route", phone: "+1 555 0100",
      checkInBy: new Date(Date.now() + 600000).toISOString(), remindMinutesBefore: 5, graceMinutes: 2, ackMinutes: 3,
      contacts: [{ name: "Alex", relationship: "sister" }, { name: "Jordan" }], location: { lat: 37.9, lng: -122.5, accuracy: 20 },
    });
    const h = (u) => Object.fromEntries(new URLSearchParams(new URL(u).hash.slice(1)));
    const o = h(res.ownerUrl), c = res.contacts.map((x) => h(x.alertUrl));
    return {
      res,
      owner: () => j("GET", `/v1/plans/${res.id}?s=${encodeURIComponent(o.s)}`),
      contact: (i) => j("GET", `/v1/plans/${res.id}/alert?c=${i}&s=${encodeURIComponent(c[i].s)}`),
      ff: (s) => j("POST", `/_mock/plans/${res.id}/fast-forward?seconds=${s}`),
      checkin: (b) => j("POST", `/v1/plans/${res.id}/checkin?s=${encodeURIComponent(o.s)}`, b),
      ack: (i, b) => j("POST", `/v1/plans/${res.id}/ack?c=${i}&s=${encodeURIComponent(c[i].s)}`, b),
    };
  };
  const snap = async (p, key) => {
    views.owner[key] = await p.owner();
    views.contact[key + "/0"] = await p.contact(0);
    views.contact[key + "/1"] = await p.contact(1);
  };
  let p = await plan();
  created = p.res;
  await snap(p, "active");
  await p.ff(310); await snap(p, "active-reminded");
  await p.ff(300); await snap(p, "overdue");
  await p.ff(120); await snap(p, "alerting");
  await p.ff(180); await snap(p, "alerting-2");
  await p.ff(180); await snap(p, "unanswered");
  await p.ack(1, { note: "Driving up" }); await snap(p, "acknowledged");
  await p.checkin({ action: "safe", note: "All good" }); await snap(p, "safe");
  p = await plan();
  await p.checkin({ action: "sos", note: "Ankle" }); await snap(p, "sos");
  await p.ack(0, {}); await snap(p, "sos-acked");
  p = await plan();
  await p.ff(600 + 120 + 1); await p.ff(180); await p.ff(180); await p.ff(48 * 3600 + 5); await snap(p, "closed");
});
after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));

function fakeFetch(body) {
  return () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
}

// ---------- tests ----------
test("frames re-poll on refresh even after a final state, and look again after it", () => {
  for (const f of ["plan.js", "alert.js"]) {
    assert.match(read(f), /refresh: function \(\) \{ load\(\); \}/, f);
    assert.match(read(f), /\[2000, 5000, 10000\]\.forEach/, f);
  }
  assert.match(read("demo.js"), /refreshFramesForAWhile/);
});

test("pages load config.js first, local scripts only, and every $(id) exists", () => {
  for (const page of PAGES) {
    const html = read(page);
    const scripts = scriptsOf(html);
    assert.equal(scripts[0].src, "config.js", `${page} loads config.js first`);
    for (const s of scripts) {
      assert.ok(s.src, `${page}: no inline scripts`);
      assert.ok(!/^(https?:)?\/\//.test(s.src), `${page}: no external scripts`);
      assert.ok(fs.existsSync(path.join(WEB, s.src)), `${page}: ${s.src} exists`);
    }
    for (const m of html.matchAll(/<link\b[^>]*href="([^"]+)"/g)) {
      assert.ok(!/^https?:/.test(m[1]) || /^https:\/\/fonts\.(googleapis|gstatic)\.com/.test(m[1]), `${page}: external link ${m[1]}`);
    }
    assert.match(html, /<link rel="icon" href="favicon\.svg"/, `${page} has the favicon`);
    assert.match(html, /<meta name="viewport"/);
    for (const s of scripts.filter((x) => !["config.js", "common.js", "qr.js", "markdown.js"].includes(x.src))) {
      const js = read(s.src);
      for (const m of js.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)) {
        assert.ok(html.includes(`id="${m[1]}"`), `${page}: #${m[1]} used by ${s.src} is in the HTML`);
      }
    }
  }
});

test("pages that create plans or show alerts say Last Call is not an emergency service", () => {
  for (const page of ["index.html", "new.html", "demo.html"]) assert.match(read(page), /not an emergency service/, page);
  assert.match(read("common.js"), /not an emergency service/); // plan.html and alert.html render LC.notEmergency
  assert.match(read("plan.js"), /LC\.notEmergency/);
  assert.match(read("alert.js"), /LC\.notEmergency/);
});

test("no window.confirm, alert() or prompt() anywhere", () => {
  for (const f of fs.readdirSync(WEB).filter((x) => x.endsWith(".js"))) {
    assert.doesNotMatch(read(f), /\b(confirm|prompt)\s*\(|window\.alert\s*\(/, f);
  }
});

test("index.html and new.html scripts run", async () => {
  await runPage("index.html", "http://x.test/web/index.html", fakeFetch({}));
  const ctx = await runPage("new.html", "http://x.test/web/new.html", fakeFetch({}));
  assert.equal(typeof ctx.LC.api, "function");
  assert.equal(ctx.LC.apiBase, "http://localhost:8787");
  ctx.LastCallNew.showResult(created, { name: "Sam", activity: "Solo hike", checkInBy: created.plan.checkInBy, contacts: [{ relationship: "sister" }, {}] });
});

test("plan.html renders every plan state", async () => {
  const ctx = await runPage("plan.html", "http://x.test/web/plan.html#id=pln_x&s=y", fakeFetch(views.owner.active));
  assert.ok(ctx.LastCallPage.view(), "first poll rendered");
  for (const [k, v] of Object.entries(views.owner)) {
    ctx.LastCallPage.render(v);
    ctx.LastCallPage.tick();
    assert.equal(ctx.LastCallPage.view().status, v.status, k);
  }
  // incomplete link
  await runPage("plan.html", "http://x.test/web/plan.html", fakeFetch({}));
});

test("alert.html renders every plan state for every contact", async () => {
  const ctx = await runPage("alert.html", "http://x.test/web/alert.html#id=pln_x&c=0&s=y", fakeFetch(views.contact["active/0"]));
  assert.equal(ctx.LastCallPage.mode(), "standby");
  const expect = {
    "active/0": "standby", "overdue/0": "late", "alerting/0": "urgent", "alerting/1": "next", "alerting-2/1": "urgent",
    "acknowledged/0": "onit", "sos/1": "urgent", "sos-acked/0": "onit", "sos-acked/1": "onit", "safe/0": "safe", "closed/0": "closed",
  };
  for (const [k, v] of Object.entries(views.contact)) {
    ctx.LastCallPage.render(v);
    if (expect[k]) assert.equal(ctx.LastCallPage.mode(), expect[k], k);
  }
});

test("demo.html captions every event and walks the stepper", async () => {
  const ctx = await runPage("demo.html", "http://x.test/web/demo.html", fakeFetch({}));
  const D = ctx.LastCallDemo;
  const all = Object.values(views.owner);
  const lines = new Set();
  for (const v of all) v.events.forEach((ev, i) => { const b = D.beatFor(ev, v, i); if (b) lines.add(b.line); });
  for (const want of ["Sam is out on a solo hike. Check-in due in {clock}.", "Sam missed the check-in.", "Alex is alerted.",
    "Alex didn't answer in time; Jordan is alerted.", "Jordan: “I'm on it.”", "Sam checked in safe.", "Sam pressed “I need help”.",
    "Nobody has answered yet.", "The plan is closed."]) {
    assert.ok(lines.has(want), want);
  }
  const steps = D.stepState(views.owner.safe);
  assert.equal(steps.at(-1).cls, "current");
  assert.equal(steps[1].cls, "done");
  D.handleView(views.owner.active, { seen: 0, sig: "", id: 0 });
  assert.equal(D.finale(views.owner.safe).line, "Sam is safe. Everyone who was alerted knows.");
  assert.equal(D.finale(views.owner.safe).sub, "If you don't check in, the people you trust find out.");
});

test("common.js formatting helpers", async () => {
  const ctx = await runPage("index.html", "http://x.test/web/index.html#theme=dark", fakeFetch({}));
  const LC = ctx.LC;
  assert.equal(LC.clock(75000), "1:15");
  assert.equal(LC.clock(-5), "0:00");
  assert.equal(LC.clock(2 * 3600000 + 5 * 60000), "2h 05m");
  assert.equal(LC.span(12 * 60000), "12 min");
  assert.equal(LC.listNames(["Alex", "Jordan", "Sam"]), "Alex, Jordan and Sam");
  assert.equal(LC.minutesLabel(90), "1 h 30 min");
  assert.match(LC.osmEmbed(37.9, -122.5), /^https:\/\/www\.openstreetmap\.org\/export\/embed\.html\?bbox=-122\.5\d+,37\.8\d+,-122\.4\d+,37\.9\d+&layer=mapnik&marker=37\.9,-122\.5$/);
  assert.equal(LC.telHref("+1 (555) 0100"), "tel:+15550100");
  assert.equal(LC.params.theme, "dark");
  for (const s of ["active", "overdue", "alerting", "sos", "acknowledged", "unanswered", "safe", "closed"]) assert.notEqual(LC.statusInfo(s).label, s);
  for (const v of Object.values(views.owner)) for (const ev of v.events) assert.ok(LC.eventView(ev, v).title && !/_/.test(LC.eventView(ev, v).title), ev.type);
  assert.doesNotMatch(LC.timelineHtml([{ type: "safe", at: new Date().toISOString(), detail: { note: "<img src=x onerror=1>" } }], { name: "<b>" }), /<img|<b>/);
});
