// The whole loop in-process: real handlers, the in-memory table, a simulated state
// machine (Advance -> Done? -> WaitForEvent -> timeout or nudge -> Advance) and a
// controlled clock. This is the e2e storyline at unit-test speed.

import './helpers.mjs';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { SendTaskSuccessCommand, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { apiEvent, awsError, parse } from './helpers.mjs';
import { T0, resetMocks, sfnMock, storedPlan } from './fixtures.mjs';
import { sendRequest } from '../src/lib/outbound.mjs';
import { handler as createPlan } from '../src/handlers/createPlan.mjs';
import { handler as checkin } from '../src/handlers/checkin.mjs';
import { handler as ack } from '../src/handlers/ack.mjs';
import { deps, handler as advance } from '../src/handlers/workflow/advance.mjs';
import { handler as waitForEvent } from '../src/handlers/workflow/waitForEvent.mjs';

let sent;
let exec; // the simulated execution

beforeEach(() => {
  resetMocks();
  mock.timers.enable({ apis: ['Date'], now: T0 });
  sent = [];
  deps.now = () => new Date();
  deps.sendRequest = async (url, request) => {
    sent.push({ url, title: request.headers.Title });
    return { status: 200, headers: {}, body: '' };
  };
  exec = null;
  sfnMock.on(StartExecutionCommand).callsFake(async ({ input }) => {
    exec = { input: JSON.parse(input), next: { loop: 0 }, token: null, open: false, nudged: false, waitUntil: 0, done: false, loops: 0 };
    return { executionArn: 'arn:exec' };
  });
  // SendTaskSuccess closes the open task; anything else is a closed task, as in SFN.
  sfnMock.on(SendTaskSuccessCommand).callsFake(async ({ taskToken }) => {
    if (!exec?.open || taskToken !== exec.token) throw awsError('TaskTimedOut');
    exec.open = false;
    exec.nudged = true;
    return {};
  });
});
afterEach(() => {
  mock.timers.reset();
  deps.sendRequest = sendRequest;
});

/** One pass: Advance, then (unless done) WaitForEvent with a fresh token. */
async function loopOnce() {
  exec.loops += 1;
  const out = await advance({ planId: exec.input.planId, secrets: exec.input.secrets, loop: exec.next.loop });
  exec.next = out;
  if (out.done) {
    exec.done = true;
    return;
  }
  exec.token = `tok-${out.loop}`;
  exec.open = true;
  exec.waitUntil = Date.now() + out.waitSeconds * 1000;
  await waitForEvent({ planId: exec.input.planId, taskToken: exec.token, version: out.version, loop: out.loop });
}

/** Runs the loop for every pending nudge. */
async function settle() {
  while (exec.nudged && !exec.done) {
    exec.nudged = false;
    await loopOnce();
  }
}

/** Moves the clock to `ms`, firing every task timeout on the way. */
async function tick(ms) {
  await settle();
  while (!exec.done && exec.waitUntil <= ms) {
    mock.timers.setTime(exec.waitUntil);
    exec.open = false; // States.Timeout -> Catch -> Advance
    await loopOnce();
    await settle();
  }
  mock.timers.setTime(ms);
}

async function start(overrides) {
  const res = parse(await createPlan(apiEvent({
    method: 'POST',
    path: '/v1/plans',
    body: {
      name: 'Sam',
      activity: 'Solo hike',
      checkInInSeconds: 75,
      remindMinutesBefore: 1,
      graceMinutes: 0,
      ackMinutes: 1,
      contacts: [{ name: 'Alex' }, { name: 'Jordan' }],
      ...overrides,
    },
  })));
  assert.equal(res.statusCode, 201, res.body);
  await loopOnce(); // the execution starts
  const secret = (url) => new URLSearchParams(new URL(url).hash.slice(1)).get('s');
  const { id } = res.json;
  return {
    id,
    owner: (body) => checkin(apiEvent({ method: 'POST', params: { id }, query: { s: secret(res.json.ownerUrl) }, body })).then(parse),
    ack: (i) => ack(apiEvent({ method: 'POST', params: { id }, query: { c: String(i), s: secret(res.json.contacts[i].alertUrl) }, body: '' })).then(parse),
    urls: { owner: res.json.ownerSubscribeUrl, contacts: res.json.contacts.map((c) => c.subscribeUrl) },
  };
}

describe('the check-in loop end to end', () => {
  it('missed check-in: reminder, overdue, escalation, ack, safe, all clear', async () => {
    const plan = await start();
    const [alex, jordan] = plan.urls.contacts;

    await tick(T0 + 14_000);
    assert.equal(sent.length, 0);
    await tick(T0 + 17_000);
    assert.deepEqual(sent.map((s) => s.title), ['Check in by 10:01 AM UTC']);

    await tick(T0 + 77_000);
    assert.deepEqual(sent.slice(1).map((s) => [s.url, s.title]), [[plan.urls.owner, 'You missed your check-in'], [alex, "Sam hasn't checked in"]]);
    assert.equal(storedPlan(plan.id).status, 'alerting');

    assert.equal((await plan.owner({ action: 'extend', minutes: 30 })).json.error.code, 'cannot_extend');

    await tick(T0 + 130_000);
    assert.equal(sent.length, 3, 'Jordan waits a full ackMinutes');
    await tick(T0 + 138_000);
    assert.deepEqual(sent.slice(3).map((s) => s.url), [jordan]);

    const acked = await plan.ack(1);
    assert.equal(acked.json.status, 'acknowledged');
    await settle();
    await tick(T0 + 600_000);
    assert.equal(sent.length, 4, 'no more alerts once someone is on it');

    assert.equal((await plan.owner({ action: 'safe' })).json.status, 'safe');
    await settle();
    assert.equal(exec.done, true);
    assert.deepEqual(sent.slice(4).map((s) => [s.url, s.title]), [[alex, 'Sam checked in safe'], [jordan, 'Sam checked in safe']]);
    assert.ok(exec.loops < 20, `took ${exec.loops} loops`);
  });

  it('safe before the deadline: the loop ends and nobody hears a thing', async () => {
    const plan = await start({ remindMinutesBefore: 0 });
    await tick(T0 + 30_000);
    await plan.owner({ action: 'safe' });
    await settle();
    assert.equal(exec.done, true);
    await tick(T0 + 3_600_000);
    assert.deepEqual(sent, []);
  });

  it('extend while active pushes every milestone back', async () => {
    const plan = await start({ remindMinutesBefore: 0 });
    await plan.owner({ action: 'extend', minutes: 30 });
    await settle();
    await tick(T0 + 75_000 + 29 * 60_000);
    assert.deepEqual(sent, []);
    await tick(T0 + 75_000 + 31 * 60_000);
    assert.deepEqual(sent.map((s) => s.title), ['You missed your check-in', "Sam hasn't checked in"]);
  });

  it('SOS: everyone at once, then unanswered, then closed 48 h later', async () => {
    const plan = await start({ remindMinutesBefore: 0 });
    await plan.owner({ action: 'sos' });
    await settle();
    assert.deepEqual(sent.map((s) => s.title), ['Sam needs help now', 'Sam needs help now']);
    await tick(T0 + 62_000);
    assert.equal(storedPlan(plan.id).status, 'unanswered');
    await tick(T0 + 62_000 + 48 * 3_600_000 + 2_000);
    assert.equal(storedPlan(plan.id).status, 'closed');
    assert.equal(exec.done, true);
    assert.equal(sent.length, 2);
  });

  it('a nudge that lands while Advance is running is not lost (version check in WaitForEvent)', async () => {
    const plan = await start({ remindMinutesBefore: 0 });
    // The task times out and Advance runs; before WaitForEvent parks a new token the
    // owner checks in. The endpoint's nudge hits the old, closed task...
    exec.open = false;
    const out = await advance({ planId: plan.id, secrets: exec.input.secrets, loop: exec.next.loop });
    assert.equal(out.done, false);
    assert.equal((await plan.owner({ action: 'safe' })).json.status, 'safe');
    assert.equal(exec.nudged, false);
    // ...so WaitForEvent sees the bumped version and wakes the loop itself.
    Object.assign(exec, { next: out, token: 'tok-late', open: true });
    assert.deepEqual(await waitForEvent({ planId: plan.id, taskToken: 'tok-late', version: out.version, loop: out.loop }), { parked: true, nudged: true });
    await settle();
    assert.equal(exec.done, true);
  });
});
