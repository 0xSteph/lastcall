// Cross-platform command runner for the deploy scripts. On Windows, `sam` is a .cmd
// shim that needs a shell, and a freshly installed SAM/AWS CLI may be missing from
// this process's PATH until the PATH is re-read from the registry.

import { execFileSync, spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';

export function refreshWindowsPath() {
  if (!isWindows) return;
  try {
    const fresh = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')",
    ], { encoding: 'utf8' }).trim();
    const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'Path';
    const merged = new Set([...(process.env[key] ?? '').split(';'), ...fresh.split(';')].filter(Boolean));
    process.env[key] = [...merged].join(';');
  } catch {
    // Keep the inherited PATH; the command itself will report if it is missing.
  }
}

// Quote for the platform shell. Args here are flags, ARNs, bucket names and paths;
// anything with glob or shell metacharacters ("/*", "Stacks[0]") gets quoted.
const SAFE = /^[\w@+=:,./\\-]+$/;
const quote = (arg) => {
  const value = String(arg);
  if (SAFE.test(value)) return value;
  return isWindows ? `"${value.replace(/"/g, '""')}"` : `'${value.replace(/'/g, "'\\''")}'`;
};

/**
 * Runs a command, streaming its output. With `capture`, returns stdout instead.
 * Throws if the command exits non-zero.
 */
export function run(command, args = [], { capture = false, cwd } = {}) {
  const line = [command, ...args].map(quote).join(' ');
  if (!capture) console.log(`\n$ ${line}`);
  const result = spawnSync(line, {
    cwd,
    shell: true,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command failed (exit ${result.status}): ${line}`);
  return capture ? result.stdout : undefined;
}
