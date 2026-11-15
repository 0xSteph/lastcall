// Every endpoint's happy path and error codes, against the in-memory table.

import { API, WEB, apiEvent, awsError, parse } from './helpers.mjs';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { SendTaskSuccessCommand, StartExecutionCommand } from '@aws-sdk/client-sfn';
import {
  CONTACT_SECRETS, MIN, OWNER_SECRET, PLAN_ID, TOKEN, assertNoSecrets, contactsWith, eventTypes, hooks, iso,
  resetMocks, seedPlan, sfnMock, storedEvents, storedPlan, table,
} from './fixtures.mjs';
import { sha256Hex } from '../src/lib/ids.mjs';
import { handler as createPlan } from '../src/handlers/createPlan.mjs';
import { handler as getPlan } from '../src/handlers/getPlan.mjs';
import { handler as getAlert } from '../src/handlers/getAlert.mjs';
import { handler as checkin } from '../src/handlers/checkin.mjs';
import { handler as location } from '../src/handlers/location.mjs';
import { handler as ack } from '../src/handlers/ack.mjs';

// Endpoints use the real clock: plans are created an hour ago and due in an hour.
const base = () => Date.now() - 60 * MIN;
const seed = (overrides = {}) => seedPlan({ base: base(), ...overrides });
const fragment = (url) => new URLSearchParams(new URL(url).hash.slice(1));
const nudges = () => sfnMock.commandCalls(SendTaskSuccessCommand).map((c) => c.args[0].input.taskToken);

const owner = (path, { query = {}, body, method = 'POST' } = {}) => apiEvent({
  method, path: `/v1/plans/${PLAN_ID}${path}`, params: { id: PLAN_ID }, query: { s: OWNER_SECRET, ...query }, body,
});
const contact = (index, path, { query = {}, body, method = 'POST' } = {}) => apiEvent({
  method, path: `/v1/plans/${PLAN_ID}${path}`, params: { id: PLAN_ID }, query: { c: String(index), s: CONTACT_SECRETS[index], ...query }, body,
});
const errorOf = async (promise, status, code) => {
  const res = parse(await promise);
  assert.equal(res.statusCode, status, res.body);
  assert.equal(res.json.error.code, code);
  assert.ok(res.json.error.message);
  return res;
};

beforeEach(() => {
  resetMocks();
  sfnMock.on(StartExecutionCommand).resolves({ executionArn: 'arn:exec' });
  sfnMock.on(SendTaskSuccessCommand).resolves({});
});

