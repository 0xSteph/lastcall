// Environment and product limits in one place, so the template and the code agree.
// Env vars are read lazily so tests can set them after import.

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const LIMITS = Object.freeze({
  nameMax: 40,
  activityMax: 120,
  detailsMax: 4_000,
  relationshipMax: 40,
  phoneMax: 40,
  noteMax: 280,
  urlMax: 2_048,
  timeZoneMax: 64,
  contactsMin: 1,
  contactsMax: 5,
  locationsKept: 20,
  checkInMinMs: 60_000,
  // Client clocks and network latency eat into the 60 s minimum; a plan created
  // "60 s from now" must not bounce because it arrived 2 s later.
  checkInSkewMs: 5_000,
  checkInMaxMs: 7 * DAY,
  remindDefault: 15,
  remindMax: 120,
  graceDefault: 15,
  graceMax: 120,
  ackDefault: 10,
  ackMin: 1,
  ackMax: 120,
  extendDefault: 30,
  extendMin: 5,
  extendMax: 240,
  closeAfterMs: 48 * HOUR,
});

export function env(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export const tableName = () => env('TABLE_NAME');
export const stateMachineArn = () => env('STATE_MACHINE_ARN');
export const webBaseUrl = () => env('WEB_BASE_URL').replace(/\/+$/, '');

export function dailyPlanCap() {
  const n = Number.parseInt(env('DAILY_PLAN_CAP', '20'), 10);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

export const epochSeconds = (ms) => Math.floor(ms / 1000);
const toMs = (value) => (value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : value);

/** Plan TTL while it is live: 14 days after creation (longer than any plan can run). */
export const planTtl = (createdAt) => epochSeconds(toMs(createdAt) + 14 * DAY);

/** Plan TTL once terminal: 7 days after the end, or 14 days after creation, whichever is later. */
export const terminalTtl = (createdAt, endedAt) => Math.max(planTtl(createdAt), epochSeconds(toMs(endedAt) + 7 * DAY));

/**
 * Event TTL. Events are written before the plan's final TTL is known, so they get a
 * bound that outlives it: a plan ends at most ~9.5 days after creation (7 d deadline,
 * 2 h grace, 5 x 2 h escalation, 48 h close), so 17 days covers terminal + 7 d.
 */
export const eventTtl = (createdAt, at) => Math.max(epochSeconds(toMs(createdAt) + 17 * DAY), epochSeconds(toMs(at) + 8 * DAY));

export const rateLimitTtl = (at) => epochSeconds(toMs(at) + 2 * DAY);
