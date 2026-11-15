import { SFNClient, SendTaskSuccessCommand } from '@aws-sdk/client-sfn';

export const sfn = new SFNClient({});

// The task behind this token is already closed: it timed out, was nudged by someone
// else, or its execution moved on. Advance reads the plan from the table either way.
const CLOSED_TASK_ERRORS = new Set(['TaskTimedOut', 'TaskDoesNotExist', 'InvalidToken']);

/**
 * Wakes the plan's workflow so Advance re-reads the plan now instead of at its next
 * milestone. Endpoints call this after a successful write and ignore every SFN error:
 * the change is durable, and the next Advance picks it up from DynamoDB anyway.
 * With `rethrow`, errors other than "task already closed" propagate (WaitForEvent uses
 * this so a failed self-nudge fails the task, which the state machine catches into Advance).
 */
export async function nudge(taskToken, { rethrow = false } = {}) {
  if (!taskToken) return false;
  try {
    await sfn.send(new SendTaskSuccessCommand({ taskToken, output: '{}' }));
    return true;
  } catch (err) {
    if (rethrow && !CLOSED_TASK_ERRORS.has(err?.name)) throw err;
    console.info(`Nudge skipped (${err?.name ?? err}); Advance will read the change from the table.`);
    return false;
  }
}
