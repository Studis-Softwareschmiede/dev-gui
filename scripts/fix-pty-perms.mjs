/**
 * Ensures node-pty's spawn-helper binaries are executable.
 * macOS npm installs can strip the +x bit from native helper binaries.
 * This postinstall script restores it.
 */
import { existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const prebuildsDir = join(__dirname, '..', 'node_modules', 'node-pty', 'prebuilds');

if (!existsSync(prebuildsDir)) {
  // Not installed yet (e.g. running in CI before install) — skip
  process.exit(0);
}

import { readdirSync } from 'node:fs';

for (const platform of readdirSync(prebuildsDir)) {
  const helper = join(prebuildsDir, platform, 'spawn-helper');
  if (existsSync(helper)) {
    try {
      chmodSync(helper, 0o755);
    } catch {
      // Non-fatal: may lack permissions in some envs
    }
  }
}
