#!/usr/bin/env node
// End-to-end test against a deployed Last Call API. Creates real, short-lived plans
// and sends real pushes to freshly generated (unsubscribed) ntfy topics.
//
// Usage: node scripts/e2e.mjs <apiBase>     (or set LASTCALL_API_BASE)
//
// Scenarios run concurrently; the slowest (b) takes about 2.5 minutes.
//   a. due in ~60 s, grace 0: check in safe before the deadline -> safe, nobody alerted
//   b. reminder -> miss the deadline -> contact 0 alerted -> ~60 s later contact 1
//      alerted -> extend refused -> contact 1 acks -> owner safe -> all clear x2
//   c. extend while active moves the deadline
//   d. SOS alerts every contact at once
//   e. wrong secrets and unknown plans are refused (401 / 404)

import assert from 'node:assert/strict';

const API = (process.argv[2] ?? process.env.LASTCALL_API_BASE ?? '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(API)) {
  console.error('Usage: node scripts/e2e.mjs <apiBase>   e.g. https://abc123.execute-api.us-east-1.amazonaws.com');
  process.exit(2);
}

const PRIVATE_FIELDS = ['notifyUrl', 'ownerNotifyUrl', 'secretHash', 'ownerSecretHash', 'taskToken', 'tokenLoop', 'apiBase'];
const started = Date.now();
let passed = 0;
let failed = 0;

