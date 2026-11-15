// Request validation. Each validator returns a normalised copy of the input or
// throws a 400 HttpError whose message names the offending field.

import { LIMITS } from './config.mjs';
import { badRequest } from './http.mjs';
import { checkUrl, OutboundError } from './outbound.mjs';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const PHONE_RE = /^\+?[0-9 ().-]{3,40}$/;

export function optionalString(value, field, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw badRequest(`${field} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw badRequest(`${field} must be at most ${max} characters.`);
  return trimmed === '' ? null : trimmed;
}

function requiredString(value, field, max) {
  const result = optionalString(value, field, max);
  if (result === null) throw badRequest(`${field} is required.`);
  return result;
}

export function integerInRange(value, field, min, max, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value)) throw badRequest(`${field} must be an integer.`);
  if (value < min || value > max) throw badRequest(`${field} must be between ${min} and ${max}.`);
  return value;
}

function numberInRange(value, field, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw badRequest(`${field} must be a number.`);
  if (value < min || value > max) throw badRequest(`${field} must be between ${min} and ${max}.`);
  return value;
}

/** Notification URL: https only, no credentials, no private IP literals or local names. */
export function validateNotifyUrl(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw badRequest(`${field} must be a string.`);
  if (value.length > LIMITS.urlMax) throw badRequest(`${field} must be at most ${LIMITS.urlMax} characters.`);
  try {
    return checkUrl(value.trim()).toString();
  } catch (err) {
    if (err instanceof OutboundError) throw badRequest(`${field}: ${err.message}`);
    throw err;
  }
}

/** A link shown to contacts: http(s) only, so it can never be a javascript: URL. */
function validateLink(value, field) {
  const raw = optionalString(value, field, LIMITS.urlMax);
  if (raw === null) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw badRequest(`${field} must be a valid URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest(`${field} must be an http or https URL.`);
  return url.toString();
}

function validatePhone(value) {
  const phone = optionalString(value, 'phone', LIMITS.phoneMax);
  if (phone === null) return null;
  if (!PHONE_RE.test(phone) || !/\d/.test(phone)) throw badRequest('phone may contain only digits, spaces, "+", "(", ")", "-" and ".".');
  return phone;
}

export function validateTimeZone(value) {
  const tz = optionalString(value, 'timeZone', LIMITS.timeZoneMax);
  if (tz === null) return 'UTC';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
  } catch {
    throw badRequest('timeZone must be an IANA time zone such as "America/Los_Angeles".');
  }
}

/** {lat, lng, accuracy?} -> {lat, lng, accuracy} (accuracy null when not given). */
export function validateLocation(value, field = 'location') {
  if (!isPlainObject(value)) throw badRequest(`${field} must be an object with lat and lng.`);
  return {
    lat: numberInRange(value.lat, `${field}.lat`, -90, 90),
    lng: numberInRange(value.lng, `${field}.lng`, -180, 180),
    accuracy: value.accuracy === undefined || value.accuracy === null
      ? null
      : numberInRange(value.accuracy, `${field}.accuracy`, 0, 100_000),
  };
}

const optionalLocation = (value, field = 'location') => (value === undefined || value === null ? null : validateLocation(value, field));

/**
 * The deadline, from exactly one of:
 *   checkInBy         absolute ISO timestamp (5 s allowance for client clock skew), or
 *   checkInInSeconds  relative to the server clock, so a skewed client clock cannot
 *                     bounce a short plan or skip its reminder.
 */
function validateDeadline(body, now) {
  const hasAbsolute = body.checkInBy !== undefined && body.checkInBy !== null;
  const hasRelative = body.checkInInSeconds !== undefined && body.checkInInSeconds !== null;
  if (hasAbsolute && hasRelative) throw badRequest('Give either checkInBy or checkInInSeconds, not both.');
  if (!hasRelative) return validateCheckInBy(body.checkInBy, now);
  const seconds = integerInRange(body.checkInInSeconds, 'checkInInSeconds', LIMITS.checkInMinMs / 1000, LIMITS.checkInMaxMs / 1000);
  return new Date(now.getTime() + seconds * 1000).toISOString();
}

