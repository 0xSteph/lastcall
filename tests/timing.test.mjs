// The lifecycle rules as pure functions: every milestone, the wait until the next
// one, and the order of escalation.

import './helpers.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MIN, T0, at, contactsWith, iso, planItem } from './fixtures.mjs';
import { deadlines, nextMilestone, nextStep, schedule } from '../src/lib/timing.mjs';

/** Applies every due step at `now` (what Advance does), returning the plan and step names. */
function drain(plan, now) {
  const names = [];
  let current = plan;
  for (let step = nextStep(current, now); step; step = nextStep(current, now)) {
    names.push(step.name);
    current = { ...current, ...step.changes };
    assert.ok(names.length < 50, 'runaway loop');
  }
  return { plan: current, names };
}

const wait = (plan, ms) => schedule(plan, at(ms)).waitSeconds;

describe('deadlines', () => {
  it('derives graceUntil and remindAt from checkInBy', () => {
    const d = deadlines({ checkInBy: iso(T0 + 120 * MIN), graceMinutes: 15, remindMinutesBefore: 15 }, at(T0));
    assert.deepEqual(d, { graceUntil: iso(T0 + 135 * MIN), remindAt: iso(T0 + 105 * MIN) });
  });

  it('has no reminder when remindMinutesBefore is 0', () => {
    assert.equal(deadlines({ checkInBy: iso(T0 + 120 * MIN), graceMinutes: 15, remindMinutesBefore: 0 }, at(T0)).remindAt, null);
  });

  it('skips a reminder that would already be past', () => {
    const d = deadlines({ checkInBy: iso(T0 + 10 * MIN), graceMinutes: 15, remindMinutesBefore: 15 }, at(T0));
    assert.equal(d.remindAt, null);
  });

  it('grace 0 makes graceUntil equal checkInBy', () => {
    const d = deadlines({ checkInBy: iso(T0 + 2 * MIN), graceMinutes: 0, remindMinutesBefore: 1 }, at(T0));
    assert.equal(d.graceUntil, iso(T0 + 2 * MIN));
    assert.equal(d.remindAt, iso(T0 + 1 * MIN));
  });
});

describe('active', () => {
  it('waits for the reminder first (with 1 s of slack)', () => {
    const plan = planItem();
    assert.equal(nextStep(plan, at(T0 + 60 * MIN)), null);
    assert.equal(wait(plan, T0 + 60 * MIN), 45 * 60 + 1);
    assert.deepEqual(schedule(plan, at(T0)), { done: false, waitSeconds: 105 * 60 + 1 });
  });

  it('sends the reminder once, then waits for the deadline', () => {
    const step = nextStep(planItem(), at(T0 + 105 * MIN));
    assert.equal(step.name, 'reminder');
    assert.deepEqual(step.changes, { reminderSent: true });
    assert.deepEqual(step.effect, { kind: 'reminder' });
    const after = { ...planItem(), ...step.changes };
    assert.equal(nextStep(after, at(T0 + 105 * MIN)), null);
    assert.equal(wait(after, T0 + 105 * MIN), 15 * 60 + 1);
  });

  it('with no reminder, waits straight for the deadline', () => {
    const plan = planItem({ remindAt: null });
    assert.equal(nextStep(plan, at(T0 + 110 * MIN)), null);
    assert.equal(wait(plan, T0 + 110 * MIN), 10 * 60 + 1);
  });

  it('rounds partial seconds up and never waits less than 1 s', () => {
    const plan = planItem({ remindAt: null });
    assert.equal(wait(plan, T0 + 120 * MIN - 500), 2);
    assert.equal(wait(plan, T0 + 120 * MIN - 1), 2);
  });

  it('goes overdue at checkInBy, pings the owner, then waits for graceUntil', () => {
    const plan = planItem({ reminderSent: true });
    const step = nextStep(plan, at(T0 + 120 * MIN));
    assert.equal(step.name, 'overdue');
    assert.equal(step.changes.status, 'overdue');
    assert.deepEqual(step.events, [{ type: 'overdue', detail: { checkInBy: plan.checkInBy } }]);
    assert.deepEqual(step.effect, { kind: 'overdue' });
    const { plan: after, names } = drain(plan, at(T0 + 120 * MIN));
    assert.deepEqual(names, ['overdue']);
    assert.equal(wait(after, T0 + 120 * MIN), 15 * 60 + 1);
  });

  it('skips a reminder that is still unsent once the deadline has passed', () => {
    assert.deepEqual(drain(planItem(), at(T0 + 121 * MIN)).names, ['overdue']);
  });
});

