#!/usr/bin/env node
// Offline analysis of a real tournament log (Part 7).
//
//   node tests/analysis/diagnostics-analyze.mjs logs/real-run-XXXX/tournament.jsonl [--out logs/analysis.md]
//
// Computes passive/aggressive frequencies, aggression opportunities, street and
// stack-depth breakdowns, deterministic hand-strength buckets, and (for Jev)
// probability mass / confidence / top-vs-second diagnostics. No API calls.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { heroHandCategory, aggregateActionProbabilitiesByFamily, familyForActionType } from '../../src/lib/decision-core.js';

const args = process.argv.slice(2);
const input = args.find(a => !a.startsWith('--'));
const outFlag = args.indexOf('--out');
const outPath = outFlag >= 0 ? args[outFlag + 1] : null;
if (!input) { console.error('Usage: node tests/analysis/diagnostics-analyze.mjs <tournament.jsonl> [--out report.md]'); process.exit(1); }

const events = (await readFile(input, 'utf8')).split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
const decisions = events.filter(e => e.type === 'DECISION');
if (!decisions.length) { console.error('No DECISION events found.'); process.exit(1); }

const AGGRESSIVE = /^(Bet|Raise)\b/i;
const PASSIVE = /^(Check|Call|Fold)\b/i;
function labelOf(event, id) {
  if (id === event.action?.id) return event.action?.description ?? '';
  return (event.legalActions ?? []).find(a => a.id === id)?.description ?? '';
}
function isAggressiveLabel(label) { return AGGRESSIVE.test(String(label || '')); }
function isPassiveLabel(label) { return PASSIVE.test(String(label || '')); }
function handStrength(event) {
  const hero = event.replay?.hero?.cards ?? event.replay?.heroCards ?? [];
  const board = event.replay?.board ?? [];
  if (hero.length !== 2 || board.length < 3) return null;
  const hand = heroHandCategory(hero, board);
  return hand?.key ?? null;
}
function stackBucket(event) {
  const bb = Number(event.replay?.hero?.stackBB ?? event.replay?.betting?.stackBB ?? event.stackBB);
  if (!Number.isFinite(bb)) return 'unknown';
  if (bb < 10) return '<10 BB';
  if (bb < 25) return '10–25 BB';
  if (bb < 50) return '25–50 BB';
  if (bb < 100) return '50–100 BB';
  return '>100 BB';
}

const byModel = new Map();
for (const event of decisions) {
  const model = event.configuredModel || event.resolvedModel || event.playerName || 'unknown';
  if (!byModel.has(model)) byModel.set(model, { model, decisions: 0, counts: { CHECK: 0, CALL: 0, FOLD: 0, BET: 0, RAISE: 0, OTHER: 0 }, opportunities: 0, aggressive: 0, byStreet: new Map(), byStack: new Map(), byHand: new Map(), probAggressiveMass: 0, probPassiveMass: 0, familyAggMassTotal: 0, familyAggMassCount: 0, selectedProb: [], confidence: [], gaps: [], errors: 0, forced: 0 });
  const row = byModel.get(model);
  row.decisions++;
  const type = String(event.action?.type || 'OTHER');
  row.counts[type] = (row.counts[type] ?? 0) + 1;
  const opportunity = (event.legalActions ?? []).some(a => isAggressiveLabel(a.description)) || AGGRESSIVE.test(String(event.action?.description || ''));
  if (opportunity) row.opportunities++;
  if (type === 'BET' || type === 'RAISE') row.aggressive++;
  for (const [bucketMap, key] of [[row.byStreet, String(event.street || '—')], [row.byStack, stackBucket(event)], [row.byHand, handStrength(event) ?? 'unavailable']]) {
    if (!bucketMap.has(key)) bucketMap.set(key, { decisions: 0, aggressive: 0, passive: 0 });
    const cell = bucketMap.get(key);
    cell.decisions++;
    if (type === 'BET' || type === 'RAISE') cell.aggressive++; else cell.passive++;
  }
  if (event.forced) row.forced++;
  if (event.errorCategory || event.error) row.errors++;
  const probs = event.decisionMeta?.probabilities;
  if (probs && typeof probs === 'object') {
    // Legacy flat probabilities are aggregated into action families so CHECK,
    // CALL, FOLD, BET and RAISE stay comparable regardless of how many bet
    // sizes the historical arena exposed. The selected action is unchanged.
    const familyMass = event.decisionMeta?.family?.probabilities
      ? event.decisionMeta.family.probabilities
      : aggregateActionProbabilitiesByFamily(probs, event.legalActions, { labelResolver: id => ({ description: labelOf(event, id) }) });
    row.familyAggMassTotal += (Number(familyMass.bet) || 0) + (Number(familyMass.raise) || 0);
    row.familyAggMassCount++;
    const aggressiveMass = (Number(familyMass.bet) || 0) + (Number(familyMass.raise) || 0);
    const passiveMass = ['check', 'call', 'fold', 'other'].reduce((s, k) => s + (Number(familyMass[k]) || 0), 0);
    row.probAggressiveMass += aggressiveMass;
    row.probPassiveMass += passiveMass;
    const selected = Number(probs[event.action?.id]);
    if (Number.isFinite(selected)) row.selectedProb.push(selected);
    const sorted = Object.values(probs).map(Number).filter(Number.isFinite).sort((a, b) => b - a);
    if (sorted.length >= 2) row.gaps.push(sorted[0] - sorted[1]);
  }
  const confidence = event.decisionMeta?.confidence;
  if (Number.isFinite(Number(confidence))) row.confidence.push(Number(confidence));
}