describe('POST /v1/plans', () => {
  const body = (overrides = {}) => ({
    name: 'Sam',
    activity: 'Solo hike: Dipsea Trail loop',
    details: 'Blue Subaru at the trailhead',
    checkInBy: new Date(Date.now() + 3 * 3_600_000).toISOString(),
    timeZone: 'America/Los_Angeles',
    contacts: [{ name: 'Alex', relationship: 'sister' }, { name: 'Jordan', notifyUrl: 'https://hooks.slack.com/services/T/B/x' }],
    location: { lat: 37.9, lng: -122.6, accuracy: 30 },
    ...overrides,
  });
  const create = (b = body(), ip) => createPlan(apiEvent({ method: 'POST', path: '/v1/plans', body: b, ip }));

  it('creates the plan, returns links with secrets in the fragment, and starts the workflow', async () => {
    const res = parse(await create());
    assert.equal(res.statusCode, 201, res.body);
    const { id, ownerUrl, ownerSubscribeUrl, contacts, plan } = res.json;
    assert.match(id, /^pln_[0-9a-hjkmnp-tv-z]{16}$/);
    assert.ok(ownerUrl.startsWith(`${WEB}/plan.html#id=${id}&s=`));
    assert.match(ownerSubscribeUrl, /^https:\/\/ntfy\.sh\/lastcall-[a-z0-9]{24}$/);
    assert.equal(contacts.length, 2);
    assert.ok(contacts[0].alertUrl.startsWith(`${WEB}/alert.html#id=${id}&c=0&s=`));
    assert.match(contacts[0].subscribeUrl, /^https:\/\/ntfy\.sh\/lastcall-[a-z0-9]{24}$/);
    assert.ok(!('subscribeUrl' in contacts[1]), 'no subscribe link when the contact brought a notify URL');

    assert.equal(plan.status, 'active');
    assert.equal(plan.timeZone, 'America/Los_Angeles');
    assert.deepEqual(plan.events.map((e) => e.type), ['created']);
    assert.equal(plan.lastLocation.lat, 37.9);
    assert.equal(plan.contacts[0].state, 'standby');
    assert.ok(plan.remindAt && plan.graceUntil && plan.now);
    assertNoSecrets(assert, plan);

    // Stored: hashes only, generated topics as notify URLs, apiBase from the request.
    const stored = storedPlan(id);
    const ownerSecret = fragment(ownerUrl).get('s');
    assert.equal(stored.ownerSecretHash, sha256Hex(ownerSecret));
    assert.ok(!JSON.stringify(stored).includes(ownerSecret));
    assert.equal(stored.ownerNotifyUrl, ownerSubscribeUrl);
    assert.equal(stored.contacts[0].notifyUrl, contacts[0].subscribeUrl);
    assert.equal(stored.contacts[1].notifyUrl, 'https://hooks.slack.com/services/T/B/x');
    assert.equal(stored.apiBase, API);
    assert.equal(stored.version, 1);
    assert.equal(table.get('IP#203.0.113.7#' + stored.createdAt.slice(0, 10).replace(/-/g, '') + '|META').planCount, 1);

    const [start] = sfnMock.commandCalls(StartExecutionCommand);
    assert.equal(start.args[0].input.name, id);
    assert.deepEqual(JSON.parse(start.args[0].input.input), {
      planId: id,
      secrets: { owner: ownerSecret, contacts: contacts.map((c) => fragment(c.alertUrl).get('s')) },
      next: { loop: 0 },
    });
  });

  it('checkInInSeconds: deadline and reminder come from the server clock, whatever the client clock says', async () => {
    const before = Date.now();
    const res = parse(await create(body({ checkInBy: undefined, checkInInSeconds: 75, remindMinutesBefore: 1, graceMinutes: 0 })));
    assert.equal(res.statusCode, 201, res.body);
    const { plan } = res.json;
    const serverNow = Date.parse(storedPlan(res.json.id).createdAt);
    assert.ok(serverNow >= before && serverNow <= Date.now());
    assert.equal(Date.parse(plan.checkInBy) - serverNow, 75_000);
    assert.equal(Date.parse(plan.remindAt) - serverNow, 15_000, 'a 75 s plan with a 1 min reminder reminds 15 s in');
    assert.equal(plan.graceUntil, plan.checkInBy);
  });

  it('400s when both or neither of checkInBy and checkInInSeconds are given', async () => {
    await errorOf(create(body({ checkInInSeconds: 120 })), 400, 'validation_error');
    await errorOf(create(body({ checkInBy: undefined })), 400, 'validation_error');
    await errorOf(create(body({ checkInBy: undefined, checkInInSeconds: 30 })), 400, 'validation_error');
    assert.equal(sfnMock.commandCalls(StartExecutionCommand).length, 0);
  });

  it('returns 400 with the field name on invalid input', async () => {
    const res = await errorOf(create(body({ contacts: [] })), 400, 'validation_error');
    assert.match(res.json.error.message, /contacts/);
    await errorOf(createPlan(apiEvent({ method: 'POST', path: '/v1/plans', body: '{nope' })), 400, 'invalid_json');
    assert.equal(sfnMock.commandCalls(StartExecutionCommand).length, 0);
  });

  it('caps plans per source IP per UTC day (429 rate_limited)', async () => {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    table.set(`IP#198.51.100.9#${day}|META`, { PK: `IP#198.51.100.9#${day}`, SK: 'META', planCount: 20 });
    await errorOf(create(body(), '198.51.100.9'), 429, 'rate_limited');
    assert.equal(parse(await create(body(), '198.51.100.10')).statusCode, 201, 'other IPs are unaffected');
  });

  it('closes the plan and returns 503 if the workflow cannot start', async () => {
    sfnMock.on(StartExecutionCommand).rejects(awsError('ServiceUnavailable'));
    await errorOf(create(), 503, 'workflow_unavailable');
    const plan = [...table.values()].find((i) => i.type === 'plan');
    assert.equal(plan.status, 'closed');
    assert.deepEqual(eventTypes(plan.id), ['created', 'closed']);
  });
});

describe('GET /v1/plans/{id}', () => {
  it('returns the owner view with locations and events, and no secrets', async () => {
    seed();
    const res = parse(await getPlan(owner('', { method: 'GET' })));
    assert.equal(res.statusCode, 200);
    assert.equal(res.json.id, PLAN_ID);
    assert.equal(res.json.locations.length, 1);
    assert.deepEqual(res.json.lastLocation, res.json.locations[0]);
    assert.deepEqual(Object.keys(res.json.contacts[0]), ['name', 'relationship', 'state', 'alertedAt', 'acknowledgedAt', 'note', 'allClearSent']);
    assertNoSecrets(assert, res.body);
  });

  it('404s for unknown or malformed IDs and 401s for a wrong secret', async () => {
    await errorOf(getPlan(owner('', { method: 'GET' })), 404, 'not_found');
    seed();
    await errorOf(getPlan(apiEvent({ params: { id: 'pln_bad' }, query: { s: OWNER_SECRET } })), 404, 'not_found');
    await errorOf(getPlan(owner('', { method: 'GET', query: { s: 'wrong' } })), 401, 'invalid_secret');
    await errorOf(getPlan(owner('', { method: 'GET', query: { s: CONTACT_SECRETS[0] } })), 401, 'invalid_secret');
  });
});

