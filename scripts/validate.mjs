#!/usr/bin/env node
// Lints template.yaml and the state machine definition.
//
// `sam validate --lint` does not open DefinitionUri files, so the ASL is also linted
// on its own: placeholders are filled with dummy ARNs and the definition is inlined
// into a throwaway template, where cfn-lint's E3601 rule checks it against the
// Step Functions schema.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { refreshWindowsPath, run } from './lib/run.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
process.env.SAM_CLI_TELEMETRY ??= '0';
refreshWindowsPath();

run('sam', ['validate', '--lint', '--region', 'us-east-1'], { cwd: root });

const asl = readFileSync(join(root, 'statemachine', 'lastcall.asl.json'), 'utf8')
  .replace(/\$\{(\w+)FunctionArn\}/g, 'arn:aws:lambda:us-east-1:123456789012:function:$1');
const leftover = /\$\{\w+\}/.exec(asl);
if (leftover) throw new Error(`Unknown placeholder ${leftover[0]} in lastcall.asl.json`);

const dir = mkdtempSync(join(tmpdir(), 'lastcall-asl-'));
try {
  const file = join(dir, 'asl-check.json');
  writeFileSync(file, JSON.stringify({
    AWSTemplateFormatVersion: '2010-09-09',
    Resources: {
      LastCallStateMachine: {
        Type: 'AWS::StepFunctions::StateMachine',
        Properties: {
          RoleArn: 'arn:aws:iam::123456789012:role/lastcall-state-machine',
          StateMachineType: 'STANDARD',
          Definition: JSON.parse(asl),
        },
      },
    },
  }, null, 2));
  run('sam', ['validate', '--lint', '--region', 'us-east-1', '--template', file], { cwd: root });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log('\ntemplate.yaml and statemachine/lastcall.asl.json are valid.');