function pct(n, d) { return d > 0 ? `${Math.round((n / d) * 100)}%` : '—'; }
function avg(list) { return list.length ? list.reduce((a, b) => a + b, 0) / list.length : null; }
function fmtAvg(list) { const v = avg(list); return v == null ? '—' : `${Math.round(v * 100)}%`; }
function bucketTable(map) {
  return [...map.entries()].map(([key, cell]) => `| ${key} | ${cell.decisions} | ${pct(cell.aggressive, cell.decisions)} | ${pct(cell.passive, cell.decisions)} |`).join('\n');
}
function confidenceBuckets(list) {
  const buckets = { '0–25%': 0, '25–50%': 0, '50–75%': 0, '75–100%': 0 };
  for (const value of list) {
    if (value < 0.25) buckets['0–25%']++;
    else if (value < 0.5) buckets['25–50%']++;
    else if (value < 0.75) buckets['50–75%']++;
    else buckets['75–100%']++;
  }
  return Object.entries(buckets).map(([k, v]) => `${k}: ${v}`).join(' · ');
}

const sections = [];
for (const row of byModel.values()) {
  const total = row.decisions;
  sections.push(`## ${row.model}`);
  sections.push('');
  sections.push(`- Decisions: **${total}** · aggression opportunities: **${row.opportunities}** · aggressive actions: **${row.aggressive}** (${pct(row.aggressive, row.opportunities)})`);
  sections.push(`- CHECK ${pct(row.counts.CHECK, total)} · CALL ${pct(row.counts.CALL, total)} · FOLD ${pct(row.counts.FOLD, total)} · BET ${pct(row.counts.BET, total)} · RAISE ${pct(row.counts.RAISE, total)}`);
  sections.push(`- Forced fallbacks: ${row.forced} · errors: ${row.errors}`);
  if (row.selectedProb.length || row.confidence.length) {
    sections.push(`- Probability mass to aggressive: **${fmtAvg([row.probAggressiveMass / Math.max(1, total)])}** · to passive: **${fmtAvg([row.probPassiveMass / Math.max(1, total)])}**`);
    if (row.familyAggMassCount) sections.push(`- Aggregated from legacy flat action probabilities → mean aggressive family mass: **${fmtAvg([row.familyAggMassTotal / row.familyAggMassCount])}**`);
    sections.push(`- Mean selected-action probability: **${fmtAvg(row.selectedProb)}** · mean top−second gap: **${fmtAvg(row.gaps)}**`);
    sections.push(`- Confidence distribution: ${confidenceBuckets(row.confidence)} (mean ${fmtAvg(row.confidence)})`);
  }
  sections.push('');
  sections.push('### By street');
  sections.push('| Street | Decisions | Aggressive | Passive |');
  sections.push('| --- | --- | --- | --- |');
  sections.push(bucketTable(row.byStreet));
  sections.push('');
  sections.push('### By stack depth');
  sections.push('| Stack | Decisions | Aggressive | Passive |');
  sections.push('| --- | --- | --- | --- |');
  sections.push(bucketTable(row.byStack));
  sections.push('');
  sections.push('### By deterministic hand strength (postflop)');
  sections.push('| Hand | Decisions | Aggressive | Passive |');
  sections.push('| --- | --- | --- | --- |');
  sections.push(bucketTable(row.byHand));
  sections.push('');
}

const report = [
  '# Tournament decision analysis',
  '',
  `Source: ${input}`,
  `Events: ${events.length} · decisions: ${decisions.length}`,
  '',
  '> Saved legal actions do not always carry the action type, so aggression is inferred from the saved description (Bet/Raise vs Check/Call/Fold). Older logs without a replay snapshot cannot contribute hand-strength or stack buckets.',
  '',
  ...sections,
].join('\n');

if (outPath) {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, report);
  console.log(`Wrote ${outPath}`);
}
console.log(report);
