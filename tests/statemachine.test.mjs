// Static checks of statemachine/lastcall.asl.json against template.yaml: well-formed
// JSON, every transition target exists, every state is reachable, every ${...}
// placeholder has a DefinitionSubstitutions entry that points at a real resource,
// and the loop is exactly Advance -> Done? -> WaitForEvent -> Advance.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const root = new URL('../', import.meta.url);
const aslText = readFileSync(new URL('statemachine/lastcall.asl.json', root), 'utf8');
const template = readFileSync(new URL('template.yaml', root), 'utf8');
const asl = JSON.parse(aslText);
const s = asl.States;

function substitutions() {
  const block = /DefinitionSubstitutions:\n((?: {8}.+\n)+)/.exec(template);
  assert.ok(block, 'DefinitionSubstitutions block not found in template.yaml');
  return Object.fromEntries(block[1].trim().split('\n').map((line) => {
    const [key, ...rest] = line.trim().split(':');
    return [key, rest.join(':').trim()];
  }));
}

function targets(state) {
  const next = [];
  if (state.Next) next.push(state.Next);
  if (state.Default) next.push(state.Default);
  for (const choice of state.Choices ?? []) next.push(choice.Next);
  for (const c of state.Catch ?? []) next.push(c.Next);
  return next;
}

const LAMBDA_TRANSIENT = ['Lambda.ServiceException', 'Lambda.TooManyRequestsException'];

describe('state machine definition', () => {
  it('is well-formed with a valid StartAt', () => {
    assert.equal(typeof s, 'object');
    assert.ok(s[asl.StartAt], `StartAt ${asl.StartAt} missing`);
  });

  it('only transitions to states that exist, and every state is reachable', () => {
    const seen = new Set([asl.StartAt]);
    const queue = [asl.StartAt];
    while (queue.length) {
      const name = queue.shift();
      for (const target of targets(s[name])) {
        assert.ok(s[target], `${name} -> unknown state ${target}`);
        if (!seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
    assert.deepEqual(Object.keys(s).filter((n) => !seen.has(n)), [], 'unreachable states');
  });

  it('gives every non-terminal state a way out', () => {
    for (const [name, state] of Object.entries(s)) {
      if (['Succeed', 'Fail'].includes(state.Type)) continue;
      if (state.Type === 'Choice') assert.ok(state.Default, `${name} has no Default`);
      else assert.ok(state.Next || state.End, `${name} has no Next/End`);
    }
  });

  it('resolves every ${placeholder} through DefinitionSubstitutions to a template resource', () => {
    const subs = substitutions();
    const used = new Set([...aslText.matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]));
    assert.deepEqual([...used].sort(), ['AdvanceFunctionArn', 'WaitForEventFunctionArn']);
    for (const name of used) {
      assert.ok(subs[name], `\${${name}} has no DefinitionSubstitutions entry`);
      const resource = /!(?:Ref|GetAtt)\s+(\w+)/.exec(subs[name])?.[1];
      assert.ok(resource, `${name} must reference a resource`);
      assert.match(template, new RegExp(`^  ${resource}:\\n    Type: AWS::Serverless::Function`, 'm'), `${resource} is not a function in template.yaml`);
      assert.match(template, new RegExp(`LambdaInvokePolicy: \\{ FunctionName: !Ref ${resource} \\}`), `state machine may not invoke ${resource}`);
    }
    for (const name of Object.keys(subs)) assert.ok(used.has(name), `substitution ${name} is unused`);
  });

  it('implements the spec loop: Advance -> Done? -> WaitForEvent -> Advance', () => {
    assert.equal(asl.StartAt, 'Advance');
    assert.deepEqual(Object.keys(s).sort(), ['Advance', 'Done', 'Done?', 'WaitForEvent']);

    assert.equal(s.Advance.Resource, 'arn:aws:states:::lambda:invoke');
    assert.equal(s.Advance.ResultPath, '$.next');
    assert.deepEqual(Object.keys(s.Advance.ResultSelector).sort(), ['done.$', 'loop.$', 'version.$', 'waitSeconds.$']);
    assert.equal(s.Advance.Next, 'Done?');

    assert.equal(s['Done?'].Type, 'Choice');
    assert.deepEqual(s['Done?'].Choices, [{ Variable: '$.next.done', BooleanEquals: true, Next: 'Done' }]);
    assert.equal(s['Done?'].Default, 'WaitForEvent');
    assert.equal(s.Done.Type, 'Succeed');

    const wait = s.WaitForEvent;
    assert.equal(wait.Resource, 'arn:aws:states:::lambda:invoke.waitForTaskToken');
    assert.equal(wait.TimeoutSecondsPath, '$.next.waitSeconds');
    assert.deepEqual(wait.Parameters.Payload, {
      'planId.$': '$.planId', 'taskToken.$': '$$.Task.Token', 'version.$': '$.next.version', 'loop.$': '$.next.loop',
    });
    assert.equal(wait.Next, 'Advance');
    assert.equal(wait.ResultPath, null, 'the nudge payload must not clobber the state');
    assert.deepEqual(wait.Catch, [{ ErrorEquals: ['States.Timeout', 'States.TaskFailed'], ResultPath: '$.lastError', Next: 'Advance' }]);
  });

  it('feeds Advance its plan, secrets and loop counter, and the initial input matches', () => {
    assert.deepEqual(s.Advance.Parameters.Payload, { 'planId.$': '$.planId', 'secrets.$': '$.secrets', 'loop.$': '$.next.loop' });
    const create = readFileSync(new URL('src/handlers/createPlan.mjs', root), 'utf8');
    assert.match(create, /next: \{ loop: 0 \}/, 'createPlan must seed $.next.loop for the first Advance');
  });

  it('retries transient Lambda errors with backoff, and never retries the wait timeout', () => {
    for (const name of ['Advance', 'WaitForEvent']) {
      const rule = s[name].Retry.find((r) => LAMBDA_TRANSIENT.every((e) => r.ErrorEquals.includes(e)));
      assert.ok(rule && rule.BackoffRate > 1 && rule.MaxAttempts >= 3, `${name} lacks a Lambda retry`);
    }
    assert.ok(s.Advance.Retry.some((r) => r.ErrorEquals.includes('States.TaskFailed')), 'Advance retries its own failures');
    for (const rule of s.WaitForEvent.Retry) {
      assert.ok(!rule.ErrorEquals.includes('States.Timeout') && !rule.ErrorEquals.includes('States.ALL') && !rule.ErrorEquals.includes('States.TaskFailed'));
    }
  });
});
