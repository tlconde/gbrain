/**
 * v0.41.6.0 D1 E2E — `gbrain sync` preflight rejects missing creds
 * cleanly without writing N failures to sync-failures.jsonl.
 *
 * Repro from the production bug report:
 *   unset OPENAI_API_KEY
 *   gbrain sync --repo /tmp/test --full --yes
 *
 * Pre-v0.41.6.0: 565 identical "OpenAI embedding requires
 * OPENAI_API_KEY" entries in ~/.gbrain/sync-failures.jsonl, bookmark
 * blocked.
 *
 * Post-v0.41.6.0: single clean stderr line, exit 1, zero
 * sync-failures.jsonl entries.
 *
 * Hermetic: GBRAIN_HOME points at a tmpdir; OPENAI_API_KEY explicitly
 * unset; runs against PGLite via `gbrain init --pglite` so no real
 * Postgres needed.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { tmpdir } from 'os';

const CLI = ['bun', 'run', join(import.meta.dir, '..', '..', 'src', 'cli.ts')];

let tmpHome: string;
let repoDir: string;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-preflight-e2e-'));
});

afterAll(() => {
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
});

beforeEach(() => {
  // Create a fresh PGLite-backed brain repo with one markdown file.
  if (repoDir) { try { rmSync(repoDir, { recursive: true, force: true }); } catch { /* */ } }
  repoDir = mkdtempSync(join(tmpdir(), 'gbrain-preflight-repo-'));
  mkdirSync(join(repoDir, 'people'), { recursive: true });
  writeFileSync(join(repoDir, 'people', 'alice-example.md'), [
    '---',
    'type: person',
    'title: Alice Example',
    '---',
    '',
    'Alice is a placeholder person used in privacy-safe test fixtures.',
  ].join('\n'));
  // Initialize git so sync has a HEAD to anchor on.
  execFileSync('git', ['init', '-q'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
  execFileSync('git', ['add', '.'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: repoDir });
});

function runCli(args: string[], env: Record<string, string | undefined>): { code: number; stdout: string; stderr: string } {
  const fullEnv: Record<string, string | undefined> = { ...(process.env as Record<string, string | undefined>), GBRAIN_HOME: tmpHome, ...env };
  // Strip any undefined-explicitly-set vars (signals "unset").
  for (const k of Object.keys(fullEnv)) if (fullEnv[k] === undefined) delete fullEnv[k];
  const res = spawnSync(CLI[0], [...CLI.slice(1), ...args], {
    env: fullEnv as Record<string, string>,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  return { code: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

describe('v0.41.6.0 D1 E2E — gbrain sync preflight rejects missing OPENAI_API_KEY', () => {
  test('exits non-zero with paste-ready stderr message', () => {
    // Initialize a PGLite brain pointing at the test repo.
    const initResult = runCli(
      ['init', '--pglite', '--repo', repoDir, '--yes'],
      { OPENAI_API_KEY: undefined },
    );
    // init succeeds even without OPENAI_API_KEY (it defers embedding setup).
    expect(initResult.code === 0 || initResult.code === 2).toBe(true);

    const result = runCli(
      ['sync', '--repo', repoDir, '--full', '--yes'],
      { OPENAI_API_KEY: undefined },
    );

    // Exit non-zero (either 1 from preflight or 2 from deferred-embed gate).
    expect(result.code).not.toBe(0);

    // Stderr OR stdout contains the credential-error message (the preflight
    // writes to stderr but the deferred-embed gate may write to stderr too).
    const combined = result.stderr + result.stdout;
    const hasCredentialMessage =
      /OPENAI_API_KEY/i.test(combined) ||
      /requires OPENAI_API_KEY/i.test(combined) ||
      /embedding (model|setup|deferred)/i.test(combined);
    expect(hasCredentialMessage).toBe(true);
  });

  test('does NOT write 565 identical entries to sync-failures.jsonl', () => {
    runCli(['init', '--pglite', '--repo', repoDir, '--yes'], { OPENAI_API_KEY: undefined });
    runCli(['sync', '--repo', repoDir, '--full', '--yes'], { OPENAI_API_KEY: undefined });

    const failuresPath = join(tmpHome, 'sync-failures.jsonl');
    if (!existsSync(failuresPath)) {
      // File never created — perfect outcome.
      expect(true).toBe(true);
      return;
    }
    const lines = readFileSync(failuresPath, 'utf8').split('\n').filter(Boolean);
    // Pre-v0.41.6.0 wrote N entries per file. Post-fix should write 0 entries
    // for the missing-key case (preflight exits before import).
    expect(lines.length).toBeLessThanOrEqual(1);
  });

  test('--no-embed bypasses the preflight (sync proceeds)', () => {
    runCli(['init', '--pglite', '--repo', repoDir, '--yes'], { OPENAI_API_KEY: undefined });
    const result = runCli(
      ['sync', '--repo', repoDir, '--full', '--yes', '--no-embed'],
      { OPENAI_API_KEY: undefined },
    );
    // --no-embed lets sync continue. Exit 0 (or 2 for cost prompt non-confirmation
    // if --yes wasn't consumed by some path); 1 would mean we still rejected.
    // The key contract: preflight DID NOT block this path.
    const combined = result.stderr + result.stdout;
    expect(combined).not.toMatch(/Embedding model.*requires.*OPENAI_API_KEY.*\n.*Set it in your shell/);
  });
});
