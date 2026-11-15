// End-to-end tests of the Last Call mock API (mock/server.mjs). Run: node --test mock/
// Time-based transitions are driven with the mock-only fast-forward endpoint,
// so the whole state machine is covered without waiting minutes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createMockServer } from "./server.mjs";

let server, base;
before(async () => {
  server = createMockServer({ quiet: true, plansPerDay: 1000 });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));

async function call(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, headers: res.headers, text };
}

const inSeconds = (s) => new Date(Date.now() + s * 1000).toISOString();
const frag = (u) => Object.fromEntries(new URLSearchParams(new URL(u).hash.slice(1)));

function planBody(extra = {}) {
  return {
    name: "Sam", activity: "Solo hike: Dipsea Trail loop", details: "**Car:** blue Corolla",
    routeUrl: "https://www.openstreetmap.org/#map=14/37.9/-122.6", phone: "+1 555 0100",
    checkInBy: inSeconds(600), remindMinutesBefore: 5, graceMinutes: 2, ackMinutes: 3,
    contacts: [{ name: "Alex", relationship: "sister" }, { name: "Jordan", relationship: "friend" }],
    location: { lat: 37.9057, lng: -122.5476, accuracy: 25 }, timeZone: "America/Los_Angeles",
    ...extra,
  };
}

async function newPlan(extra) {
  const r = await call("POST", "/v1/plans", planBody(extra));
  assert.equal(r.status, 201, r.text);
  const owner = frag(r.json.ownerUrl);
  const contacts = r.json.contacts.map((c) => frag(c.alertUrl));
  const id = r.json.id;
  return {
    res: r.json, id,
    view: () => call("GET", `/v1/plans/${id}?s=${encodeURIComponent(owner.s)}`),
    alert: (i) => call("GET", `/v1/plans/${id}/alert?c=${i}&s=${encodeURIComponent(contacts[i].s)}`),
    checkin: (body, q = "") => call("POST", `/v1/plans/${id}/checkin?s=${encodeURIComponent(owner.s)}${q}`, body),
    location: (body) => call("POST", `/v1/plans/${id}/location?s=${encodeURIComponent(owner.s)}`, body),
    ack: (i, body, q = "") => call("POST", `/v1/plans/${id}/ack?c=${i}&s=${encodeURIComponent(contacts[i].s)}${q}`, body),
    ff: (seconds) => call("POST", `/_mock/plans/${id}/fast-forward?seconds=${seconds}`),
    ownerSecret: owner.s, contactSecrets: contacts.map((c) => c.s),
  };
}
const types = (v) => v.events.map((e) => e.type);

test("create returns links, generated ntfy topics and the owner view", async () => {
  const pl = await newPlan();
  const r = pl.res;
  assert.match(r.id, /^pln_[0-9a-hjkmnp-tv-z]{16}$/);
  assert.match(r.ownerUrl, new RegExp(`/web/plan\\.html#id=${r.id}&s=[A-Za-z0-9_-]{32}$`));
  assert.match(r.ownerSubscribeUrl, /^https:\/\/ntfy\.sh\/lastcall-[a-z0-9]{24}$/);
  assert.equal(r.contacts.length, 2);
  r.contacts.forEach((c, i) => {
    assert.match(c.alertUrl, new RegExp(`/web/alert\\.html#id=${r.id}&c=${i}&s=[A-Za-z0-9_-]{32}$`));
    assert.match(c.subscribeUrl, /^https:\/\/ntfy\.sh\/lastcall-[a-z0-9]{24}$/);
  });
  assert.notEqual(r.contacts[0].subscribeUrl, r.contacts[1].subscribeUrl);
  const v = r.plan;
  assert.equal(v.status, "active");
  for (const k of ["id", "name", "activity", "details", "routeUrl", "phone", "status", "createdAt", "checkInBy", "graceUntil",
    "remindAt", "graceMinutes", "ackMinutes", "safeAt", "closedAt", "lastLocation", "locations", "contacts", "events", "now"]) {
    assert.ok(k in v, `owner view has ${k}`);
  }
  assert.equal(Date.parse(v.graceUntil) - Date.parse(v.checkInBy), 2 * 60000);
  assert.equal(Date.parse(v.checkInBy) - Date.parse(v.remindAt), 5 * 60000);
  assert.deepEqual(v.contacts[0], { name: "Alex", relationship: "sister", state: "standby", alertedAt: null, acknowledgedAt: null, note: null, allClearSent: false });
  assert.equal(v.lastLocation.lat, 37.9057);
  assert.equal(v.locations.length, 1);
  assert.deepEqual(types(v), ["created"]);
  assert.ok(Math.abs(Date.parse(v.now) - Date.now()) < 5000);
});

