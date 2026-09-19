// Pure diagnostic harness. It does not know how to talk to a provider; the
// real script injects adapters, and the offline test injects a deterministic
// mock. This keeps scoring, aggregation and reporting identical everywhere.
import { ACTION, resolveCriteriaKey, heroHandSummary, probabilityStats as coreProbabilityStats } from '../../src/lib/decision-core.js';

export const AGGRESSIVE_TYPES = new Set([ACTION.BET, ACTION.RAISE]);

export function actionsForScenario(scenario) {
  if (scenario?.kind === 'action' && Array.isArray(scenario.state?.legalActions) && scenario.state.legalActions.length) {
    return scenario.state.legalActions.map(a => ({ id: a.id, type: a.type, amount: a.amount ?? null, description: a.description ?? a.type ?? a.id }));
  }
  const criteria = scenario?.criteria ?? {};
  return Object.entries(criteria).map(([id, description]) => ({ id, type: null, amount: null, description }));
}

export function scenarioHasAggression(scenario) {
  return actionsForScenario(scenario).some(a => AGGRESSIVE_TYPES.has(a.type));
}

export function resolveActionForScenario(scenario, key, keyMode = 'opaque') {
  const actions = actionsForScenario(scenario);
  const direct = actions.find(a => a.id === key);
  if (direct) return direct;
  if (keyMode === 'semantic') return resolveCriteriaKey(actions, key) ?? actions.find(a => a.id === key) ?? null;
  return null;
}

export function scoreResult(scenario, { key, keyMode = 'opaque' }) {
  if (scenario.kind === 'action') {
    const action = resolveActionForScenario(scenario, key, keyMode);
    if (!action) return { correct: false, actionType: null, actionAmount: null, actionDescription: null };
    const typesOk = (scenario.expectedTypes ?? []).includes(action.type);
    const amountOk = scenario.expectedAmountType === 'all-in'
      ? Number(action.amount) >= Number(scenario.state?.hero?.stack ?? scenario.state?.stack ?? 0)
      : (scenario.expectedAmount == null || Number(action.amount) === Number(scenario.expectedAmount));
    return { correct: Boolean(typesOk && amountOk), actionType: action.type, actionAmount: action.amount ?? null, actionDescription: action.description ?? null };
  }
  const expected = scenario.expectedKeys ?? [];
  return { correct: expected.includes(String(key)), actionType: null, actionAmount: null, actionDescription: null };
}

// Hierarchical adapters resolve their final action themselves (family + size).
// Score that resolved action directly instead of looking up a flat action id.
export function scoreProvidedAction(scenario, { actionType, actionAmount }) {
  if (scenario.kind !== 'action') return { correct: false, actionType: actionType ?? null, actionAmount: actionAmount ?? null };
  const typesOk = (scenario.expectedTypes ?? []).includes(actionType);
  const amountOk = scenario.expectedAmountType === 'all-in'
    ? Number(actionAmount) >= Number(scenario.state?.hero?.stack ?? scenario.state?.stack ?? 0)
    : (scenario.expectedAmount == null || Number(actionAmount) === Number(scenario.expectedAmount));
  return { correct: Boolean(typesOk && amountOk), actionType: actionType ?? null, actionAmount: actionAmount ?? null };
}

function probabilityStats(probabilities, key) {
  // Delegates to the canonical, domain-labelled implementation so reports never
  // confuse flat action entropy with family entropy.
  const stats = coreProbabilityStats(probabilities, key, { domain: 'flat_action' });
  return {
    domain: stats.domain,
    selectedProbability: stats.selectedProbability,
    topProbability: stats.topProbability,
    topKey: stats.topKey,
    margin: stats.gap,
    gap: stats.gap,
    entropy: stats.entropy,
    entropyBits: stats.entropyBits,
  };
}

