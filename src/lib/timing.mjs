// The plan lifecycle as pure functions of (plan, now). No I/O, so every timing rule
// is unit-testable. Advance calls nextStep() until it returns null, committing each
// step (and performing its side effect) as it goes, then schedule() for the wait.
//
//   active ──checkInBy──▶ overdue ──graceUntil──▶ alerting ──(contact i, +ackMinutes)…──▶ unanswered
//      │ owner "sos"                                  │ contact acks                           │
//      ▼                                              ▼                                        ▼
//     sos ──sosAt + ackMinutes──▶ unanswered     acknowledged ──48 h──▶ closed ◀──48 h──── unanswered
//   any non-terminal ──owner "safe"──▶ safe (then "all clear" to every alerted contact)

import { LIMITS, MINUTE, terminalTtl } from './config.mjs';

export const TERMINAL = new Set(['safe', 'closed']);

const ms = (iso) => (iso ? Date.parse(iso) : Number.NaN);
const isoAt = (t) => new Date(t).toISOString();

/** graceUntil and remindAt for a deadline. The reminder is skipped when it would already be past. */
export function deadlines({ checkInBy, graceMinutes, remindMinutesBefore }, now) {
  const due = ms(checkInBy);
  const remind = due - remindMinutesBefore * MINUTE;
  return {
    graceUntil: isoAt(due + graceMinutes * MINUTE),
    remindAt: remindMinutesBefore > 0 && remind > now.getTime() ? isoAt(remind) : null,
  };
}

const withContact = (contacts, index, patch) => contacts.map((c, i) => (i === index ? { ...c, ...patch } : c));

/** Contacts still owed the SOS alert for the latest SOS press. */
const owesSos = (plan, contact) => !contact.sosAlertedAt || contact.sosAlertedAt < plan.sosAt;

function unanswered(iso) {
  return {
    name: 'unanswered',
    changes: { status: 'unanswered', unansweredAt: iso, settledAt: iso },
    events: [{ type: 'unanswered', detail: {} }],
  };
}

/**
 * The single next transition due at `now`, or null when nothing is due.
 * Returns {name, changes, events: [{type, detail}], effect?}. `changes` are top-level
 * plan attributes; for side effects they include the "done" marker (contact state,
 * reminderSent, allClearSent...), which is committed before the effect is performed.
 */
export function nextStep(plan, now) {
  const t = now.getTime();
  const iso = now.toISOString();
  const contacts = plan.contacts ?? [];
  const ack = plan.ackMinutes * MINUTE;

  if (plan.status === 'closed') return null;

  if (plan.status === 'safe') {
    const index = contacts.findIndex((c) => c.state !== 'standby' && !c.allClearSent);
    if (index === -1) return null;
    return {
      name: 'all_clear',
      changes: { contacts: withContact(contacts, index, { allClearSent: true }) },
      events: [],
      effect: { kind: 'allClear', index },
    };
  }

  // SOS reaches every contact at once, including ones already alerted or on it.
  if (plan.sosAt && (plan.status === 'sos' || plan.status === 'acknowledged')) {
    const index = contacts.findIndex((c) => owesSos(plan, c));
    if (index !== -1) {
      const patch = { sosAlertedAt: iso };
      if (contacts[index].state === 'standby') Object.assign(patch, { state: 'alerted', alertedAt: iso });
      return {
        name: 'sos_alert',
        changes: { contacts: withContact(contacts, index, patch) },
        events: [],
        effect: { kind: 'alert', index, sos: true },
      };
    }
  }

  switch (plan.status) {
    case 'active':
      if (t >= ms(plan.checkInBy)) {
        return {
          name: 'overdue',
          changes: { status: 'overdue', overdueAt: iso },
          events: [{ type: 'overdue', detail: { checkInBy: plan.checkInBy } }],
          effect: { kind: 'overdue' },
        };
      }
      if (plan.remindAt && !plan.reminderSent && t >= ms(plan.remindAt)) {
        return { name: 'reminder', changes: { reminderSent: true }, events: [], effect: { kind: 'reminder' } };
      }
      return null;

    case 'overdue':
      if (t >= ms(plan.graceUntil)) return { name: 'alerting', changes: { status: 'alerting', alertingAt: iso }, events: [] };
      return null;

    case 'alerting': {
      // Contacts are alerted in order, so the first standby contact is next in line.
      const next = contacts.findIndex((c) => c.state === 'standby');
      const last = next === -1 ? contacts.length - 1 : next - 1;
      if (last >= 0 && t < ms(contacts[last].alertedAt) + ack) return null;
      if (next !== -1) {
        return {
          name: 'alert',
          changes: { contacts: withContact(contacts, next, { state: 'alerted', alertedAt: iso }) },
          events: [],
          effect: { kind: 'alert', index: next, sos: false },
        };
      }
      return unanswered(iso);
    }

    case 'sos':
      return t >= ms(plan.sosAt) + ack ? unanswered(iso) : null;

    case 'acknowledged':
    case 'unanswered':
      if (t >= ms(plan.settledAt) + LIMITS.closeAfterMs) {
        return {
          name: 'closed',
          changes: { status: 'closed', closedAt: iso, ttl: terminalTtl(plan.createdAt, now) },
          events: [{ type: 'closed', detail: {} }],
        };
      }
      return null;

    default:
      return null;
  }
}

/** Epoch ms of the next time-based transition, or null if the plan only moves on input. */
export function nextMilestone(plan) {
  const contacts = plan.contacts ?? [];
  const ack = plan.ackMinutes * MINUTE;
  switch (plan.status) {
    case 'active': {
      const due = ms(plan.checkInBy);
      return plan.remindAt && !plan.reminderSent ? Math.min(ms(plan.remindAt), due) : due;
    }
    case 'overdue':
      return ms(plan.graceUntil);
    case 'alerting': {
      const alerted = contacts.filter((c) => c.alertedAt).map((c) => ms(c.alertedAt));
      return alerted.length ? Math.max(...alerted) + ack : 0;
    }
    case 'sos':
      return ms(plan.sosAt) + ack;
    case 'acknowledged':
    case 'unanswered':
      return ms(plan.settledAt) + LIMITS.closeAfterMs;
    default:
      return null;
  }
}

const IDLE_WAIT_SECONDS = 3600; // non-terminal with no milestone: should not happen, re-check hourly

/** {done, waitSeconds} after every due step has been applied. */
export function schedule(plan, now) {
  if (nextStep(plan, now)) return { done: false, waitSeconds: 1 };
  if (TERMINAL.has(plan.status)) return { done: true, waitSeconds: 1 };
  const at = nextMilestone(plan);
  if (at === null || !Number.isFinite(at)) return { done: false, waitSeconds: IDLE_WAIT_SECONDS };
  // Minimum 1 s, plus 1 s of slack so the wake-up lands after the milestone, not just before.
  return { done: false, waitSeconds: Math.max(1, Math.ceil((at - now.getTime()) / 1000) + 1) };
}
