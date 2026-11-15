// Endpoint state changes as pure functions: extend rules, safe, sos, ack, location.

import './helpers.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MIN, T0, at, contactsWith, iso, planItem } from './fixtures.mjs';
import { ackChanges, checkinChanges, locationChanges } from '../src/lib/actions.mjs';

const checkin = (plan, input, nowMs) => checkinChanges(plan, { minutes: null, note: null, location: null, ...input }, at(nowMs));
const rejects = (fn, status, code) => assert.throws(fn, (err) => err.status === status && err.code === code);

describe('extend', () => {
  it('adds minutes to checkInBy while active and re-arms the reminder', () => {
    const plan = planItem({ reminderSent: true });
    const { changes, events } = checkin(plan, { action: 'extend', minutes: 30 }, T0 + 110 * MIN);
    assert.equal(changes.status, 'active');
    assert.equal(changes.checkInBy, iso(T0 + 150 * MIN));
    assert.equal(changes.graceUntil, iso(T0 + 165 * MIN));
    assert.equal(changes.remindAt, iso(T0 + 135 * MIN));
    assert.equal(changes.reminderSent, false);
    assert.deepEqual(events, [{ type: 'extended', detail: { minutes: 30, checkInBy: iso(T0 + 150 * MIN) } }]);
  });

  it('skips the re-armed reminder when it would already be past', () => {
    const { changes } = checkin(planItem(), { action: 'extend', minutes: 5 }, T0 + 115 * MIN);
    assert.equal(changes.checkInBy, iso(T0 + 125 * MIN));
    assert.equal(changes.remindAt, null);
  });

  it('from overdue counts from now (the old deadline is in the past) and resets to active', () => {
    const plan = planItem({ status: 'overdue', overdueAt: iso(T0 + 120 * MIN) });
    const { changes } = checkin(plan, { action: 'extend', minutes: 30 }, T0 + 130 * MIN);
    assert.equal(changes.status, 'active');
    assert.equal(changes.checkInBy, iso(T0 + 160 * MIN));
    assert.equal(changes.overdueAt, null);
  });

  it('refuses once contacts are involved', () => {
    for (const status of ['alerting', 'sos', 'acknowledged', 'unanswered']) {
      rejects(() => checkin(planItem({ status }), { action: 'extend', minutes: 30 }, T0), 409, 'cannot_extend');
    }
  });

  it('keeps the deadline within 7 days of creation', () => {
    const plan = planItem({ checkInBy: iso(T0 + 7 * 24 * 60 * MIN - 10 * MIN) });
    rejects(() => checkin(plan, { action: 'extend', minutes: 30 }, T0), 400, 'validation_error');
    assert.ok(checkin(plan, { action: 'extend', minutes: 10 }, T0).changes.checkInBy);
  });
});

describe('safe', () => {
  it('ends the plan from any open state', () => {
    for (const status of ['active', 'overdue', 'alerting', 'sos', 'acknowledged', 'unanswered']) {
      const { changes, events } = checkin(planItem({ status }), { action: 'safe', note: 'Back at the car' }, T0 + 60 * MIN);
      assert.equal(changes.status, 'safe');
      assert.equal(changes.safeAt, iso(T0 + 60 * MIN));
      assert.equal(changes.ttl, Math.floor((T0 + 14 * 86_400_000) / 1000));
      assert.deepEqual(events, [{ type: 'safe', detail: { note: 'Back at the car' } }]);
    }
  });

  it('409s on terminal plans, for every action', () => {
    for (const action of ['safe', 'extend', 'sos']) {
      rejects(() => checkin(planItem({ status: 'safe' }), { action, minutes: 30 }, T0), 409, 'already_safe');
      rejects(() => checkin(planItem({ status: 'closed' }), { action, minutes: 30 }, T0), 409, 'closed');
    }
  });

  it('records a location sent with the check-in', () => {
    const { changes, events } = checkin(planItem(), { action: 'safe', location: { lat: 1, lng: 2, accuracy: 5 } }, T0);
    assert.deepEqual(changes.locations[0], { lat: 1, lng: 2, accuracy: 5, at: iso(T0) });
    assert.deepEqual(events.map((e) => e.type), ['safe', 'location']);
  });
});