const elapsed = () => `${((Date.now() - started) / 1000).toFixed(0).padStart(3)} s`;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function call(method, path, { body, rawBody } = {}) {
  const headers = body === undefined ? {} : { 'content-type': 'application/json' };
  const res = await fetch(`${API}${path}`, { method, headers, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  for (const field of PRIVATE_FIELDS) assert.ok(!text.includes(`"${field}"`), `${method} ${path} leaked ${field}`);
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // leave null; the status assertion will explain
  }
  return { status: res.status, json };
}

const expectStatus = (res, status) => assert.equal(res.status, status, `HTTP ${res.status}: ${JSON.stringify(res.json)}`);

/** One scenario: steps run in order; the first failure skips the rest of that scenario. */
function scenario(tag) {
  let broken = false;
  return async (name, fn) => {
    if (broken) {
      failed += 1;
      console.log(`  skip  [${tag}] ${name} (an earlier step failed)`);
      return undefined;
    }
    const t = Date.now();
    try {
      const result = await fn();
      passed += 1;
      console.log(`  ok    [${tag}] ${name} (${Date.now() - t} ms, at ${elapsed()})`);
      return result;
    } catch (err) {
      broken = true;
      failed += 1;
      console.log(`  FAIL  [${tag}] ${name}\n          ${err.message}`);
      return undefined;
    }
  };
}

/** Polls `read` every 2 s until `check(value)` is truthy. */
async function waitFor(read, check, { timeoutMs, what }) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await read();
    if (check(last)) return last;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last status ${last?.status ?? JSON.stringify(last).slice(0, 200)}`);
    await sleep(2000);
  }
}

// Deadlines are relative (checkInInSeconds) and waits are measured on the API's clock
// (its `now` field), so a skewed local clock cannot break the timed scenarios.
/** Local ms until `iso` on the server clock, given a view and when we received it. */
const msUntil = (iso, view, receivedAt) => Date.parse(iso) - Date.parse(view.now) - (Date.now() - receivedAt);
const linkParams = (url) => new URLSearchParams(new URL(url).hash.slice(1));
const events = (view, type) => view.events.filter((e) => e.type === type);

function planBody(overrides) {
  return {
    name: 'E2E Sam',
    activity: 'e2e: solo hike',
    details: 'Created by scripts/e2e.mjs',
    phone: '+1 555 0100',
    graceMinutes: 0,
    ackMinutes: 1,
    remindMinutesBefore: 0,
    timeZone: 'America/Los_Angeles',
    contacts: [{ name: 'Alex', relationship: 'sister' }, { name: 'Jordan', relationship: 'friend' }],
    location: { lat: 37.9, lng: -122.6, accuracy: 30 },
    ...overrides,
  };
}

/** Creates a plan and returns handy accessors for its owner and contact links. */
async function createPlan(overrides) {
  const res = await call('POST', '/v1/plans', { body: planBody(overrides) });
  const receivedAt = Date.now();
  expectStatus(res, 201);
  const { id, ownerUrl, contacts } = res.json;
  assert.match(id, /^pln_[0-9a-hjkmnp-tv-z]{16}$/);
  assert.equal(linkParams(ownerUrl).get('id'), id);
  assert.match(res.json.ownerSubscribeUrl, /^https:\/\/ntfy\.sh\/lastcall-[a-z0-9]{24}$/);
  for (const c of contacts) assert.match(c.subscribeUrl, /^https:\/\/ntfy\.sh\/lastcall-[a-z0-9]{24}$/);
  const s = encodeURIComponent(linkParams(ownerUrl).get('s'));
  const cs = contacts.map((c) => encodeURIComponent(linkParams(c.alertUrl).get('s')));
  return {
    id,
    created: res.json,
    receivedAt,
    owner: () => call('GET', `/v1/plans/${id}?s=${s}`),
    contact: (i) => call('GET', `/v1/plans/${id}/alert?c=${i}&s=${cs[i]}`),
    checkin: (body) => call('POST', `/v1/plans/${id}/checkin?s=${s}`, { body }),
    checkinTap: (query) => call('POST', `/v1/plans/${id}/checkin?s=${s}&${query}`, { rawBody: '' }),
    location: (body) => call('POST', `/v1/plans/${id}/location?s=${s}`, { body }),
    ack: (i, body) => call('POST', `/v1/plans/${id}/ack?c=${i}&s=${cs[i]}`, { body }),
    ackTap: (i) => call('POST', `/v1/plans/${id}/ack?c=${i}&s=${cs[i]}&a=ack`, { rawBody: '' }),
    raw: { s, cs },
  };
}

// ---------------------------------------------------------------- a. safe before the deadline

async function scenarioA() {
  const step = scenario('a');
  const plan = await step('create a plan due in 60 s (grace 0, ack 1 min, two generated ntfy contacts)', () =>
    createPlan({ activity: 'e2e: quick errand', checkInInSeconds: 60 }));
  await step('owner shares a location', async () => {
    const res = await plan.location({ lat: 37.91, lng: -122.61, accuracy: 12 });
    expectStatus(res, 200);
    assert.equal(res.json.lastLocation.lat, 37.91);
    assert.equal(res.json.locations.length, 2);
  });
  await step('check in safe before the deadline', async () => {
    const res = await plan.checkin({ action: 'safe', note: 'Back early' });
    expectStatus(res, 200);
    assert.equal(res.json.status, 'safe');
  });
  await step('a second check-in is 409 already_safe', async () => {
    const res = await plan.checkin({ action: 'safe' });
    expectStatus(res, 409);
    assert.equal(res.json.error.code, 'already_safe');
  });
  await step('still safe after the old deadline, and nobody was alerted', async () => {
    await sleep(Math.max(0, msUntil(plan.created.plan.checkInBy, plan.created.plan, plan.receivedAt) + 8000));
    const res = await plan.owner();
    expectStatus(res, 200);
    assert.equal(res.json.status, 'safe');
    assert.ok(res.json.contacts.every((c) => c.state === 'standby'), 'a contact was alerted');
    for (const type of ['overdue', 'owner_pinged', 'alerted', 'all_clear_sent']) assert.equal(events(res.json, type).length, 0, `unexpected ${type}`);
  });
}

// ---------------------------------------------------------------- b. missed check-in, escalation

async function scenarioB() {
  const step = scenario('b');
  const plan = await step('create a plan due in 75 s with a 1 min reminder', () =>
    createPlan({ activity: 'e2e: missed check-in', checkInInSeconds: 75, remindMinutesBefore: 1 }));
  if (!plan) return;
  await step('server-side timing: due 75 s after the API clock, reminder 15 s in', async () => {
    const { now, checkInBy, remindAt, graceUntil } = plan.created.plan;
    assert.ok(Math.abs(Date.parse(checkInBy) - Date.parse(now) - 75_000) < 2000, `checkInBy ${checkInBy} vs now ${now}`);
    assert.equal(Date.parse(checkInBy) - Date.parse(remindAt), 60_000);
    assert.equal(graceUntil, checkInBy);
  });
  await step('contact view before any alert: standby, nothing wrong', async () => {
    const res = await plan.contact(0);
    expectStatus(res, 200);
    assert.equal(res.json.status, 'active');
    assert.deepEqual(res.json.you, { index: 0, name: 'Alex', state: 'standby' });
    assert.ok(!('locations' in res.json));
  });
  await step('the owner gets the reminder ~15 s in', () => waitFor(plan.owner, (r) => events(r.json, 'reminder_sent').length === 1, { timeoutMs: 45_000, what: 'reminder_sent' }));
  await step('past the deadline: overdue, owner pinged, contact 0 alerted (grace 0)', async () => {
    // The contact is marked alerted before the push goes out and the event is
    // recorded after it, so wait for the event, not just the state.
    const view = await waitFor(() => plan.contact(0),
      (r) => r.json.you.state === 'alerted' && events(r.json, 'alerted').length === 1,
      { timeoutMs: 90_000, what: 'contact 0 alerted' });
    assert.equal(view.json.status, 'alerting');
    assert.equal(events(view.json, 'overdue').length, 1);
    assert.equal(events(view.json, 'owner_pinged').length, 1);
    const alerted = events(view.json, 'alerted');
    assert.equal(alerted.length, 1);
    assert.deepEqual(alerted[0].detail, { index: 0, name: 'Alex', channel: 'ntfy', ok: true });
    assert.equal(view.json.contacts[1].state, 'standby');
  });
  await step('extend is refused once contacts are alerted (409 cannot_extend)', async () => {
    const res = await plan.checkin({ action: 'extend', minutes: 30 });
    expectStatus(res, 409);
    assert.equal(res.json.error.code, 'cannot_extend');
  });
  await step('contact 1 cannot ack before being alerted (409 not_alerted)', async () => {
    const res = await plan.ack(1, {});
    expectStatus(res, 409);
    assert.equal(res.json.error.code, 'not_alerted');
  });
  await step('~60 s later nobody answered: contact 1 alerted, contact 0 still alerted', async () => {
    const view = await waitFor(() => plan.contact(1),
      (r) => r.json.you.state === 'alerted' && events(r.json, 'alerted').length === 2,
      { timeoutMs: 100_000, what: 'contact 1 alerted' });
    assert.deepEqual(view.json.contacts.map((c) => c.state), ['alerted', 'alerted']);
    assert.deepEqual(events(view.json, 'alerted').map((e) => e.detail.index), [0, 1]);
  });
  await step('contact 1 taps "I\'m on it" -> acknowledged', async () => {
    const res = await plan.ackTap(1);
    expectStatus(res, 200);
    assert.equal(res.json.status, 'acknowledged');
    assert.equal(res.json.you.state, 'acknowledged');
  });
  await step('a second ack is 409 already_acknowledged', async () => {
    const res = await plan.ack(1, { note: 'again' });
    expectStatus(res, 409);
    assert.equal(res.json.error.code, 'already_acknowledged');
  });
  await step('owner taps "I\'m safe" -> safe', async () => {
    const res = await plan.checkinTap('a=safe');
    expectStatus(res, 200);
    assert.equal(res.json.status, 'safe');
  });
  await step('all clear sent to both alerted contacts', async () => {
    const view = await waitFor(plan.owner, (r) => events(r.json, 'all_clear_sent').length === 2, { timeoutMs: 30_000, what: 'two all_clear_sent events' });
    assert.deepEqual(events(view.json, 'all_clear_sent').map((e) => e.detail.index).sort(), [0, 1]);
    assert.ok(view.json.contacts.every((c) => c.allClearSent));
    assert.equal(events(view.json, 'alerted').length, 2, 'no further alerts after the ack');
  });
  await step('ack after safe is 409 safe', async () => {
    const res = await plan.ack(0, {});
    expectStatus(res, 409);
    assert.equal(res.json.error.code, 'safe');
  });
}

// ---------------------------------------------------------------- c. extend while active

async function scenarioC() {
  const step = scenario('c');
  const plan = await step('create a plan due in 10 min', () => createPlan({ activity: 'e2e: extend', checkInInSeconds: 600, graceMinutes: 15 }));
  await step('extend +30 min while active moves the deadline and graceUntil', async () => {
    const res = await plan.checkin({ action: 'extend', minutes: 30 });
    expectStatus(res, 200);
    assert.equal(res.json.status, 'active');
    assert.equal(Date.parse(res.json.checkInBy) - Date.parse(plan.created.plan.checkInBy), 30 * 60_000);
    assert.equal(Date.parse(res.json.graceUntil) - Date.parse(res.json.checkInBy), 15 * 60_000);
    assert.deepEqual(events(res.json, 'extended')[0].detail, { minutes: 30, checkInBy: res.json.checkInBy });
  });
  await step('one-tap +30 (a=extend&m=30, empty body) works too', async () => {
    const res = await plan.checkinTap('a=extend&m=30');
    expectStatus(res, 200);
    assert.equal(events(res.json, 'extended').length, 2);
  });
  await step('400 on an out-of-range extension', async () => {
    const res = await plan.checkin({ action: 'extend', minutes: 1 });
    expectStatus(res, 400);
  });
  await step('clean up: check in safe', async () => expectStatus(await plan.checkin({ action: 'safe' }), 200));
}

// ---------------------------------------------------------------- d. SOS

async function scenarioD() {
  const step = scenario('d');
  const plan = await step('create a plan due in 10 min', () => createPlan({ activity: 'e2e: sos', checkInInSeconds: 600 }));
  await step('owner presses "I need help"', async () => {
    const res = await plan.checkin({ action: 'sos', note: 'e2e: twisted ankle' });
    expectStatus(res, 200);
    assert.equal(res.json.status, 'sos');
    assert.equal(events(res.json, 'sos')[0].detail.note, 'e2e: twisted ankle');
  });
  await step('every contact is alerted at once', async () => {
    const view = await waitFor(plan.owner, (r) => events(r.json, 'alerted').length === 2, { timeoutMs: 30_000, what: 'two alerted events' });
    assert.deepEqual(view.json.contacts.map((c) => c.state), ['alerted', 'alerted']);
    assert.ok(events(view.json, 'alerted').every((e) => e.detail.ok && e.detail.sos));
  });
  await step('clean up: contact 0 acks, owner checks in safe', async () => {
    expectStatus(await plan.ack(0, { note: 'On my way' }), 200);
    expectStatus(await plan.checkin({ action: 'safe' }), 200);
  });
}

// ---------------------------------------------------------------- e. access control

async function scenarioE() {
  const step = scenario('e');
  const plan = await step('create a plan due in 10 min', () => createPlan({ activity: 'e2e: access', checkInInSeconds: 600 }));
  await step('owner view with a wrong secret is 401 invalid_secret', async () => {
    const res = await call('GET', `/v1/plans/${plan.id}?s=wrong-secret`);
    expectStatus(res, 401);
    assert.equal(res.json.error.code, 'invalid_secret');
  });
  await step('a contact secret does not open the owner view, nor another contact\'s (401)', async () => {
    expectStatus(await call('GET', `/v1/plans/${plan.id}?s=${plan.raw.cs[0]}`), 401);
    expectStatus(await call('GET', `/v1/plans/${plan.id}/alert?c=1&s=${plan.raw.cs[0]}`), 401);
  });
  await step('check-in and ack with a wrong secret are 401 and change nothing', async () => {
    expectStatus(await call('POST', `/v1/plans/${plan.id}/checkin?s=nope`, { body: { action: 'safe' } }), 401);
    expectStatus(await call('POST', `/v1/plans/${plan.id}/ack?c=0&s=nope`, { body: {} }), 401);
    assert.equal((await plan.owner()).json.status, 'active');
  });
  await step('unknown plan, malformed ID and unknown contact index are 404', async () => {
    expectStatus(await call('GET', `/v1/plans/pln_0000000000000000?s=${plan.raw.s}`), 404);
    expectStatus(await call('GET', `/v1/plans/not-a-plan?s=${plan.raw.s}`), 404);
    expectStatus(await call('GET', `/v1/plans/${plan.id}/alert?c=9&s=${plan.raw.cs[0]}`), 404);
  });
  await step('validation errors use the documented shape', async () => {
    const res = await call('POST', '/v1/plans', { body: planBody({ contacts: [], checkInInSeconds: 600 }) });
    expectStatus(res, 400);
    assert.equal(res.json.error.code, 'validation_error');
    assert.match(res.json.error.message, /contacts/);
    const both = await call('POST', '/v1/plans', { body: planBody({ checkInInSeconds: 600, checkInBy: plan.created.plan.checkInBy }) });
    expectStatus(both, 400);
    assert.match(both.json.error.message, /not both/);
  });
  await step('clean up: check in safe', async () => expectStatus(await plan.checkin({ action: 'safe' }), 200));
}

async function main() {
  console.log(`Last Call e2e against ${API}\n(scenarios run concurrently; about 2.5 minutes)\n`);
  await Promise.all([scenarioA(), scenarioB(), scenarioC(), scenarioD(), scenarioE()]);
  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total in ${elapsed().trim()}.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
