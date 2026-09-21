#!/usr/bin/env node
// Release archive builder (0.4.0 reorganized layout).
//
//   node tools/release/archive.mjs [--out pokertools-arena-<version>.tar.gz]
//
// Packages the full source tree — src, tools, tests, bin, docs, GitHub
// workflows, package metadata and lockfile — while excluding .env, secrets,
// generated logs, dist, node_modules and OS/editor junk.
//
// The required-file manifest and exclusion patterns are exported so the
// archive-content regression test (`tests/unit/archive-content.mjs`) can assert
// the same contract without shelling out blindly.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_FILES = [
  'package.json', 'package-lock.json', 'README.md', 'LICENSE', '.env.example', 'build.mjs', '.gitignore', '.nojekyll',
  'bin/pokertools-arena.mjs',
  'src/index.html', 'src/app.js', 'src/styles.css',
  'src/lib/decision-core.js', 'src/benchmark/scenarios.js', 'src/env/arena-env.js',
  'src/shims/crypto.cjs', 'src/assets/favicon.svg', 'src/assets/og-image.svg', 'src/assets/og-image.png',
  'tools/diagnostics/env.js', 'tools/diagnostics/harness.js', 'tools/diagnostics/representations.js',
  'tools/diagnostics/scenarios.js', 'tools/diagnostics/corpus.js', 'tools/diagnostics/stats.js',
  'tools/diagnostics/paired.js', 'tools/diagnostics/report.js', 'tools/diagnostics/size-buckets.js',
  'tools/shared/dotenv.mjs',
  'tools/release/archive.mjs',
  'tests/README.md', 'tests/release-check.mjs',
  'tests/unit/decision-scenarios.mjs', 'tests/unit/decision-diagnostics.mjs',
  'tests/unit/hierarchical-decision-tests.mjs', 'tests/unit/methodology-tests.mjs',
  'tests/unit/paired-architecture-tests.mjs', 'tests/unit/size-bucket-tests.mjs',
  'tests/unit/tournament-safety-tests.mjs', 'tests/unit/model-capabilities-tests.mjs',
  'tests/unit/streaming-reasoning-tests.mjs',
  'tests/unit/archive-content.mjs', 'tests/unit/report-consistency.mjs',
  'tests/integration/pokertools-integration.mjs', 'tests/integration/env-bootstrap.mjs',
  'tests/integration/launcher-port-retry.mjs',
  'tests/integration/package-smoke.mjs',
  'tests/real/real-decision-diagnostics.mjs', 'tests/real/real-tournament-ab.mjs',
  'tests/real/real-paired-corpus.mjs',
  'tests/analysis/diagnostics-analyze.mjs', 'tests/analysis/diagnostics-summary.mjs',
  'docs/architecture/CONTEXT.md', 'docs/releases/RELEASE_NOTES.md', 'docs/verification/0.3.x.md',
  'docs/diagnostics/SUMMARY.md', 'docs/diagnostics/summary.json',
  'docs/legal/THIRD_PARTY_NOTICES.md',
  '.github/workflows/ci.yml', '.github/workflows/pages.yml', '.github/workflows/publish.yml',
  '.github/workflows/real-diagnostics.yml',
];

export const EXCLUDED_PATTERNS = [
  '.env', '.env.local', 'node_modules', 'logs', 'dist', '.git', '.DS_Store',
  '.release-inline-check.mjs', '*.tgz', '*.tar.gz', 'pokertools-arena.html', '*.log',
];

// Guard: never package an .env or a secret-bearing file. Generated bundles and
// the build output are excluded; the archive is a source archive.
export function assertArchiveInputs(root) {
  const missing = REQUIRED_FILES.filter(path => !existsSync(join(root, path)));
  if (missing.length) throw new Error(`Release archive is missing required files: ${missing.join(', ')}`);
}

export function verifyArchiveEntries(entries) {
  const leaks = entries.filter(entry => (
    /(^|\/)\.env(?:\.local|\.(?!example$)\w+)?$/.test(entry) ||
    /(^|\/)node_modules(\/|$)/.test(entry) ||
    /(^|\/)logs(\/|$)/.test(entry) ||
    /(^|\/)dist(\/|$)/.test(entry) ||
    /(^|\/)pokertools-arena\.html$/.test(entry)
  ));
  if (leaks.length) throw new Error(`Archive contains excluded paths: ${leaks.slice(0, 10).join(', ')}`);
  return true;
}

export function buildArchive({ root, outPath }) {
  assertArchiveInputs(root);
  const excludeArgs = EXCLUDED_PATTERNS.flatMap(pattern => ['--exclude', pattern]);
  execFileSync('tar', ['-czf', outPath, ...excludeArgs, '-C', root, '.'], { stdio: 'inherit' });
  const listing = execFileSync('tar', ['-tzf', outPath], { encoding: 'utf8' });
  const entries = listing.split('\n').filter(Boolean);
  verifyArchiveEntries(entries);
  return { outPath, entries, sizeBytes: statSync(outPath).size };
}

function main() {
  const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  const args = process.argv.slice(2);
  const outFlag = args.indexOf('--out');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const outPath = outFlag >= 0 ? args[outFlag + 1] : join(root, `${pkg.name}-${pkg.version}.tar.gz`);
  const { entries, sizeBytes } = buildArchive({ root, outPath });
  const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
  console.log(`Wrote ${outPath}`);
  console.log(`Entries: ${entries.length} · size: ${sizeMb} MB`);
  console.log(`Excluded: ${EXCLUDED_PATTERNS.join(', ')}`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
