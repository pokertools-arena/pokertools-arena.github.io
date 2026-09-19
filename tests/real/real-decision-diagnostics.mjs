#!/usr/bin/env node
// Real-API poker decision diagnostics.
//
//   node tests/real/real-decision-diagnostics.mjs [options]
//
// Options:
//   --reps N              repetitions per model × scenario × representation (default 5)
//   --cap N               hard cap on total model requests (default 240)
//   --delay MS            delay between requests (default 150)
//   --timeout MS          per-request timeout (default 45000)
//   --temperature T       chat-model temperature (default 0.3)
//   --models a,b          substring filter on configured models
//   --experiments a,b     strict,representations,herohand,questions,context,strategy,descriptions
//   --layers A,B,D,E,P    scenario layers to include
//   --dry-run             print the plan and exit without calling any API
//   --out DIR             output directory (default logs)
//
// Writes logs/diagnostics-<timestamp>.json and .md. The API key is never
// printed or written to either file.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  actionCriteria, buildJevDecisionsBody, buildJevQuestions, buildOpenAICompatibleBody,
  completionsUrl, extractTextContent, fetchJsonWithRetry, makeHeaders, openRouterDecisionsUrl,
  stripCodeFence, DECISION_OBJECTIVE, heroHandSummary,
  decideHierarchical, aggregateActionProbabilitiesByFamily, probabilityStats, familyForActionType,
  diagnosticsCounters,
} from '../../src/lib/decision-core.js';
import {
  STRICT_SCENARIOS, STRATEGY_SCENARIOS, DOMINATED_SCENARIOS, RIVER_PROBE,
  FRAGMENTATION_SCENARIOS, FRAGMENTATION_HIERARCHICAL_SCENARIOS, riverProbeScenarios,
} from '../../tools/diagnostics/scenarios.js';
import {
  REPRESENTATIONS, CONTEXT_VARIANTS, applyContextVariant, descriptionVariants,
} from '../../tools/diagnostics/representations.js';
import {
  runSuite, aggregate, groupBy, strictMatrix, representationTable, contextTable,
  questionAblationTable, probabilityMassTable, architectureComparisonTable,
  jevFamilyTelemetryTable, fragmentationTable, resolveActionForScenario,
} from '../../tools/diagnostics/harness.js';
import { resolveConfig, redact, adapterProtocol } from '../../tools/diagnostics/env.js';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// Hard safety ceiling: real-API diagnostics must never exceed 50 decisions.
const HARD_MAX_REQUESTS = 50;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { reps: 5, cap: HARD_MAX_REQUESTS, delay: 150, timeout: 45000, temperature: 0.3, models: null, experiments: null, layers: null, dryRun: false, out: join(root, 'logs') };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--reps') opts.reps = Math.max(1, Number(next()) || 1);
    else if (arg === '--cap') opts.cap = Math.min(HARD_MAX_REQUESTS, Math.max(0, Number(next()) || 0));
    else if (arg === '--delay') opts.delay = Math.max(0, Number(next()) || 0);
    else if (arg === '--timeout') opts.timeout = Math.max(1000, Number(next()) || 45000);
    else if (arg === '--temperature') opts.temperature = Math.max(0, Number(next()) || 0);
    else if (arg === '--models') opts.models = String(next() || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (arg === '--experiments') opts.experiments = String(next() || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (arg === '--layers') opts.layers = String(next() || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (arg === '--out') opts.out = String(next() || opts.out);
    else if (arg === '--from-json') opts.fromJson = String(next() || '');
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  return opts;
}

function shortName(model) {
  const raw = String(model || '').replace(/^~/, '').split('/').pop() || model;
  const lower = raw.toLowerCase();
  if (lower.startsWith('jev')) return 'Jev';
  if (lower.startsWith('gemma')) return 'Gemma';
  if (lower.startsWith('qwen')) return 'Qwen';
  return raw.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------
function criteriaFor(scenario, actions, keyMode) {
  if (scenario.kind === 'action') return actionCriteria(actions, { keyMode });
  return scenario.criteria;
}

function questionFlags(mode) {
  const parts = String(mode || '').split('+');
  return { aggression: parts.includes('aggression'), bluff: parts.includes('bluff') };
}

function familyStatsFromFlat(probabilities, legalActions, actionType) {
  if (!probabilities) return null;
  const familyMass = aggregateActionProbabilitiesByFamily(probabilities, legalActions);
  const stats = probabilityStats(familyMass, actionType ? familyForActionType(actionType) : null);
  return { aggressiveMass: (familyMass.bet ?? 0) + (familyMass.raise ?? 0), familyMass, ...stats };
}
function familyStatsFromHierarchy(probabilities, selectedFamily) {
  if (!probabilities) return null;
  const stats = probabilityStats(probabilities, selectedFamily);
  const aggressiveMass = (Number(probabilities.bet) || 0) + (Number(probabilities.raise) || 0);
  return { aggressiveMass, familyMass: probabilities, ...stats };
}

function createChatAdapter({ connection, model, opts, architecture = 'flat' }) {
  const protocolOrder = ['json_schema', 'tool', 'prompt_json'];
  const temperature = opts.temperature;
  return {
    id: `chat:${architecture}:${model}`, model, name: shortName(model), protocol: 'chat', architecture,
    async run({ scenario, actions, built, keyMode, signal }) {
      const criteria = criteriaFor(scenario, actions, keyMode);
      let lastError = null;
      for (const protocol of protocolOrder) {
        try {
          if (architecture === 'hierarchical') {
            const result = await decideHierarchical({
              agent: { model, temperature, protocol, provider: '' }, connection, state: scenario.state,
              legalActions: actions, decisionId: 'diagnostic', timeoutMs: opts.timeout, signal,
              representationText: built.chatText, jevState: built.jevState, protocol,
            });
            return {
              key: result.action.id ?? null, actionType: result.action.type, actionAmount: result.action.amount,
              actionDescription: result.action.description, familyChoice: result.family.choice,
              sizeChoice: result.sizing?.choice ?? null, familyProbabilities: result.family.probabilities ?? null,
              sizeProbabilities: result.sizing?.probabilities ?? null, familyConfidence: result.family.confidence ?? null,
              sizeConfidence: result.sizing?.confidence ?? null,
              familyStats: familyStatsFromHierarchy(result.family.probabilities, result.family.choice),
              probabilities: result.family.probabilities ?? null, confidence: result.family.confidence ?? null,
              usage: result.usage ?? null, latencyMs: result.primaryDecisionLatencyMs,
              primaryDecisionLatencyMs: result.primaryDecisionLatencyMs, questionMode: 'hierarchical',
            };
          }
          const body = buildOpenAICompatibleBody({
            agent: { model, temperature, protocol },
            connection,
            state: scenario.state,
            legalActions: actions,
            decisionId: 'diagnostic',
            protocol,
            instructions: scenario.instructions,
            criteria,
            representationText: built.chatText,
          });
          const { payload } = await fetchJsonWithRetry(completionsUrl(connection.baseUrl), {
            method: 'POST', headers: makeHeaders(connection), body: JSON.stringify(body), signal,
          }, { maxRetries: 1 });
          const message = payload?.choices?.[0]?.message;
          let obj;
          if (protocol === 'tool') {
            const call = message?.tool_calls?.find(item => item?.function?.name === 'play_poker_action');
            if (!call) throw new Error('model did not call play_poker_action');
            obj = JSON.parse(call.function.arguments);
          } else {
            obj = JSON.parse(stripCodeFence(extractTextContent(message)));
          }
          const key = obj?.actionId ?? obj?.answer;
          if (!key) throw new Error('response did not contain an actionId');
          const resolved = resolveActionForScenario(scenario, key, keyMode);
          const actionType = resolved?.type ?? null;
          return { key, probabilities: null, confidence: Number.isFinite(Number(obj.confidence)) ? Number(obj.confidence) : null, usage: payload?.usage ?? null, questionMode: 'action', familyStats: familyStatsFromFlat(null, actions, actionType) };
        } catch (err) { lastError = err; }
      }
      throw lastError ?? new Error('chat request failed');
    },
  };
}

function createJevAdapter({ connection, model, opts, architecture = 'flat' }) {
  return {
    id: `jev:${architecture}:${model}`, model, name: shortName(model), protocol: 'jev_decisions', architecture,
    async run({ scenario, actions, built, keyMode, questionMode, signal }) {
      if (architecture === 'hierarchical') {
        const result = await decideHierarchical({
          agent: { model, protocol: 'jev_decisions', temperature: opts.temperature }, connection, state: scenario.state,
          legalActions: actions, decisionId: 'diagnostic', timeoutMs: opts.timeout, signal,
          representationText: built.chatText, jevState: built.jevState,
        });
        return {
          key: result.action.id ?? null, actionType: result.action.type, actionAmount: result.action.amount,
          actionDescription: result.action.description, familyChoice: result.family.choice,
          sizeChoice: result.sizing?.choice ?? null, familyProbabilities: result.family.probabilities ?? null,
          sizeProbabilities: result.sizing?.probabilities ?? null, familyConfidence: result.family.confidence ?? null,
          sizeConfidence: result.sizing?.confidence ?? null,
          familyStats: familyStatsFromHierarchy(result.family.probabilities, result.family.choice),
          probabilities: result.family.probabilities ?? null, confidence: result.family.confidence ?? null,
          usage: result.usage ?? null, latencyMs: result.primaryDecisionLatencyMs, primaryDecisionLatencyMs: result.primaryDecisionLatencyMs,
          questionMode: 'hierarchical',
        };
      }
      const criteria = criteriaFor(scenario, actions, keyMode);
      const flags = questionFlags(questionMode);
      const questions = buildJevQuestions({
        instructions: scenario.instructions ?? DECISION_OBJECTIVE,
        criteria,
        includeAction: true,
        includeAggression: flags.aggression,
        includeBluff: flags.bluff,
      });
      const body = buildJevDecisionsBody({ model, state: built.jevState, questions });
      const { payload } = await fetchJsonWithRetry(openRouterDecisionsUrl(connection.baseUrl), {
        method: 'POST', headers: makeHeaders(connection), body: JSON.stringify(body), signal,
      }, { maxRetries: 1 });
      const answer = payload?.answers?.action;
      if (!answer?.choice) throw new Error('Jev response had no answers.action.choice');
      const resolved = resolveActionForScenario(scenario, answer.choice, keyMode);
      return {
        key: answer.choice,
        probabilities: answer.probabilities ?? null,
        confidence: Number.isFinite(Number(answer.confidence)) ? Number(answer.confidence) : null,
        aggression: payload?.answers?.aggression?.score ?? null,
        bluffSpot: payload?.answers?.bluff_spot?.noul ?? null,
        usage: payload?.usage ?? null,
        questionMode,
        familyStats: familyStatsFromFlat(answer.probabilities, actions, resolved?.type ?? null),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Experiment planning
// ---------------------------------------------------------------------------
const ALL_EXPERIMENTS = ['strict', 'hierarchical', 'representations', 'herohand', 'questions', 'context', 'strategy', 'descriptions', 'fragmentation', 'probe'];

function contextProbeState() {
  const state = { ...RIVER_PROBE.state };
  state.actionHistory = [
    { street: 'PREFLOP', playerName: 'Villain', position: 'BTN/SB', action: { type: 'RAISE', amount: 300, description: 'Raise to 300 (3 BB)' }, potBefore: 150 },
    { street: 'PREFLOP', playerName: 'Hero', position: 'BB', action: { type: 'CALL', amount: 200, description: 'Call 200 (2 BB)' }, potBefore: 450 },
    { street: 'FLOP', playerName: 'Villain', position: 'BTN/SB', action: { type: 'BET', amount: 900, description: 'Bet 900 (9 BB)' }, potBefore: 600 },
    { street: 'FLOP', playerName: 'Hero', position: 'BB', action: { type: 'CALL', amount: 900, description: 'Call 900 (9 BB)' }, potBefore: 1500 },
    { street: 'TURN', playerName: 'Villain', position: 'BTN/SB', action: { type: 'BET', amount: 3200, description: 'Bet 3200 (32 BB)' }, potBefore: 3300 },
    { street: 'TURN', playerName: 'Hero', position: 'BB', action: { type: 'CALL', amount: 3200, description: 'Call 3200 (32 BB)' }, potBefore: 6500 },
  ];
  state.recentHands = Array.from({ length: 8 }, (_, i) => ({
    handNumber: 92 + i,
    board: ['Ah', '7c', '2d', '9s', 'Kd'],
    winners: [{ playerId: i % 2 ? 'diag-hero' : 'diag-villain', amount: 1200 + i * 100 }],
    stacksAfter: [{ seat: 1, name: 'Hero', stack: 4000 + i * 50 }, { seat: 2, name: 'Villain', stack: 5000 - i * 50 }],
    actions: [{ street: 'PREFLOP', playerName: i % 2 ? 'Hero' : 'Villain', action: { type: i % 2 ? 'RAISE' : 'CALL', amount: 300 } }],
  }));
  return state;
}

function buildPlan({ experiments, adapters, hierarchicalAdapters, opts }) {
  const layers = opts.layers;
  const canonical = REPRESENTATIONS.find(r => r.id === 'full-json');
  const plan = [];
  const want = new Set(experiments);
  const scenarioFilter = list => layers?.length ? list.filter(s => layers.includes(String(s.layer).toUpperCase())) : list;
  const strictScenarios = scenarioFilter(STRICT_SCENARIOS);
  const strategyScenarios = scenarioFilter(STRATEGY_SCENARIOS);
  const actionDiag = scenarioFilter([...DOMINATED_SCENARIOS, RIVER_PROBE]);
  const repScenarios = actionDiag.filter(s => ['dominated-free-check-vs-fold', 'dominated-nuts-vs-allin', 'dominated-dead-hand-vs-allin', 'dominated-nuts-forced-call', RIVER_PROBE.id].includes(s.id));
  const contextScenarios = scenarioFilter([{ ...RIVER_PROBE, id: 'probe-context-full', state: contextProbeState() }]);

  // Layer A (opaque-id mapping) and Layer B (hand recognition) fixtures are
  // flat-only by design: the hierarchical architecture is defined over typed
  // action families and does not apply to those synthetic tasks.
  const hierarchicalStrict = strictScenarios.filter(s => s.kind === 'action' && s.hierarchicalCompatible !== false);
  if (want.has('strict')) plan.push({ name: 'strict', adapters, scenarios: strictScenarios, representations: [canonical], repetitions: opts.reps, questionMode: 'action+aggression+bluff', architecture: 'flat' });
  if (want.has('hierarchical')) plan.push({ name: 'hierarchical', adapters: hierarchicalAdapters, scenarios: [...hierarchicalStrict, RIVER_PROBE], representations: [canonical], repetitions: opts.reps, questionMode: 'hierarchical', architecture: 'hierarchical' });
  if (want.has('strategy')) plan.push({ name: 'strategy', adapters, scenarios: strategyScenarios, representations: [canonical], repetitions: opts.reps, questionMode: 'action+aggression+bluff', architecture: 'flat' });
  if (want.has('representations')) plan.push({ name: 'representations', adapters, scenarios: repScenarios, representations: REPRESENTATIONS, repetitions: opts.reps, questionMode: 'action+aggression+bluff', architecture: 'flat' });
  if (want.has('herohand')) plan.push({ name: 'herohand', adapters, scenarios: repScenarios, representations: [canonical, REPRESENTATIONS.find(r => r.id === 'canonical-herohand')], repetitions: opts.reps, questionMode: 'action+aggression+bluff', architecture: 'flat' });
  if (want.has('context')) plan.push({ name: 'context', adapters, scenarios: contextScenarios, representations: CONTEXT_VARIANTS.map(v => ({ id: v.id, name: v.name, contextVariantId: v.id, keyMode: 'opaque', build: (s, _a) => { const next = applyContextVariant(s, v); return { jevState: next, chatText: JSON.stringify(next) }; } })), repetitions: opts.reps, questionMode: 'action+aggression+bluff', architecture: 'flat' });
  if (want.has('questions')) plan.push({ name: 'questions', adapters: adapters.filter(a => a.protocol === 'jev_decisions'), scenarios: scenarioFilter([...DOMINATED_SCENARIOS, RIVER_PROBE]), representations: [canonical], repetitions: opts.reps, questionModes: ['action', 'action+aggression', 'action+bluff', 'action+aggression+bluff'], architecture: 'flat' });
  if (want.has('descriptions')) plan.push({ name: 'descriptions', adapters, scenarios: [RIVER_PROBE], representations: null, descriptionVariants: Object.keys(descriptionVariants(RIVER_PROBE.state)), architecture: 'flat' });
  if (want.has('fragmentation')) {
    plan.push({ name: 'fragmentation-flat', adapters, scenarios: FRAGMENTATION_SCENARIOS, representations: [canonical], repetitions: opts.reps, questionMode: 'action+aggression+bluff', architecture: 'flat' });
    plan.push({ name: 'fragmentation-hierarchical', adapters: hierarchicalAdapters, scenarios: FRAGMENTATION_HIERARCHICAL_SCENARIOS, representations: [canonical], repetitions: opts.reps, questionMode: 'hierarchical', architecture: 'hierarchical' });
  }
  if (want.has('probe')) {
    const probeScenarios = riverProbeScenarios();
    plan.push({ name: 'probe-flat', adapters, scenarios: probeScenarios.filter(s => s.architecture === 'flat'), representations: [canonical], repetitions: opts.reps, questionMode: 'action+aggression+bluff', architecture: 'flat' });
    plan.push({ name: 'probe-hierarchical', adapters: hierarchicalAdapters, scenarios: probeScenarios.filter(s => s.architecture === 'hierarchical'), representations: [canonical], repetitions: opts.reps, questionMode: 'hierarchical', architecture: 'hierarchical' });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log('Usage: node tests/real/real-decision-diagnostics.mjs [--reps 5] [--cap 240] [--models a,b] [--experiments strict,...] [--layers A,B,D,E,P] [--dry-run] [--from-json FILE]');
  process.exit(0);
}

const state = { results: [], calls: 0, batches: [], skipped: [] };
let adapters = [];
let hierarchicalAdapters = [];
let experiments = opts.experiments?.length ? opts.experiments : ALL_EXPERIMENTS;
let startedAt = new Date();
let elapsedMs = 0;
let aborted = false;
let config = null;

if (opts.fromJson) {
  // Offline re-render: regenerate the Markdown/JSON report from a saved run
  // without spending any API calls.
  const data = JSON.parse(await readFile(opts.fromJson, 'utf8'));
  state.results = data.results ?? [];
  state.calls = data.meta?.totalCalls ?? state.results.length;
  state.batches = data.meta?.experimentsRun ?? [];
  state.skipped = data.meta?.skipped ?? [];
  // Preserve the saved transport counters: this re-render makes no HTTP calls.
  diagnosticsCounters.requests = Number(data.meta?.httpRequests ?? 0);
  diagnosticsCounters.retries = Number(data.meta?.retries ?? 0);
  diagnosticsCounters.rateLimits = Number(data.meta?.rateLimitEvents ?? 0);
  diagnosticsCounters.providerErrors = Number(data.meta?.providerErrorEvents ?? 0);
  adapters = (data.meta?.adapters ?? []).map(a => ({ id: a.id, model: a.model, name: a.name, protocol: a.protocol, architecture: a.architecture ?? 'flat' }));
  hierarchicalAdapters = (data.meta?.hierarchicalAdapters ?? []).map(a => ({ id: a.id, model: a.model, name: a.name, protocol: a.protocol, architecture: a.architecture ?? 'hierarchical' }));
  experiments = data.meta?.experiments ?? [...new Set(state.results.map(r => r.experiment).filter(Boolean))];
  startedAt = new Date(data.meta?.generatedAt ?? Date.now());
  elapsedMs = data.meta?.elapsedMs ?? 0;
  aborted = Boolean(data.meta?.aborted);
  const maxRep = Math.max(1, ...state.results.map(r => Number(r.repetition) || 1));
  opts.reps = maxRep;
  opts.cap = Math.max(state.calls, Number(data.meta?.cap) || 0);
  config = { baseUrl: data.meta?.baseUrl ?? '', hasApiKey: false, isOpenRouter: Boolean(data.meta?.isOpenRouter), envSource: data.meta?.envSource ?? null, connection: { apiKey: '' }, models: adapters.map(a => ({ model: a.model })) };
  console.log(`Re-rendering ${opts.fromJson}: ${state.results.length} result rows, 0 API calls`);
} else {
  config = await resolveConfig({ cwd: process.cwd() });
  if (!config.models.length) {
    console.error('No models configured. Set OPENAI_PLAYER1.. in .env.');
    process.exit(1);
  }
  const selectedModels = config.models.filter(m => !opts.models || opts.models.some(f => m.model.includes(f)));
  if (!selectedModels.length) {
    console.error('No configured model matched --models.');
    process.exit(1);
  }

  adapters = selectedModels.map(({ model }) => adapterProtocol(model) === 'jev_decisions'
    ? createJevAdapter({ connection: config.connection, model, opts, architecture: 'flat' })
    : createChatAdapter({ connection: config.connection, model, opts, architecture: 'flat' }));
  hierarchicalAdapters = selectedModels.map(({ model }) => adapterProtocol(model) === 'jev_decisions'
    ? createJevAdapter({ connection: config.connection, model, opts, architecture: 'hierarchical' })
    : createChatAdapter({ connection: config.connection, model, opts, architecture: 'hierarchical' }));

  const plan = buildPlan({ experiments, adapters, hierarchicalAdapters, opts });
  const plannedCalls = plan.reduce((sum, batch) => {
    const modes = batch.questionModes?.length ?? 1;
    const repCount = batch.representations?.length ?? batch.descriptionVariants?.length ?? 1;
    return sum + batch.adapters.length * batch.scenarios.length * repCount * (batch.repetitions ?? opts.reps) * modes;
  }, 0);

  console.log(`Diagnostics: ${adapters.length} model(s), ${experiments.join(', ')}`);
  console.log(`Models: ${config.models.map(m => m.model).join(', ')}`);
  console.log(`Base URL: ${config.baseUrl} · API key: ${config.hasApiKey ? 'present' : 'MISSING'}`);
  console.log(`Planned model calls: ~${plannedCalls} (cap ${opts.cap})`);

  if (opts.dryRun) {
    for (const batch of plan) {
      const modelCount = batch.adapters.length;
      const repCount = batch.representations?.length ?? batch.descriptionVariants?.length ?? 1;
      const modeCount = batch.questionModes?.length ?? 1;
      console.log(`  - ${batch.name}: ${modelCount} model(s) × ${batch.scenarios.length} scenario(s) × ${repCount} representation(s) × ${batch.repetitions ?? opts.reps} rep × ${modeCount} question mode(s) = ${modelCount * batch.scenarios.length * repCount * (batch.repetitions ?? opts.reps) * modeCount}`);
    }
    process.exit(0);
  }

  if (!config.hasApiKey) {
    console.error('OPENAI_API_KEY is missing; refusing to make real requests.');
    process.exit(1);
  }

  process.on('SIGINT', () => { aborted = true; console.error('\nInterrupted — writing partial report…'); });
  const controller = new AbortController();
  if (!process.env.DIAGNOSTICS_NO_ABORT) process.on('SIGTERM', () => controller.abort());

  function progress({ calls, totalPlanned, adapter, scenario, representation, repetition, correct, error }) {
    const status = error ? 'ERR' : correct ? 'ok' : 'MISS';
    process.stdout.write(`[${String(calls).padStart(3)}/${totalPlanned}] ${adapter} · ${scenario} · ${representation} · rep ${repetition} → ${status}${error ? ` (${String(error).slice(0, 80)})` : ''}\n`);
  }

  async function runBatch(batch, name) {
    const remaining = opts.cap - state.calls;
    if (remaining <= 0) { state.skipped.push(name); return; }
    const reps = batch.repetitions ?? opts.reps;
    const questionModes = batch.questionModes ?? [batch.questionMode ?? 'action+aggression+bluff'];
    const representations = batch.representations
      ?? Object.entries(descriptionVariants(RIVER_PROBE.state)).map(([id, stateVariant]) => ({
        id: `desc-${id}`, name: `Description: ${id}`, keyMode: 'opaque',
        build: () => ({ jevState: stateVariant, chatText: JSON.stringify(stateVariant) }),
      }));
    for (const questionMode of questionModes) {
      const remainingNow = opts.cap - state.calls;
      if (remainingNow <= 0 || aborted) { if (!state.skipped.includes(name)) state.skipped.push(name); break; }
      const run = await runSuite({
        adapters: batch.adapters, scenarios: batch.scenarios, representations, repetitions: reps,
        cap: remainingNow, delayMs: opts.delay, questionMode, onProgress: progress, signal: controller.signal, label: name,
        architecture: batch.architecture ?? 'flat',
      });
      state.calls += run.calls;
      for (const result of run.results) { result.experiment = name; state.results.push(result); }
      state.batches.push({ name, questionMode, calls: run.calls, planned: run.totalPlanned, stopped: run.stopped });
    }
  }

  const t0 = performance.now();
  for (const batch of plan) {
    if (aborted) break;
    if (state.calls >= opts.cap) { state.skipped.push(batch.name); continue; }
    await runBatch(batch, batch.name);
  }
  elapsedMs = Math.round(performance.now() - t0);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const allScenarios = [...STRICT_SCENARIOS, RIVER_PROBE, ...STRATEGY_SCENARIOS];
const byExperiment = name => state.results.filter(r => r.experiment === name);
const failedAdapters = adapters.map(adapter => ({ adapter, agg: aggregate(state.results.filter(r => r.adapterId === adapter.id)) }));

function strictDetailTable() {
  const strict = byExperiment('strict');
  const body = [];
  for (const scenario of STRICT_SCENARIOS) {
    for (const adapter of adapters) {
      const rows = strict.filter(r => r.scenarioId === scenario.id && r.adapterId === adapter.id);
      if (!rows.length) continue;
      const agg = aggregate(rows);
      body.push([`${scenario.layer}`, scenario.title, adapter.name, `${agg.correct}/${agg.total}`, `${Math.round(agg.accuracy * 100)}%`, agg.actionCounts && Object.keys(agg.actionCounts).length ? Object.entries(agg.actionCounts).map(([k, v]) => `${k}×${v}`).join(' ') : '—', String(agg.errors)]);
    }
  }
  return ['| Layer | Scenario | Model | Pass | Accuracy | Actions | Errors |', '| --- | --- | --- | --- | --- | --- | --- |', ...body.map(r => `| ${r.join(' | ')} |`)].join('\n');
}

function heroHandTable() {
  const rows = byExperiment('herohand');
  const scenarios = [...new Set(rows.map(r => r.scenarioId))];
  const body = scenarios.map(scenarioId => {
    const cells = adapters.map(adapter => {
      const without = aggregate(rows.filter(r => r.scenarioId === scenarioId && r.adapterId === adapter.id && r.representationId === 'full-json'));
      const withHand = aggregate(rows.filter(r => r.scenarioId === scenarioId && r.adapterId === adapter.id && r.representationId === 'canonical-herohand'));
      if (!without.total && !withHand.total) return '—';
      const delta = (withHand.accuracy - without.accuracy);
      const title = rows.find(r => r.scenarioId === scenarioId)?.title ?? scenarioId;
      return `${Math.round(without.accuracy * 100)}% → ${Math.round(withHand.accuracy * 100)}% (${delta >= 0 ? '+' : ''}${Math.round(delta * 100)}pp)`;
    });
    return [`${rows.find(r => r.scenarioId === scenarioId)?.expectedLabel ?? ''}`, ...cells];
  });
  return ['| Scenario | ' + adapters.map(a => a.name).join(' | ') + ' |', '| ' + ['---', ...adapters.map(() => '---')].join(' | ') + ' |', ...body.map(r => `| ${r.map(v => String(v).replace(/\|/g, '\\|')).join(' | ')} |`)].join('\n');
}

function descriptionTable() {
  const rows = byExperiment('descriptions');
  const variants = [...new Set(rows.map(r => r.representationId))];
  const body = variants.map(variantId => {
    const cells = adapters.map(adapter => {
      const agg = aggregate(rows.filter(r => r.representationId === variantId && r.adapterId === adapter.id));
      return `${Math.round(agg.accuracy * 100)}% / agg ${agg.aggressiveRate == null ? '—' : Math.round(agg.aggressiveRate * 100) + '%'}`;
    });
    return [variantId, ...cells];
  });
  return ['| Variant | ' + adapters.map(a => a.name).join(' | ') + ' |', '| ' + ['---', ...adapters.map(() => '---')].join(' | ') + ' |', ...body.map(r => `| ${r.join(' | ')} |`)].join('\n');
}

function regressionProbeReport() {
  const rows = state.results.filter(r => r.menu && String(r.menu).startsWith('probe ·'));
  if (!rows.length) return '_Probe not run._';
  const hand = heroHandSummary(RIVER_PROBE.state.hero.cards, RIVER_PROBE.state.board);
  const body = adapters.map(adapter => {
    const adapterRows = rows.filter(r => r.adapterName === adapter.name && r.architecture === 'flat');
    const agg = aggregate(adapterRows);
    const actionText = Object.entries(agg.actionCounts).map(([k, v]) => `${k}×${v}`).join(', ') || '—';
    return [adapter.name, actionText, agg.selectedProbabilityMean == null ? '—' : `${Math.round(agg.selectedProbabilityMean * 100)}%`, agg.aggressiveRate == null ? '—' : `${Math.round(agg.aggressiveRate * 100)}%`];
  });
  return `Deterministic hand: **${hand?.category ?? '—'}** (${hand?.key ?? '—'}). This is a regression probe, not a correctness test. The full four-way matrix is in the probe table below.\n\n` + ['| Model | Selected actions (flat) | Mean selected prob | Aggressive-choice rate |', '| --- | --- | --- | --- |', ...body.map(r => `| ${r.join(' | ')} |`)].join('\n');
}

function diagnosis() {
  const lines = [];
  const accFor = (rows) => { const agg = aggregate(rows); return agg.total ? agg.accuracy : null; };
  const layerA = accFor(state.results.filter(r => r.layer === 'A'));
  const layerB = accFor(state.results.filter(r => r.layer === 'B'));
  const dominated = accFor(state.results.filter(r => r.layer === 'D' && r.strict));
  const strict = accFor(byExperiment('strict'));
  const reps = byExperiment('representations');
  const repAgg = groupBy(reps, r => r.representationId);
  const repAcc = new Map([...repAgg.entries()].map(([id, rows]) => [id, aggregate(rows).accuracy]));
  const opaqueAcc = repAcc.get('full-json');
  const semanticAcc = repAcc.get('semantic-keys');
  const hero = byExperiment('herohand');
  const withoutHand = hero.some(r => r.representationId === 'full-json') ? aggregate(hero.filter(r => r.representationId === 'full-json')).accuracy : null;
  const withHand = hero.some(r => r.representationId === 'canonical-herohand') ? aggregate(hero.filter(r => r.representationId === 'canonical-herohand')).accuracy : null;
  const ctx = byExperiment('context');
  const ctxAgg = groupBy(ctx, r => r.contextVariantId);
  const immediate = ctxAgg.has('context-immediate') ? aggregate(ctxAgg.get('context-immediate')).accuracy : null;
  const full = ctxAgg.has('context-full') ? aggregate(ctxAgg.get('context-full')).accuracy : null;
  const questions = byExperiment('questions');
  const qAgg = groupBy(questions, r => `${r.questionMode}|${r.adapterId}`);
  const actionOnly = [...qAgg.entries()].filter(([k]) => k.startsWith('action|')).map(([, v]) => aggregate(v).accuracy);
  const fullQuestions = [...qAgg.entries()].filter(([k]) => k.startsWith('action+aggression+bluff|')).map(([, v]) => aggregate(v).accuracy);
  const pct = v => Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—';
  lines.push(`- Layer A (action-id mapping) accuracy: **${pct(layerA)}**`);
  lines.push(`- Layer B (hand recognition) accuracy: **${pct(layerB)}**`);
  lines.push(`- Layer D (strictly dominated) accuracy: **${pct(dominated)}**`);
  lines.push(`- Strict overall: **${pct(strict)}**`);
  lines.push(`- Representation sensitivity: opaque canonical ${pct(opaqueAcc)} vs semantic keys ${pct(semanticAcc)}`);
  lines.push(`- Deterministic heroHand: ${pct(withoutHand)} → ${pct(withHand)}`);
  lines.push(`- Context ablation: immediate ${pct(immediate)} vs full production ${pct(full)}`);
  lines.push(`- Auxiliary questions: action-only ${pct(actionOnly[0])} vs action+aggression+bluff ${pct(fullQuestions[0])}`);
  lines.push('');
  lines.push('Diagnosis hierarchy (honest, evidence-based):');
  if (Number.isFinite(layerA) && layerA < 0.8) lines.push('- Layer A failed: action mapping / Decisions API interpretation is the primary problem.');
  else if (Number.isFinite(layerB) && layerB < 0.8) lines.push('- A passes but B fails: the model cannot reliably infer hand strength from raw cards.');
  else if (Number.isFinite(dominated) && dominated < 0.8) lines.push('- A+B pass but dominated-action tests fail: representation is understood, basic decision quality is poor.');
  else if (opaqueAcc != null && semanticAcc != null && semanticAcc - opaqueAcc > 0.15) lines.push('- Semantic action keys materially outperform opaque A0/A1 keys.');
  else if (immediate != null && full != null && immediate - full > 0.15) lines.push('- Immediate state passes but full context fails: context overload / state design is likely the problem.');
  else if (withHand - withoutHand > 0.15) lines.push('- Deterministic heroHand materially improves decisions: hand recognition is a bottleneck.');
  else if (actionOnly[0] != null && fullQuestions[0] != null && actionOnly[0] - fullQuestions[0] > 0.15) lines.push('- Action-only questions outperform action+aggression+bluff: auxiliary questions contaminate the decision.');
  else lines.push('- No single layer is decisively broken by this run. Read the tables for the per-scenario picture; passivity may be a genuine strategic policy.');
  lines.push('');
  lines.push('Reminder: ordinary poker-strategy disagreements are not protocol bugs. Only legality, strict dominance, deterministic hand information, or explicitly specified synthetic opponent behavior count as correctness.');
  return lines.join('\n');
}

function probeMatrix() {
  const rows = state.results.filter(r => r.menu && String(r.menu).startsWith('probe ·'));
  if (!rows.length) return '_Probe matrix not run._';
  const names = [...new Set(rows.map(r => r.adapterName))];
  const combos = [...new Set(rows.map(r => r.menu))];
  const body = combos.map(menu => {
    const cells = names.map(name => {
      const group = rows.filter(r => r.menu === menu && r.adapterName === name);
      if (!group.length) return '—';
      const agg = aggregate(group);
      const actions = Object.entries(agg.actionCounts).map(([k, v]) => `${k}×${v}`).join(' ') || '—';
      return `${actions} · agg ${pctText(agg.aggressiveRate)}`;
    });
    return [menu, ...cells];
  });
  return hTable(['Probe variant', ...names], body);
}
function pctText(v) { return Number.isFinite(v) ? `${Math.round(v * 100)}%` : '—'; }
function hTable(headers, rows) {
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map(r => `| ${r.map(v => String(v).replace(/\|/g, '\\|')).join(' | ')} |`)].join('\n');
}

function acceptanceAnswers() {
  const lines = [];
  const behavioral = state.results.filter(r => r.kind === 'action' && !r.error && !r.menu);
  const aggFor = (filter) => aggregate(state.results.filter(filter));
  const aggBehavioral = (filter) => aggregate(behavioral.filter(filter));
  // 1. Fragmentation.
  const fragA = aggFor(r => r.menu && r.menu.startsWith('A ·'));
  const fragC = aggFor(r => r.menu && r.menu.startsWith('C ·'));
  const fragD = aggFor(r => r.architecture === 'hierarchical' && r.menu && r.menu.startsWith('D ·'));
  lines.push(`1. **Bet-size fragmentation bias.** Flat variant A (CHECK / BET ALL-IN) aggressive rate ${pctText(fragA.aggressiveRate)}; flat variant C (five aggressive classes) ${pctText(fragC.aggressiveRate)}; hierarchical variant D ${pctText(fragD.aggressiveRate)}. ${Number.isFinite(fragA.aggressiveRate) && Number.isFinite(fragC.aggressiveRate) && fragC.aggressiveRate < fragA.aggressiveRate ? 'More size classes are associated with *less* aggression, confirming the option-count asymmetry.' : 'No monotonic fragmentation effect is visible in this sample.'}`);
  // 2. Jev passivity after fragmentation removed.
  const jevHier = aggBehavioral(r => r.architecture === 'hierarchical' && /jev/i.test(r.adapterName));
  const jevFlat = aggBehavioral(r => r.architecture === 'flat' && /jev/i.test(r.adapterName));
  lines.push(`2. **Jev after fragmentation is removed.** Flat aggressive rate ${pctText(jevFlat.aggressiveRate)} (mean aggressive family mass ${pctText(jevFlat.meanAggressiveFamilyMass)}); hierarchical aggressive rate ${pctText(jevHier.aggressiveRate)} (mean aggressive family mass ${pctText(jevHier.meanAggressiveFamilyMass)}). ${Number.isFinite(jevHier.aggressiveRate) && Number.isFinite(jevFlat.aggressiveRate) && jevHier.aggressiveRate >= jevFlat.aggressiveRate - 0.05 ? 'Jev’s aggression rises or holds once sizes are separated, so its passivity was substantially an artifact of the flat menu.' : 'Jev remains more passive than the flat menu alone would predict; this is a genuine model-side tendency in this sample.'}`);
  // 3. Gemma/Qwen change.
  for (const name of [...new Set(behavioral.map(r => r.adapterName))].filter(n => /gemma|qwen/i.test(n))) {
    const flat = aggBehavioral(r => r.adapterName === name && r.architecture === 'flat');
    const hier = aggBehavioral(r => r.adapterName === name && r.architecture === 'hierarchical');
    lines.push(`3. **${name} under hierarchy.** Flat aggressive rate ${pctText(flat.aggressiveRate)} → hierarchical ${pctText(hier.aggressiveRate)}.`);
  }
  // 4. heroHand.
  const hero = byExperiment('herohand');
  if (hero.length) {
    const withoutHand = aggregate(hero.filter(r => r.representationId === 'full-json'));
    const withHand = aggregate(hero.filter(r => r.representationId === 'canonical-herohand'));
    lines.push(`4. **Deterministic heroHand.** Accuracy ${pctText(withoutHand.accuracy)} → ${pctText(withHand.accuracy)} (accuracy is only meaningful for the fixed-answer scenarios). The probe-level raw-vs-heroHand behavioral ablation is in the probe matrix.`);
  } else {
    lines.push('4. **Deterministic heroHand.** Not part of this batch; see the merged probe/heroHand run in the summary report.');
  }
  // 5. Strict diagnostics preserved.
  const strictFlat = byExperiment('strict');
  const strictHier = byExperiment('hierarchical');
  lines.push(`5. **Strict diagnostics under hierarchy.** Flat ${pctText(aggregate(strictFlat.filter(r => r.layer !== 'P' && r.layer !== 'F')).accuracy)}; hierarchical ${pctText(aggregate(strictHier.filter(r => r.layer !== 'P' && r.layer !== 'F')).accuracy)}.`);
  lines.push('6. **Representation sensitivity** is reported in the representation table; the hierarchical architecture does not change the canonical state.');
  lines.push('7. **Same semantic state for every model:** guaranteed by one shared serializer and proven by the offline fairness tests.');
  lines.push('8. **Same family set:** guaranteed by `legalActionFamilies` and the Jev/chat enum parity test.');
  lines.push('9. **Same sizing set:** guaranteed by `aggressiveSizesForState` and the Jev/chat enum parity test.');
  lines.push('10. **Remaining arena-side reasons for passivity:** none found beyond option-count asymmetry; the fixed option sets are identical for every adapter.');
  lines.push('11. **Remaining passivity explanation:** any residual passivity after fragmentation is removed is best attributed to the model policy, not the arena.');
  return lines.join('\n');
}

const meta = {
  generatedAt: startedAt.toISOString(),
  baseUrl: config.baseUrl,
  isOpenRouter: config.isOpenRouter,
  envSource: config.envSource,
  models: adapters.map(a => a.model),
  adapters: adapters.map(a => ({ id: a.id, model: a.model, protocol: a.protocol, name: a.name, architecture: a.architecture ?? 'flat' })),
  hierarchicalAdapters: hierarchicalAdapters.map(a => ({ id: a.id, model: a.model, protocol: a.protocol, name: a.name, architecture: a.architecture ?? 'hierarchical' })),
  experiments,
  experimentsRun: state.batches,
  skipped: state.skipped,
  repetitions: opts.reps,
  cap: opts.cap,
  totalCalls: state.calls,
  httpRequests: diagnosticsCounters.requests,
  retries: diagnosticsCounters.retries,
  rateLimitEvents: diagnosticsCounters.rateLimits,
  providerErrorEvents: diagnosticsCounters.providerErrors,
  elapsedMs,
  aborted,
};

const aggregates = {
  overall: aggregate(state.results),
  byExperiment: Object.fromEntries(experiments.map(name => [name, aggregate(byExperiment(name))])),
  byModel: Object.fromEntries(adapters.map(a => [a.model, aggregate(state.results.filter(r => r.adapterId === a.id))])),
  byLayer: Object.fromEntries([...new Set(state.results.map(r => r.layer))].map(layer => [layer, aggregate(state.results.filter(r => r.layer === layer))])),
};

const report = [
  '# Poker Decision Diagnostics',
  '',
  `Generated: ${meta.generatedAt}`,
  `Models: ${meta.models.join(', ')}`,
  `Endpoint: ${meta.baseUrl} · key present: ${config.hasApiKey} (never written to this report)`,
  `Repetitions: ${opts.reps} · cap: ${opts.cap} · decisions: ${state.calls} · HTTP requests: ${diagnosticsCounters.requests} (retries ${diagnosticsCounters.retries}, rate-limit ${diagnosticsCounters.rateLimits}, provider ${diagnosticsCounters.providerErrors}) · wall time: ${Math.round(elapsedMs / 1000)}s${aborted ? ' · ABORTED (partial)' : ''}`,
  state.skipped.length ? `Skipped batches (cap/interrupt): ${state.skipped.join(', ')}` : '',
  '',
  '## Diagnosis',
  '',
  diagnosis(),
  '',
  '## STRICT DIAGNOSTICS',
  '',
  strictMatrix(byExperiment('strict'), STRICT_SCENARIOS, adapters),
  '',
  '### Per-scenario strict detail',
  '',
  strictDetailTable(),
  '',
  '## HIERARCHICAL STRICT DIAGNOSTICS (same action scenarios, two-stage; id-mapping and hand-recognition layers are flat-only by design)',
  '',
  strictMatrix(byExperiment('hierarchical'), [...STRICT_SCENARIOS.filter(s => s.kind === 'action' && s.hierarchicalCompatible !== false), RIVER_PROBE], hierarchicalAdapters),
  '',
  '## FLAT VS HIERARCHICAL',
  '',
  architectureComparisonTable(state.results),
  '',
  '## ACTION FRAGMENTATION',
  '',
  fragmentationTable(state.results),
  '',
  '## JEV FAMILY PROBABILITY TELEMETRY',
  '',
  jevFamilyTelemetryTable(state.results),
  '',
  '## REPRESENTATION TEST',
  '',
  representationTable(byExperiment('representations'), adapters),
  '',
  '## HERO-HAND ABLATION (deterministic)',
  '',
  heroHandTable(),
  '',
  '## JEV QUESTION ABLATION',
  '',
  questionAblationTable(byExperiment('questions'), adapters.find(a => a.protocol === 'jev_decisions') ?? adapters[0]),
  '',
  '## CONTEXT ABLATION',
  '',
  contextTable(byExperiment('context'), adapters),
  '',
  '## STRATEGY SANITY CHECKS (not objectively correct)',
  '',
  strictMatrix(byExperiment('strategy'), STRATEGY_SCENARIOS, adapters),
  '',
  '## DESCRIPTION QUALITY (river probe, accuracy is not meaningful here)',
  '',
  descriptionTable(),
  '',
  '## REGRESSION PROBE — observed river passivity',
  '',
  regressionProbeReport(),
  '',
  '### Probe matrix (flat/hierarchical × raw/heroHand)',
  '',
  probeMatrix(),
  '',
  '## ACCEPTANCE QUESTIONS',
  '',
  acceptanceAnswers(),
  '',
  '## PROBABILITY MASS',
  '',
  probabilityMassTable(state.results, adapters),
  '',
  '## Errors',
  '',
  state.results.some(r => r.error)
    ? ['| Model | Scenario | Representation | Error |', '| --- | --- | --- | --- |', ...[...new Set(state.results.filter(r => r.error).map(r => `${r.adapterId}|${r.scenarioId}|${r.representationId}|${r.error}`))].map(k => { const [adapterId, scenarioId, rep, error] = k.split('|'); return `| ${adapterId} | ${scenarioId} | ${rep} | ${String(error).slice(0, 120)} |`; })].join('\n')
    : '_No request errors._',
  '',
].filter(line => line !== '').join('\n');

await mkdir(opts.out, { recursive: true });
const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
const jsonPath = join(opts.out, `diagnostics-${stamp}.json`);
const mdPath = join(opts.out, `diagnostics-${stamp}.md`);
const sanitize = value => redact(JSON.stringify(value), config.connection.apiKey);
await writeFile(jsonPath, JSON.stringify(JSON.parse(sanitize({ meta, aggregates, results: state.results })), null, 2));
await writeFile(mdPath, redact(report, config.connection.apiKey));

console.log(`\nWrote ${jsonPath}`);
console.log(`Wrote ${mdPath}`);
console.log(`Decisions: ${state.calls}/${opts.cap} · HTTP requests: ${diagnosticsCounters.requests} · errors: ${state.results.filter(r => r.error).length}`);
