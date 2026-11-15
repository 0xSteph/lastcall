// POST /v1/plans -> 201 {id, ownerUrl, ownerSubscribeUrl?, contacts: [{name, alertUrl, subscribeUrl?}], plan}
//
// Writes the plan (and counts it against the caller's daily cap in the same
// transaction) before starting its execution, so a GET straight after never 404s.

import { StartExecutionCommand } from '@aws-sdk/client-sfn';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { dailyPlanCap, planTtl, rateLimitTtl, stateMachineArn, tableName, terminalTtl } from '../lib/config.mjs';
import { commitPlan, ddb, eventItem, isConditionFailure, keys } from '../lib/db.mjs';
import { apiBaseFrom, HttpError, json, readJsonBody, route, sourceIp } from '../lib/http.mjs';
import { newNtfyTopicUrl, newPlanId, newSecret, sha256Hex } from '../lib/ids.mjs';
import { alertUrl, ownerUrl, ownerView } from '../lib/plans.mjs';
import { deadlines } from '../lib/timing.mjs';
import { validateCreatePlan } from '../lib/validate.mjs';
import { sfn } from '../lib/workflow.mjs';

// Plans from the same IP share one rate-limit counter item, so concurrent creates
// (a double-tap, or a page creating several plans) can collide inside DynamoDB
// with TransactionConflict. A cancelled transaction wrote nothing, so retrying it
// with a short jittered backoff is safe.
const isTransactionConflict = (err) =>
  err?.name === 'TransactionCanceledException' &&
  (err.CancellationReasons ?? []).some((r) => r?.Code === 'TransactionConflict');

export async function writeWithConflictRetry(write, { attempts = 5, baseMs = 40 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write();
    } catch (err) {
      if (!isTransactionConflict(err) || attempt >= attempts) throw err;
      await new Promise((r) => setTimeout(r, baseMs * attempt + Math.random() * baseMs * attempt));
    }
  }
}

/** A person's notify URL, or a freshly generated ntfy topic they can subscribe to. */
function channelFor(notifyUrl) {
  return notifyUrl ? { notifyUrl, generated: false } : { notifyUrl: newNtfyTopicUrl(), generated: true };
}

export const handler = route(async (event) => {
  const now = new Date();
  const input = validateCreatePlan(readJsonBody(event), now);
  const id = newPlanId();
  const createdAt = now.toISOString();
  const ownerSecret = newSecret();
  const owner = channelFor(input.ownerNotifyUrl);
  const contacts = input.contacts.map((c) => ({ ...c, secret: newSecret(), ...channelFor(c.notifyUrl) }));

  const plan = {
    ...keys.plan(id),
    type: 'plan',
    id,
    name: input.name,
    activity: input.activity,
    details: input.details,
    routeUrl: input.routeUrl,
    phone: input.phone,
    timeZone: input.timeZone,
    status: 'active',
    createdAt,
    checkInBy: input.checkInBy,
    ...deadlines(input, now),
    remindMinutesBefore: input.remindMinutesBefore,
    graceMinutes: input.graceMinutes,
    ackMinutes: input.ackMinutes,
    reminderSent: false,
    safeAt: null,
    closedAt: null,
    locations: input.location ? [{ ...input.location, at: createdAt }] : [],
    contacts: contacts.map((c) => ({
      name: c.name,
      relationship: c.relationship,
      notifyUrl: c.notifyUrl,
      secretHash: sha256Hex(c.secret),
      state: 'standby',
      alertedAt: null,
      acknowledgedAt: null,
      note: null,
      allClearSent: false,
    })),
    ownerNotifyUrl: owner.notifyUrl,
    ownerSecretHash: sha256Hex(ownerSecret),
    apiBase: apiBaseFrom(event),
    version: 1,
    ttl: planTtl(now),
  };
  const created = eventItem(plan, 'created', { contacts: contacts.length, checkInBy: plan.checkInBy }, now);

  const cap = dailyPlanCap();
  const day = createdAt.slice(0, 10).replace(/-/g, '');
  try {
    await writeWithConflictRetry(() => ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          // Daily cap per source IP (UTC day). Index 0: a failed condition here means 429.
          Update: {
            TableName: tableName(),
            Key: keys.rateLimit(sourceIp(event), day),
            UpdateExpression: 'ADD planCount :one SET #ttl = if_not_exists(#ttl, :ttl)',
            ConditionExpression: 'attribute_not_exists(planCount) OR planCount < :cap',
            ExpressionAttributeNames: { '#ttl': 'ttl' },
            ExpressionAttributeValues: { ':one': 1, ':cap': cap, ':ttl': rateLimitTtl(now) },
          },
        },
        { Put: { TableName: tableName(), Item: plan, ConditionExpression: 'attribute_not_exists(PK)' } },
        { Put: { TableName: tableName(), Item: created } },
      ],
    })));
  } catch (err) {
    if (isConditionFailure(err, 0)) {
      throw new HttpError(429, 'rate_limited', `You can create at most ${cap} plans per day. Please try again tomorrow.`);
    }
    throw err;
  }

  // Advance needs the plaintext secrets to build one-tap links, and the table only
  // holds their hashes, so they travel in the execution input.
  const workflowInput = {
    planId: id,
    secrets: { owner: ownerSecret, contacts: contacts.map((c) => c.secret) },
    next: { loop: 0 },
  };
  try {
    await sfn.send(new StartExecutionCommand({
      stateMachineArn: stateMachineArn(),
      name: id, // execution names are unique, so a retried start cannot double-run a plan
      input: JSON.stringify(workflowInput),
    }));
  } catch (err) {
    console.error('StartExecution failed', { planId: id, error: err });
    await abandon(plan, now);
    throw new HttpError(503, 'workflow_unavailable', 'Could not start the check-in timer. Please try again.');
  }

  const subscribe = (channel) => (channel.generated ? channel.notifyUrl : undefined);
  return json(201, {
    id,
    ownerUrl: ownerUrl(id, ownerSecret),
    ownerSubscribeUrl: subscribe(owner),
    contacts: contacts.map((c, i) => ({ name: c.name, alertUrl: alertUrl(id, i, c.secret), subscribeUrl: subscribe(c) })),
    plan: ownerView(plan, [created], now),
  });
});

/** A plan without a running timer would silently never alert anyone: close it. */
async function abandon(plan, now) {
  try {
    await commitPlan(plan, { status: 'closed', closedAt: now.toISOString(), ttl: terminalTtl(plan.createdAt, now) }, [
      eventItem(plan, 'closed', { reason: 'workflow_start_failed' }, now),
    ]);
  } catch (err) {
    console.error('Could not close abandoned plan', { planId: plan.id, error: err });
  }
}
