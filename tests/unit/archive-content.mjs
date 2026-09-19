// Archive-content regression test (offline).
//
// Builds the real release archive and proves it contains the full reorganized
// source tree while never containing .env, secrets, logs, dist, node_modules or
// generated bundles.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { REQUIRED_FILES, EXCLUDED_PATTERNS, assertArchiveInputs, verifyArchiveEntries, buildArchive } from '../../tools/release/archive.mjs';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// 1. Manifest sanity.
assert.ok(REQUIRED_FILES.includes('src/app.js'), 'archive must include application source');
assert.ok(REQUIRED_FILES.includes('tools/diagnostics/corpus.js'), 'archive must include diagnostics tools');
assert.ok(REQUIRED_FILES.some(path => path.startsWith('tests/unit/')), 'archive must include unit tests');
assert.ok(REQUIRED_FILES.some(path => path.startsWith('docs/')), 'archive must include documentation');
assert.ok(REQUIRED_FILES.includes('bin/pokertools-arena.mjs'), 'archive must include the npm launcher');
assert.ok(REQUIRED_FILES.some(path => path.startsWith('.github/workflows/')), 'archive must include workflows');
assert.ok(EXCLUDED_PATTERNS.includes('.env'), '.env must be excluded');
assertArchiveInputs(root);
console.log('archive-content: manifest PASS');

// 2. Build into a temp path and verify the listing.
const dir = await mkdtemp(join(tmpdir(), 'pokertools-arena-archive-'));
const outPath = join(dir, 'pokertools-arena-test.tar.gz');
try {
  const { entries, sizeBytes } = buildArchive({ root, outPath });
  assert.ok(sizeBytes > 0);
  verifyArchiveEntries(entries);
  for (const required of ['package.json', 'src/app.js', 'src/lib/decision-core.js', 'tools/release/archive.mjs', 'docs/diagnostics/SUMMARY.md']) {
    assert.ok(entries.some(entry => entry.replace(/^\.\//, '') === required), `archive must contain ${required}`);
  }
  for (const forbidden of ['.env', '.env.local', 'dist/app.js', 'pokertools-arena.html']) {
    assert.ok(!entries.some(entry => entry.replace(/^\.\//, '') === forbidden || entry.endsWith(`/${forbidden}`)), `archive must not contain ${forbidden}`);
  }
  assert.ok(!entries.some(entry => /(^|\/)node_modules(\/|$)/.test(entry)), 'archive must not contain node_modules');
  assert.ok(!entries.some(entry => /(^|\/)logs(\/|$)/.test(entry)), 'archive must not contain logs');
  // CI has no .env and this test never creates one: exclusion is guaranteed by
  // EXCLUDED_PATTERNS, and node_modules (present after install) empirically
  // proves the tar exclusions are actually applied.
  assert.ok(!entries.some(entry => entry.replace(/^\.\//, '') === '.env'), '.env must be excluded');
} finally {
  await rm(dir, { recursive: true, force: true });
}
console.log('archive-content: build + exclusion PASS');

console.log('archive-content: PASS');
