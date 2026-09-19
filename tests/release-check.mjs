import { readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const textExts = new Set(['.html','.js','.mjs','.css','.md','.json','.yml','.yaml','.py']);
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules' || name === 'logs' || name === 'dist') continue;
    const path = join(dir, name);
    statSync(path).isDirectory() ? walk(path) : files.push(path);
  }
}
walk(root);
for (const file of files) {
  if (!textExts.has(extname(file))) continue;
  const text = readFileSync(file, 'utf8');
  if (/\p{Script=Cyrillic}/u.test(text)) throw new Error(`Cyrillic text found in ${file.slice(root.length + 1)}`);
}

for (const file of ['src/app.js','src/lib/decision-core.js','src/benchmark/scenarios.js','build.mjs','bin/pokertools-arena.mjs','tests/integration/pokertools-integration.mjs','tests/integration/launcher-port-retry.mjs','tests/unit/decision-scenarios.mjs','tests/unit/decision-diagnostics.mjs','tests/unit/hierarchical-decision-tests.mjs','tests/unit/methodology-tests.mjs','tests/unit/paired-architecture-tests.mjs','tests/unit/size-bucket-tests.mjs','tests/unit/archive-content.mjs','tests/unit/report-consistency.mjs','tests/real/real-decision-diagnostics.mjs','tests/analysis/diagnostics-analyze.mjs','tools/diagnostics/scenarios.js','tools/diagnostics/representations.js','tools/diagnostics/harness.js','tools/diagnostics/corpus.js','tools/diagnostics/stats.js','tools/diagnostics/counters.js','tools/diagnostics/paired.js','tools/diagnostics/report.js','tools/diagnostics/size-buckets.js','tools/release/archive.mjs']) {
  const result = spawnSync(process.execPath, ['--check', join(root, file)], { encoding:'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `Syntax check failed: ${file}`);
}

const index = readFileSync(join(root,'src','index.html'),'utf8');
const app = readFileSync(join(root,'src','app.js'),'utf8');
// The decision core (action space, serialization, Jev/OpenAI request formats)
// lives in its own module so the Node diagnostics harness exercises production
// code. Invariants below accept either location.
const corePath = join(root,'src','lib','decision-core.js');
const core = existsSync(corePath) ? readFileSync(corePath,'utf8') : '';
const has = text => app.includes(text) || core.includes(text);
const css = readFileSync(join(root,'src','styles.css'),'utf8');
if (!index.includes('id="soundBtn"') || !index.includes('id="fxLayer"')) throw new Error('Visual/audio UI controls missing');
if (!index.includes('id="startTopBtn"') || !index.includes('id="seatDialog"') || !index.includes('id="seatsLayer"')) throw new Error('Seat-first lobby UI missing');
if (!app.includes('MAX_LOBBY_SEATS = 10') || !app.includes('function openSeatEditor') || !app.includes('function renderLobbyTable')) throw new Error('Seat-first lobby logic missing');
if (index.includes('id="playersEditor"') || app.includes('addPlayerRow(')) throw new Error('Legacy player-list setup still present');
if (!app.startsWith("import { createBrowserEngine as createPokerToolsBrowserEngine } from '@pokertools/engine/browser';")) throw new Error('App does not import @pokertools/engine/browser directly');
if (/esm\.sh|esm\.unpkg\.com|cdn\.jsdelivr\.net/.test(app)) throw new Error('Runtime PokerTools CDN reference found in app.js');
if (index.includes('id="enginePill"') || app.includes('PokerTools 1.0.17 bundled')) throw new Error('Legacy engine pill/status still present');

if (!has('/api/alpha/decisions')) throw new Error('OpenRouter Decisions endpoint missing');
if (!has('function decideJevDecisions')) throw new Error('OpenRouter Jev Decisions adapter missing');
if (!has('function isJevModel')) throw new Error('Jev model auto-detection missing');
if (!index.includes('value="openrouter"') || !index.includes('value="jev_decisions"')) throw new Error('OpenRouter/Jev Decisions UI options missing');

const elsBlock = app.match(/const els = \{([\s\S]*?)\n\};/);
if (!elsBlock) throw new Error('UI element map not found');
const ids = new Set([...elsBlock[1].matchAll(/\$\('#([^']+)'\)/g)].map(m=>m[1]));
const htmlIds = new Set([...index.matchAll(/id="([^"]+)"/g)].map(m=>m[1]));
const missing = [...ids].filter(id=>!htmlIds.has(id));
if (missing.length) throw new Error(`Missing DOM IDs: ${missing.join(', ')}`);

if (!app.includes("storageSet('pokertoolsArenaBrowserConfig'")) throw new Error('Expected safe setup storage key missing');
if (!app.includes('raw.connections.map(({ apiKey, headers, ...c })')) throw new Error('API keys may be persisted');
if (!app.includes('connections: this.config.connections.map(({ apiKey, headers, ...c })')) throw new Error('API keys may leak through public config');
if (!app.includes('engine.validate(fresh.engineAction)')) throw new Error('Fresh action validation missing');

if (!has('DECISION_CONTEXT_VERSION = 3')) throw new Error('Canonical decision-context version missing');
if (!app.includes('buildPublicPlayerStats')) throw new Error('Shared public player statistics missing');
if (!app.includes('buildCurrentHandPublicActions')) throw new Error('Structured current-hand history missing');
if (!has('function assertDecisionState')) throw new Error('Runtime decision-context invariants missing');
if (!app.includes('playersRemaining: Math.max(0, startingPlayers - eliminatedPlayerIds.length)')) throw new Error('All-in-safe tournament player count missing');
if (!has('const aggressiveType = highestBet > 0 ? ACTION.RAISE : ACTION.BET')) throw new Error('BET/RAISE semantic de-duplication missing');
if (!has('type === ACTION.FOLD && toCall === 0')) throw new Error('FOLD-when-CHECK dominance guard missing');
if (!has('n <= maxTotal')) throw new Error('Aggressive action stack cap missing');
if (!app.includes('Number.isSafeInteger(value)') || !app.includes("Unable to build a safe blind structure")) throw new Error('Safe blind-structure overflow guard missing');
if (!app.includes('openSetup({ preserveError = false } = {})') || !app.includes('openSetup({ preserveError: true })')) throw new Error('Visible startup-error handling missing');
if (!app.includes('buildPublicTournamentMemory')) throw new Error('Shared public tournament memory missing');
if (!has('Fail closed. A failed player view must never fall back')) throw new Error('Fail-closed player masking missing');
if (!has('isReasoningModel(agent.model) ? 1024 : 320')) throw new Error('Reasoning-model completion budget fix missing');
if (!has('body.reasoning = { max_tokens: 256, exclude: true }')) throw new Error('OpenRouter reasoning cap missing');
if (!readFileSync(join(root,'build.mjs'),'utf8').includes("filter: /^(?:node:)?crypto$/")) throw new Error('Browser crypto resolver missing from build');
if (!existsSync(join(root,'src','shims','crypto.cjs'))) throw new Error('Browser crypto shim missing');

const pkg = JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
if (pkg.name !== 'pokertools-arena') throw new Error('npm package name mismatch');
if (pkg.version !== '0.4.4') throw new Error('Expected release version 0.4.4');
if (pkg.dependencies?.['@pokertools/engine'] !== '1.0.20') throw new Error('@pokertools/engine 1.0.20 must be an explicit dependency');
if (pkg.dependencies?.['@pokertools/evaluator'] !== '1.0.20') throw new Error('@pokertools/evaluator 1.0.20 must be an explicit dependency for deterministic hand evaluation');
if (!pkg.devDependencies?.esbuild) throw new Error('esbuild devDependency missing');
if (pkg.bin?.['pokertools-arena'] !== 'bin/pokertools-arena.mjs') throw new Error('npm binary missing');
if (!pkg.files?.includes('dist/')) throw new Error('npm package must include dist/');
if (pkg.repository?.url !== 'git+https://github.com/pokertools-arena/pokertools-arena.github.io.git') throw new Error('Canonical repository metadata mismatch');
if (pkg.homepage !== 'https://pokertools-arena.github.io/') throw new Error('Canonical GitHub Pages homepage mismatch');

if (!index.includes('id="seatModelOptions"') || !index.includes('id="refreshModelsBtn"')) throw new Error('Model picker UI missing');
if (!index.includes('<option value="openai">OpenAI-compatible</option>') || !index.includes('data-field="baseUrl"')) throw new Error('Generic OpenAI-compatible connection UI missing');
if (!css.includes('0.2.9 — compact modal system')) throw new Error('0.2.9 modal/header polish missing');

if (!css.includes('0.2.10 — felt identity + resilient translucent table HUD')) throw new Error('0.2.10 table identity/HUD polish missing');
if (!app.includes('function fmtHud(') || !app.includes('els.potValue.title = fmt(table.pot)')) throw new Error('Compact overflow-safe HUD number formatting missing');
if (!has('/api/v1/models?limit=1000&offset=0')) throw new Error('OpenRouter paged model catalog endpoint missing');
if (!app.includes('function refreshSeatModelCatalog')) throw new Error('OpenRouter model catalog loader missing');
if (!app.includes('OPENROUTER_DECISION_MODELS') || !app.includes('typesafe/jev-1.13') || !app.includes('~typesafe/jev-latest')) throw new Error('OpenRouter Decisions shortcuts missing');
if (!has('isUnsupportedToolChoiceError') || !has('tool→json_schema')) throw new Error('Adaptive tool-to-JSON-schema fallback missing');
if (!has('fetchJsonWithRetry') || !has('response.status === 429 || response.status >= 500')) throw new Error('Bounded provider retry missing');
if (!app.includes('modelErrors') || !app.includes('providerErrors') || !app.includes('rateLimits') || !app.includes('protocolFallbacks')) throw new Error('Reliability telemetry missing');
if (!css.includes('True viewport fit on desktop')) throw new Error('Viewport overflow regression fix missing');
if (!css.includes('height:100dvh')) throw new Error('Dynamic viewport desktop shell missing');
if (!index.includes('class="table-brand"') || index.includes('class="felt-brand"')) throw new Error('Table brand hierarchy not updated');
if (!index.includes('id="winnerBanner"')) throw new Error('Legacy winner status anchor missing');
if (!css.includes('.winner-banner{display:none!important}')) throw new Error('Winner banner must not shift table layout');
if (!app.includes('rankOnlyCorners') || !css.includes('.rank-only-corners')) throw new Error('Hole-card corner simplification missing');
if (!index.includes('favicon.svg')) throw new Error('Favicon link missing');
if (!index.includes('id="testsDialog"') || !index.includes('id="testsBtn"')) throw new Error('Decision sanity-suite UI missing');
if (!index.includes('id="anteValue"') || !index.includes('id="handValue"') || !index.includes('id="levelValue"')) throw new Error('Semantic table HUD missing');
if (!app.includes('DECISION_SANITY_SCENARIOS') || !app.includes('runDecisionSanitySuite')) throw new Error('Decision sanity-suite runner missing');
if (!app.includes('id: player.id || `player-${player.lobbySeat + 1}`')) throw new Error('Sanity agents must carry stable unique ids');
if (!app.includes('function syncSeatNameFromModel') || !app.includes('seatNameAuto')) throw new Error('Seat editor must show the model-derived seat name');
if (!css.includes('.icon-button svg{') || !index.includes('class="icon-glyph"')) throw new Error('Close buttons must use centered SVG glyphs');
if (app.includes('decision-facts-note') || core.includes('SPECTATOR_NOTE') || css.includes('.decision-facts-note')) throw new Error('Typed-decision spectator note must not be rendered');
if (index.includes('Close settings">×')) throw new Error('Text close glyph still present (off-centre)');
if (!css.includes('.table-hud') || !css.includes('.tests-dialog')) throw new Error('Table HUD/tests UI polish missing');
if (!css.includes('0.2.8 — viewport-fit table') || !css.includes('grid-template-columns:minmax(0,1fr) clamp(270px,25vw,360px)')) throw new Error('0.2.8 viewport-fit table layout missing');
if (!app.includes('const renderMemo') || !app.includes('activeInspectorTab') || !app.includes('schedulePersist()') || !app.includes('publicStatsCacheHand')) throw new Error('0.2.8 render/persistence optimization missing');
if (!app.includes('decisionTelemetryHtml') || !index.includes('id="decisionHand"') || !index.includes('id="decisionOptionCount"')) throw new Error('Stable decision instrument / feed telemetry UI missing');
if (!css.includes('0.2.13 — spectator dashboard polish')) throw new Error('Spectator dashboard polish missing');
if (!index.includes('id="recordBtn"') || !app.includes('startTableRecording') || !app.includes('restrictCaptureToTable')) throw new Error('0.2.14 table recording UI/runtime missing');
if (!app.includes('displayModelName') || !app.includes("'Tournament winner'") || !css.includes('0.2.14 — stable spectator panel')) throw new Error('0.2.14 spectator identity/winner UI missing');

if (!index.includes('id="testsParticipants"') || !index.includes('Decision sanity suite')) throw new Error('0.2.15 decision suite explainer/participants UI missing');
if (!app.includes('renderSanityParticipants') || !app.includes('sanityModelSummary') || !css.includes('0.2.15 — Decision sanity suite clarity')) throw new Error('0.2.15 decision suite comparison UX missing');
if (!index.includes('id="replayDialog"') || !app.includes('openDecisionReplay') || !app.includes('replay: {') || !css.includes('0.2.16 — decision history replay')) throw new Error('0.2.16 decision replay UX missing');
if (!app.includes('showActionToast(`${displayModelName(')) throw new Error('Action ticker must use model identity instead of Player N');
if (!index.includes('id="saveReplayImage"') || !index.includes('id="copyReplayImage"') || !app.includes('makeReplayShareCanvas') || !app.includes('1080') || !app.includes('1350')) throw new Error('0.2.19 replay social-image export missing');
if (!css.includes('0.2.19 — replay modal + social sharing')) throw new Error('0.2.19 replay modal polish missing');

if (!app.includes('seatLayoutDiagnostics') || !app.includes('clampSeatIntoTable') || !app.includes("'micro'") || !app.includes('ResizeObserver')) throw new Error('0.2.20 viewport-driven seat fitting missing');
if (!css.includes('0.2.20 — true viewport-fit seating') || !css.includes('data-density="micro"')) throw new Error('0.2.20 micro density CSS missing');

if (!app.includes('function setDecisionContext') || !app.includes('protocolDisplay(')) throw new Error('0.2.21 stable decision instrument missing');
if (!css.includes('0.2.21 — visible-table sizing + stable decision instrument') || !css.includes('flex:1 1 0!important') || !css.includes('height:0!important')) throw new Error('0.2.21 visible table sizing CSS missing');

if (!index.includes('<script src="./arena-env.js"></script>') || !existsSync(join(root,'src','env','arena-env.js')) || !existsSync(join(root,'.env.example'))) throw new Error('0.2.22 .env bootstrap assets missing');
const launcher = readFileSync(join(root,'bin','pokertools-arena.mjs'),'utf8');
if (!launcher.includes("urlPath === '/arena-env.js'") || !launcher.includes('OPENAI_PLAYER${i}') || !launcher.includes("resolve(process.cwd(), '.env')")) throw new Error('0.2.22 launcher .env auto-bootstrap missing');
if (!app.includes('function injectedEnvironmentConfig') || !app.includes("connection.apiKey || ''")) throw new Error('0.2.22 browser env bootstrap missing');
if (!app.includes('function recordingVideoBitrate') || !app.includes('24_000_000') || !app.includes("frameRate: { ideal: 60, max: 60 }")) throw new Error('0.2.22 high-quality recording preset missing');
if (!css.includes('0.2.22 — persistent felt branding + separate in-table action line') || !css.includes('.poker-table.action-message-visible .table-brand-stage .table-brand')) throw new Error('0.2.22 persistent felt branding missing');

// 0.3.0 — hierarchical decision architecture + Strategy/Raw benchmark modes.
if (!has('function legalActionFamilies')) throw new Error('Canonical action-family generation missing');
if (!has('function legalAggressiveSizes') || !has('function planAggressiveSizes')) throw new Error('Deterministic sizing candidates missing');
if (!has('function decideHierarchical')) throw new Error('Two-stage hierarchical decision execution missing');
if (!has('function aggregateActionProbabilitiesByFamily')) throw new Error('Legacy flat probability aggregation missing');
if (!has('function applyBenchmarkMode') || !has('BENCHMARK_MODES')) throw new Error('Strategy/Raw benchmark mode missing');
if (!has('DECISION_ARCHITECTURE_VERSION =') || !has('hierarchical-v1')) throw new Error('Decision architecture version missing');
if (!has('function renderDecisionState') || !has('REPRESENTATION_MODES')) throw new Error('Representation modes missing');
if (!has("type: 'choice'") || !has('action_family') || !has('bet_size')) throw new Error('Jev hierarchical question format missing');
if (!app.includes('decideHierarchical(')) throw new Error('Production does not use hierarchical decisions');
if (!app.includes('benchmarkMode') || !app.includes('decisionArchitecture') || !app.includes('spectatorExplanations')) throw new Error('Benchmark/architecture settings missing from production config');
if (!app.includes('applyBenchmarkMode(baseState')) throw new Error('Production state does not apply the benchmark mode');
if (!app.includes('enqueueSpectatorExplanation')) throw new Error('Isolated spectator-explanation queue missing');
if (!app.includes('primaryDecisionLatencyMs')) throw new Error('Primary decision latency telemetry missing');
if (!index.includes('name="benchmarkMode"') || !index.includes('name="decisionArchitecture"')) throw new Error('Benchmark-mode UI missing');
if (!css.includes('0.3.0 — hierarchical decision architecture')) throw new Error('0.3.0 hierarchical CSS missing');
if (!existsSync(join(root,'tests','unit','hierarchical-decision-tests.mjs'))) throw new Error('Hierarchical offline test suite missing');

// 0.4.0 — methodology + repository reorganization.
if (!existsSync(join(root,'src','benchmark','scenarios.js'))) throw new Error('Reorganized benchmark scenarios missing');
if (!existsSync(join(root,'tools','diagnostics','corpus.js'))) throw new Error('Fixed-state corpus missing');
if (!existsSync(join(root,'tools','diagnostics','stats.js'))) throw new Error('Statistics helpers missing');
if (!existsSync(join(root,'tools','release','archive.mjs'))) throw new Error('Release archive builder missing');
if (!existsSync(join(root,'tests','unit','methodology-tests.mjs'))) throw new Error('Methodology tests missing');
if (!existsSync(join(root,'tests','unit','paired-architecture-tests.mjs'))) throw new Error('Paired architecture tests missing');
if (!existsSync(join(root,'tests','unit','archive-content.mjs'))) throw new Error('Archive-content regression test missing');
if (!existsSync(join(root,'docs','architecture','CONTEXT.md'))) throw new Error('Architecture doc missing');
if (!existsSync(join(root,'docs','diagnostics','SUMMARY.md'))) throw new Error('Diagnostics summary missing');
if (!css.includes('0.4.0 — methodology')) throw new Error('0.4.0 methodology marker missing');
// Tooltips must float above modal overflow instead of being clipped by it.
if (!app.includes("tooltipEl.className = 'ui-tooltip'")) throw new Error('Floating tooltip controller missing');
if (!app.includes('function positionTooltip(') || !app.includes('function showTooltip(') || !app.includes("dataset.tip")) throw new Error('Tooltip positioning/data-tip wiring missing');
if (!app.includes("dialog.addEventListener('close', hideTooltip)")) throw new Error('Tooltips must hide when a modal closes');
if (!css.includes('.ui-tooltip{position:fixed')) throw new Error('Tooltip must be fixed-position to escape modal clipping');
if (css.includes('.info-button::after')) throw new Error('Clipped pseudo-element tooltip still present');
// Turn-ring timing must derive from configuration, never a hardcoded budget.
if (!app.includes('const TIMING_DEFAULTS = Object.freeze(')) throw new Error('Configurable timing defaults missing');
if (!app.includes('decisionClockPhase(')) throw new Error('Turn ring must use the shared clock phase');
if (!core.includes('phaseRemaining / phaseTotal')) throw new Error('Shared clock/ring phase missing');
if (!app.includes('lowTimeMs') || !app.includes('lowTimeFraction')) throw new Error('Configurable low-time thresholds missing');
if (!index.includes('name="lowTimeSeconds"') || !index.includes('name="lowTimeFraction"')) throw new Error('Low-time timing fields missing from setup UI');
if (existsSync(join(root,'app.js')) || existsSync(join(root,'index.html')) || existsSync(join(root,'styles.css'))) throw new Error('Duplicate root application sources present');

for (const workflow of ['ci.yml','pages.yml','publish.yml','real-diagnostics.yml']) {
  if (!statSync(join(root,'.github','workflows',workflow)).isFile()) throw new Error(`Missing workflow ${workflow}`);
}
const diagnosticsWorkflow = readFileSync(join(root,'.github','workflows','real-diagnostics.yml'),'utf8');
if (!diagnosticsWorkflow.includes("needs.preflight.outputs.configured == 'true'")) throw new Error('Real-API diagnostics must skip instead of failing when credentials are absent');
const pagesWorkflow = readFileSync(join(root,'.github','workflows','pages.yml'),'utf8');
if (!pagesWorkflow.includes('https://pokertools-arena.github.io/')) throw new Error('Canonical Pages URL missing from workflow');
const publishWorkflow = readFileSync(join(root,'.github','workflows','publish.yml'),'utf8');
if (!publishWorkflow.includes('pokertools-arena/pokertools-arena.github.io')) throw new Error('Canonical repository missing from publish workflow');

const sourceOnly = process.env.SOURCE_ONLY === '1';
if (!existsSync(dist)) {
  if (!sourceOnly) throw new Error('dist/ missing; run npm run build first');
  console.log('release-check: source-only mode (dist unavailable)');
} else {
const builtApp = readFileSync(join(dist,'app.js'),'utf8');
const builtIndex = readFileSync(join(dist,'index.html'),'utf8');
const single = readFileSync(join(dist,'pokertools-arena.html'),'utf8');
if (!builtApp.includes('createBrowserEngine')) throw new Error('Built app does not contain Arena/PokerTools integration');
if (builtApp.includes('@pokertools/engine/browser')) throw new Error('Bare PokerTools import survived bundling');
if (/esm\.sh|esm\.unpkg\.com|cdn\.jsdelivr\.net/.test(builtApp + single)) throw new Error('External PokerTools CDN survived build');
if (!single.includes(css)) throw new Error('Single-file build is missing CSS');
if (!single.includes('pokertools-arena')) throw new Error('Brand missing from single-file build');
if (!builtIndex.includes('<script type="module" src="./app.js"></script>')) throw new Error('Built index script reference changed unexpectedly');
if (!existsSync(join(dist,'favicon.svg'))) throw new Error('Built favicon missing');

const moduleMatch = single.match(/<script type="module">\n([\s\S]*?)\n<\/script>/);
if (!moduleMatch) throw new Error('Inline module not found');
const tmp = join(root,'.release-inline-check.mjs');
try {
  writeFileSync(tmp,moduleMatch[1]);
  const result = spawnSync(process.execPath,['--check',tmp],{encoding:'utf8'});
  if (result.status !== 0) throw new Error(result.stderr || 'Inline module syntax failed');
} finally { try { unlinkSync(tmp); } catch {} }

}
console.log('release-check: PASS');

if (!css.includes('0.2.17 — unclipped current decision layout') || !css.includes('flex:1 1 auto') || !css.includes('scrollbar-gutter:stable')) throw new Error('0.2.17 current decision layout polish missing');