test("given notify URLs are used and not echoed back as subscribe links", async () => {
  const pl = await newPlan({
    ownerNotifyUrl: "https://ntfy.sh/my-own-topic",
    contacts: [{ name: "Alex", notifyUrl: "https://hooks.slack.com/services/T/B/x" }, { name: "Jo" }],
  });
  assert.equal(pl.res.ownerSubscribeUrl, undefined);
  assert.equal(pl.res.contacts[0].subscribeUrl, undefined);
  assert.match(pl.res.contacts[1].subscribeUrl, /ntfy\.sh\/lastcall-/);
  await pl.ff(600 + 120);
  const v = (await pl.view()).json;
  const alerted = v.events.find((e) => e.type === "alerted");
  assert.equal(alerted.detail.channel, "slack");
});

test("views never leak secrets, hashes or notify URLs", async () => {
  const pl = await newPlan({ ownerNotifyUrl: "https://ntfy.sh/owner-private-topic" });
  const owner = (await pl.view()).text;
  const contact = (await pl.alert(0)).text;
  for (const text of [owner, contact]) {
    assert.ok(!text.includes(pl.ownerSecret));
    for (const s of pl.contactSecrets) assert.ok(!text.includes(s));
    assert.ok(!text.includes("ntfy.sh"), "no notify urls");
    assert.ok(!/hash|token|secret/i.test(text));
  }
});

test("contact view drops locations and adds you", async () => {
  const pl = await newPlan();
  const r = await pl.alert(1);
  assert.equal(r.status, 200);
  assert.equal(r.json.locations, undefined);
  assert.equal(r.json.lastLocation.lng, -122.5476);
  assert.deepEqual(r.json.you, { index: 1, name: "Jordan", state: "standby" });
});

test("validation errors use the error envelope", async () => {
  const cases = [
    [{ name: "" }, /name/],
    [{ name: "x".repeat(41) }, /name/],
    [{ activity: undefined }, /activity/],
    [{ activity: "x".repeat(121) }, /activity/],
    [{ details: "x".repeat(4001) }, /details/],
    [{ checkInBy: "tomorrow" }, /checkInBy/],
    [{ checkInBy: inSeconds(30) }, /60 seconds/],
    [{ checkInBy: inSeconds(8 * 86400) }, /7 days/],
    [{ remindMinutesBefore: 121 }, /remindMinutesBefore/],
    [{ graceMinutes: -1 }, /graceMinutes/],
    [{ ackMinutes: 0 }, /ackMinutes/],
    [{ ackMinutes: 1.5 }, /ackMinutes/],
    [{ contacts: [] }, /contacts/],
    [{ contacts: Array.from({ length: 6 }, (_, i) => ({ name: "c" + i })) }, /contacts/],
    [{ contacts: [{ name: "" }] }, /contacts\[0\]\.name/],
    [{ contacts: [{ name: "A", relationship: "x".repeat(41) }] }, /relationship/],
    [{ contacts: [{ name: "A", notifyUrl: "http://ntfy.sh/x" }] }, /https/],
    [{ contacts: [{ name: "A", notifyUrl: "https://127.0.0.1/x" }] }, /public/],
    [{ ownerNotifyUrl: "https://localhost/x" }, /public/],
    [{ routeUrl: "javascript:alert(1)" }, /routeUrl/],
    [{ phone: "<script>" }, /phone/],
    [{ location: { lat: 91, lng: 0 } }, /lat/],
    [{ location: { lat: 0, lng: 181 } }, /lng/],
    [{ location: { lat: 0, lng: 0, accuracy: -1 } }, /accuracy/],
    [{ timeZone: "Mars/Olympus" }, /timeZone/],
  ];
  for (const [extra, re] of cases) {
    const r = await call("POST", "/v1/plans", planBody(extra));
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.equal(r.json.error.code, "validation_error");
    assert.match(r.json.error.message, re, JSON.stringify(extra));
  }
  const j = await call("POST", "/v1/plans", "{not json");
  assert.equal(j.status, 400);
  assert.equal(j.json.error.code, "invalid_json");
});