describe('GET /v1/plans/{id}/alert', () => {
  it('returns the contact view: no location history, plus who you are', async () => {
    seed();
    const res = parse(await getAlert(contact(1, '/alert', { method: 'GET' })));
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json.you, { index: 1, name: 'Jordan', state: 'standby' });
    assert.ok(!('locations' in res.json));
    assert.equal(res.json.lastLocation.lat, 37.9);
    assertNoSecrets(assert, res.body);
  });

  it('shows location events without the location history', async () => {
    seed();
    await location(owner('/location', { body: { lat: 10, lng: 20 } }));
    await location(owner('/location', { body: { lat: 11, lng: 21 } }));
    const res = parse(await getAlert(contact(0, '/alert', { method: 'GET' })));
    assert.deepEqual(res.json.events.map((e) => [e.type, e.detail]), [['location', {}], ['location', {}]]);
    assert.equal(res.json.lastLocation.lat, 11);
    const ownerRes = parse(await getPlan(owner('', { method: 'GET' })));
    assert.equal(ownerRes.json.events[0].detail.lat, 10);
  });

  it('checks the contact index and that contact\'s own secret', async () => {
    seed();
    await errorOf(getAlert(contact(0, '/alert', { method: 'GET', query: { c: '7' } })), 404, 'not_found');
    await errorOf(getAlert(contact(0, '/alert', { method: 'GET', query: { c: 'x' } })), 404, 'not_found');
    await errorOf(getAlert(contact(0, '/alert', { method: 'GET', query: { s: CONTACT_SECRETS[1] } })), 401, 'invalid_secret');
    await errorOf(getAlert(contact(0, '/alert', { method: 'GET', query: { s: OWNER_SECRET } })), 401, 'invalid_secret');
  });
});

describe('POST /v1/plans/{id}/checkin', () => {
  it('safe: writes with a version bump, nudges the stored token, returns the owner view', async () => {
    seed();
    const res = parse(await checkin(owner('/checkin', { body: { action: 'safe', note: 'Back at the car' } })));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json.status, 'safe');
    assert.ok(res.json.safeAt);
    assert.deepEqual(res.json.events.map((e) => e.type), ['safe']);
    assert.deepEqual(res.json.events[0].detail, { note: 'Back at the car' });
    assert.equal(storedPlan().version, 2);
    assert.deepEqual(nudges(), [TOKEN]);
    assertNoSecrets(assert, res.body);
  });

  it('accepts one-tap query actions with an empty body (ntfy buttons)', async () => {
    const before = seed();
    const res = parse(await checkin(owner('/checkin', { query: { a: 'extend', m: '30' }, body: '' })));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json.status, 'active');
    assert.equal(res.json.events[0].type, 'extended');
    assert.equal(res.json.events[0].detail.minutes, 30);
    assert.equal(Date.parse(res.json.checkInBy) - Date.parse(before.checkInBy), 30 * MIN);
  });

  it('extend returns 409 cannot_extend once contacts are alerted', async () => {
    seed({ status: 'alerting', contacts: contactsWith([{ state: 'alerted', alertedAt: iso(Date.now()) }]) });
    await errorOf(checkin(owner('/checkin', { body: { action: 'extend', minutes: 30 } })), 409, 'cannot_extend');
    assert.deepEqual(nudges(), [], 'refused requests do not nudge');
    assert.equal(storedPlan().version, 1);
  });

  it('409 already_safe and closed, 400 on a bad action, 401 on a wrong secret', async () => {
    seed({ status: 'safe' });
    await errorOf(checkin(owner('/checkin', { body: { action: 'sos' } })), 409, 'already_safe');
    seed({ status: 'closed' });
    await errorOf(checkin(owner('/checkin', { body: { action: 'safe' } })), 409, 'closed');
    seed();
    await errorOf(checkin(owner('/checkin', { body: { action: 'nap' } })), 400, 'validation_error');
    await errorOf(checkin(owner('/checkin', { body: { action: 'safe' }, query: { s: 'nope' } })), 401, 'invalid_secret');
  });

  it('sos: status sos with the note, nudged so Advance alerts everyone', async () => {
    seed();
    const res = parse(await checkin(owner('/checkin', { body: { action: 'sos', note: 'Twisted ankle' } })));
    assert.equal(res.json.status, 'sos');
    assert.equal(storedPlan().sosNote, 'Twisted ankle');
    assert.deepEqual(nudges(), [TOKEN]);
  });

  it('ignores every SFN error from the nudge: the write already stands', async () => {
    for (const name of ['TaskTimedOut', 'TaskDoesNotExist', 'InvalidToken', 'ThrottlingException', 'ServiceUnavailable']) {
      resetMocks();
      sfnMock.on(SendTaskSuccessCommand).rejects(awsError(name));
      seed();
      const res = parse(await checkin(owner('/checkin', { body: { action: 'safe' } })));
      assert.equal(res.statusCode, 200, name);
      assert.equal(storedPlan().status, 'safe');
    }
  });

  it('re-reads and decides again when Advance wrote in between (compare-and-swap)', async () => {
    seed();
    // Advance moves the plan to overdue just before our write lands.
    hooks.beforeTransact = () => {
      const plan = storedPlan();
      table.set(`PLAN#${PLAN_ID}|META`, { ...plan, status: 'alerting', version: plan.version + 1 });
    };
    await errorOf(checkin(owner('/checkin', { body: { action: 'extend', minutes: 30 } })), 409, 'cannot_extend');

    seed();
    hooks.beforeTransact = () => {
      const plan = storedPlan();
      table.set(`PLAN#${PLAN_ID}|META`, { ...plan, status: 'overdue', version: plan.version + 1 });
    };
    const res = parse(await checkin(owner('/checkin', { body: { action: 'safe' } })));
    assert.equal(res.json.status, 'safe');
    assert.equal(storedPlan().version, 3);
  });
});

