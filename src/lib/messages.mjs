// What each notification says. Pure: returns a channel-neutral message
//   {kind, planId, title, body, priority: default|high|urgent, tags, click, actions}
// that notify-presets.mjs renders for ntfy, Slack, Discord or a generic webhook.
// Times are formatted in the plan creator's time zone.

import { ackActionUrl, alertUrl, checkinActionUrl, ownerUrl } from './plans.mjs';

export const DISCLAIMER = 'Last Call is not an emergency service. If someone is in danger, call your local emergency number.';

/** "6:30 PM" in the plan's zone ("6:30 PM UTC" when no zone was given). */
export function formatTime(iso, timeZone = 'UTC') {
  const text = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' })
    .format(new Date(iso))
    .replace(/[  ]/g, ' '); // newer ICU puts a narrow no-break space before AM/PM
  return timeZone === 'UTC' ? `${text} UTC` : text;
}

/** 90 s -> "2 min", 65 min -> "1 h 5 min". */
export function formatDuration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export const osmUrl = ({ lat, lng }) => `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`;

function ownerActions(plan, secret) {
  return [
    { type: 'http', label: "I'm safe", url: checkinActionUrl(plan.apiBase, plan.id, secret, 'safe') },
    { type: 'http', label: '+30 min', url: checkinActionUrl(plan.apiBase, plan.id, secret, 'extend', 30) },
  ];
}

export function reminderMessage(plan, { secrets }) {
  return {
    kind: 'reminder',
    planId: plan.id,
    title: `Check in by ${formatTime(plan.checkInBy, plan.timeZone)}`,
    body: `Tap I'm safe when you're back from: ${plan.activity}`,
    priority: 'default',
    tags: [],
    click: ownerUrl(plan.id, secrets.owner),
    actions: ownerActions(plan, secrets.owner),
  };
}

export function overdueMessage(plan, { secrets }) {
  const when = plan.graceMinutes > 0
    ? `Your contacts will be alerted at ${formatTime(plan.graceUntil, plan.timeZone)} unless you check in.`
    : 'Your contacts are being alerted now.';
  return {
    kind: 'overdue',
    planId: plan.id,
    title: 'You missed your check-in',
    body: `${when} Tap I'm safe if you're OK. Activity: ${plan.activity}`,
    priority: 'high',
    tags: [],
    click: ownerUrl(plan.id, secrets.owner),
    actions: ownerActions(plan, secrets.owner),
  };
}

function locationLine(plan) {
  const last = plan.locations?.[0];
  if (!last) return 'No location has been shared.';
  return `Last known location (${formatTime(last.at, plan.timeZone)}): ${osmUrl(last)}`;
}

export function alertMessage(plan, index, { secrets, now, sos }) {
  const secret = secrets.contacts[index];
  const link = alertUrl(plan.id, index, secret);
  const lines = sos
    ? [`${plan.name} pressed "I need help" during: ${plan.activity}.`, plan.sosNote ? `Note: ${plan.sosNote}` : null]
    : [`${plan.name} was due back by ${formatTime(plan.checkInBy, plan.timeZone)} from: ${plan.activity}. `
      + `Now ${formatDuration(now.getTime() - Date.parse(plan.checkInBy))} overdue.`];
  lines.push(plan.phone ? `Phone: ${plan.phone}` : null, locationLine(plan), DISCLAIMER);
  return {
    kind: sos ? 'sos' : 'alert',
    planId: plan.id,
    title: sos ? `${plan.name} needs help now` : `${plan.name} hasn't checked in`,
    body: lines.filter(Boolean).join('\n'),
    priority: 'urgent',
    tags: ['warning'],
    click: link,
    actions: [
      { type: 'view', label: 'Open alert', url: link },
      { type: 'http', label: "I'm on it", url: ackActionUrl(plan.apiBase, plan.id, index, secret) },
    ],
  };
}

export function allClearMessage(plan, index, { secrets }) {
  const lines = [`${plan.name} checked in safe at ${formatTime(plan.safeAt, plan.timeZone)}. No action needed.`];
  if (plan.safeNote) lines.push(`Note: ${plan.safeNote}`);
  return {
    kind: 'all_clear',
    planId: plan.id,
    title: `${plan.name} checked in safe`,
    body: lines.join('\n'),
    priority: 'default',
    tags: ['white_check_mark'],
    click: alertUrl(plan.id, index, secrets.contacts[index]),
    actions: [],
  };
}

/** The message for one of Advance's effects ({kind, index?, sos?}). */
export function messageFor(plan, effect, ctx) {
  switch (effect.kind) {
    case 'reminder': return reminderMessage(plan, ctx);
    case 'overdue': return overdueMessage(plan, ctx);
    case 'alert': return alertMessage(plan, effect.index, { ...ctx, sos: effect.sos });
    case 'allClear': return allClearMessage(plan, effect.index, ctx);
    default: throw new Error(`Unknown effect ${effect.kind}`);
  }
}