test("checkInInSeconds: deadline from the server clock; exactly one of the two fields", async () => {
  const body = planBody({ checkInBy: undefined, checkInInSeconds: 75 });
  delete body.checkInBy;
  const r = await call("POST", "/v1/plans", body);
  assert.equal(r.status, 201, r.text);
  const due = Date.parse(r.json.plan.checkInBy) - Date.parse(r.json.plan.now);
  assert.ok(due > 74000 && due <= 75000, `due in ${due} ms`);
  for (const [extra, re] of [
    [{ checkInInSeconds: 59 }, /checkInInSeconds/],
    [{ checkInInSeconds: 604801 }, /checkInInSeconds/],
    [{ checkInInSeconds: 90.5 }, /checkInInSeconds/],
    [{ checkInInSeconds: 120, checkInBy: inSeconds(600) }, /exactly one/],
    [{ checkInBy: undefined }, /exactly one/],
  ]) {
    const b = { ...planBody(), ...extra };
    if (extra.checkInBy === undefined && !("checkInInSeconds" in extra)) delete b.checkInBy;
    else if (!("checkInBy" in extra)) delete b.checkInBy;
    const res = await call("POST", "/v1/plans", b);
    assert.equal(res.status, 400, JSON.stringify(extra));
    assert.match(res.json.error.message, re);
  }
  // 5 s of skew allowance on checkInBy
  const ok = await call("POST", "/v1/plans", planBody({ checkInBy: inSeconds(57) }));
  assert.equal(ok.status, 201);
});

test("defaults: reminder 15, grace 15, ack 10, UTC", async () => {
  const r = await call("POST", "/v1/plans", { name: "Sam", activity: "Walk", checkInBy: inSeconds(3600), contacts: [{ name: "Alex" }] });
  assert.equal(r.status, 201);
  assert.equal(r.json.plan.graceMinutes, 15);
  assert.equal(r.json.plan.ackMinutes, 10);
  assert.equal(Date.parse(r.json.plan.checkInBy) - Date.parse(r.json.plan.remindAt), 15 * 60000);
  assert.equal(r.json.plan.details, null);
  assert.equal(r.json.plan.timeZone, "UTC");
  assert.equal(r.json.plan.remindMinutesBefore, 15);
  assert.equal(r.json.plan.lastLocation, null);
});

test("auth: wrong secret 401, unknown plan 404, bad contact index 401", async () => {
  const pl = await newPlan();
  let r = await call("GET", `/v1/plans/${pl.id}?s=nope`);
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, "invalid_secret");
  r = await call("GET", `/v1/plans/${pl.id}`);
  assert.equal(r.status, 401);
  r = await call("GET", `/v1/plans/pln_0000000000000000?s=x`);
  assert.equal(r.status, 404);
  assert.equal(r.json.error.code, "not_found");
  r = await call("GET", `/v1/plans/${pl.id}/alert?c=1&s=${encodeURIComponent(pl.contactSecrets[0])}`);
  assert.equal(r.status, 401, "contact 0's secret does not open contact 1");
  r = await call("GET", `/v1/plans/${pl.id}/alert?c=9&s=x`);
  assert.equal(r.status, 404, "unknown contact index");
  r = await call("GET", `/v1/plans/not-a-plan?s=x`);
  assert.equal(r.status, 404);
  r = await call("POST", `/v1/plans/${pl.id}/checkin?s=${encodeURIComponent(pl.contactSecrets[0])}`, { action: "safe" });
  assert.equal(r.status, 401, "a contact secret cannot check in");
});

