import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { writeWithConflictRetry } from '../src/handlers/createPlan.mjs';

const cancelled = (...codes) =>
  Object.assign(new Error('Transaction cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });

describe('writeWithConflictRetry', () => {
  it('retries a TransactionConflict and returns the eventual result', async () => {
    let calls = 0;
    const result = await writeWithConflictRetry(async () => {
      calls++;
      if (calls < 3) throw cancelled('TransactionConflict', 'None', 'None');
      return 'written';
    }, { baseMs: 1 });
    assert.equal(result, 'written');
    assert.equal(calls, 3);
  });

  it('does not retry a failed condition (the daily cap)', async () => {
    let calls = 0;
    const err = cancelled('ConditionalCheckFailed', 'None', 'None');
    await assert.rejects(writeWithConflictRetry(async () => { calls++; throw err; }, { baseMs: 1 }), err);
    assert.equal(calls, 1);
  });

  it('does not retry unrelated errors', async () => {
    let calls = 0;
    await assert.rejects(writeWithConflictRetry(async () => { calls++; throw new Error('boom'); }, { baseMs: 1 }), /boom/);
    assert.equal(calls, 1);
  });

  it('gives up after the attempt limit', async () => {
    let calls = 0;
    await assert.rejects(
      writeWithConflictRetry(async () => { calls++; throw cancelled('TransactionConflict'); }, { attempts: 4, baseMs: 1 }),
      (e) => e.name === 'TransactionCanceledException',
    );
    assert.equal(calls, 4);
  });
});
