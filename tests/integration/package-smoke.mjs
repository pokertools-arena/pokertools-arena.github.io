// Verify the published package, rather than only the repository checkout. This
// catches launcher imports accidentally omitted by package.json's files allowlist.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const temp = await mkdtemp(join(tmpdir(), 'pokertools-arena-package-'));

try {
  const output = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const packResult = JSON.parse(output);
  // npm 11 returns an array; npm 12 keys the same manifest by package name.
  const { filename, files } = Array.isArray(packResult) ? packResult[0] : Object.values(packResult)[0];
  assert.ok(files.some(file => file.path === 'tools/shared/dotenv.mjs'), 'package must include the launcher dotenv dependency');

  execFileSync('tar', ['-xzf', join(temp, filename), '-C', temp]);
  const launcher = spawnSync(process.execPath, [join(temp, 'package', 'bin', 'pokertools-arena.mjs'), '--help'], {
    encoding: 'utf8',
  });
  assert.equal(launcher.status, 0, launcher.stderr || 'packaged launcher failed');
  assert.match(launcher.stdout, /Usage:/);
} finally {
  await rm(temp, { recursive: true, force: true });
}

console.log('package-smoke: PASS');