test("timeline: reminder -> overdue -> alerting -> next contact -> unanswered -> closed", async () => {
  const pl = await newPlan(); // check in 600 s, remind 5 min before, grace 2, ack 3
  await pl.ff(200);
  let v = (await pl.view()).json;
  assert.equal(v.status, "active");
  assert.deepEqual(types(v), ["created"]);

  await pl.ff(110); // 310 s: past remindAt (300 s)
  v = (await pl.view()).json;
  assert.equal(v.status, "active");
  assert.deepEqual(types(v), ["created", "reminder_sent"]);

  await pl.ff(300); // 610 s: deadline passed, inside grace
  v = (await pl.view()).json;
  assert.equal(v.status, "overdue");
  assert.deepEqual(types(v).slice(-2), ["overdue", "owner_pinged"]);
  assert.equal(v.events.at(-1).detail.ok, true);
  assert.ok(v.contacts.every((c) => c.state === "standby"));
  assert.equal((await pl.alert(0)).json.you.state, "standby");

  await pl.ff(120); // 730 s: grace over
  v = (await pl.view()).json;
  assert.equal(v.status, "alerting");
  assert.equal(v.contacts[0].state, "alerted");
  assert.ok(Date.parse(v.contacts[0].alertedAt) >= Date.parse(v.graceUntil), "alerted when the workflow actually ran");
  assert.equal(v.contacts[1].state, "standby");
  const a0 = v.events.at(-1);
  assert.deepEqual(a0.detail, { index: 0, name: "Alex", channel: "ntfy", ok: true });

  const r = await pl.ack(1, {});
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "not_alerted");

  await pl.ff(180); // Alex's 3 minutes are up
  v = (await pl.view()).json;
  assert.equal(v.status, "alerting");
  assert.equal(v.contacts[0].state, "alerted", "Alex stays alerted");
  assert.equal(v.contacts[1].state, "alerted");
  const gap = Date.parse(v.contacts[1].alertedAt) - Date.parse(v.contacts[0].alertedAt);
  assert.ok(gap >= 180000 && gap < 182000, `next contact ackMinutes after the previous one's actual alert (${gap})`);

  await pl.ff(180);
  v = (await pl.view()).json;
  assert.equal(v.status, "unanswered");
  assert.equal(types(v).at(-1), "unanswered");

  const ext = await pl.checkin({ action: "extend", minutes: 30 });
  assert.equal(ext.status, 409);
  assert.equal(ext.json.error.code, "cannot_extend");

  await pl.ff(48 * 3600);
  v = (await pl.view()).json;
  assert.equal(v.status, "closed");
  assert.ok(v.closedAt);
  assert.equal(types(v).at(-1), "closed");

  for (const [res, code] of [
    [await pl.checkin({ action: "safe" }), "closed"],
    [await pl.checkin({ action: "sos" }), "closed"],
    [await pl.location({ lat: 1, lng: 2 }), "closed"],
    [await pl.ack(0, {}), "closed"],
  ]) {
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, code);
  }
});

test("a big jump applies due milestones, timing the next contact from the actual alert", async () => {
  const pl = await newPlan();
  await pl.ff(600 + 120 + 180 + 180 + 5);
  let v = (await pl.view()).json;
  assert.equal(v.status, "alerting");
  assert.deepEqual(types(v), ["created", "overdue", "owner_pinged", "alerted"], "reminder skipped once the deadline passed");
  assert.deepEqual(v.events[1].detail, { checkInBy: v.checkInBy });
  await pl.ff(180);
  await pl.ff(180);
  v = (await pl.view()).json;
  assert.equal(v.status, "unanswered");
});

