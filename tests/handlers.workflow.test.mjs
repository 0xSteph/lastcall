// Advance (the only place that sends) and WaitForEvent, against the in-memory table.

import { API, awsError } from './helpers.mjs';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { SendTaskSuccessCommand } from '@aws-sdk/client-sfn';
import {
  CONTACT_SECRETS, MIN, OWNER_SECRET, PLAN_ID, SECRETS, T0, at, contactsWith, eventTypes, hooks, iso,
  resetMocks, seedPlan, sfnMock, storedEvents, storedPlan, table,
} from './fixtures.mjs';
import { sendRequest } from '../src/lib/outbound.mjs';
import { deps, handler as advance } from '../src/handlers/workflow/advance.mjs';
import { handler as waitForEvent } from '../src/handlers/workflow/waitForEvent.mjs';

let sent;
let clock;
let delivery; // (url, request) => response; tests swap it to simulate failures

beforeEach(() => {
  resetMocks();
  sent = [];
  clock = T0;
  delivery = async () => ({ status: 200, headers: {}, body: 'ok' });
  deps.now = () => at(clock);
  deps.sendRequest = async (url, request) => {
    sent.push({ url, ...request });
    return delivery(url, request);
  };
  sfnMock.on(SendTaskSuccessCommand).resolves({});
});
afterEach(() => {
  deps.sendRequest = sendRequest;
  deps.now = () => new Date();
});

const run = (loop = 3) => advance({ planId: PLAN_ID, secrets: SECRETS, loop });
const urls = () => sent.map((s) => s.url);
const OWNER_NTFY = 'https://ntfy.sh/lastcall-ownerownerownerownerowne';
const ALEX = 'https://ntfy.sh/lastcall-alexalexalexalexalexalex';
const JORDAN = 'https://ntfy.sh/lastcall-jordanjordanjordanjord';

