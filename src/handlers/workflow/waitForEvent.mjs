// State machine task: WaitForEvent (invoked with .waitForTaskToken).
// Input: {planId, taskToken, version, loop}
//
// Parks the task token on the plan so endpoints can wake the workflow, then returns;
// the task stays open until someone calls SendTaskSuccess or the timeout (the next
// milestone) fires. Either way the state machine goes back to Advance.
//
// If the plan changed after Advance read it (its version moved on), an endpoint may
// have looked for a token before this one was parked and found none, so wake
// ourselves right away rather than sleep through the change.

import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { tableName } from '../../lib/config.mjs';
import { ddb, isConditionFailure, keys } from '../../lib/db.mjs';
import { nudge } from '../../lib/workflow.mjs';

export async function handler({ planId, taskToken, version, loop }) {
  let plan;
  try {
    ({ Attributes: plan } = await ddb.send(new UpdateCommand({
      TableName: tableName(),
      Key: keys.plan(planId),
      UpdateExpression: 'SET taskToken = :token, tokenLoop = :loop',
      // Never let a stale invocation overwrite the token of a later loop.
      ConditionExpression: 'attribute_exists(PK) AND (attribute_not_exists(tokenLoop) OR tokenLoop <= :loop)',
      ExpressionAttributeValues: { ':token': taskToken, ':loop': loop },
      ReturnValues: 'ALL_NEW',
    })));
  } catch (err) {
    if (!isConditionFailure(err)) throw err;
    // Plan gone, or a later loop already parked: release this task; Advance sorts it out.
    await nudge(taskToken, { rethrow: true });
    return { parked: false, nudged: true };
  }

  if (plan.version !== version) {
    await nudge(taskToken, { rethrow: true });
    return { parked: true, nudged: true };
  }
  return { parked: true, nudged: false };
}