describe('overdue and alerting', () => {
  const overdue = () => planItem({ status: 'overdue', reminderSent: true, overdueAt: iso(T0 + 120 * MIN) });

  it('starts alerting at graceUntil with contact 0, then waits ackMinutes', () => {
    const { plan, names } = drain(overdue(), at(T0 + 135 * MIN));
    assert.deepEqual(names, ['alerting', 'alert']);
    assert.equal(plan.status, 'alerting');
    assert.equal(plan.contacts[0].state, 'alerted');
    assert.equal(plan.contacts[0].alertedAt, iso(T0 + 135 * MIN));
    assert.equal(plan.contacts[1].state, 'standby');
    assert.equal(wait(plan, T0 + 135 * MIN), 10 * 60 + 1);
  });

  it('escalates in order, keeps earlier contacts alerted, then goes unanswered', () => {
    let { plan } = drain(overdue(), at(T0 + 135 * MIN));
    assert.equal(nextStep(plan, at(T0 + 144 * MIN)), null);

    const second = nextStep(plan, at(T0 + 145 * MIN));
    assert.equal(second.name, 'alert');
    assert.deepEqual(second.effect, { kind: 'alert', index: 1, sos: false });
    ({ plan } = drain(plan, at(T0 + 145 * MIN)));
    assert.deepEqual(plan.contacts.map((c) => c.state), ['alerted', 'alerted']);
    assert.equal(wait(plan, T0 + 145 * MIN), 10 * 60 + 1);

    const last = drain(plan, at(T0 + 155 * MIN));
    assert.deepEqual(last.names, ['unanswered']);
    assert.equal(last.plan.status, 'unanswered');
    assert.equal(last.plan.settledAt, iso(T0 + 155 * MIN));
    assert.equal(wait(last.plan, T0 + 155 * MIN), 48 * 3600 + 1);
  });

  it('escalates from when the contact was actually alerted', () => {
    const plan = planItem({ status: 'alerting', contacts: contactsWith([{ state: 'alerted', alertedAt: iso(T0 + 140 * MIN) }]) });
    assert.equal(nextStep(plan, at(T0 + 149 * MIN)), null);
    assert.equal(nextStep(plan, at(T0 + 150 * MIN)).effect.index, 1);
    assert.equal(nextMilestone(plan), T0 + 150 * MIN);
  });

  it('applies every due transition in one pass when Advance runs late', () => {
    const { plan, names } = drain(planItem({ reminderSent: true }), at(T0 + 140 * MIN));
    assert.deepEqual(names, ['overdue', 'alerting', 'alert']);
    assert.equal(plan.contacts[1].state, 'standby', 'the next contact still gets a full ackMinutes');
  });

  it('grace 0 alerts contact 0 at the deadline itself', () => {
    const plan = planItem({ graceMinutes: 0, graceUntil: iso(T0 + 120 * MIN), remindAt: null });
    assert.deepEqual(drain(plan, at(T0 + 120 * MIN)).names, ['overdue', 'alerting', 'alert']);
  });
});

describe('sos', () => {
  it('alerts every contact at once, then goes unanswered after ackMinutes', () => {
    const plan = planItem({ status: 'sos', sosAt: iso(T0 + 30 * MIN) });
    const { plan: after, names } = drain(plan, at(T0 + 30 * MIN));
    assert.deepEqual(names, ['sos_alert', 'sos_alert']);
    assert.deepEqual(after.contacts.map((c) => c.state), ['alerted', 'alerted']);
    assert.equal(wait(after, T0 + 30 * MIN), 10 * 60 + 1);
    assert.deepEqual(drain(after, at(T0 + 40 * MIN)).names, ['unanswered']);
  });

  it('marks the SOS alert as an SOS effect', () => {
    const step = nextStep(planItem({ status: 'sos', sosAt: iso(T0) }), at(T0));
    assert.deepEqual(step.effect, { kind: 'alert', index: 0, sos: true });
  });

  it('also reaches contacts already alerted by escalation, keeping their alertedAt', () => {
    const plan = planItem({
      status: 'sos', sosAt: iso(T0 + 140 * MIN),
      contacts: contactsWith([{ state: 'alerted', alertedAt: iso(T0 + 135 * MIN) }]),
    });
    const { plan: after, names } = drain(plan, at(T0 + 140 * MIN));
    assert.deepEqual(names, ['sos_alert', 'sos_alert']);
    assert.equal(after.contacts[0].alertedAt, iso(T0 + 135 * MIN));
    assert.equal(after.contacts[1].alertedAt, iso(T0 + 140 * MIN));
  });

  it('sends SOS alerts even when someone is already on it, and keeps acknowledged', () => {
    const plan = planItem({
      status: 'acknowledged', settledAt: iso(T0 + 140 * MIN), sosAt: iso(T0 + 150 * MIN),
      contacts: contactsWith([{ state: 'acknowledged', alertedAt: iso(T0 + 135 * MIN), acknowledgedAt: iso(T0 + 140 * MIN) }]),
    });
    const { plan: after, names } = drain(plan, at(T0 + 150 * MIN));
    assert.deepEqual(names, ['sos_alert', 'sos_alert']);
    assert.equal(after.status, 'acknowledged');
    assert.equal(after.contacts[0].state, 'acknowledged');
  });

  it('a second SOS press (later sosAt) alerts everyone again', () => {
    const plan = planItem({
      status: 'sos', sosAt: iso(T0 + 200 * MIN),
      contacts: contactsWith([
        { state: 'alerted', alertedAt: iso(T0), sosAlertedAt: iso(T0 + 10 * MIN) },
        { state: 'alerted', alertedAt: iso(T0), sosAlertedAt: iso(T0 + 10 * MIN) },
      ]),
    });
    assert.deepEqual(drain(plan, at(T0 + 200 * MIN)).names, ['sos_alert', 'sos_alert']);
  });
});