test("acknowledge stops escalation; later acks are allowed; closes 48 h after", async () => {
  const pl = await newPlan();
  await pl.ff(600 + 120 + 1);
  let r = await pl.ack(0, { note: "Calling her now" });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "acknowledged");
  assert.deepEqual(r.json.you, { index: 0, name: "Alex", state: "acknowledged" });
  assert.equal(r.json.contacts[0].note, "Calling her now");
  assert.ok(r.json.contacts[0].acknowledgedAt);
  assert.deepEqual(r.json.events.at(-1).detail, { index: 0, name: "Alex", note: "Calling her now" });

  r = await pl.ack(0, {});
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "already_acknowledged");

  await pl.ff(3600); // no escalation to Jordan once acknowledged
  let v = (await pl.view()).json;
  assert.equal(v.status, "acknowledged");
  assert.equal(v.contacts[1].state, "standby");

  await pl.ff(47 * 3600);
  v = (await pl.view()).json;
  assert.equal(v.status, "closed");
});

test("ack from unanswered moves the plan to acknowledged; one-tap ?a=ack works", async () => {
  const pl = await newPlan();
  await pl.ff(600 + 120 + 1);
  await pl.ff(180);
  await pl.ff(180);
  assert.equal((await pl.view()).json.status, "unanswered");
  const r = await pl.ack(1, undefined, "&a=ack");
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "acknowledged");
  assert.equal(r.json.contacts[1].state, "acknowledged");
});

test("safe from alerting sends the all clear to every alerted contact only", async () => {
  const pl = await newPlan();
  await pl.ff(600 + 120 + 1);
  await pl.ack(0, {});
  const r = await pl.checkin({ action: "safe", note: "Back at the car" });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "safe");
  assert.ok(r.json.safeAt);
  assert.equal(r.json.contacts[0].allClearSent, true);
  assert.equal(r.json.contacts[1].allClearSent, false, "Jordan was never alerted");
  const ev = r.json.events;
  assert.deepEqual(ev.find((e) => e.type === "safe").detail, { note: "Back at the car" });
  assert.deepEqual(ev.filter((e) => e.type === "all_clear_sent").map((e) => e.detail.index), [0]);

  for (const [res, code] of [
    [await pl.checkin({ action: "safe" }), "already_safe"],
    [await pl.checkin({ action: "extend", minutes: 30 }), "already_safe"],
    [await pl.checkin({ action: "sos" }), "already_safe"],
    [await pl.location({ lat: 1, lng: 2 }), "already_safe"],
    [await pl.ack(0, {}), "safe"],
  ]) {
    assert.equal(res.status, 409);
    assert.equal(res.json.error.code, code);
  }
  // safe is terminal: no timers fire later
  await pl.ff(10 * 86400);
  assert.equal((await pl.view()).json.status, "safe");
});

test("safe before any alert sends no all clear", async () => {
  const pl = await newPlan();
  const r = await pl.checkin(undefined, "&a=safe"); // one-tap from the reminder
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "safe");
  assert.ok(!r.json.events.some((e) => e.type === "all_clear_sent"));
});

test("extend: from active and overdue, re-arms the reminder, validates minutes", async () => {
  const pl = await newPlan();
  const before = (await pl.view()).json;
  let r = await pl.checkin({ action: "extend", minutes: 45 });
  assert.equal(r.status, 200);
  assert.equal(Date.parse(r.json.checkInBy) - Date.parse(before.checkInBy), 45 * 60000);
  assert.deepEqual(r.json.events.at(-1).detail, { minutes: 45, checkInBy: r.json.checkInBy });

  for (const m of [4, 241, "x"]) {
    r = await pl.checkin({ action: "extend", minutes: m });
    assert.equal(r.status, 400, String(m));
    assert.equal(r.json.error.code, "validation_error");
  }

  // overdue -> extend -> active, with a fresh reminder
  await pl.ff(600 + 45 * 60 + 10);
  assert.equal((await pl.view()).json.status, "overdue");
  r = await pl.checkin(undefined, "&a=extend&m=30");
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "active");
  const due = Date.parse(r.json.checkInBy) - Date.parse(r.json.now);
  assert.ok(due > 29 * 60000 && due <= 30 * 60000, "extends from now when already past the deadline");
  await pl.ff(26 * 60);
  assert.equal((await pl.view()).json.events.at(-1).type, "reminder_sent");

  r = await pl.checkin({ action: "nap" });
  assert.equal(r.status, 400);
});