// Runs the full adapter × scenario × representation × repetition matrix with a
// hard cap on model calls. Failures are recorded, never allowed to kill a run.
export async function runSuite({ adapters, scenarios, representations = [], repetitions = 1, cap = Infinity, delayMs = 0, onProgress = () => {}, signal = null, questionMode = 'action+aggression+bluff', label = null, architecture = 'flat' } = {}) {
  const results = [];
  let calls = 0;
  let stopped = false;
  const totalPlanned = adapters.length * scenarios.length * Math.max(1, representations.length) * repetitions;
  const wait = ms => new Promise(r => setTimeout(r, ms));
  outer:
  for (const adapter of adapters) {
    for (const scenario of scenarios) {
      const actions = actionsForScenario(scenario);
      if (!actions.length) continue;
      for (const representation of representations.length ? representations : [null]) {
        for (let repetition = 1; repetition <= repetitions; repetition++) {
          if (signal?.aborted) { stopped = true; break outer; }
          if (calls >= cap) { stopped = true; break outer; }
          calls++;
          const started = Date.now();
          // Build the representation before the request so the adapter sends
          // exactly the bytes we score. A callable representation lets the
          // context ablation reuse the same harness.
          const built = representation?.build ? representation.build(scenario.state, actions) : { jevState: scenario.state, chatText: JSON.stringify(scenario.state), keyMode: 'opaque' };
          const keyMode = built.keyMode ?? representation?.keyMode ?? 'opaque';
          let raw = null;
          let error = null;
          try {
            raw = await adapter.run({ adapter, scenario, representation, actions, repetition, questionMode, signal, built, keyMode, architecture });
          } catch (err) {
            error = err?.message ? String(err.message).slice(0, 400) : String(err).slice(0, 400);
          }
          const key = raw?.key ?? null;
          const scored = error
            ? { correct: false, actionType: null, actionAmount: null, actionDescription: null }
            : (raw?.actionType != null
              ? { ...scoreProvidedAction(scenario, raw), actionDescription: raw.actionDescription ?? null }
              : scoreResult(scenario, { key, keyMode }));
          const probStats = probabilityStats(raw?.probabilities, key);
          const probabilityTypeMass = {};
          for (const [probKey, value] of Object.entries(raw?.probabilities ?? {})) {
            const resolved = resolveActionForScenario(scenario, probKey, keyMode);
            const typeKey = resolved?.type ?? 'OTHER';
            probabilityTypeMass[typeKey] = (probabilityTypeMass[typeKey] ?? 0) + (Number(value) || 0);
          }
          results.push({
            scenarioId: scenario.id, layer: scenario.layer, kind: scenario.kind, strict: Boolean(scenario.strict),
            title: scenario.title, category: scenario.category,
            menu: scenario.menu ?? null,
            adapterId: adapter.id, adapterName: adapter.name ?? adapter.id, model: adapter.model, protocol: adapter.protocol ?? null,
            architecture,
            representationId: representation?.id ?? 'canonical', representationName: representation?.name ?? 'Canonical',
            contextVariantId: representation?.contextVariantId ?? null,
            repetition, key, keyMode,
            expectedLabel: scenario.expectedLabel ?? null,
            ...scored, ...probStats,
            aggression: raw?.aggression ?? null, bluffSpot: raw?.bluffSpot ?? null, confidence: raw?.confidence ?? null,
            usage: raw?.usage ?? null, latencyMs: raw?.latencyMs ?? (Date.now() - started),
            primaryDecisionLatencyMs: raw?.primaryDecisionLatencyMs ?? raw?.latencyMs ?? (Date.now() - started),
            probabilities: raw?.probabilities ?? null,
            familyChoice: raw?.familyChoice ?? null, sizeChoice: raw?.sizeChoice ?? null,
            familyProbabilities: raw?.familyProbabilities ?? null, sizeProbabilities: raw?.sizeProbabilities ?? null,
            familyConfidence: raw?.familyConfidence ?? null, sizeConfidence: raw?.sizeConfidence ?? null,
            familyStats: raw?.familyStats ?? null, sizeStats: raw?.sizeStats ?? null,
            probabilityTypeMass,
            questionMode: raw?.questionMode ?? questionMode,
            error,
            deterministicHand: scenario.deterministicHand ?? null,
          });
          onProgress({ calls, totalPlanned, adapter: adapter.id, scenario: scenario.id, representation: representation?.id ?? 'canonical', repetition, correct: results.at(-1).correct, error });
          if (delayMs && calls < cap && !signal?.aborted) await wait(delayMs);
        }
      }
    }
  }
  return { results, calls, totalPlanned, stopped, label };
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------
export function aggregate(rows) {
  const total = rows.length;
  const correct = rows.filter(r => r.correct).length;
  const errors = rows.filter(r => r.error).length;
  const aggressiveChoices = rows.filter(r => AGGRESSIVE_TYPES.has(r.actionType)).length;
  const aggressionOpportunities = rows.filter(r => r.kind === 'action' && !r.error && ['BET', 'CALL', 'CHECK', 'FOLD', 'RAISE'].includes(String(r.actionType)));
  const latencies = rows.map(r => Number(r.latencyMs)).filter(Number.isFinite).sort((a, b) => a - b);
  const primaryLatencies = rows.map(r => Number(r.primaryDecisionLatencyMs)).filter(Number.isFinite).sort((a, b) => a - b);
  const usageIn = rows.reduce((s, r) => s + Number(r.usage?.prompt_tokens ?? r.usage?.input_tokens ?? 0), 0);
  const usageOut = rows.reduce((s, r) => s + Number(r.usage?.completion_tokens ?? r.usage?.output_tokens ?? 0), 0);
  const selected = rows.map(r => r.selectedProbability).filter(v => Number.isFinite(v));
  const familyMasses = rows.filter(r => r.familyStats).map(r => r.familyStats.aggressiveMass).filter(v => Number.isFinite(v));
  const gaps = rows.map(r => (r.familyStats ? r.familyStats.gap : r.gap)).filter(v => Number.isFinite(v));
  return {
    total, correct, errors,
    accuracy: total ? correct / total : 0,
    actionCounts: countBy(rows.filter(r => r.kind === 'action'), r => r.actionType ?? 'ERROR'),
    familyCounts: countBy(rows.filter(r => r.familyChoice), r => r.familyChoice),
    sizeCounts: countBy(rows.filter(r => r.sizeChoice), r => r.sizeChoice),
    aggressiveChoices,
    aggressiveRate: aggressionOpportunities.length ? aggressiveChoices / aggressionOpportunities.length : null,
    aggressionOpportunities: aggressionOpportunities.length,
    selectedProbabilityMean: selected.length ? selected.reduce((a, b) => a + b, 0) / selected.length : null,
    meanAggressiveFamilyMass: familyMasses.length ? familyMasses.reduce((a, b) => a + b, 0) / familyMasses.length : null,
    meanTopSecondGap: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
    latencyMean: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null,
    latencyMedian: median(latencies),
    latencyP95: percentile(latencies, 0.95),
    primaryLatencyMean: primaryLatencies.length ? primaryLatencies.reduce((a, b) => a + b, 0) / primaryLatencies.length : null,
    usageIn, usageOut,
  };
}
export function countBy(rows, keyFn) {
  const out = {};
  for (const row of rows) { const key = String(keyFn(row)); out[key] = (out[key] ?? 0) + 1; }
  return out;
}
export function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}
export function median(sorted) { if (!sorted.length) return null; const mid = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2; }
export function percentile(sorted, p) { if (!sorted.length) return null; const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1)); return sorted[idx]; }