describe('acknowledged, unanswered, closed', () => {
  it('stops escalating once acknowledged and closes 48 h later', () => {
    const plan = planItem({
      status: 'acknowledged', settledAt: iso(T0 + 140 * MIN),
      contacts: contactsWith([{ state: 'acknowledged', alertedAt: iso(T0 + 135 * MIN) }]),
    });
    assert.equal(nextStep(plan, at(T0 + 47 * 60 * MIN)), null);
    assert.equal(nextMilestone(plan), T0 + 140 * MIN + 48 * 60 * MIN);
    const step = nextStep(plan, at(T0 + 140 * MIN + 48 * 60 * MIN));
    assert.equal(step.name, 'closed');
    assert.equal(step.changes.status, 'closed');
    assert.deepEqual(step.events, [{ type: 'closed', detail: {} }]);
    // TTL: 7 days after closing beats 14 days after creation here.
    assert.equal(step.changes.ttl, Math.max(Math.floor((T0 + 14 * 86_400_000) / 1000), Math.floor((T0 + 140 * MIN + 48 * 60 * MIN + 7 * 86_400_000) / 1000)));
  });

  it('closes an unanswered plan 48 h after it went unanswered', () => {
    const plan = planItem({ status: 'unanswered', settledAt: iso(T0 + 155 * MIN) });
    assert.equal(nextStep(plan, at(T0 + 155 * MIN + 48 * 60 * MIN - 1)), null);
    assert.equal(nextStep(plan, at(T0 + 155 * MIN + 48 * 60 * MIN)).name, 'closed');
  });

  it('is done once closed', () => {
    assert.deepEqual(schedule(planItem({ status: 'closed' }), at(T0)), { done: true, waitSeconds: 1 });
  });
});

describe('safe', () => {
  it('sends an all clear to every alerted or acknowledged contact, then is done', () => {
    const plan = planItem({
      status: 'safe', safeAt: iso(T0 + 150 * MIN),
      contacts: contactsWith([{ state: 'acknowledged', alertedAt: iso(T0) }, { state: 'alerted', alertedAt: iso(T0) }]),
    });
    const first = nextStep(plan, at(T0 + 150 * MIN));
    assert.deepEqual(first.effect, { kind: 'allClear', index: 0 });
    assert.equal(first.changes.contacts[0].allClearSent, true);
    const { plan: after, names } = drain(plan, at(T0 + 150 * MIN));
    assert.deepEqual(names, ['all_clear', 'all_clear']);
    assert.deepEqual(schedule(after, at(T0 + 150 * MIN)), { done: true, waitSeconds: 1 });
  });

  it('sends nothing to contacts who were never alerted', () => {
    const plan = planItem({ status: 'safe', safeAt: iso(T0), contacts: contactsWith([{ state: 'alerted', alertedAt: iso(T0) }]) });
    assert.deepEqual(drain(plan, at(T0)).names, ['all_clear']);
    assert.equal(nextStep(planItem({ status: 'safe', safeAt: iso(T0) }), at(T0)), null);
  });

  it('is not done while an all clear is still owed', () => {
    const plan = planItem({ status: 'safe', safeAt: iso(T0), contacts: contactsWith([{ state: 'alerted', alertedAt: iso(T0) }]) });
    assert.deepEqual(schedule(plan, at(T0)), { done: false, waitSeconds: 1 });
  });
});
