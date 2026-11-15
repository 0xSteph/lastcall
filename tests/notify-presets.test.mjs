// What each notification says and how it is rendered per channel. The ntfy
// headers are asserted exactly, Actions included, because the one-tap buttons are
// the product: a malformed header means no buttons (or no push at all).

import './helpers.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { API, WEB } from './helpers.mjs';
import { CONTACT_SECRETS, MIN, OWNER_SECRET, PLAN_ID, SECRETS, T0, at, contactsWith, iso, planItem } from './fixtures.mjs';
import {
  DISCLAIMER, alertMessage, allClearMessage, formatDuration, formatTime, messageFor, overdueMessage, osmUrl, reminderMessage,
} from '../src/lib/messages.mjs';
import { buildNotification, channelOf, detectPreset, encodeHeaderValue, ntfyActions } from '../src/lib/notify-presets.mjs';

const NTFY = 'https://ntfy.sh/lastcall-abcdefghijklmnopqrstuvwx';
const ownerLink = `${WEB}/plan.html#id=${PLAN_ID}&s=${OWNER_SECRET}`;
const alertLink = (i) => `${WEB}/alert.html#id=${PLAN_ID}&c=${i}&s=${CONTACT_SECRETS[i]}`;
const checkin = (q) => `${API}/v1/plans/${PLAN_ID}/checkin?s=${OWNER_SECRET}&${q}`;
const ack = (i) => `${API}/v1/plans/${PLAN_ID}/ack?c=${i}&s=${CONTACT_SECRETS[i]}&a=ack`;
const OWNER_ACTIONS = `http, "I'm safe", ${checkin('a=safe')}, method=POST, clear=true; `
  + `http, +30 min, ${checkin('a=extend&m=30')}, method=POST, clear=true`;
const ctx = { secrets: SECRETS, now: at(T0 + 150 * MIN) };

describe('formatting', () => {
  it('formats times in the plan time zone, without odd spaces', () => {
    assert.equal(formatTime('2026-11-15T02:30:00Z', 'America/Los_Angeles'), '6:30 PM');
    assert.equal(formatTime('2026-11-15T02:30:00Z', 'Europe/Paris'), '3:30 AM');
    assert.equal(formatTime('2026-11-15T02:30:00Z', 'UTC'), '2:30 AM UTC');
  });

  it('formats durations', () => {
    assert.equal(formatDuration(20_000), 'less than a minute');
    assert.equal(formatDuration(15 * MIN), '15 min');
    assert.equal(formatDuration(60 * MIN), '1 h');
    assert.equal(formatDuration(65 * MIN), '1 h 5 min');
  });

  it('links locations to OpenStreetMap', () => {
    assert.equal(osmUrl({ lat: 37.9, lng: -122.6 }), 'https://www.openstreetmap.org/?mlat=37.9&mlon=-122.6#map=15/37.9/-122.6');
  });
});

describe('detectPreset', () => {
  it('picks the preset by host', () => {
    assert.equal(detectPreset('https://hooks.slack.com/services/T0/B0/xyz'), 'slack');
    assert.equal(detectPreset('https://discord.com/api/webhooks/1/abc'), 'discord');
    assert.equal(detectPreset('https://discordapp.com/api/webhooks/1/abc'), 'discord');
    assert.equal(detectPreset(NTFY), 'ntfy');
    assert.equal(detectPreset('https://discord.com/channels/1'), 'generic');
    assert.equal(detectPreset('https://example.com/hook'), 'generic');
    assert.equal(detectPreset('https://hooks.slack.com.evil.example/x'), 'generic');
  });

  it('names channels for events', () => {
    assert.deepEqual(['ntfy', 'slack', 'discord', 'generic'].map(channelOf), ['ntfy', 'slack', 'discord', 'webhook']);
  });
});