describe('Advance', () => {
  it('sends nothing before the reminder and returns the wait until it', async () => {
    seedPlan();
    clock = T0 + 60 * MIN;
    assert.deepEqual(await run(), { done: false, waitSeconds: 45 * 60 + 1, version: 1, loop: 4 });
    assert.equal(sent.length, 0);
  });

  it('sends the reminder with one-tap buttons, once, however often it runs', async () => {
    seedPlan();
    clock = T0 + 105 * MIN;
    const first = await run();
    assert.deepEqual(first, { done: false, waitSeconds: 15 * 60 + 1, version: 2, loop: 4 });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, OWNER_NTFY);
    assert.equal(sent[0].headers.Title, 'Check in by 4:00 AM');
    assert.equal(sent[0].headers.Actions,
      `http, "I'm safe", ${API}/v1/plans/${PLAN_ID}/checkin?s=${OWNER_SECRET}&a=safe, method=POST, clear=true; `
      + `http, +30 min, ${API}/v1/plans/${PLAN_ID}/checkin?s=${OWNER_SECRET}&a=extend&m=30, method=POST, clear=true`);
    assert.deepEqual(storedEvents().map((e) => [e.type, e.detail]), [['reminder_sent', { ok: true }]]);

    clock += 5_000;
    await run();
    await run();
    assert.equal(sent.length, 1, 'retries and repeat runs never resend');
  });

  it('two Advances racing on the same plan send each notification once', async () => {
    seedPlan({ graceMinutes: 0, graceUntil: iso(T0 + 120 * MIN), reminderSent: true });
    clock = T0 + 120 * MIN;
    await Promise.all([run(), run(), run()]);
    assert.deepEqual(urls().sort(), [ALEX, OWNER_NTFY].sort());
    assert.deepEqual(eventTypes().filter((t) => t !== 'owner_pinged' && t !== 'alerted'), ['overdue']);
  });

  it('at the deadline with grace 0: overdue, owner pinged, contact 0 alerted in one run', async () => {
    seedPlan({ graceMinutes: 0, graceUntil: iso(T0 + 120 * MIN), remindAt: null });
    clock = T0 + 120 * MIN;
    const result = await run();
    assert.deepEqual(result, { done: false, waitSeconds: 10 * 60 + 1, version: 4, loop: 4 });
    assert.deepEqual(urls(), [OWNER_NTFY, ALEX]);
    assert.equal(sent[0].headers.Priority, 'high');
    assert.equal(sent[1].headers.Title, "Sam hasn't checked in");
    assert.equal(sent[1].headers.Actions,
      `view, Open alert, https://d123.cloudfront.net/alert.html#id=${PLAN_ID}&c=0&s=${CONTACT_SECRETS[0]}; `
      + `http, "I'm on it", ${API}/v1/plans/${PLAN_ID}/ack?c=0&s=${CONTACT_SECRETS[0]}&a=ack, method=POST, clear=true`);
    assert.deepEqual(storedEvents().map((e) => [e.type, e.detail]), [
      ['overdue', { checkInBy: iso(T0 + 120 * MIN) }],
      ['owner_pinged', { ok: true }],
      ['alerted', { index: 0, name: 'Alex', channel: 'ntfy', ok: true }],
    ]);
    const plan = storedPlan();
    assert.equal(plan.status, 'alerting');
    assert.deepEqual(plan.contacts.map((c) => c.state), ['alerted', 'standby']);
  });

  it('escalates to the next contact after ackMinutes, then goes unanswered', async () => {
    seedPlan({ status: 'alerting', contacts: contactsWith([{ state: 'alerted', alertedAt: iso(T0 + 135 * MIN) }]) });
    clock = T0 + 145 * MIN;
    await run();
    assert.deepEqual(urls(), [JORDAN]);
    clock = T0 + 155 * MIN;
    const result = await run();
    assert.equal(storedPlan().status, 'unanswered');
    assert.equal(result.waitSeconds, 48 * 3600 + 1);
    assert.deepEqual(eventTypes(), ['alerted', 'unanswered']);
    assert.equal(sent.length, 1, 'unanswered itself sends nothing');
  });

  it('SOS alerts every contact at once with the SOS wording', async () => {
    seedPlan({ status: 'sos', sosAt: iso(T0 + 30 * MIN), sosNote: 'Twisted ankle' });
    clock = T0 + 30 * MIN;
    await run();
    assert.deepEqual(urls(), [ALEX, JORDAN]);
    assert.ok(sent.every((s) => s.headers.Title === 'Sam needs help now' && s.headers.Priority === 'urgent'));
    assert.deepEqual(storedEvents().map((e) => e.detail), [
      { index: 0, name: 'Alex', channel: 'ntfy', ok: true, sos: true },
      { index: 1, name: 'Jordan', channel: 'ntfy', ok: true, sos: true },
    ]);
    await run();
    assert.equal(sent.length, 2);
  });

  it('after a safe check-in, sends the all clear to alerted contacts only, then is done', async () => {
    seedPlan({
      status: 'safe', safeAt: iso(T0 + 140 * MIN),
      contacts: contactsWith([{ state: 'alerted', alertedAt: iso(T0 + 135 * MIN) }]),
    });
    clock = T0 + 140 * MIN;
    assert.equal((await run()).done, true);
    assert.deepEqual(urls(), [ALEX]);
    assert.equal(sent[0].headers.Title, 'Sam checked in safe');
    assert.deepEqual(storedEvents().map((e) => [e.type, e.detail]), [['all_clear_sent', { index: 0, name: 'Alex', ok: true }]]);
    assert.equal((await run()).done, true);
    assert.equal(sent.length, 1);
  });

  it('records a failed delivery as ok: false and carries on to the next contact', async () => {
    seedPlan({ status: 'sos', sosAt: iso(T0) });
    delivery = async (url) => {
      if (url === ALEX) throw new Error('ECONNRESET');
      return { status: 500, headers: {}, body: '' };
    };
    await run();
    assert.deepEqual(storedEvents().map((e) => e.detail.ok), [false, false]);
    assert.equal(sent.length, 2);
    assert.ok(storedPlan().contacts.every((c) => c.state === 'alerted'), 'marked alerted: never retried, never doubled');
  });

  it('labels Slack, Discord and webhook channels in the alerted event', async () => {
    seedPlan({
      status: 'sos', sosAt: iso(T0),
      contacts: contactsWith([{ notifyUrl: 'https://hooks.slack.com/services/T/B/x' }, { notifyUrl: 'https://example.com/hook' }]),
    });
    await run();
    assert.deepEqual(storedEvents().map((e) => e.detail.channel), ['slack', 'webhook']);
  });

  it('re-decides from a fresh read when an endpoint writes mid-run', async () => {
    seedPlan({ reminderSent: true });
    clock = T0 + 120 * MIN;
    // The owner taps "+30 min" just as Advance tries to mark the plan overdue.
    hooks.beforeTransact = () => {
      const plan = storedPlan();
      table.set(`PLAN#${PLAN_ID}|META`, { ...plan, checkInBy: iso(T0 + 150 * MIN), graceUntil: iso(T0 + 165 * MIN), version: plan.version + 1 });
    };
    const result = await run();
    assert.equal(sent.length, 0, 'no overdue ping for a deadline that moved');
    assert.deepEqual(result, { done: false, waitSeconds: 30 * 60 + 1, version: 2, loop: 4 });
  });

  it('is done when the plan no longer exists', async () => {
    assert.deepEqual(await run(), { done: true, waitSeconds: 1, version: 0, loop: 4 });
  });

  it('closes 48 h after acknowledged and finishes', async () => {
    seedPlan({ status: 'acknowledged', settledAt: iso(T0) });
    clock = T0 + 48 * 60 * MIN;
    assert.equal((await run()).done, true);
    assert.equal(storedPlan().status, 'closed');
    assert.deepEqual(eventTypes(), ['closed']);
  });
});

