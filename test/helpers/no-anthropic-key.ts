/**
 * Per-test isolation from the developer's real `~/.gbrain/config.json`.
 *
 * `hasAnthropicKey()` (src/core/ai/anthropic-key.ts) and the gateway resolve
 * the Anthropic key from BOTH the `ANTHROPIC_API_KEY` env var AND the gbrain
 * config file (via loadConfig). A test that only `delete`s the env var is NOT
 * hermetic: it passes in CI (no config file) but fails on a developer machine
 * with a configured brain, because loadConfig() still resolves the key.
 *
 * `suppressAnthropicKey()` deletes the env var AND repoints `GBRAIN_HOME` at a
 * fresh empty temp dir for the duration of the test, so loadConfig() finds no
 * config.json. loadConfig is uncached and honors GBRAIN_HOME at call time.
 * Returns a `restore()` to call in `finally`.
 *
 * SCOPE: in-process tests only. It mutates process.env.GBRAIN_HOME and restores
 * it synchronously in restore(); do NOT use it around a child-process spawn
 * (the child would inherit the temp GBRAIN_HOME). Subprocess tests isolate via
 * their own child env instead.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function suppressAnthropicKey(): () => void {
  const origKey = process.env.ANTHROPIC_API_KEY;
  const origHome = process.env.GBRAIN_HOME;
  delete process.env.ANTHROPIC_API_KEY;
  process.env.GBRAIN_HOME = mkdtempSync(join(tmpdir(), 'gbrain-nokey-'));
  return () => {
    if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = origKey;
    if (origHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = origHome;
  };
}