describe('ntfy payloads', () => {
  it('owner reminder: title with the local time, safe and +30 buttons, default priority', () => {
    const req = buildNotification(NTFY, reminderMessage(planItem(), ctx));
    assert.equal(req.preset, 'ntfy');
    assert.equal(req.method, 'POST');
    assert.deepEqual(req.headers, {
      'content-type': 'text/plain; charset=utf-8',
      Title: 'Check in by 4:00 AM',
      Priority: 'default',
      Click: ownerLink,
      Actions: OWNER_ACTIONS,
    });
    assert.equal(req.body, "Tap I'm safe when you're back from: Solo hike: Dipsea Trail loop");
  });

  it('owner overdue: high priority, says when contacts will be alerted', () => {
    const req = buildNotification(NTFY, overdueMessage(planItem({ status: 'overdue' }), ctx));
    assert.deepEqual(req.headers, {
      'content-type': 'text/plain; charset=utf-8',
      Title: 'You missed your check-in',
      Priority: 'high',
      Click: ownerLink,
      Actions: OWNER_ACTIONS,
    });
    assert.equal(req.body, "Your contacts will be alerted at 4:15 AM unless you check in. Tap I'm safe if you're OK. Activity: Solo hike: Dipsea Trail loop");
  });

  it('owner overdue with grace 0 says contacts are being alerted now', () => {
    const body = overdueMessage(planItem({ graceMinutes: 0 }), ctx).body;
    assert.match(body, /^Your contacts are being alerted now\./);
  });

  it('contact alert: urgent, warning tag, open + I\'m on it buttons, overdue time, map link, phone', () => {
    const plan = planItem({ status: 'alerting', contacts: contactsWith([{ state: 'alerted' }]) });
    const req = buildNotification(NTFY, alertMessage(plan, 0, { ...ctx, sos: false }));
    assert.deepEqual(req.headers, {
      'content-type': 'text/plain; charset=utf-8',
      Title: "Sam hasn't checked in",
      Priority: 'urgent',
      Click: alertLink(0),
      Tags: 'warning',
      Actions: `view, Open alert, ${alertLink(0)}; http, "I'm on it", ${ack(0)}, method=POST, clear=true`,
    });
    assert.equal(req.body, [
      'Sam was due back by 4:00 AM from: Solo hike: Dipsea Trail loop. Now 30 min overdue.',
      'Phone: +1 555 0100',
      `Last known location (2:00 AM): ${osmUrl({ lat: 37.9, lng: -122.6 })}`,
      DISCLAIMER,
    ].join('\n'));
  });

  it('contact alert without a location or phone says so', () => {
    const body = alertMessage(planItem({ locations: [], phone: null }), 1, { ...ctx, sos: false }).body;
    assert.ok(body.includes('No location has been shared.'));
    assert.ok(!body.includes('Phone:'));
  });

  it('SOS alert: "needs help now" with the owner note', () => {
    const plan = planItem({ status: 'sos', sosAt: iso(T0), sosNote: 'Twisted ankle near the creek' });
    const req = buildNotification(NTFY, messageFor(plan, { kind: 'alert', index: 1, sos: true }, ctx));
    assert.equal(req.headers.Title, 'Sam needs help now');
    assert.equal(req.headers.Priority, 'urgent');
    assert.equal(req.headers.Actions, `view, Open alert, ${alertLink(1)}; http, "I'm on it", ${ack(1)}, method=POST, clear=true`);
    assert.match(req.body, /^Sam pressed "I need help" during: Solo hike: Dipsea Trail loop\.\nNote: Twisted ankle near the creek\n/);
  });

  it('all clear: default priority, check mark, no buttons', () => {
    const plan = planItem({ status: 'safe', safeAt: iso(T0 + 150 * MIN), safeNote: 'Back at the car' });
    const req = buildNotification(NTFY, allClearMessage(plan, 1, ctx));
    assert.deepEqual(req.headers, {
      'content-type': 'text/plain; charset=utf-8',
      Title: 'Sam checked in safe',
      Priority: 'default',
      Click: alertLink(1),
      Tags: 'white_check_mark',
    });
    assert.equal(req.body, 'Sam checked in safe at 4:30 AM. No action needed.\nNote: Back at the car');
  });

  it('encodes non-ASCII titles (RFC 2047) and keeps headers on one line', () => {
    const req = buildNotification(NTFY, alertMessage(planItem({ name: 'Zoë 🥾' }), 0, { ...ctx, sos: false }));
    assert.equal(req.headers.Title, `=?UTF-8?B?${Buffer.from("Zoë 🥾 hasn't checked in").toString('base64')}?=`);
    assert.ok(req.body.startsWith('Zoë 🥾 was due back'));
    assert.equal(encodeHeaderValue('a\r\nInjected: yes'), 'a Injected: yes');
  });

  it('caps actions at ntfy\'s three and quotes labels with separators', () => {
    const actions = Array.from({ length: 4 }, (_, i) => ({ type: 'view', label: i === 0 ? 'a, b' : `L${i}`, url: `https://x.example/${i}` }));
    assert.equal(ntfyActions(actions), 'view, "a, b", https://x.example/0; view, L1, https://x.example/1; view, L2, https://x.example/2');
  });
});

describe('other channels', () => {
  const alert = () => alertMessage(planItem({ name: 'Sam <@here> & co' }), 0, { ...ctx, sos: false });

  it('Slack: header, escaped body, one link button to the page', () => {
    const req = buildNotification('https://hooks.slack.com/services/T/B/x', alert());
    assert.equal(req.preset, 'slack');
    const payload = JSON.parse(req.body);
    assert.equal(payload.text, "Sam <@here> & co hasn't checked in");
    assert.equal(payload.blocks[0].type, 'header');
    assert.ok(payload.blocks[1].text.text.startsWith('Sam &lt;@here&gt; &amp; co was due back'));
    assert.deepEqual(payload.blocks[2].elements.map((b) => [b.text.text, b.url, b.style]), [['Open Last Call', alertLink(0), 'danger']]);
  });

  it('Discord: embed linking to the page, mentions disabled', () => {
    const req = buildNotification('https://discord.com/api/webhooks/1/abc', alert());
    const payload = JSON.parse(req.body);
    assert.equal(req.preset, 'discord');
    assert.equal(payload.username, 'Last Call');
    assert.equal(payload.embeds[0].url, alertLink(0));
    assert.equal(payload.embeds[0].color, 0xdc2626);
    assert.deepEqual(payload.allowed_mentions, { parse: [] });
  });

  it('generic webhook: {event, planId, title, message, priority, url}', () => {
    const msg = reminderMessage(planItem(), ctx);
    const req = buildNotification('https://example.com/hook', msg);
    assert.deepEqual(JSON.parse(req.body), {
      event: 'lastcall.reminder', planId: PLAN_ID, title: msg.title, message: msg.body, priority: 'default', url: ownerLink,
    });
    assert.equal(req.headers['content-type'], 'application/json');
  });
});
