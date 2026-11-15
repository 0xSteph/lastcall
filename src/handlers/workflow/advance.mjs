// State machine task: Advance.
// Input:  {planId, secrets: {owner, contacts: []}, loop}
// Output: {done, waitSeconds, version, loop}
//
// The single place with side effects. Reads the plan, applies every transition due
// now one step at a time, and for each step:
//   1. commits the step's "done" marker with a version-checked write
//      (e.g. contacts[1].state standby -> alerted), then
//   2. performs the notification, then records how it went.
// If anyone wrote in between, the commit fails and the step is re-decided from a
// fresh read, so a retry, a duplicate invocation or a racing endpoint can never send
// the same notification twice. (A crash between 1 and 2 loses that one message
// rather than repeating it: at most once, by design.)

import { commitPlan, eventItem, getPlan, isConditionFailure, putEvent } from '../../lib/db.mjs';
import { messageFor } from '../../lib/messages.mjs';
import { buildNotification, channelOf } from '../../lib/notify-presets.mjs';
import { sendRequest } from '../../lib/outbound.mjs';
import { nextStep, schedule } from '../../lib/timing.mjs';

// Swappable in tests: no network, and a controllable clock.
export const deps = { sendRequest, now: () => new Date() };

const MAX_STEPS = 30; // a plan has at most ~15 due steps at once; this only bounds a pathological loop

export async function handler({ planId, secrets = { contacts: [] }, loop = 0 }) {
  let plan = await getPlan(planId);
  if (!plan) return { done: true, waitSeconds: 1, version: 0, loop: loop + 1 };

  for (let i = 0; i < MAX_STEPS; i++) {
    const now = deps.now();
    const step = nextStep(plan, now);
    if (!step) break;
    try {
      plan = await commitPlan(plan, step.changes, step.events.map((e) => eventItem(plan, e.type, e.detail, now)));
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
      plan = await getPlan(planId); // someone else moved first: decide again from what they wrote
      if (!plan) return { done: true, waitSeconds: 1, version: 0, loop: loop + 1 };
      continue;
    }
    if (step.effect) await perform(plan, step.effect, secrets, now);
  }

  return { ...schedule(plan, deps.now()), version: plan.version, loop: loop + 1 };
}

/** Sends one notification and records the outcome. Never throws for delivery failures. */
async function perform(plan, effect, secrets, now) {
  const toOwner = effect.kind === 'reminder' || effect.kind === 'overdue';
  const contact = toOwner ? null : plan.contacts[effect.index];
  const notifyUrl = toOwner ? plan.ownerNotifyUrl : contact.notifyUrl;

  let ok = false;
  let channel = 'webhook';
  try {
    const request = buildNotification(notifyUrl, messageFor(plan, effect, { secrets, now }));
    channel = channelOf(request.preset);
    const res = await deps.sendRequest(notifyUrl, request);
    ok = res.status >= 200 && res.status < 300;
    if (!ok) console.warn('Notification rejected', { planId: plan.id, kind: effect.kind, status: res.status });
  } catch (err) {
    console.warn('Notification failed', { planId: plan.id, kind: effect.kind, error: err.message });
  }

  const [type, detail] = {
    reminder: () => ['reminder_sent', { ok }],
    overdue: () => ['owner_pinged', { ok }],
    alert: () => ['alerted', { index: effect.index, name: contact.name, channel, ok, ...(effect.sos ? { sos: true } : {}) }],
    allClear: () => ['all_clear_sent', { index: effect.index, name: contact.name, ok }],
  }[effect.kind]();

  try {
    await putEvent(eventItem(plan, type, detail, deps.now()));
  } catch (err) {
    // The notification went (or not) either way; a lost timeline entry must not fail the step.
    console.error('Could not record event', { planId: plan.id, type, error: err });
  }
}
