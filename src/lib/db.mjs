// Single-table access. Key layout:
//   PLAN#<id>        / META                  the plan, contacts included (server-side fields too)
//   PLAN#<id>        / EVENT#<iso>#<seq>     timeline, sorted by time
//   IP#<ip>#<yyyymmdd> / META                daily plan counter per source IP
//
// Every write to a plan is a compare-and-swap on its `version`: read, decide, then
// write only if nobody else wrote in between (and bump the version). Exactly one of
// two racing writers wins; the loser re-reads and decides again.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { randomBase32 } from './ids.mjs';
import { eventTtl, tableName } from './config.mjs';

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export const keys = {
  plan: (planId) => ({ PK: `PLAN#${planId}`, SK: 'META' }),
  rateLimit: (ip, day) => ({ PK: `IP#${ip}#${day}`, SK: 'META' }),
};

// Orders events written in the same millisecond by one Lambda; the random tail keeps
// keys unique across concurrent Lambdas.
let seq = 0;

export function eventItem(plan, type, detail = {}, at = new Date()) {
  const iso = at.toISOString();
  seq = (seq + 1) % 10_000;
  return {
    PK: `PLAN#${plan.id}`,
    SK: `EVENT#${iso}#${String(seq).padStart(4, '0')}${randomBase32(4)}`,
    type,
    at: iso,
    detail,
    ttl: eventTtl(plan.createdAt, at),
  };
}

/** Strongly consistent read of the plan, or null. */
export async function getPlan(planId) {
  const { Item } = await ddb.send(new GetCommand({ TableName: tableName(), Key: keys.plan(planId), ConsistentRead: true }));
  return Item ?? null;
}

export async function getEvents(planId) {
  const events = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': `PLAN#${planId}`, ':prefix': 'EVENT#' },
      ConsistentRead: true,
      ExclusiveStartKey,
    }));
    events.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return events;
}

export async function putEvent(item) {
  await ddb.send(new PutCommand({ TableName: tableName(), Item: item }));
}

/**
 * Applies `changes` (top-level attributes) to the plan only if its version is still
 * `plan.version`, bumps the version, and writes `events` in the same transaction.
 * Throws a condition failure (see isConditionFailure) if someone else wrote first.
 * Returns the plan as it now is.
 */
export async function commitPlan(plan, changes, events = []) {
  const names = { '#version': 'version' };
  const values = { ':expected': plan.version, ':next': plan.version + 1 };
  const sets = ['#version = :next'];
  Object.entries(changes).forEach(([name, value], i) => {
    names[`#a${i}`] = name;
    values[`:a${i}`] = value === undefined ? null : value;
    sets.push(`#a${i} = :a${i}`);
  });

  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      {
        Update: {
          TableName: tableName(),
          Key: keys.plan(plan.id),
          UpdateExpression: `SET ${sets.join(', ')}`,
          ConditionExpression: '#version = :expected',
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        },
      },
      ...events.map((Item) => ({ Put: { TableName: tableName(), Item } })),
    ],
  }));
  return { ...plan, ...changes, version: plan.version + 1 };
}

/** True when a write failed only because its ConditionExpression did not hold. */
export function isConditionFailure(err, index) {
  if (err?.name === 'ConditionalCheckFailedException') return true;
  if (err?.name !== 'TransactionCanceledException') return false;
  const reasons = err.CancellationReasons ?? [];
  if (index !== undefined) return reasons[index]?.Code === 'ConditionalCheckFailed';
  return reasons.some((reason) => reason?.Code === 'ConditionalCheckFailed');
}
