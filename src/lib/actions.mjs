// What the endpoints change, as pure functions of (plan, input, now). Each returns
// {changes, events} for commitPlan, or throws the documented 409/400. None of them
// sends anything: Advance performs every notification after the endpoint nudges it.

import { LIMITS, MINUTE, terminalTtl } from './config.mjs';
import { badRequest, conflict } from './http.mjs';
import { deadlines } from './timing.mjs';

const EXTENDABLE = new Set(['active', 'overdue']);

/** Prepends a location fix, keeping the newest 20. */
export function locationChanges(plan, location, now) {
  const fix = { ...location, at: now.toISOString() };
  return {
    changes: { locations: [fix, ...(plan.locations ?? [])].slice(0, LIMITS.locationsKept) },
    events: [{ type: 'location', detail: fix }],
  };
}

function assertOpen(plan) {
  if (plan.status === 'safe') throw conflict('already_safe', 'This plan is already checked in safe.');
  if (plan.status === 'closed') throw conflict('closed', 'This plan is closed.');
}

/** Owner check-in: safe, extend or sos (plus an optional location fix). */
export function checkinChanges(plan, { action, minutes, note, location }, now) {
  assertOpen(plan);
  const t = now.getTime();
  const iso = now.toISOString();
  let changes = {};
  const events = [];

  if (action === 'safe') {
    changes = { status: 'safe', safeAt: iso, safeNote: note, ttl: terminalTtl(plan.createdAt, now) };
    events.push({ type: 'safe', detail: { note } });
  } else if (action === 'extend') {
    if (!EXTENDABLE.has(plan.status)) {
      throw conflict('cannot_extend', 'Contacts have already been alerted. Use "I\'m safe" instead.');
    }
    // From overdue the deadline is in the past: "+30 min" means 30 minutes from now.
    const next = Math.max(Date.parse(plan.checkInBy), t) + minutes * MINUTE;
    if (next > Date.parse(plan.createdAt) + LIMITS.checkInMaxMs) {
      throw badRequest('The check-in time cannot be more than 7 days after the plan was created.', 'validation_error');
    }
    const checkInBy = new Date(next).toISOString();
    changes = { status: 'active', checkInBy, ...deadlines({ ...plan, checkInBy }, now), reminderSent: false, overdueAt: null };
    events.push({ type: 'extended', detail: { minutes, checkInBy } });
  } else if (action === 'sos') {
    // A repeated press while already in SOS is a no-op: every contact was just alerted.
    if (plan.status !== 'sos') {
      // Someone is already on it: keep that status, but everyone still gets the SOS alert.
      changes = { status: plan.status === 'acknowledged' ? 'acknowledged' : 'sos', sosAt: iso, sosNote: note };
      events.push({ type: 'sos', detail: { note } });
    }
  }

  if (location) {
    const loc = locationChanges(plan, location, now);
    Object.assign(changes, loc.changes);
    events.push(...loc.events);
  }
  return { changes, events };
}

const ACKABLE_PLAN = new Set(['alerting', 'sos', 'unanswered']);

/** A contact presses "I'm on it". */
export function ackChanges(plan, index, { note }, now) {
  if (plan.status === 'safe') throw conflict('safe', 'Good news: this person already checked in safe.');
  if (plan.status === 'closed') throw conflict('closed', 'This plan is closed.');
  const contact = plan.contacts[index];
  if (contact.state === 'acknowledged') throw conflict('already_acknowledged', 'You already said you are on it.');
  if (contact.state !== 'alerted') throw conflict('not_alerted', 'You have not been alerted. Nothing is wrong right now.');

  const iso = now.toISOString();
  const contacts = plan.contacts.map((c, i) => (i === index ? { ...c, state: 'acknowledged', acknowledgedAt: iso, note } : c));
  const changes = { contacts };
  if (ACKABLE_PLAN.has(plan.status)) Object.assign(changes, { status: 'acknowledged', acknowledgedAt: iso, settledAt: iso });
  return { changes, events: [{ type: 'acknowledged', detail: { index, name: contact.name, note } }] };
}