// ---------------------------------------------------------------------------
// Markdown report
// ---------------------------------------------------------------------------
function pctText(v) { return Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—'; }
function msText(v) { return Number.isFinite(v) ? `${Math.round(v)}ms` : '—'; }
function esc(v) { return String(v ?? '').replace(/\|/g, '\\|'); }
function table(headers, rows) {
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(r => `| ${r.join(' | ')} |`)].join('\n');
}

export function strictMatrix(results, scenarios, adapters) {
  const rows = scenarios.map(scenario => {
    const cells = adapters.map(adapter => {
      const rowsFor = results.filter(r => r.scenarioId === scenario.id && r.adapterId === adapter.id);
      if (!rowsFor.length) return '—';
      const correct = rowsFor.filter(r => r.correct).length;
      const errors = rowsFor.filter(r => r.error).length;
      return `${correct}/${rowsFor.length}${errors ? ` (${errors} err)` : ''}`;
    });
    return [esc(scenario.title), ...cells];
  });
  return table(['Scenario', ...adapters.map(a => esc(a.name ?? a.id))], rows);
}

export function representationTable(results, adapters, { layers = null } = {}) {
  const sections = [];
  for (const adapter of adapters) {
    let rows = results.filter(r => r.adapterId === adapter.id && r.representationId);
    if (layers) rows = rows.filter(r => layers.includes(r.layer));
    const groups = groupBy(rows, r => `${r.representationId}|${r.representationName}`);
    const body = [...groups.entries()].map(([key, group]) => {
      const [id, name] = key.split('|');
      const agg = aggregate(group);
      return [esc(name), id === 'semantic-keys' ? 'semantic' : 'opaque', pctText(agg.accuracy), pctText(agg.aggressiveRate), msText(agg.latencyMean), String(agg.errors)];
    });
    sections.push(`### ${esc(adapter.name ?? adapter.id)}\n\n${table(['Representation', 'Keys', 'Accuracy', 'Aggressive-choice rate', 'Latency', 'Errors'], body)}`);
  }
  return sections.join('\n\n');
}