describe('sos', () => {
  it('switches to sos and stamps sosAt', () => {
    const { changes, events } = checkin(planItem(), { action: 'sos', note: 'Twisted ankle' }, T0 + 5 * MIN);
    assert.deepEqual(changes, { status: 'sos', sosAt: iso(T0 + 5 * MIN), sosNote: 'Twisted ankle' });
    assert.deepEqual(events, [{ type: 'sos', detail: { note: 'Twisted ankle' } }]);
  });

  it('keeps acknowledged (someone is on it) but still triggers SOS alerts', () => {
    const { changes } = checkin(planItem({ status: 'acknowledged' }), { action: 'sos' }, T0);
    assert.equal(changes.status, 'acknowledged');
    assert.equal(changes.sosAt, iso(T0));
  });

  it('is a no-op when already in sos', () => {
    assert.deepEqual(checkin(planItem({ status: 'sos', sosAt: iso(T0) }), { action: 'sos' }, T0 + MIN), { changes: {}, events: [] });
  });
});

describe('ack', () => {
  const alerting = (patches) => planItem({ status: 'alerting', contacts: contactsWith(patches) });

  it('marks the contact acknowledged and the plan acknowledged', () => {
    const { changes, events } = ackChanges(alerting([{ state: 'alerted', alertedAt: iso(T0) }]), 0, { note: 'Calling now' }, at(T0 + MIN));
    assert.equal(changes.status, 'acknowledged');
    assert.equal(changes.settledAt, iso(T0 + MIN));
    assert.deepEqual(
      { state: changes.contacts[0].state, acknowledgedAt: changes.contacts[0].acknowledgedAt, note: changes.contacts[0].note },
      { state: 'acknowledged', acknowledgedAt: iso(T0 + MIN), note: 'Calling now' },
    );
    assert.equal(changes.contacts[0].secretHash, alerting([]).contacts[0].secretHash, 'server-side fields are kept');
    assert.deepEqual(events, [{ type: 'acknowledged', detail: { index: 0, name: 'Alex', note: 'Calling now' } }]);
  });

  it('acknowledges from sos and unanswered too', () => {
    for (const status of ['sos', 'unanswered']) {
      const plan = planItem({ status, contacts: contactsWith([{ state: 'alerted', alertedAt: iso(T0) }]) });
      assert.equal(ackChanges(plan, 0, { note: null }, at(T0)).changes.status, 'acknowledged');
    }
  });

  it('a second contact can still acknowledge; the plan stays acknowledged', () => {
    const plan = planItem({
      status: 'acknowledged', settledAt: iso(T0),
      contacts: contactsWith([{ state: 'acknowledged' }, { state: 'alerted', alertedAt: iso(T0) }]),
    });
    const { changes } = ackChanges(plan, 1, { note: null }, at(T0 + MIN));
    assert.equal(changes.status, undefined);
    assert.equal(changes.contacts[1].state, 'acknowledged');
  });

  it('refuses with the documented codes', () => {
    rejects(() => ackChanges(alerting([]), 0, {}, at(T0)), 409, 'not_alerted');
    rejects(() => ackChanges(alerting([{ state: 'acknowledged' }]), 0, {}, at(T0)), 409, 'already_acknowledged');
    rejects(() => ackChanges(planItem({ status: 'safe', contacts: contactsWith([{ state: 'alerted' }]) }), 0, {}, at(T0)), 409, 'safe');
    rejects(() => ackChanges(planItem({ status: 'closed', contacts: contactsWith([{ state: 'alerted' }]) }), 0, {}, at(T0)), 409, 'closed');
  });
});

describe('location', () => {
  it('prepends the newest fix and keeps 20', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ lat: i, lng: i, accuracy: 1, at: iso(T0 - i * MIN) }));
    const { changes, events } = locationChanges(planItem({ locations: many }), { lat: 50, lng: 5, accuracy: null }, at(T0 + MIN));
    assert.equal(changes.locations.length, 20);
    assert.deepEqual(changes.locations[0], { lat: 50, lng: 5, accuracy: null, at: iso(T0 + MIN) });
    assert.equal(changes.locations[19].lat, 18);
    assert.deepEqual(events, [{ type: 'location', detail: changes.locations[0] }]);
  });
});