test("extend may not push the deadline past 7 days from creation", async () => {
  const pl = await newPlan({ checkInBy: inSeconds(7 * 86400 - 600) });
  const r = await pl.checkin({ action: "extend", minutes: 30 });
  assert.equal(r.status, 400);
  assert.match(r.json.error.message, /7 days/);
});

test("SOS alerts every contact at once, then ack moves it to acknowledged", async () => {
  const pl = await newPlan();
  let r = await pl.checkin({ action: "sos", note: "Twisted ankle", location: { lat: 37.91, lng: -122.6, accuracy: 10 } });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "sos");
  assert.ok(r.json.contacts.every((c) => c.state === "alerted"));
  assert.equal(r.json.lastLocation.lat, 37.91);
  const ev = r.json.events;
  assert.deepEqual(ev.find((e) => e.type === "sos").detail, { note: "Twisted ankle" });
  assert.equal(ev.filter((e) => e.type === "alerted").length, 2);

  r = await pl.checkin({ action: "sos" }); // pressing again does not re-alert
  assert.equal(r.status, 200);
  assert.equal(r.json.events.filter((e) => e.type === "alerted").length, 2);

  r = await pl.checkin({ action: "extend", minutes: 30 });
  assert.equal(r.json.error.code, "cannot_extend");

  r = await pl.alert(1);
  assert.equal(r.json.status, "sos");
  assert.equal(r.json.you.state, "alerted");
  r = await pl.ack(1, { note: "Driving up" });
  assert.equal(r.json.status, "acknowledged");

  r = await pl.checkin({ action: "safe" });
  assert.equal(r.json.status, "safe");
  assert.equal(r.json.events.filter((e) => e.type === "all_clear_sent").length, 2);
});

test("SOS with nobody answering becomes unanswered after ackMinutes", async () => {
  const pl = await newPlan();
  await pl.checkin({ action: "sos" });
  await pl.ff(170);
  assert.equal((await pl.view()).json.status, "sos");
  await pl.ff(15);
  const v = (await pl.view()).json;
  assert.equal(v.status, "unanswered");
  assert.equal(types(v).at(-1), "unanswered");
});

test("SOS on an acknowledged plan keeps it acknowledged but alerts everyone again", async () => {
  const pl = await newPlan();
  await pl.ff(600 + 120 + 1);
  await pl.ack(0, {});
  let r = await pl.checkin({ action: "sos", note: "Worse now" });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "acknowledged");
  const sosAlerts = r.json.events.filter((e) => e.type === "alerted" && e.detail.sos);
  assert.deepEqual(sosAlerts.map((e) => e.detail.index), [0, 1], "acknowledged and standby contacts both get the SOS");
  assert.equal(r.json.contacts[1].state, "alerted");
  assert.equal(r.json.contacts[0].state, "acknowledged");
  r = await pl.checkin({ action: "sos" }); // another press while acknowledged alerts again
  assert.equal(r.json.events.filter((e) => e.type === "alerted" && e.detail.sos).length, 4);
});

