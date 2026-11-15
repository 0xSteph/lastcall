import './helpers.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parseContactIndex, validateAck, validateCheckin, validateCreatePlan, validateLocation, validateNotifyUrl, validateTimeZone,
} from '../src/lib/validate.mjs';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const inHours = (h) => new Date(NOW.getTime() + h * 3_600_000).toISOString();
const valid = (overrides = {}) => ({
  name: 'Sam',
  activity: 'Solo hike: Dipsea Trail loop',
  checkInBy: inHours(3),
  contacts: [{ name: 'Alex', relationship: 'sister' }],
  ...overrides,
});
const rejects = (body, pattern) => assert.throws(
  () => validateCreatePlan(body, NOW),
  (err) => err.status === 400 && err.code === 'validation_error' && pattern.test(err.message),
);

describe('validateCreatePlan', () => {
  it('normalises a minimal plan and applies defaults', () => {
    assert.deepEqual(validateCreatePlan(valid(), NOW), {
      name: 'Sam',
      activity: 'Solo hike: Dipsea Trail loop',
      details: null,
      routeUrl: null,
      phone: null,
      checkInBy: inHours(3),
      remindMinutesBefore: 15,
      graceMinutes: 15,
      ackMinutes: 10,
      ownerNotifyUrl: null,
      contacts: [{ name: 'Alex', relationship: 'sister', notifyUrl: null }],
      location: null,
      timeZone: 'UTC',
    });
  });

  it('accepts the full documented body', () => {
    const plan = validateCreatePlan(valid({
      details: '**Blue hatchback** at the trailhead',
      routeUrl: 'https://example.com/route',
      phone: '+1 555 0100',
      remindMinutesBefore: 0,
      graceMinutes: 0,
      ackMinutes: 1,
      ownerNotifyUrl: 'https://ntfy.sh/my-topic',
      contacts: [{ name: 'Alex', notifyUrl: 'https://hooks.slack.com/services/T/B/x' }, { name: 'Jordan', relationship: '' }],
      location: { lat: 37.9, lng: -122.6, accuracy: 30 },
      timeZone: 'America/Los_Angeles',
      checkInBy: '2026-11-14T13:00:00+01:00',
    }), NOW);
    assert.equal(plan.checkInBy, '2026-11-14T12:00:00.000Z');
    assert.equal(plan.remindMinutesBefore, 0);
    assert.equal(plan.graceMinutes, 0);
    assert.equal(plan.contacts[1].relationship, null);
    assert.equal(plan.timeZone, 'America/Los_Angeles');
    assert.deepEqual(plan.location, { lat: 37.9, lng: -122.6, accuracy: 30 });
  });

  it('requires name, activity, checkInBy and contacts', () => {
    rejects(valid({ name: '  ' }), /name is required/);
    rejects(valid({ activity: undefined }), /activity is required/);
    rejects(valid({ checkInBy: undefined }), /checkInBy \(an ISO 8601 timestamp\) or checkInInSeconds is required/);
    rejects(valid({ contacts: [] }), /contacts must be an array of 1 to 5/);
    rejects(valid({ contacts: Array.from({ length: 6 }, () => ({ name: 'x' })) }), /1 to 5/);
    rejects(valid({ contacts: [{ relationship: 'sister' }] }), /contacts\[0\]\.name is required/);
  });

  it('enforces lengths', () => {
    rejects(valid({ name: 'x'.repeat(41) }), /name must be at most 40/);
    rejects(valid({ activity: 'x'.repeat(121) }), /activity must be at most 120/);
    rejects(valid({ details: 'x'.repeat(4001) }), /details must be at most 4000/);
    rejects(valid({ contacts: [{ name: 'A', relationship: 'x'.repeat(41) }] }), /relationship must be at most 40/);
  });

  it('keeps checkInBy between 60 s (with a little clock-skew allowance) and 7 days out', () => {
    rejects(valid({ checkInBy: 'tomorrow' }), /ISO 8601/);
    rejects(valid({ checkInBy: new Date(NOW.getTime() + 30_000).toISOString() }), /at least 60 seconds/);
    assert.ok(validateCreatePlan(valid({ checkInBy: new Date(NOW.getTime() + 57_000).toISOString() }), NOW));
    assert.ok(validateCreatePlan(valid({ checkInBy: inHours(7 * 24) }), NOW));
    rejects(valid({ checkInBy: inHours(7 * 24 + 0.01) }), /at most 7 days/);
  });

  it('accepts checkInInSeconds instead, measured from the server clock', () => {
    const plan = validateCreatePlan(valid({ checkInBy: undefined, checkInInSeconds: 75 }), NOW);
    assert.equal(plan.checkInBy, '2026-11-14T10:01:15.000Z');
    assert.equal(validateCreatePlan(valid({ checkInBy: null, checkInInSeconds: 60 }), NOW).checkInBy, '2026-11-14T10:01:00.000Z');
    assert.equal(validateCreatePlan(valid({ checkInBy: undefined, checkInInSeconds: 604_800 }), NOW).checkInBy, inHours(7 * 24));
  });

  it('requires exactly one of checkInBy and checkInInSeconds', () => {
    rejects(valid({ checkInInSeconds: 120 }), /either checkInBy or checkInInSeconds, not both/);
    rejects(valid({ checkInBy: undefined }), /or checkInInSeconds is required/);
  });

  it('keeps checkInInSeconds an integer between 60 and 604800', () => {
    rejects(valid({ checkInBy: undefined, checkInInSeconds: 59 }), /checkInInSeconds must be between 60 and 604800/);
    rejects(valid({ checkInBy: undefined, checkInInSeconds: 604_801 }), /checkInInSeconds must be between 60 and 604800/);
    rejects(valid({ checkInBy: undefined, checkInInSeconds: 90.5 }), /checkInInSeconds must be an integer/);
    rejects(valid({ checkInBy: undefined, checkInInSeconds: '90' }), /checkInInSeconds must be an integer/);
  });

  it('checks the minute ranges', () => {
    rejects(valid({ remindMinutesBefore: 121 }), /remindMinutesBefore must be between 0 and 120/);
    rejects(valid({ graceMinutes: -1 }), /graceMinutes must be between 0 and 120/);
    rejects(valid({ ackMinutes: 0 }), /ackMinutes must be between 1 and 120/);
    rejects(valid({ ackMinutes: 2.5 }), /ackMinutes must be an integer/);
    rejects(valid({ graceMinutes: '15' }), /graceMinutes must be an integer/);
  });

  it('only accepts safe notification URLs and http(s) route links', () => {
    rejects(valid({ ownerNotifyUrl: 'http://ntfy.sh/x' }), /ownerNotifyUrl: .*https/);
    rejects(valid({ contacts: [{ name: 'A', notifyUrl: 'https://169.254.169.254/latest' }] }), /contacts\[0\]\.notifyUrl: .*private/);
    rejects(valid({ routeUrl: 'javascript:alert(1)' }), /routeUrl must be an http or https URL/);
    rejects(valid({ routeUrl: 'not a url' }), /routeUrl must be a valid URL/);
  });

  it('validates phone numbers and time zones', () => {
    rejects(valid({ phone: 'call me maybe' }), /phone may contain only/);
    rejects(valid({ phone: '+-()' }), /phone may contain only/);
    rejects(valid({ timeZone: 'Mars/Olympus_Mons' }), /IANA time zone/);
    assert.equal(validateTimeZone('europe/paris'), 'Europe/Paris');
    assert.equal(validateTimeZone(undefined), 'UTC');
  });
});

