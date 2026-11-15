// AWS SDK mocks backed by a tiny in-memory table, plus plan fixtures.
//
// The fake table understands exactly the writes the code makes (version-checked
// commits, the rate-limit counter, conditional puts, the WaitForEvent token update)
// and enforces their conditions, so compare-and-swap and idempotency behave as they
// would against DynamoDB.

import { SFNClient } from '@aws-sdk/client-sfn';
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { sha256Hex } from '../src/lib/ids.mjs';
import { API } from './helpers.mjs';

export const ddbMock = mockClient(DynamoDBDocumentClient);
export const sfnMock = mockClient(SFNClient);

export const PLAN_ID = 'pln_0123456789abcdef';
export const OWNER_SECRET = 'b3duZXItc2VjcmV0LW93bmVyLXNlY3Jl';
export const CONTACT_SECRETS = ['Y29udGFjdDAtc2VjcmV0LWNvbnRhY3Qw', 'Y29udGFjdDEtc2VjcmV0LWNvbnRhY3Qx'];
export const SECRETS = { owner: OWNER_SECRET, contacts: CONTACT_SECRETS };
export const TOKEN = 'task-token-1';
export const T0 = Date.parse('2026-11-14T10:00:00.000Z');
export const MIN = 60_000;
export const at = (ms) => new Date(ms);
export const iso = (ms) => new Date(ms).toISOString();

const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const keyOf = ({ PK, SK }) => `${PK}|${SK}`;

export const table = new Map();
/** Called before each transaction is applied; tests use it to simulate a racing writer. */
export const hooks = { beforeTransact: null };

const cancelled = (codes) => Object.assign(new Error('Transaction cancelled'), {
  name: 'TransactionCanceledException',
  CancellationReasons: codes.map((Code) => ({ Code })),
});

// Returns null if the condition holds, otherwise a failure code.
function checkUpdate(item, u) {
  const v = u.ExpressionAttributeValues ?? {};
  const cond = u.ConditionExpression ?? '';
  if (cond === '#version = :expected') return item?.version === v[':expected'] ? null : 'ConditionalCheckFailed';
  if (cond.includes('planCount < :cap')) return !item?.planCount || item.planCount < v[':cap'] ? null : 'ConditionalCheckFailed';
  if (cond) throw new Error(`fake table: unsupported condition ${cond}`);
  return null;
}

function applyUpdate(item, u) {
  const next = { ...(item ?? clone(u.Key)) };
  const names = u.ExpressionAttributeNames ?? {};
  const values = u.ExpressionAttributeValues ?? {};
  if (u.UpdateExpression.startsWith('ADD planCount')) {
    next.planCount = (next.planCount ?? 0) + values[':one'];
    next.ttl ??= values[':ttl'];
    return next;
  }
  const sets = u.UpdateExpression.replace(/^SET /, '').split(', ');
  for (const set of sets) {
    const [lhs, rhs] = set.split(' = ');
    next[names[lhs] ?? lhs] = clone(values[rhs]);
  }
  return next;
}

function transact({ TransactItems }) {
  const codes = TransactItems.map((op) => {
    if (op.Update) return checkUpdate(table.get(keyOf(op.Update.Key)), op.Update) ?? 'None';
    if (op.Put?.ConditionExpression === 'attribute_not_exists(PK)') return table.has(keyOf(op.Put.Item)) ? 'ConditionalCheckFailed' : 'None';
    return 'None';
  });
  if (codes.some((c) => c !== 'None')) throw cancelled(codes);
  for (const op of TransactItems) {
    if (op.Update) table.set(keyOf(op.Update.Key), applyUpdate(table.get(keyOf(op.Update.Key)), op.Update));
    if (op.Put) table.set(keyOf(op.Put.Item), clone(op.Put.Item));
  }
  return {};
}

// The only UpdateCommand in the code: WaitForEvent parking its token.
function tokenUpdate(input) {
  const item = table.get(keyOf(input.Key));
  const loop = input.ExpressionAttributeValues[':loop'];
  if (!item || (item.tokenLoop !== undefined && item.tokenLoop > loop)) {
    throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
  }
  const next = { ...item, taskToken: input.ExpressionAttributeValues[':token'], tokenLoop: loop };
  table.set(keyOf(input.Key), next);
  return { Attributes: clone(next) };
}