test("location: validation, newest first, keeps 20", async () => {
  const pl = await newPlan();
  for (const body of [{}, { lat: "1", lng: 2 }, { lat: 1, lng: 200 }, { lat: 1, lng: 2, accuracy: 100001 }]) {
    const r = await pl.location(body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  let r;
  for (let i = 0; i < 25; i++) r = await pl.location({ lat: i, lng: i, accuracy: 5 });
  assert.equal(r.status, 200);
  assert.equal(r.json.locations.length, 20);
  assert.equal(r.json.lastLocation.lat, 24);
  assert.equal(r.json.locations[0].lat, 24);
  assert.ok(r.json.lastLocation.at);
  assert.equal(r.json.events.filter((e) => e.type === "location").length, 25);
  assert.deepEqual(r.json.events.at(-1).detail, { lat: 24, lng: 24, accuracy: 5 });
  const cv = (await pl.alert(0)).json;
  assert.ok(cv.events.filter((e) => e.type === "location").every((e) => Object.keys(e.detail).length === 0), "contacts don't get the location history");
  assert.equal(cv.lastLocation.lat, 24);
});

test("grace 0 goes straight from the deadline to alerting", async () => {
  const pl = await newPlan({ graceMinutes: 0, remindMinutesBefore: 0, ackMinutes: 1 });
  await pl.ff(601);
  const v = (await pl.view()).json;
  assert.equal(v.status, "alerting");
  assert.deepEqual(types(v), ["created", "overdue", "owner_pinged", "alerted"]);
});

test("reminder is skipped when its time already passed at creation", async () => {
  const pl = await newPlan({ checkInBy: inSeconds(120), remindMinutesBefore: 15 });
  await pl.ff(60);
  assert.deepEqual(types((await pl.view()).json), ["created"]);
});

test("real timers fire without fast-forward", async () => {
  const pl = await newPlan({ checkInBy: inSeconds(61), remindMinutesBefore: 0, graceMinutes: 0 });
  await pl.ff(59); // now ~2 s before the deadline; the real timer does the rest
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal((await pl.view()).json.status, "alerting");
});

test("per-IP daily cap returns 429 rate_limited", async () => {
  const small = createMockServer({ quiet: true, plansPerDay: 2 });
  await new Promise((r) => small.listen(0, "127.0.0.1", r));
  const b = `http://127.0.0.1:${small.address().port}`;
  const post = () => fetch(b + "/v1/plans", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(planBody()) });
  assert.equal((await post()).status, 201);
  assert.equal((await post()).status, 201);
  const r = await post();
  assert.equal(r.status, 429);
  assert.equal((await r.json()).error.code, "rate_limited");
  small.closeAllConnections?.();
  await new Promise((r) => small.close(r));
});

test("CORS preflight and headers", async () => {
  const r = await call("OPTIONS", "/v1/plans", undefined, { Origin: "https://x.example", "Access-Control-Request-Method": "POST" });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.match(r.headers.get("access-control-allow-methods"), /GET/);
  assert.match(r.headers.get("access-control-allow-methods"), /POST/);
  assert.match(r.headers.get("access-control-allow-headers"), /Content-Type/);
  const g = await call("GET", "/v1/plans/pln_x?s=y");
  assert.equal(g.headers.get("access-control-allow-origin"), "*");
});

test("unknown routes and methods", async () => {
  let r = await call("GET", "/v1/nope");
  assert.equal(r.status, 404);
  r = await call("DELETE", "/v1/plans");
  assert.equal(r.status, 405);
  r = await call("POST", "/_mock/plans/pln_missing/fast-forward?seconds=5");
  assert.equal(r.status, 404);
});

test("static web serving with a generated config.js", async () => {
  let r = await call("GET", "/web/config.js");
  assert.equal(r.status, 200);
  assert.match(r.text, new RegExp(`window\\.LASTCALL_CONFIG = \\{ apiBase: "${base.replace(/[.]/g, "\\.")}" \\}`));
  for (const page of ["index.html", "new.html", "plan.html", "alert.html", "demo.html", "styles.css", "common.js", "favicon.svg"]) {
    r = await call("GET", "/web/" + page);
    assert.equal(r.status, 200, page);
  }
  r = await call("GET", "/web/");
  assert.match(r.headers.get("content-type"), /text\/html/);
  r = await call("GET", "/web/..%2fmock%2fserver.mjs");
  assert.equal(r.status, 404);
  r = await fetch(base + "/", { redirect: "manual" });
  assert.equal(r.status, 302);
});