describe('validateLocation', () => {
  it('checks ranges and makes accuracy optional', () => {
    assert.deepEqual(validateLocation({ lat: -90, lng: 180 }), { lat: -90, lng: 180, accuracy: null });
    assert.throws(() => validateLocation({ lat: 91, lng: 0 }), /location\.lat must be between -90 and 90/);
    assert.throws(() => validateLocation({ lat: 0, lng: -181 }), /lng must be between -180 and 180/);
    assert.throws(() => validateLocation({ lat: 0, lng: 0, accuracy: 100_001 }), /accuracy must be between 0 and 100000/);
    assert.throws(() => validateLocation({ lat: '1', lng: 0 }), /lat must be a number/);
    assert.throws(() => validateLocation(null), /must be an object/);
  });
});

describe('validateCheckin', () => {
  it('reads the body, or the one-tap query (a=, m=)', () => {
    assert.deepEqual(validateCheckin({ action: 'safe', note: ' Home ' }), { action: 'safe', minutes: null, note: 'Home', location: null });
    assert.deepEqual(validateCheckin({}, { a: 'extend', m: '30' }), { action: 'extend', minutes: 30, note: null, location: null });
    assert.equal(validateCheckin({ action: 'extend' }).minutes, 30, 'defaults to 30 minutes');
    assert.equal(validateCheckin({ action: 'extend', minutes: 240 }).minutes, 240);
  });

  it('rejects bad actions, minutes and notes', () => {
    assert.throws(() => validateCheckin({}), /action must be one of: safe, extend, sos/);
    assert.throws(() => validateCheckin({ action: 'nap' }), /action must be one of/);
    assert.throws(() => validateCheckin({ action: 'extend', minutes: 4 }), /minutes must be between 5 and 240/);
    assert.throws(() => validateCheckin({}, { a: 'extend', m: 'lots' }), /minutes must be an integer/);
    assert.throws(() => validateCheckin({ action: 'sos', note: 'x'.repeat(281) }), /note must be at most 280/);
  });

  it('validateAck allows an empty body and limits the note', () => {
    assert.deepEqual(validateAck({}), { note: null });
    assert.throws(() => validateAck({ note: 'x'.repeat(281) }), /note must be at most 280/);
  });
});

describe('small parsers', () => {
  it('parseContactIndex accepts small integers only', () => {
    assert.equal(parseContactIndex('0'), 0);
    assert.equal(parseContactIndex('4'), 4);
    for (const bad of [undefined, '', '-1', '1.5', 'x', '123']) assert.equal(parseContactIndex(bad), null);
  });

  it('validateNotifyUrl treats empty as absent', () => {
    assert.equal(validateNotifyUrl('', 'notifyUrl'), null);
    assert.equal(validateNotifyUrl(' https://ntfy.sh/x ', 'notifyUrl'), 'https://ntfy.sh/x');
  });
});