describe('POST /v1/plans/{id}/location', () => {
  it('records the fix newest first, keeps 20, and does not nudge', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ lat: i, lng: i, accuracy: 1, at: iso(Date.now() - (i + 1) * MIN) }));
    seed({ locations: many });
    const res = parse(await location(owner('/location', { body: { lat: 37.91, lng: -122.61, accuracy: 12 } })));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json.locations.length, 20);
    assert.deepEqual({ ...res.json.lastLocation, at: undefined }, { lat: 37.91, lng: -122.61, accuracy: 12, at: undefined });
    assert.equal(res.json.events.at(-1).type, 'location');
    assert.deepEqual(nudges(), []);
  });

  it('400s on bad coordinates and 409s on terminal plans', async () => {
    seed();
    await errorOf(location(owner('/location', { body: { lat: 100, lng: 0 } })), 400, 'validation_error');
    await errorOf(location(owner('/location', { body: '' })), 400, 'invalid_json');
    seed({ status: 'safe' });
    await errorOf(location(owner('/location', { body: { lat: 1, lng: 1 } })), 409, 'already_safe');
    seed({ status: 'closed' });
    await errorOf(location(owner('/location', { body: { lat: 1, lng: 1 } })), 409, 'closed');
  });
});

describe('POST /v1/plans/{id}/ack', () => {
  const alerting = () => seed({
    status: 'alerting',
    contacts: contactsWith([{ state: 'alerted', alertedAt: iso(Date.now() - 12 * MIN) }, { state: 'alerted', alertedAt: iso(Date.now() - 2 * MIN) }]),
  });

  it('acknowledges, moves the plan to acknowledged, nudges, returns the contact view', async () => {
    alerting();
    const res = parse(await ack(contact(1, '/ack', { body: { note: 'Driving to the trailhead' } })));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json.status, 'acknowledged');
    assert.deepEqual(res.json.you, { index: 1, name: 'Jordan', state: 'acknowledged' });
    assert.equal(res.json.contacts[1].note, 'Driving to the trailhead');
    assert.deepEqual(storedEvents().map((e) => [e.type, e.detail]), [['acknowledged', { index: 1, name: 'Jordan', note: 'Driving to the trailhead' }]]);
    assert.deepEqual(nudges(), [TOKEN]);
    assertNoSecrets(assert, res.body);
  });

  it('accepts the one-tap ?a=ack with an empty body', async () => {
    alerting();
    const res = parse(await ack(contact(0, '/ack', { query: { a: 'ack' }, body: '' })));
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json.you.state, 'acknowledged');
  });

  it('409 not_alerted, already_acknowledged and safe; 401 with another contact\'s secret', async () => {
    seed();
    await errorOf(ack(contact(0, '/ack')), 409, 'not_alerted');
    alerting();
    await ack(contact(0, '/ack'));
    await errorOf(ack(contact(0, '/ack')), 409, 'already_acknowledged');
    seed({ status: 'safe', contacts: contactsWith([{ state: 'alerted' }]) });
    await errorOf(ack(contact(0, '/ack')), 409, 'safe');
    await errorOf(ack(contact(0, '/ack', { query: { s: CONTACT_SECRETS[1] } })), 401, 'invalid_secret');
  });
});