function validateCheckInBy(value, now) {
  if (typeof value !== 'string' || value.trim() === '') throw badRequest('checkInBy (an ISO 8601 timestamp) or checkInInSeconds is required.');
  const at = Date.parse(value);
  if (!Number.isFinite(at)) throw badRequest('checkInBy must be an ISO 8601 timestamp such as "2026-11-15T01:30:00Z".');
  const t = now.getTime();
  if (at < t + LIMITS.checkInMinMs - LIMITS.checkInSkewMs) throw badRequest('checkInBy must be at least 60 seconds from now.');
  if (at > t + LIMITS.checkInMaxMs) throw badRequest('checkInBy must be at most 7 days from now.');
  return new Date(at).toISOString();
}

function validateContacts(value) {
  if (!Array.isArray(value) || value.length < LIMITS.contactsMin || value.length > LIMITS.contactsMax) {
    throw badRequest(`contacts must be an array of ${LIMITS.contactsMin} to ${LIMITS.contactsMax} people.`);
  }
  return value.map((contact, i) => {
    if (!isPlainObject(contact)) throw badRequest(`contacts[${i}] must be an object.`);
    return {
      name: requiredString(contact.name, `contacts[${i}].name`, LIMITS.nameMax),
      relationship: optionalString(contact.relationship, `contacts[${i}].relationship`, LIMITS.relationshipMax),
      notifyUrl: validateNotifyUrl(contact.notifyUrl, `contacts[${i}].notifyUrl`),
    };
  });
}

export function validateCreatePlan(body, now = new Date()) {
  return {
    name: requiredString(body.name, 'name', LIMITS.nameMax),
    activity: requiredString(body.activity, 'activity', LIMITS.activityMax),
    details: optionalString(body.details, 'details', LIMITS.detailsMax),
    routeUrl: validateLink(body.routeUrl, 'routeUrl'),
    phone: validatePhone(body.phone),
    checkInBy: validateDeadline(body, now),
    remindMinutesBefore: integerInRange(body.remindMinutesBefore, 'remindMinutesBefore', 0, LIMITS.remindMax, LIMITS.remindDefault),
    graceMinutes: integerInRange(body.graceMinutes, 'graceMinutes', 0, LIMITS.graceMax, LIMITS.graceDefault),
    ackMinutes: integerInRange(body.ackMinutes, 'ackMinutes', LIMITS.ackMin, LIMITS.ackMax, LIMITS.ackDefault),
    ownerNotifyUrl: validateNotifyUrl(body.ownerNotifyUrl, 'ownerNotifyUrl'),
    contacts: validateContacts(body.contacts),
    location: optionalLocation(body.location),
    timeZone: validateTimeZone(body.timeZone),
  };
}

const ACTIONS = new Set(['safe', 'extend', 'sos']);

function parseMinutes(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw === 'number') return raw;
  if (!/^\d{1,4}$/.test(String(raw))) throw badRequest('minutes must be an integer.');
  return Number.parseInt(raw, 10);
}

/** Body {action, minutes, note, location} or, for one-tap push buttons, query a= and m=. */
export function validateCheckin(body, query = {}) {
  const action = body.action ?? query.a;
  if (typeof action !== 'string' || !ACTIONS.has(action)) throw badRequest('action must be one of: safe, extend, sos.');
  return {
    action,
    minutes: action === 'extend'
      ? integerInRange(parseMinutes(body.minutes ?? query.m), 'minutes', LIMITS.extendMin, LIMITS.extendMax, LIMITS.extendDefault)
      : null,
    note: optionalString(body.note, 'note', LIMITS.noteMax),
    location: optionalLocation(body.location),
  };
}

export const validateAck = (body) => ({ note: optionalString(body.note, 'note', LIMITS.noteMax) });

/** Contact index from ?c=. Anything but a small non-negative integer is "no such contact". */
export function parseContactIndex(raw) {
  if (typeof raw !== 'string' || !/^\d{1,2}$/.test(raw)) return null;
  return Number.parseInt(raw, 10);
}