export function contextTable(results, adapters) {
  return adapters.map(adapter => {
    const rows = results.filter(r => r.adapterId === adapter.id && r.contextVariantId);
    const groups = groupBy(rows, r => r.contextVariantId);
    const body = [...groups.entries()].map(([id, group]) => {
      const agg = aggregate(group);
      return [esc(id), pctText(agg.accuracy), pctText(agg.aggressiveRate), msText(agg.latencyMean), String(agg.errors)];
    });
    return `### ${esc(adapter.name ?? adapter.id)}\n\n${table(['Context variant', 'Accuracy', 'Aggressive-choice rate', 'Latency', 'Errors'], body)}`;
  }).join('\n\n');
}

export function questionAblationTable(results, jevAdapter) {
  const rows = results.filter(r => r.adapterId === jevAdapter.id && r.questionMode);
  const groups = groupBy(rows, r => r.questionMode);
  const body = [...groups.entries()].map(([mode, group]) => {
    const agg = aggregate(group);
    return [esc(mode), pctText(agg.accuracy), pctText(agg.aggressiveRate), msText(agg.latencyMean), String(agg.errors)];
  });
  return table(['Questions', 'Accuracy', 'Aggressive-choice rate', 'Latency', 'Errors'], body);
}

export function probabilityMassTable(results, adapters) {
  return adapters.map(adapter => {
    const rows = results.filter(r => r.adapterId === adapter.id && r.kind === 'action' && r.probabilities);
    const groups = groupBy(rows, r => r.scenarioId);
    const body = [...groups.entries()].map(([scenarioId, group]) => {
      const first = group[0];
      const passiveMass = group.reduce((s, r) => s + passiveFromTypes(r.probabilityTypeMass), 0) / Math.max(1, group.length);
      const aggressiveMass = group.reduce((s, r) => s + aggressiveFromTypes(r.probabilityTypeMass), 0) / Math.max(1, group.length);
      const probRows = group.filter(r => Number.isFinite(r.selectedProbability));
      const marginRows = group.filter(r => Number.isFinite(r.margin));
      return [
        esc(first.title), first.expectedLabel ?? '—',
        pctText(probRows.length ? probRows.reduce((s, r) => s + r.selectedProbability, 0) / probRows.length : null),
        pctText(passiveMass),
        pctText(aggressiveMass),
        pctText(marginRows.length ? marginRows.reduce((s, r) => s + r.margin, 0) / marginRows.length : null),
      ];
    });
    return `### ${esc(adapter.name ?? adapter.id)}\n\n${table(['Scenario', 'Expected', 'Selected prob', 'Passive mass', 'Aggressive mass', 'Top−selected'], body)}`;
  }).join('\n\n');
}
function passiveFromTypes(mass = {}) {
  return [ACTION.CHECK, ACTION.CALL, ACTION.FOLD].reduce((s, t) => s + (Number(mass[t]) || 0), 0);
}
function aggressiveFromTypes(mass = {}) {
  return [ACTION.BET, ACTION.RAISE].reduce((s, t) => s + (Number(mass[t]) || 0), 0);
}

