// Release documentation consistency test (offline).
//
// 0.3.0 drifted between "909 decisions", ">750 decisions" and ">1000
// decisions". 0.4.0 commits one machine-readable `docs/diagnostics/summary.json`
// and derives `docs/diagnostics/SUMMARY.md` from it. This test fails if the
// human-readable document no longer matches the machine-readable source of
// truth, or if the counters themselves are internally inconsistent.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSummary, renderSummaryMarkdown, totalsLine, expectedTotalsFragments, assertSummaryConsistent } from '../../tools/diagnostics/report.js';
import { createCounters } from '../../tools/diagnostics/counters.js';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// 1. The renderer is self-consistent and catches contradictory rates.
{
  const counters = createCounters({ pokerDecisions: 10, familyModelCalls: 10, sizingModelCalls: 5, totalModelCalls: 15, httpRequests: 16, httpRetries: 1 });
  const summary = buildSummary({
    version: 'test', counters,
    sections: { strict: [{ architecture: 'hierarchical', family: { successes: 9, trials: 10, rate: 0.9, ci95: { low: 0.5, high: 0.99 } } }] },
  });
  assertSummaryConsistent(summary);
  const md = renderSummaryMarkdown(summary);
  for (const fragment of expectedTotalsFragments(summary)) assert.ok(md.includes(fragment), `rendered report must state ${fragment}`);
  assert.ok(md.includes(totalsLine(summary)));
  assert.throws(() => buildSummary({ version: 'bad', counters: { totalModelCalls: 5, familyModelCalls: 1, sizingModelCalls: 1, spectatorModelCalls: 0 } }), /Counter mismatch/);
  const badRate = buildSummary({ version: 'bad', counters, sections: { strict: [{ architecture: 'x', family: { successes: 9, trials: 10, rate: 0.5 } }] } });
  assert.throws(() => assertSummaryConsistent(badRate), /does not match/);
}
console.log('report-consistency: renderer PASS');

// 2. The committed docs are derived from the committed summary JSON.
{
  const summaryPath = join(root, 'docs', 'diagnostics', 'summary.json');
  const mdPath = join(root, 'docs', 'diagnostics', 'SUMMARY.md');
  assert.ok(existsSync(summaryPath), 'docs/diagnostics/summary.json must exist as the source of truth');
  assert.ok(existsSync(mdPath), 'docs/diagnostics/SUMMARY.md must exist');
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  assertSummaryConsistent(summary);
  assert.equal(summary.version, JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, 'summary version must match package.json');
  const committed = readFileSync(mdPath, 'utf8');
  for (const fragment of expectedTotalsFragments(summary)) {
    assert.ok(committed.includes(fragment), `SUMMARY.md is stale: missing "${fragment}"`);
  }
  assert.ok(committed.includes(totalsLine(summary)), 'SUMMARY.md must contain the canonical totals line verbatim');
  // No contradictory decision totals may appear anywhere in the document.
  const decisions = summary.counters.pokerDecisions;
  const conflicting = committed.match(/\b(\d+)\s+decisions\b/gi)?.filter(match => Number(match.match(/\d+/)[0]) !== decisions) ?? [];
  assert.deepEqual(conflicting, [], `SUMMARY.md contains conflicting decision totals: ${conflicting.join(', ')}`);
}
console.log('report-consistency: committed docs PASS');

console.log('report-consistency: PASS');
