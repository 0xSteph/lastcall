/*
 * Last Call mock API server
 * =========================
 *
 * A zero-dependency, in-memory implementation of the Last Call API
 * (docs/LASTCALL_SPEC.md) plus a static file server for web/. Use it to
 * develop, test and record the web app without AWS.
 *
 * Run (Node 22+):
 *
 *     node mock/server.mjs                 # http://localhost:8787
 *     PORT=9000 node mock/server.mjs       # another port
 *     HOST=0.0.0.0 node mock/server.mjs    # reachable from a phone on your LAN
 *
 * Then open:
 *
 *     http://localhost:8787/web/               landing page
 *     http://localhost:8787/web/new.html       create a plan
 *     http://localhost:8787/web/demo.html      the three-phone demo (?auto=1 for the scripted run)
 *     plan.html#id=..&s=.. and alert.html#id=..&c=..&s=..   (links come from POST /v1/plans)
 *
 * When web/ is served by this mock, /web/config.js is generated on the fly so
 * apiBase points at whatever host you used (localhost or your LAN IP); the
 * committed web/config.js is not used in that case.
 *
 * What it implements (same contract as the real API):
 *   POST /v1/plans                               create a plan (validates like the real API);
 *                                                checkInBy (ISO) or checkInInSeconds (60..604800)
 *   GET  /v1/plans/{id}?s=<ownerSecret>          owner view
 *   GET  /v1/plans/{id}/alert?c=<i>&s=<secret>   contact view
 *   POST /v1/plans/{id}/checkin?s=..             {action: safe|extend|sos, minutes?, note?, location?}
 *                                                or one-tap ?a=safe|extend|sos&m=<minutes>
 *   POST /v1/plans/{id}/location?s=..            {lat, lng, accuracy}
 *   POST /v1/plans/{id}/ack?c=..&s=..            {note?} or one-tap ?a=ack
 *
 *   The state machine runs on real timers, one per plan, exactly like the
 *   Step Functions loop: an advance() step applies every transition that is
 *   due (reminder, overdue, grace -> alerting, next contact, unanswered,
 *   48 h close), performs the side effects once, records events and arms the
 *   timer for the next milestone. API calls change state and then "nudge"
 *   advance(); they never notify anyone themselves. Matches the real API:
 *   the next contact is due ackMinutes after the previous one's actual alert;
 *   SOS alerts every contact once per press (an acknowledged plan stays
 *   acknowledged), and sos becomes unanswered after ackMinutes with no answer.
 *
 *   Notifications are NOT sent. The mock logs what it would send (ntfy headers
 *   Title / Priority / Tags / Click / Actions, or the Slack / Discord / generic
 *   JSON body) and records the events with ok: true.
 *
 * Mock-only helper (not part of the real API):
 *   POST /_mock/plans/{id}/fast-forward?seconds=N   shift that plan's clock N
 *        seconds into the future and run advance() (the plan's "now" moves too).
 *
 * Environment: PORT (8787), HOST (127.0.0.1), WEB_BASE_URL (override the base
 * used in ownerUrl / alertUrl; default http://<request host>/web),
 * PLANS_PER_DAY (per-IP daily cap, default 20), QUIET=1 (no logs).
 *
 * Tests: node --test mock/
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(here, "..", "web");

const MAX_JSON = 64 * 1024;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const CLOSE_AFTER = 48 * HOUR;
const MAX_LOCATIONS = 20;
const TERMINAL = new Set(["safe", "closed"]);

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json", ".woff2": "font/woff2",
};

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
const ALNUM = "abcdefghijklmnopqrstuvwxyz0123456789";
const randomFrom = (alphabet, n) => {
  // rejection sampling keeps the distribution uniform for any alphabet size
  let out = "";
  const limit = 256 - (256 % alphabet.length);
  while (out.length < n) {
    for (const b of crypto.randomBytes(n * 2)) {
      if (b < limit) out += alphabet[b % alphabet.length];
      if (out.length === n) break;
    }
  }
  return out;
};
const planId = () => "pln_" + randomFrom(CROCKFORD, 16);
const newSecret = () => crypto.randomBytes(24).toString("base64url");
const ntfyTopicUrl = () => `https://ntfy.sh/lastcall-${randomFrom(ALNUM, 24)}`;
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
function secretMatches(secret, hash) {
  if (typeof secret !== "string" || !secret) return false;
  const x = Buffer.from(sha256(secret), "hex"), y = Buffer.from(String(hash), "hex");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status; this.code = code;
  }
}
const bad = (message) => new ApiError(400, "validation_error", message);

export function createMockServer(options = {}) {
  const quiet = options.quiet ?? process.env.QUIET === "1";
  const log = quiet ? () => {} : (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
  const webBaseOverride = options.webBaseUrl || process.env.WEB_BASE_URL || "";
  const plansPerDay = options.plansPerDay ?? Number(process.env.PLANS_PER_DAY || 20);
  const slackMs = options.slackMs ?? 250; // the real workflow waits +1 s; the mock reacts a bit faster

  const plans = new Map(); // id -> internal plan
  const ipCounts = new Map(); // "<ip>#<yyyymmdd>" -> count

  const planNow = (p) => Date.now() + p.offsetMs;
  const remindAt = (p) => (p.remindMinutesBefore > 0 ? p.checkInBy - p.remindMinutesBefore * MIN : null);
  const graceUntil = (p) => p.checkInBy + p.graceMinutes * MIN;

  // ---------- helpers ----------
  function originOf(req) {
    const host = req.headers.host || `localhost:${options.port || 8787}`;
    return `http://${host}`;
  }

  function addEvent(p, type, detail = {}) {
    p.events.push({ type, at: iso(planNow(p)), detail });
  }

  function fmtTime(p, ms) {
    const s = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: p.timeZone }).format(new Date(ms));
    return p.timeZoneGiven ? s : `${s} UTC`;
  }

  function channelFor(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      if (host === "hooks.slack.com") return "slack";
      if (["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"].includes(host) && u.pathname.startsWith("/api/webhooks/")) return "discord";
      if (host === "ntfy.sh") return "ntfy";
      return "webhook";
    } catch { return "webhook"; }
  }

  // Build (and log) the request the real API would send. Returns the channel name.
  function wouldSend(url, msg, who) {
    const channel = channelFor(url);
    let req;
    if (channel === "ntfy") {
      const headers = { Title: msg.title, Priority: msg.priority, Tags: msg.tags, Click: msg.click };
      if (msg.actions && msg.actions.length) headers.Actions = msg.actions.join("; ");
      req = { method: "POST", url, headers, body: msg.body };
    } else if (channel === "slack") {
      req = { method: "POST", url, body: { text: `${msg.title}\n${msg.body}\n<${msg.click}|Open>` } };
    } else if (channel === "discord") {
      req = { method: "POST", url, body: { embeds: [{ title: msg.title, description: msg.body, url: msg.click }] } };
    } else {
      req = { method: "POST", url, body: { event: msg.event, title: msg.title, body: msg.body, url: msg.click } };
    }
    log(`[notify:${channel}] -> ${who}: would send ${JSON.stringify(req)}`);
    return channel;
  }

  const checkinAction = (p, a, m) => `${p.apiBase}/v1/plans/${p.id}/checkin?s=${p.ownerSecret}&a=${a}${m ? `&m=${m}` : ""}`;
  const ownerActions = (p) => [
    `http, I'm safe, ${checkinAction(p, "safe")}, method=POST, clear=true`,
    `http, +30 min, ${checkinAction(p, "extend", 30)}, method=POST, clear=true`,
  ];

  function notifyOwner(p, kind) {
    const msg = kind === "reminder"
      ? { event: "plan.reminder", title: `Check in by ${fmtTime(p, p.checkInBy)}`, body: `Tap I'm safe when you're back from: ${p.activity}`, priority: "default", tags: "alarm_clock" }
      : { event: "plan.overdue", title: "You missed your check-in", body: `Your contacts will be alerted at ${fmtTime(p, graceUntil(p))} unless you check in. (${p.activity})`, priority: "high", tags: "warning" };
    msg.click = p.ownerUrl;
    msg.actions = ownerActions(p);
    return wouldSend(p.ownerNotifyUrl, msg, `owner ${p.name}`);
  }

  function notifyContact(p, i, kind) {
    const c = p.contacts[i];
    const t = planNow(p);
    let msg;
    if (kind === "all_clear") {
      msg = { event: "plan.safe", title: `${p.name} checked in safe`, body: `${p.name} is back from: ${p.activity}. No action needed.`, priority: "default", tags: "white_check_mark", click: c.alertUrl };
    } else {
      const lines = [p.activity];
      const late = Math.max(0, Math.round((t - p.checkInBy) / MIN));
      if (kind === "sos") lines.push(`${p.name} pressed "I need help".`);
      else lines.push(`Check-in was due ${fmtTime(p, p.checkInBy)} (${late} min ago).`);
      const loc = p.locations[0];
      if (loc) lines.push(`Last known location: https://www.openstreetmap.org/?mlat=${loc.lat}&mlon=${loc.lng}#map=15/${loc.lat}/${loc.lng}`);
      msg = {
        event: kind === "sos" ? "plan.sos" : "plan.alert",
        title: kind === "sos" ? `${p.name} needs help now` : `${p.name} hasn't checked in`,
        body: lines.join("\n"), priority: "urgent", tags: kind === "sos" ? "warning,sos" : "warning", click: c.alertUrl,
        actions: [`view, Open alert, ${c.alertUrl}`, `http, I'm on it, ${p.apiBase}/v1/plans/${p.id}/ack?c=${i}&s=${c.secret}&a=ack, method=POST, clear=true`],
      };
    }
    return wouldSend(c.notifyUrl, msg, `contact #${i} ${c.name}`);
  }

  function alertContact(p, i, at, sos) {
    const c = p.contacts[i];
    if (c.state === "standby") { c.state = "alerted"; c.alertedAt = at; }
    const channel = notifyContact(p, i, sos ? "sos" : "alert");
    addEvent(p, "alerted", { index: i, name: c.name, channel, ok: true, ...(sos ? { sos: true } : {}) });
  }

  // ---------- the workflow (Advance + wait) ----------
  // One transition per call; returns true when something changed.
  function step(p, t) {
    if (p.status === "closed") return false;
    if (p.status === "safe") {
      let changed = false;
      p.contacts.forEach((c, i) => {
        if (c.state !== "standby" && !c.allClearSent) {
          c.allClearSent = true; // conditional "mark done first", then send
          const channel = notifyContact(p, i, "all_clear");
          addEvent(p, "all_clear_sent", { index: i, name: c.name, channel, ok: true });
          changed = true;
        }
      });
      return changed;
    }
    const sosIdx = p.contacts.findIndex((c) => c.sosPending);
    if (sosIdx >= 0) {
      p.contacts[sosIdx].sosPending = false;
      alertContact(p, sosIdx, t, true);
      return true;
    }
    switch (p.status) {
      case "active": {
        const r = remindAt(p);
        if (r != null && !p.reminderDone && t >= r) {
          p.reminderDone = true;
          if (t < p.checkInBy) {
            const channel = notifyOwner(p, "reminder");
            addEvent(p, "reminder_sent", { ok: true });
          }
          return true;
        }
        if (t >= p.checkInBy) {
          p.status = "overdue";
          addEvent(p, "overdue", { checkInBy: iso(p.checkInBy) });
          const channel = notifyOwner(p, "overdue");
          addEvent(p, "owner_pinged", { channel, ok: true });
          return true;
        }
        return false;
      }
      case "overdue":
        if (t >= graceUntil(p)) {
          p.status = "alerting";
          alertContact(p, 0, t, false);
          return true;
        }
        return false;
      case "alerting": {
        let cur = -1;
        p.contacts.forEach((c, i) => { if (c.state !== "standby") cur = i; });
        if (cur < 0) { alertContact(p, 0, t, false); return true; }
        const due = p.contacts[cur].alertedAt + p.ackMinutes * MIN;
        if (t < due) return false;
        // the next contact is due ackMinutes after the previous one was actually alerted
        if (cur + 1 < p.contacts.length) alertContact(p, cur + 1, t, false);
        else { p.status = "unanswered"; p.settledAt = t; addEvent(p, "unanswered"); }
        return true;
      }
      case "sos":
        if (t >= p.sosAt + p.ackMinutes * MIN) { p.status = "unanswered"; p.settledAt = t; addEvent(p, "unanswered"); return true; }
        return false;
      case "acknowledged":
      case "unanswered":
        if (t >= p.settledAt + CLOSE_AFTER) {
          p.status = "closed";
          p.closedAt = t;
          addEvent(p, "closed", {});
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  function nextMilestone(p) {
    switch (p.status) {
      case "active": {
        const r = remindAt(p);
        return r != null && !p.reminderDone ? Math.min(r, p.checkInBy) : p.checkInBy;
      }
      case "overdue": return graceUntil(p);
      case "alerting": {
        let cur = -1;
        p.contacts.forEach((c, i) => { if (c.state !== "standby") cur = i; });
        return cur < 0 ? planNow(p) : p.contacts[cur].alertedAt + p.ackMinutes * MIN;
      }
      case "sos": return p.sosAt + p.ackMinutes * MIN;
      case "acknowledged":
      case "unanswered": return p.settledAt + CLOSE_AFTER;
      default: return null;
    }
  }

  function advance(p) {
    const t = planNow(p);
    for (let guard = 0; guard < 100 && step(p, t); guard++) p.version++;
    if (p.timer) { clearTimeout(p.timer); p.timer = null; }
    const next = nextMilestone(p);
    if (next == null || plans.get(p.id) !== p) return;
    const wait = Math.max(0, next - planNow(p)) + slackMs;
    p.timer = setTimeout(() => { p.timer = null; advance(p); }, Math.min(wait, 2 ** 31 - 1));
    p.timer.unref?.();
  }

  // ---------- views ----------
  function contactPublic(c) {
    return {
      name: c.name, relationship: c.relationship, state: c.state,
      alertedAt: iso(c.alertedAt), acknowledgedAt: iso(c.acknowledgedAt), note: c.note, allClearSent: c.allClearSent,
    };
  }
  function locPublic(l) { return l ? { lat: l.lat, lng: l.lng, accuracy: l.accuracy, at: iso(l.at) } : null; }

  function ownerView(p) {
    return {
      id: p.id, name: p.name, activity: p.activity, details: p.details, routeUrl: p.routeUrl, phone: p.phone,
      status: p.status, createdAt: iso(p.createdAt), checkInBy: iso(p.checkInBy), graceUntil: iso(graceUntil(p)),
      remindAt: iso(remindAt(p)), remindMinutesBefore: p.remindMinutesBefore, graceMinutes: p.graceMinutes, ackMinutes: p.ackMinutes,
      timeZone: p.timeZone, safeAt: iso(p.safeAt), closedAt: iso(p.closedAt),
      lastLocation: locPublic(p.locations[0]),
      locations: p.locations.map(locPublic),
      contacts: p.contacts.map(contactPublic),
      events: p.events.map((e) => ({ type: e.type, at: e.at, detail: { ...e.detail } })),
      now: iso(planNow(p)),
    };
  }
  function contactView(p, i) {
    const v = ownerView(p);
    delete v.locations;
    // contacts get lastLocation, but not the location history inside events
    v.events = v.events.map((e) => (e.type === "location" ? { ...e, detail: {} } : e));
    v.you = { index: i, name: p.contacts[i].name, state: p.contacts[i].state };
    return v;
  }

  // ---------- validation ----------
  function str(v, field, { required = false, min = 0, max = 1000 } = {}) {
    if (v == null || (typeof v === "string" && v.trim() === "")) {
      if (required || min > 0) throw bad(`${field} is required.`);
      return null;
    }
    if (typeof v !== "string") throw bad(`${field} must be a string.`);
    const s = v.trim();
    if (s.length < min) throw bad(`${field} must be at least ${min} characters.`);
    if (s.length > max) throw bad(`${field} must be at most ${max} characters.`);
    return s;
  }

  function int(v, field, lo, hi, dflt) {
    if (v == null || v === "") {
      if (dflt === undefined) throw bad(`${field} is required.`);
      return dflt;
    }
    const n = typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : v;
    if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${field} must be a whole number from ${lo} to ${hi}.`);
    return n;
  }

  function url(v, field, { httpsOnly = true } = {}) {
    const s = str(v, field, { max: 2048 });
    if (s == null) return null;
    let u;
    try { u = new URL(s); } catch { throw bad(`${field} must be a valid URL.`); }
    if (httpsOnly ? u.protocol !== "https:" : !/^https?:$/.test(u.protocol)) throw bad(`${field} must use ${httpsOnly ? "https" : "http or https"}.`);
    if (httpsOnly) {
      // stand-in for the SSRF guard in src/lib/outbound.mjs
      const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || /^(\d+\.){3}\d+$/.test(h) || h.includes(":")) {
        throw bad(`${field} must be a public https URL.`);
      }
    }
    return u.toString();
  }

  function location(v, field = "location", { required = false } = {}) {
    if (v == null) {
      if (required) throw bad(`${field} is required.`);
      return null;
    }
    if (typeof v !== "object" || Array.isArray(v)) throw bad(`${field} must be an object with lat and lng.`);
    const { lat, lng, accuracy } = v;
    if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) throw bad(`${field}.lat must be a number from -90 to 90.`);
    if (typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180) throw bad(`${field}.lng must be a number from -180 to 180.`);
    if (accuracy != null && (typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 100000)) {
      throw bad(`${field}.accuracy must be a number of meters from 0 to 100000.`);
    }
    return { lat, lng, accuracy: accuracy == null ? null : accuracy };
  }

  function timeZone(v) {
    const s = str(v, "timeZone", { max: 64 });
    if (s == null) return "UTC";
    try { new Intl.DateTimeFormat("en-US", { timeZone: s }); } catch { throw bad("timeZone must be an IANA time zone such as America/Los_Angeles."); }
    return s;
  }

  const locDetail = (l) => ({ lat: l.lat, lng: l.lng, accuracy: l.accuracy });
  function addLocation(p, loc) {
    p.locations.unshift({ ...loc, at: planNow(p) });
    if (p.locations.length > MAX_LOCATIONS) p.locations.length = MAX_LOCATIONS;
  }

  // ---------- auth ----------
  function getPlan(id) {
    const p = plans.get(id);
    if (!p) throw new ApiError(404, "not_found", "This plan does not exist or has expired.");
    return p;
  }
  function ownerAuth(id, url) {
    const p = getPlan(id);
    if (!secretMatches(url.searchParams.get("s"), p.ownerSecretHash)) throw new ApiError(401, "invalid_secret", "This plan link is not valid.");
    return p;
  }
  function contactAuth(id, url) {
    const p = getPlan(id);
    const raw = url.searchParams.get("c");
    const i = raw != null && /^\d+$/.test(raw) ? Number(raw) : -1;
    const c = p.contacts[i];
    if (!c) throw new ApiError(404, "not_found", "This alert link is not valid.");
    if (!secretMatches(url.searchParams.get("s"), c.secretHash)) throw new ApiError(401, "invalid_secret", "This alert link is not valid.");
    return [p, i];
  }
  function terminalGuard(p) {
    if (p.status === "safe") throw new ApiError(409, "already_safe", `${p.name} already checked in safe.`);
    if (p.status === "closed") throw new ApiError(409, "closed", "This plan is closed.");
  }

  // ---------- route handlers ----------
  function createPlan(req, body) {
    const name = str(body.name, "name", { min: 1, max: 40 });
    const activity = str(body.activity, "activity", { min: 1, max: 120 });
    const details = str(body.details, "details", { max: 4000 });
    const routeUrl = url(body.routeUrl, "routeUrl", { httpsOnly: false });
    const phone = str(body.phone, "phone", { max: 40 });
    if (phone != null && !/^\+?[0-9 ()\-.]{3,40}$/.test(phone)) throw bad("phone may contain only digits, spaces, + ( ) - and .");
    const t = Date.now();
    // exactly one of checkInBy (absolute) or checkInInSeconds (relative to the server clock)
    const hasAbs = body.checkInBy != null, hasRel = body.checkInInSeconds != null;
    if (hasAbs === hasRel) throw bad("Give exactly one of checkInBy or checkInInSeconds.");
    let checkInBy;
    if (hasRel) {
      checkInBy = t + int(body.checkInInSeconds, "checkInInSeconds", 60, 7 * 86400) * 1000;
    } else {
      if (typeof body.checkInBy !== "string" || !Number.isFinite(Date.parse(body.checkInBy))) throw bad("checkInBy must be an ISO 8601 timestamp.");
      checkInBy = Date.parse(body.checkInBy);
      if (checkInBy < t + 55 * 1000) throw bad("checkInBy must be at least 60 seconds from now."); // 5 s of skew allowance
      if (checkInBy > t + 7 * DAY) throw bad("checkInBy must be at most 7 days from now.");
    }
    const remindMinutesBefore = int(body.remindMinutesBefore, "remindMinutesBefore", 0, 120, 15);
    const graceMinutes = int(body.graceMinutes, "graceMinutes", 0, 120, 15);
    const ackMinutes = int(body.ackMinutes, "ackMinutes", 1, 120, 10);
    const ownerNotifyUrl = url(body.ownerNotifyUrl, "ownerNotifyUrl");
    if (!Array.isArray(body.contacts) || body.contacts.length < 1 || body.contacts.length > 5) throw bad("contacts must be a list of 1 to 5 people.");
    const contacts = body.contacts.map((c, i) => {
      if (!c || typeof c !== "object" || Array.isArray(c)) throw bad(`contacts[${i}] must be an object.`);
      return {
        name: str(c.name, `contacts[${i}].name`, { min: 1, max: 40 }),
        relationship: str(c.relationship, `contacts[${i}].relationship`, { max: 40 }) || "",
        notifyUrl: url(c.notifyUrl, `contacts[${i}].notifyUrl`),
      };
    });
    const loc = location(body.location);
    const tz = timeZone(body.timeZone);

    const ip = req.socket.remoteAddress || "unknown";
    const dayKey = `${ip}#${new Date(t).toISOString().slice(0, 10).replace(/-/g, "")}`;
    const used = ipCounts.get(dayKey) || 0;
    if (used >= plansPerDay) throw new ApiError(429, "rate_limited", `You can create at most ${plansPerDay} plans per day from one network. Try again tomorrow.`);
    ipCounts.set(dayKey, used + 1);

    const origin = originOf(req);
    const webBase = (webBaseOverride || `${origin}/web`).replace(/\/$/, "");
    const id = planId();
    const ownerSecret = newSecret();
    const p = {
      id, name, activity, details, routeUrl, phone, timeZone: tz, timeZoneGiven: body.timeZone != null && body.timeZone !== "", sosAt: null,
      createdAt: t, checkInBy, remindMinutesBefore, graceMinutes, ackMinutes,
      status: "active", reminderDone: false, settledAt: null, safeAt: null, closedAt: null,
      locations: [], events: [], version: 1, offsetMs: 0, timer: null, apiBase: origin,
      ownerSecret, // kept only so the mock can log the one-tap action URLs it would send
      ownerSecretHash: sha256(ownerSecret),
      ownerNotifyUrl: ownerNotifyUrl || ntfyTopicUrl(), ownerSubscribeUrl: null,
      ownerUrl: `${webBase}/plan.html#id=${id}&s=${ownerSecret}`,
      contacts: [],
    };
    if (!ownerNotifyUrl) p.ownerSubscribeUrl = p.ownerNotifyUrl; // generated: the owner subscribes to it
    p.contacts = contacts.map((c, i) => {
      const secret = newSecret();
      const generated = !c.notifyUrl;
      const notifyUrl = c.notifyUrl || ntfyTopicUrl();
      return {
        ...c, notifyUrl, subscribeUrl: generated ? notifyUrl : null, secret, secretHash: sha256(secret),
        alertUrl: `${webBase}/alert.html#id=${id}&c=${i}&s=${secret}`,
        state: "standby", alertedAt: null, acknowledgedAt: null, note: null, allClearSent: false, sosPending: false,
      };
    });
    const r = remindAt(p);
    p.reminderDone = r == null || r <= t; // skip a reminder whose time already passed
    if (loc) addLocation(p, loc);
    plans.set(id, p);
    addEvent(p, "created", { contacts: p.contacts.length });
    log(`[plan] created ${id} "${name}: ${activity}" check in by ${iso(checkInBy)} -> ${p.ownerUrl}`);
    advance(p);

    const out = {
      id, ownerUrl: p.ownerUrl,
      contacts: p.contacts.map((c) => ({ name: c.name, alertUrl: c.alertUrl, ...(c.subscribeUrl ? { subscribeUrl: c.subscribeUrl } : {}) })),
      plan: ownerView(p),
    };
    if (p.ownerSubscribeUrl) out.ownerSubscribeUrl = p.ownerSubscribeUrl;
    return [201, out];
  }

  function checkin(url, body, id) {
    const p = ownerAuth(id, url);
    const action = body.action != null ? body.action : url.searchParams.get("a");
    if (!["safe", "extend", "sos"].includes(action)) throw bad("action must be safe, extend or sos.");
    const note = str(body.note, "note", { max: 280 });
    const loc = location(body.location);
    terminalGuard(p);
    const t = planNow(p);
    if (action === "extend") {
      if (p.status !== "active" && p.status !== "overdue") {
        throw new ApiError(409, "cannot_extend", "Your contacts have already been alerted. Use I'm safe instead of extending.");
      }
      const minutes = int(body.minutes != null ? body.minutes : url.searchParams.get("m"), "minutes", 5, 240, 30);
      const next = Math.max(p.checkInBy, t) + minutes * MIN;
      if (next > p.createdAt + 7 * DAY) throw bad("A plan can last at most 7 days from when it was created.");
      p.checkInBy = next;
      p.status = "active";
      const r = remindAt(p);
      p.reminderDone = r == null || r <= t; // re-arm the reminder
      if (loc) { addLocation(p, loc); addEvent(p, "location", locDetail(loc)); }
      addEvent(p, "extended", { minutes, checkInBy: iso(next) });
      log(`[checkin] ${id} extended ${minutes} min -> ${iso(next)}`);
    } else if (action === "safe") {
      if (loc) { addLocation(p, loc); addEvent(p, "location", locDetail(loc)); }
      p.status = "safe";
      p.safeAt = t;
      addEvent(p, "safe", { note });
      log(`[checkin] ${id} safe`);
    } else if (p.status !== "sos") {
      if (loc) { addLocation(p, loc); addEvent(p, "location", locDetail(loc)); }
      // every contact gets the "needs help now" alert once per press, even if already
      // alerted or acknowledged; an acknowledged plan stays acknowledged
      if (p.status !== "acknowledged") p.status = "sos";
      p.sosAt = t;
      p.contacts.forEach((c) => { c.sosPending = true; });
      addEvent(p, "sos", { note });
      log(`[checkin] ${id} SOS`);
    } else if (loc) {
      addLocation(p, loc); addEvent(p, "location", locDetail(loc));
    }
    p.version++;
    advance(p); // nudge the workflow
    return [200, ownerView(p)];
  }

  function postLocation(url, body, id) {
    const p = ownerAuth(id, url);
    const loc = location(body, "location", { required: true });
    terminalGuard(p);
    addLocation(p, loc);
    addEvent(p, "location", locDetail(loc));
    p.version++;
    advance(p);
    return [200, ownerView(p)];
  }

  function ack(url, body, id) {
    const [p, i] = contactAuth(id, url);
    const note = str(body.note, "note", { max: 280 });
    if (p.status === "safe") throw new ApiError(409, "safe", `${p.name} already checked in safe.`);
    if (p.status === "closed") throw new ApiError(409, "closed", "This plan is closed.");
    const c = p.contacts[i];
    if (c.state === "standby") throw new ApiError(409, "not_alerted", "You have not been alerted for this plan.");
    if (c.state === "acknowledged") throw new ApiError(409, "already_acknowledged", "You already said you're on it.");
    const t = planNow(p);
    c.state = "acknowledged";
    c.acknowledgedAt = t;
    c.note = note;
    if (["alerting", "sos", "unanswered"].includes(p.status)) { p.status = "acknowledged"; p.settledAt = t; }
    addEvent(p, "acknowledged", { index: i, name: c.name, note });
    log(`[ack] ${id} contact #${i} ${c.name} is on it`);
    p.version++;
    advance(p);
    return [200, contactView(p, i)];
  }

  function fastForward(url, id) {
    const p = getPlan(id);
    const seconds = int(url.searchParams.get("seconds"), "seconds", 1, 30 * 86400);
    p.offsetMs += seconds * 1000;
    log(`[mock] ${id} fast-forwarded ${seconds}s`);
    advance(p);
    return [200, ownerView(p)];
  }

  // ---------- HTTP plumbing ----------
  function setCors(res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Max-Age", "600");
  }

  function sendJson(res, status, obj) {
    if (res.writableEnded) return;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(obj));
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_JSON) { reject(new ApiError(413, "payload_too_large", "Request body too large.")); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (buf.length === 0) return resolve({});
        try {
          const v = JSON.parse(buf.toString("utf8"));
          if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
          resolve(v);
        } catch { reject(new ApiError(400, "invalid_json", "Request body must be a JSON object.")); }
      });
      req.on("error", reject);
    });
  }

  function serveStatic(req, res, pathname) {
    if (pathname === "/web") { res.writeHead(302, { Location: "/web/" }); return res.end(); }
    let rel;
    try { rel = decodeURIComponent(pathname.slice("/web/".length)); } catch { rel = "\u0000"; }
    if (rel === "" || rel.endsWith("/")) rel += "index.html";
    if (rel === "config.js") {
      res.writeHead(200, { "Content-Type": MIME[".js"], "Cache-Control": "no-store" });
      return res.end(`// generated by mock/server.mjs\nwindow.LASTCALL_CONFIG = { apiBase: ${JSON.stringify(originOf(req))} };\n`);
    }
    const file = path.resolve(WEB_DIR, rel);
    if (rel.includes("\u0000") || !file.startsWith(WEB_DIR + path.sep)) return sendJson(res, 404, { error: { code: "not_found", message: "Not found." } });
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return sendJson(res, 404, { error: { code: "not_found", message: "Not found." } });
      res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  async function handle(req, res) {
    setCors(res);
    const u = new URL(req.url, "http://mock.local");
    const p = u.pathname;
    const m = req.method;
    if (m === "OPTIONS") { res.writeHead(204); return res.end(); }

    if ((m === "GET" || m === "HEAD") && (p === "/" || p === "/index.html")) { res.writeHead(302, { Location: "/web/" }); return res.end(); }
    if ((m === "GET" || m === "HEAD") && (p === "/web" || p.startsWith("/web/"))) return serveStatic(req, res, p);
    if (p === "/favicon.ico") { res.writeHead(302, { Location: "/web/favicon.svg" }); return res.end(); }

    let r, mm;
    if (p === "/v1/plans" && m === "POST") r = createPlan(req, await readJson(req));
    else if ((mm = p.match(/^\/v1\/plans\/([^/]+)$/)) && m === "GET") r = [200, ownerView(ownerAuth(mm[1], u))];
    else if ((mm = p.match(/^\/v1\/plans\/([^/]+)\/alert$/)) && m === "GET") { const [pl, i] = contactAuth(mm[1], u); r = [200, contactView(pl, i)]; }
    else if ((mm = p.match(/^\/v1\/plans\/([^/]+)\/checkin$/)) && m === "POST") r = checkin(u, await readJson(req), mm[1]);
    else if ((mm = p.match(/^\/v1\/plans\/([^/]+)\/location$/)) && m === "POST") r = postLocation(u, await readJson(req), mm[1]);
    else if ((mm = p.match(/^\/v1\/plans\/([^/]+)\/ack$/)) && m === "POST") r = ack(u, await readJson(req), mm[1]);
    else if ((mm = p.match(/^\/_mock\/plans\/([^/]+)\/fast-forward$/)) && m === "POST") r = fastForward(u, mm[1]);
    else if (/^\/v1\/plans(\/[^/]+(\/(alert|checkin|location|ack))?)?$/.test(p)) throw new ApiError(405, "method_not_allowed", `${m} is not allowed on ${p}.`);
    else if (p.startsWith("/v1/")) throw new ApiError(404, "not_found", `No route for ${m} ${p}.`);
    else throw new ApiError(404, "not_found", "Not found.");
    sendJson(res, r[0], r[1]);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof ApiError) sendJson(res, err.status, { error: { code: err.code, message: err.message } });
      else {
        console.error(err);
        sendJson(res, 500, { error: { code: "internal", message: "Internal error in mock server." } });
      }
    });
  });
  server.on("close", () => { for (const pl of plans.values()) if (pl.timer) { clearTimeout(pl.timer); pl.timer = null; } plans.clear(); });
  server.state = { plans, ipCounts };
  return server;
}

// Run directly: node mock/server.mjs
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "127.0.0.1";
  const server = createMockServer({ port });
  server.listen(port, host, () => {
    const shown = host === "0.0.0.0" ? "localhost" : host;
    console.log(`Last Call mock API on http://${shown}:${port}`);
    console.log(`  landing   http://${shown}:${port}/web/`);
    console.log(`  new plan  http://${shown}:${port}/web/new.html`);
    console.log(`  demo      http://${shown}:${port}/web/demo.html   (?auto=1 for the scripted run)`);
  });
}
