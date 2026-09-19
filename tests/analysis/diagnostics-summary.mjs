#!/usr/bin/env node
// Concise release summary builder.
//
//   node tests/analysis/diagnostics-summary.mjs --dir logs/release-0.4.0 [--out logs/diagnostics-summary.md]
//
// Reads the newest diagnostics-*.json and tournament-ab-*.json in the directory
// (or explicit --diagnostics / --tournament paths) and writes a single concise
// Markdown report. No API calls, no secrets.
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate } from '../../tools/diagnostics/harness.js';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const args = process.argv.slice(2);
function flag(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; }
const dir = flag('--dir') || join(root, 'logs');
const outPath = flag('--out') || join(root, 'logs', 'diagnostics-summary.md');
const diagnosticsFlag = flag('--diagnostics');

async function newest(prefix, explicit) {
  if (explicit) return explicit;
  const files = await readdir(dir);
  const candidates = [];
  for (const name of files) {
    if (!name.startsWith(prefix) || !name.endsWith('.json')) continue;
    const path = join(dir, name);
    candidates.push({ path, mtime: (await stat(path)).mtimeMs });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.path ?? null;
}

function pct(v) { return Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—'; }
function ms(v) { return Number.isFinite(v) ? `${Math.round(v)}ms` : '—'; }
function table(headers, rows) {
  if (!rows.length) return '_No data._';
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(r => `| ${r.map(v => String(v).replace(/\|/g, '\\|')).join(' | ')} |`)].join('\n');
}

const diagnosticsPath = await newest('diagnostics-', flag('--diagnostics'));
const tournamentPath = await newest('tournament-ab-', flag('--tournament'));
// Merge additional diagnostics files so one report can cover several runs
// (broad strict/fragmentation plus focused probe/heroHand repetitions).
const mergePaths = (flag('--merge') || '').split(',').map(s => s.trim()).filter(Boolean);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lines = [`# pokertools-arena ${pkg.version} — release diagnostics summary`, ''];

if (diagnosticsPath) {
  const data = JSON.parse(await readFile(diagnosticsPath, 'utf8'));
  const merged = mergePaths.map(path => JSON.parse(readFileSync(path, 'utf8')));
  const results = [...(data.results ?? []), ...merged.flatMap(entry => entry.results ?? [])];
  const meta = {
    models: data.meta?.models ?? [],
    totalCalls: (data.meta?.totalCalls ?? 0) + merged.reduce((s, m) => s + (m.meta?.totalCalls ?? 0), 0),
    httpRequests: (data.meta?.httpRequests ?? 0) + merged.reduce((s, m) => s + (m.meta?.httpRequests ?? 0), 0),
    retries: (data.meta?.retries ?? 0) + merged.reduce((s, m) => s + (m.meta?.retries ?? 0), 0),
    rateLimitEvents: (data.meta?.rateLimitEvents ?? 0) + merged.reduce((s, m) => s + (m.meta?.rateLimitEvents ?? 0), 0),
    providerErrorEvents: (data.meta?.providerErrorEvents ?? 0) + merged.reduce((s, m) => s + (m.meta?.providerErrorEvents ?? 0), 0),
  };
  const byExperiment = name => results.filter(r => r.experiment === name || (Array.isArray(data.meta?.experimentsRun) && data.meta.experimentsRun.some(b => b.name === name)));
  lines.push(`Source diagnostics: \`${diagnosticsPath.replace(root + '/', '')}\`${mergePaths.length ? ` + ${mergePaths.length} merged run(s)` : ''}`);
  lines.push(`Models: ${meta.models.join(', ')}`);
  lines.push(`Decisions recorded: ${results.length} · model calls: ${meta.totalCalls} · HTTP requests: ${meta.httpRequests} (retries ${meta.retries}, rate-limit ${meta.rateLimitEvents}, provider ${meta.providerErrorEvents})`);
  lines.push('');

  lines.push('## STRICT DIAGNOSTICS');
  const strict = results.filter(r => r.experiment === 'strict' || r.experiment === 'hierarchical');
  const strictRows = [];
  for (const experiment of ['strict', 'hierarchical']) {
    const rows = results.filter(r => r.experiment === experiment);
    if (!rows.length) continue;
    const scored = rows.filter(r => r.layer !== 'P' && r.layer !== 'F');
    const agg = aggregate(scored);
    strictRows.push([experiment, String(agg.total), pct(agg.accuracy), String(agg.errors), ms(agg.latencyMean)]);
  }
  lines.push(table(['Architecture', 'Scored decisions', 'Accuracy', 'Errors', 'Mean latency'], strictRows));
  lines.push(`- Layer A (action-id mapping): ${pct(aggregate(results.filter(r => r.layer === 'A')).accuracy)}`);
  lines.push(`- Layer B (hand recognition): ${pct(aggregate(results.filter(r => r.layer === 'B')).accuracy)}`);
  lines.push(`- Layer D (strictly dominated): ${pct(aggregate(results.filter(r => r.layer === 'D')).accuracy)}`);
  lines.push('');

  lines.push('## ACTION FRAGMENTATION');
  const frag = results.filter(r => r.experiment?.startsWith('fragmentation') && r.menu);
  const menus = [...new Set(frag.map(r => r.menu))];
  const adapters = [...new Set(frag.map(r => r.adapterName))];
  lines.push(table(['Model', ...menus], adapters.map(name => {
    return [name, ...menus.map(menu => {
      const group = frag.filter(r => r.adapterName === name && r.menu === menu);
      return group.length ? pct(aggregate(group).aggressiveRate) : '—';
    })];
  })));
  lines.push('');

  lines.push('## FLAT VS HIERARCHICAL');
  lines.push('_Behavioral comparison over the action scenarios (fragmentation and probe menus excluded so the two architectures see the same poker states)._');
  const archRows = [];
  const archBase = results.filter(r => r.kind === 'action' && !r.error && !r.menu);
  for (const adapterId of [...new Set(archBase.map(r => r.adapterId))]) {
    for (const architecture of ['flat', 'hierarchical']) {
      const group = archBase.filter(r => r.adapterId === adapterId && r.architecture === architecture);
      if (!group.length) continue;
      const agg = aggregate(group);
      archRows.push([group[0].adapterName, architecture, String(agg.aggressionOpportunities), String(agg.aggressiveChoices), pct(agg.aggressiveRate), pct((agg.actionCounts.CHECK ?? 0) / agg.total), pct(agg.meanAggressiveFamilyMass), ms(agg.primaryLatencyMean ?? agg.latencyMean), String(agg.errors)]);
    }
  }
  lines.push(table(['Model', 'Architecture', 'Agg opps', 'Aggressive', 'Agg rate', 'Check rate', 'Mean agg family mass', 'Mean latency', 'Errors'], archRows));
  lines.push('');

  lines.push('## HERO HAND ABLATION');
  const hero = results.filter(r => r.experiment === 'herohand' || r.representationId === 'canonical-herohand');
  const heroNames = [...new Set(hero.map(r => r.adapterName))];
  if (heroNames.length) {
    lines.push(table(['Model', 'Raw accuracy', 'heroHand accuracy', 'Delta'], heroNames.map(name => {
      const raw = aggregate(hero.filter(r => r.adapterName === name && r.representationId === 'full-json'));
      const withHand = aggregate(hero.filter(r => r.adapterName === name && r.representationId === 'canonical-herohand'));
      return [name, pct(raw.accuracy), pct(withHand.accuracy), pct(withHand.accuracy - raw.accuracy)];
    })));
  }
  // Probe-level heroHand ablation: does the selected action family change when
  // the deterministic hero hand is supplied?
  const probe = results.filter(r => r.menu && String(r.menu).startsWith('probe ·'));
  if (probe.length) {
    const probeNames = [...new Set(probe.map(r => r.adapterName))];
    lines.push('');
    lines.push('### Probe: raw vs deterministic heroHand (behavioral, no gold answer)');
    lines.push(table(['Model', 'Variant', 'Aggressive rate', 'Check rate', 'Mean agg family mass'], probeNames.flatMap(name => {
      const menus = [...new Set(probe.map(r => r.menu))].sort();
      return menus.filter(menu => probe.some(r => r.menu === menu && r.adapterName === name)).map(menu => {
        const group = probe.filter(r => r.menu === menu && r.adapterName === name);
        const agg = aggregate(group);
        const clean = String(menu).replace(/^probe · /, '');
        return [name, clean, pct(agg.aggressiveRate), pct((agg.actionCounts.CHECK ?? 0) / agg.total), pct(agg.meanAggressiveFamilyMass)];
      });
    })));
  }
  lines.push('');

  lines.push('## REPRESENTATION');
  const repRows = [];
  for (const adapterId of [...new Set(results.filter(r => r.experiment === 'representations').map(r => r.adapterId))]) {
    for (const repId of [...new Set(results.filter(r => r.experiment === 'representations' && r.adapterId === adapterId).map(r => r.representationId))]) {
      const group = results.filter(r => r.experiment === 'representations' && r.adapterId === adapterId && r.representationId === repId);
      const agg = aggregate(group);
      repRows.push([group[0]?.adapterName, repId, pct(agg.accuracy), pct(agg.aggressiveRate), ms(agg.latencyMean)]);
    }
  }
  lines.push(table(['Model', 'Representation', 'Accuracy', 'Agg rate', 'Latency'], repRows));
  lines.push('');

  lines.push('## CONTEXT');
  const ctxRows = [];
  for (const adapterId of [...new Set(results.filter(r => r.experiment === 'context').map(r => r.adapterId))]) {
    for (const variant of [...new Set(results.filter(r => r.experiment === 'context' && r.adapterId === adapterId).map(r => r.contextVariantId))]) {
      const group = results.filter(r => r.experiment === 'context' && r.adapterId === adapterId && r.contextVariantId === variant);
      const agg = aggregate(group);
      ctxRows.push([group[0]?.adapterName, variant, pct(agg.accuracy), pct(agg.aggressiveRate), ms(agg.latencyMean)]);
    }
  }
  lines.push(table(['Model', 'Context variant', 'Accuracy', 'Agg rate', 'Latency'], ctxRows));
  lines.push('');

  lines.push('## PERFORMANCE');
  const perfRows = [];
  for (const adapterId of [...new Set(results.map(r => r.adapterId))]) {
    const group = results.filter(r => r.adapterId === adapterId);
    const agg = aggregate(group);
    perfRows.push([group[0]?.adapterName, group[0]?.architecture ?? '—', String(agg.total), ms(agg.latencyMean), ms(agg.latencyP95), String(agg.errors), String(agg.usageIn), String(agg.usageOut)]);
  }
  lines.push(table(['Model', 'Architecture', 'Decisions', 'Mean latency', 'P95 latency', 'Errors', 'Prompt tokens', 'Completion tokens'], perfRows));
  lines.push('');
  lines.push(`Total errors: ${results.filter(r => r.error).length} / ${results.length}`);
  lines.push('');
} else {
  lines.push('_No diagnostics JSON found._');
  lines.push('');
}

if (tournamentPath) {
  const data = JSON.parse(await readFile(tournamentPath, 'utf8'));
  lines.push('## REAL TOURNAMENT BEHAVIOR');
  lines.push(`Source: \`${tournamentPath.replace(root + '/', '')}\``);
  const modelNames = data.meta?.models ?? [];
  const labelFor = id => {
    const match = /^ab-model-(\d+)$/.exec(String(id));
    const model = match ? modelNames[Number(match[1]) - 1] : null;
    if (!model) return id;
    const raw = String(model).replace(/^~/, '').split('/').pop() || model;
    const lower = raw.toLowerCase();
    if (lower.startsWith('jev')) return 'Jev';
    if (lower.startsWith('gemma')) return 'Gemma';
    if (lower.startsWith('qwen')) return 'Qwen';
    return raw;
  };
  lines.push(`Models: ${modelNames.join(', ')}`);
  const o = data.meta?.options ?? {};
  lines.push(`Structure: ${o.starting ?? '—'} chips, blinds ${o.sb ?? '—'}/${o.bb ?? '—'}, hands/level ${o.handsPerLevel ?? '—'}, multiplier ${o.multiplier ?? '—'}`);
  const rows = [];
  for (const [architect, run] of Object.entries(data.runs ?? {})) {
    for (const [modelId, stat] of Object.entries(run.stats ?? {})) {
      rows.push([labelFor(modelId), architect, String(stat.decisions), String(stat.aggressionOpportunities), String(stat.aggressive), pct(stat.aggressive / Math.max(1, stat.aggressionOpportunities)), pct((stat.counts?.CHECK ?? 0) / Math.max(1, stat.decisions)), pct((stat.counts?.CALL ?? 0) / Math.max(1, stat.decisions)), pct((stat.counts?.FOLD ?? 0) / Math.max(1, stat.decisions)), String(stat.errors), String(stat.fallbacks)]);
    }
  }
  lines.push(table(['Model', 'Architecture', 'Decisions', 'Agg opps', 'Aggressive', 'Agg rate', 'Check', 'Call', 'Fold', 'Errors', 'Fallbacks'], rows));
  lines.push('');
  lines.push('_Win rate is not a conclusion at this sample size; the table reports decision behaviour only._');
  lines.push('');
} else {
  lines.push('## REAL TOURNAMENT BEHAVIOR');
  lines.push('_No tournament A/B JSON found._');
  lines.push('');
}

lines.push('## FAIRNESS VERIFICATION');
lines.push('- One canonical family set per engine state (`legalActionFamilies`).');
lines.push('- One deterministic, engine-validated sizing set per family (`legalAggressiveSizes`).');
lines.push('- Jev and chat schemas expose exactly the same family and size enums (offline test).');
lines.push('- Strategy/Raw benchmark mode is tournament-wide and deterministic (offline test).');
lines.push('- Opponent hole cards and opponent hand evaluations are never exposed (offline test).');
lines.push('- Spectator explanations are isolated from the decision contract and latency (production design + tests).');
lines.push('');
lines.push('_No API key is present in this report._');

await writeFile(outPath, lines.join('\n'));
console.log(`Wrote ${outPath}`);