export function resetMocks() {
  table.clear();
  hooks.beforeTransact = null;
  ddbMock.reset();
  sfnMock.reset();
  ddbMock.on(GetCommand).callsFake(async ({ Key }) => ({ Item: clone(table.get(keyOf(Key))) }));
  ddbMock.on(PutCommand).callsFake(async ({ Item }) => {
    table.set(keyOf(Item), clone(Item));
    return {};
  });
  ddbMock.on(QueryCommand).callsFake(async ({ ExpressionAttributeValues: v }) => ({
    Items: [...table.values()]
      .filter((i) => i.PK === v[':pk'] && i.SK.startsWith(v[':prefix']))
      .sort((a, b) => (a.SK < b.SK ? -1 : 1))
      .map(clone),
  }));
  ddbMock.on(TransactWriteCommand).callsFake(async (input) => {
    if (hooks.beforeTransact) {
      const hook = hooks.beforeTransact;
      hooks.beforeTransact = null;
      hook(input);
    }
    return transact(input);
  });
  ddbMock.on(UpdateCommand).callsFake(async (input) => tokenUpdate(input));
}

export const storedPlan = (id = PLAN_ID) => clone(table.get(`PLAN#${id}|META`));
export const storedEvents = (id = PLAN_ID) => [...table.values()]
  .filter((i) => i.PK === `PLAN#${id}` && i.SK.startsWith('EVENT#'))
  .sort((a, b) => (a.SK < b.SK ? -1 : 1));
export const eventTypes = (id) => storedEvents(id).map((e) => e.type);

/**
 * A plan created at `base`, due 2 h later, 15 min reminder, 15 min grace, 10 min ack,
 * two contacts on ntfy. `base` defaults to T0 (fixed clock tests); endpoint tests
 * pass a base relative to the real clock.
 */
export function planItem({ base = T0, ...overrides } = {}) {
  return {
    PK: `PLAN#${PLAN_ID}`,
    SK: 'META',
    type: 'plan',
    id: PLAN_ID,
    name: 'Sam',
    activity: 'Solo hike: Dipsea Trail loop',
    details: 'Parked at the trailhead. **Blue hatchback.**',
    routeUrl: 'https://example.com/route',
    phone: '+1 555 0100',
    timeZone: 'America/Los_Angeles',
    status: 'active',
    createdAt: iso(base),
    checkInBy: iso(base + 120 * MIN),
    graceUntil: iso(base + 135 * MIN),
    remindAt: iso(base + 105 * MIN),
    remindMinutesBefore: 15,
    graceMinutes: 15,
    ackMinutes: 10,
    reminderSent: false,
    safeAt: null,
    closedAt: null,
    locations: [{ lat: 37.9, lng: -122.6, accuracy: 30, at: iso(base) }],
    contacts: [
      {
        name: 'Alex', relationship: 'sister', notifyUrl: 'https://ntfy.sh/lastcall-alexalexalexalexalexalex',
        secretHash: sha256Hex(CONTACT_SECRETS[0]), state: 'standby', alertedAt: null, acknowledgedAt: null, note: null, allClearSent: false,
      },
      {
        name: 'Jordan', relationship: 'friend', notifyUrl: 'https://ntfy.sh/lastcall-jordanjordanjordanjord',
        secretHash: sha256Hex(CONTACT_SECRETS[1]), state: 'standby', alertedAt: null, acknowledgedAt: null, note: null, allClearSent: false,
      },
    ],
    ownerNotifyUrl: 'https://ntfy.sh/lastcall-ownerownerownerownerowne',
    ownerSecretHash: sha256Hex(OWNER_SECRET),
    apiBase: API,
    version: 1,
    taskToken: TOKEN,
    tokenLoop: 1,
    ttl: Math.floor((base + 14 * 86_400_000) / 1000),
    ...overrides,
  };
}

/** Puts a plan in the fake table and returns it. */
export function seedPlan(overrides = {}) {
  const item = planItem(overrides);
  table.set(keyOf(item), clone(item));
  return item;
}

/** Contact list helper: patch contact i of the default fixture. */
export function contactsWith(patches, base = T0) {
  return planItem({ base }).contacts.map((c, i) => ({ ...c, ...(patches[i] ?? {}) }));
}

export const SENSITIVE = ['notifyUrl', 'ownerNotifyUrl', 'secretHash', 'ownerSecretHash', 'taskToken', 'tokenLoop', 'apiBase', 'secret', 'version'];

export function assertNoSecrets(assert, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  for (const field of SENSITIVE) assert.ok(!text.includes(`"${field}"`), `response leaks ${field}`);
  assert.ok(!text.includes('ntfy.sh/lastcall-alex'), 'response leaks a notify URL');
  assert.ok(!text.includes(TOKEN), 'response leaks the task token');
  assert.ok(!text.includes(OWNER_SECRET) && !CONTACT_SECRETS.some((s) => text.includes(s)), 'response leaks a secret');
}