describe('WaitForEvent', () => {
  const nudged = () => sfnMock.commandCalls(SendTaskSuccessCommand).map((c) => c.args[0].input.taskToken);

  it('parks the token with the loop counter and waits when nothing changed', async () => {
    seedPlan({ version: 5, tokenLoop: 3 });
    assert.deepEqual(await waitForEvent({ planId: PLAN_ID, taskToken: 'tok-4', version: 5, loop: 4 }), { parked: true, nudged: false });
    assert.equal(storedPlan().taskToken, 'tok-4');
    assert.equal(storedPlan().tokenLoop, 4);
    assert.deepEqual(nudged(), []);
  });

  it('nudges itself when the plan changed after Advance read it', async () => {
    seedPlan({ version: 6, tokenLoop: 3 });
    assert.deepEqual(await waitForEvent({ planId: PLAN_ID, taskToken: 'tok-4', version: 5, loop: 4 }), { parked: true, nudged: true });
    assert.deepEqual(nudged(), ['tok-4']);
  });

  it('never overwrites a later loop\'s token, and releases the stale task', async () => {
    seedPlan({ tokenLoop: 9, taskToken: 'tok-9' });
    assert.deepEqual(await waitForEvent({ planId: PLAN_ID, taskToken: 'tok-4', version: 1, loop: 4 }), { parked: false, nudged: true });
    assert.equal(storedPlan().taskToken, 'tok-9');
    assert.deepEqual(nudged(), ['tok-4']);
  });

  it('releases the task when the plan is gone', async () => {
    assert.deepEqual(await waitForEvent({ planId: PLAN_ID, taskToken: 'tok-1', version: 1, loop: 1 }), { parked: false, nudged: true });
  });

  it('ignores "task already closed" errors but fails the task on others (the state machine catches it into Advance)', async () => {
    seedPlan({ version: 6, tokenLoop: 0 });
    sfnMock.on(SendTaskSuccessCommand).rejects(awsError('TaskDoesNotExist'));
    assert.deepEqual(await waitForEvent({ planId: PLAN_ID, taskToken: 't', version: 5, loop: 1 }), { parked: true, nudged: true });
    sfnMock.on(SendTaskSuccessCommand).rejects(awsError('ThrottlingException'));
    await assert.rejects(waitForEvent({ planId: PLAN_ID, taskToken: 't', version: 5, loop: 2 }), { name: 'ThrottlingException' });
  });
});
