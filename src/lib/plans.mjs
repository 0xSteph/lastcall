// Plan views, links, link-secret checks and the endpoint write loop.
// The views are allowlists: secret hashes, notify URLs, task tokens and apiBase
// never leave the table, whatever gets added to the item later.

import { webBaseUrl } from './config.mjs';
import { commitPlan, eventItem, getEvents, getPlan, isConditionFailure } from './db.mjs';
import { HttpError, notFound, pathParam, queryParam, unauthorized } from './http.mjs';
import { isPlanId, secretMatches } from './ids.mjs';
import { parseContactIndex } from './validate.mjs';
import { nudge } from './workflow.mjs';

const enc = encodeURIComponent;

// ---------------------------------------------------------------- links
// Page links carry the secret in the fragment so it never reaches access logs.

export const ownerUrl = (planId, secret) => `${webBaseUrl()}/plan.html#id=${enc(planId)}&s=${enc(secret)}`;
export const alertUrl = (planId, index, secret) => `${webBaseUrl()}/alert.html#id=${enc(planId)}&c=${index}&s=${enc(secret)}`;

/** One-tap API endpoints for ntfy http actions (POST with an empty body). */
export const checkinActionUrl = (apiBase, planId, secret, action, minutes) =>
  `${apiBase}/v1/plans/${planId}/checkin?s=${enc(secret)}&a=${action}${minutes ? `&m=${minutes}` : ''}`;
export const ackActionUrl = (apiBase, planId, index, secret) =>
  `${apiBase}/v1/plans/${planId}/ack?c=${index}&s=${enc(secret)}&a=ack`;

// ---------------------------------------------------------------- views

const publicEvent = (event) => ({ type: event.type, at: event.at, detail: event.detail ?? {} });

const publicContact = (c) => ({
  name: c.name,
  relationship: c.relationship ?? null,
  state: c.state,
  alertedAt: c.alertedAt ?? null,
  acknowledgedAt: c.acknowledgedAt ?? null,
  note: c.note ?? null,
  allClearSent: Boolean(c.allClearSent),
});

const publicLocation = (l) => ({ lat: l.lat, lng: l.lng, accuracy: l.accuracy ?? null, at: l.at });

function baseView(plan, events, now, { withLocations }) {
  const locations = plan.locations ?? [];
  const view = {
    id: plan.id,
    name: plan.name,
    activity: plan.activity,
    details: plan.details ?? null,
    routeUrl: plan.routeUrl ?? null,
    phone: plan.phone ?? null,
    timeZone: plan.timeZone ?? 'UTC',
    status: plan.status,
    createdAt: plan.createdAt,
    checkInBy: plan.checkInBy,
    graceUntil: plan.graceUntil,
    remindAt: plan.remindAt ?? null,
    remindMinutesBefore: plan.remindMinutesBefore,
    graceMinutes: plan.graceMinutes,
    ackMinutes: plan.ackMinutes,
    safeAt: plan.safeAt ?? null,
    closedAt: plan.closedAt ?? null,
    lastLocation: locations[0] ? publicLocation(locations[0]) : null,
  };
  if (withLocations) view.locations = locations.map(publicLocation);
  view.contacts = (plan.contacts ?? []).map(publicContact);
  // Contacts see the last known location only, so location events lose their coordinates.
  view.events = events.map(publicEvent).map((e) => (withLocations || e.type !== 'location' ? e : { ...e, detail: {} }));
  view.now = now.toISOString();
  return view;
}

export const ownerView = (plan, events, now = new Date()) => baseView(plan, events, now, { withLocations: true });

/** Same as the owner view minus the location history, plus who is looking. */
export function contactView(plan, events, index, now = new Date()) {
  const contact = plan.contacts[index];
  return { ...baseView(plan, events, now, { withLocations: false }), you: { index, name: contact.name, state: contact.state } };
}

// ---------------------------------------------------------------- access

/** Loads the plan from the path and checks the owner secret (?s=). 404 before 401, so unknown IDs say nothing. */
export async function loadForOwner(event) {
  const id = pathParam(event, 'id');
  if (!isPlanId(id)) throw notFound();
  const plan = await getPlan(id);
  if (!plan) throw notFound();
  if (!secretMatches(queryParam(event, 's'), plan.ownerSecretHash)) throw unauthorized('This plan link is not valid.', 'invalid_secret');
  return plan;
}

/** Loads the plan and checks contact ?c= against its own secret ?s=. Returns {plan, index}. */
export async function loadForContact(event) {
  const id = pathParam(event, 'id');
  if (!isPlanId(id)) throw notFound();
  const plan = await getPlan(id);
  if (!plan) throw notFound();
  const index = parseContactIndex(queryParam(event, 'c'));
  const contact = index === null ? undefined : plan.contacts?.[index];
  if (!contact) throw notFound('Contact not found.');
  if (!secretMatches(queryParam(event, 's'), contact.secretHash)) throw unauthorized('This alert link is not valid.', 'invalid_secret');
  return { plan, index };
}

// ---------------------------------------------------------------- writes

const MAX_ATTEMPTS = 5;

/**
 * Applies `decide(plan, now)` -> {changes, events} with a version-checked write,
 * re-reading and deciding again if Advance (or another request) wrote first.
 * Then nudges the workflow (unless `nudgeWorkflow` is false) and returns the fresh
 * plan with its events. `decide` may throw an HttpError (409/400) to refuse.
 */
export async function mutatePlan(plan, decide, { nudgeWorkflow = true } = {}) {
  let current = plan;
  let wrote = false;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const now = new Date();
    const { changes, events } = decide(current, now);
    if (Object.keys(changes).length === 0 && events.length === 0) break; // nothing to do (idempotent repeat)
    try {
      await commitPlan(current, changes, events.map((e) => eventItem(current, e.type, e.detail, now)));
      wrote = true;
      break;
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
      if (attempt === MAX_ATTEMPTS) throw new HttpError(503, 'busy', 'The plan is changing right now. Please retry.');
      current = await getPlan(plan.id);
      if (!current) throw notFound();
    }
  }

  // Re-read after the write: the stored task token is the one to nudge. If
  // WaitForEvent parks a newer token after this read, it sees the bumped version
  // and nudges itself.
  const [fresh, events] = await Promise.all([getPlan(plan.id), getEvents(plan.id)]);
  if (wrote && nudgeWorkflow) await nudge(fresh.taskToken);
  return { plan: fresh, events };
}