// Section 37 — model × architecture behavior table.
export function architectureComparisonTable(results, architectures = ['flat', 'hierarchical']) {
  const keys = [...new Set(results.filter(r => r.kind === 'action' && !r.error).map(r => `${r.adapterId}|${r.architecture}`))];
  const rows = [];
  for (const key of keys) {
    const [adapterId, architecture] = key.split('|');
    if (!architectures.includes(architecture)) continue;
    const group = results.filter(r => r.adapterId === adapterId && r.architecture === architecture && r.kind === 'action' && !r.error);
    if (!group.length) continue;
    const agg = aggregate(group);
    rows.push([
      esc(group[0].adapterName), architecture, String(agg.aggressionOpportunities), String(agg.aggressiveChoices),
      pctText(agg.aggressiveRate), pctText(agg.actionCounts.CHECK != null ? agg.actionCounts.CHECK / agg.total : null),
      pctText(agg.actionCounts.CALL != null ? agg.actionCounts.CALL / agg.total : null),
      pctText(agg.actionCounts.FOLD != null ? agg.actionCounts.FOLD / agg.total : null),
      msText(agg.primaryLatencyMean ?? agg.latencyMean), String(agg.errors),
    ]);
  }
  return table(['Model', 'Architecture', 'Agg opportunities', 'Aggressive', 'Agg rate', 'Check rate', 'Call rate', 'Fold rate', 'Mean latency', 'Errors'], rows);
}

// Section 17/37 — Jev family-probability telemetry under each architecture.
export function jevFamilyTelemetryTable(results) {
  const adapterKeys = [...new Set(results.filter(r => r.familyStats).map(r => r.adapterId))];
  const sections = adapterKeys.map(adapterId => {
    const rowsFor = results.filter(r => r.adapterId === adapterId && r.familyStats);
    const body = ['flat', 'hierarchical'].map(architecture => {
      const group = rowsFor.filter(r => r.architecture === architecture);
      if (!group.length) return null;
      const mean = key => { const vals = group.map(r => Number(r.familyStats?.[key])).filter(Number.isFinite); return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null; };
      return [
        architecture,
        pctText(mean('aggressiveMass')),
        pctText(mean('selectedProbability')),
        pctText(mean('gap')),
        Number.isFinite(mean('entropy')) ? mean('entropy').toFixed(2) : '—',
      ];
    }).filter(Boolean);
    return `### ${esc(rowsFor[0].adapterName)}\n\n${table(['Architecture', 'Mean aggressive family mass', 'Selected family prob', 'Top−second gap', 'Family entropy (bits)'], body)}`;
  });
  return sections.length ? sections.join('\n\n') : '_No family probability telemetry._';
}

// Section 17 — fragmentation diagnostic table.
export function fragmentationTable(results) {
  const menus = [...new Set(results.map(r => r.menu).filter(Boolean))];
  const adapterKeys = [...new Set(results.filter(r => r.menu).map(r => r.adapterId))];
  const body = [];
  for (const adapterId of adapterKeys) {
    for (const menu of menus) {
      const group = results.filter(r => r.adapterId === adapterId && r.menu === menu);
      if (!group.length) continue;
      const agg = aggregate(group);
      body.push([esc(group[0].adapterName), esc(menu), String(agg.aggressionOpportunities), pctText(agg.aggressiveRate), pctText(agg.actionCounts.CHECK != null ? agg.actionCounts.CHECK / agg.total : null), pctText(agg.meanAggressiveFamilyMass), pctText(agg.meanTopSecondGap), msText(agg.primaryLatencyMean ?? agg.latencyMean), String(agg.errors)]);
    }
  }
  return table(['Model', 'Menu', 'Agg opportunities', 'Aggressive rate', 'Check rate', 'Mean agg family mass', 'Top−second gap', 'Latency', 'Errors'], body);
}
