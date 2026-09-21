import { createBrowserEngine as createPokerToolsBrowserEngine } from '@pokertools/engine/browser';
import { DECISION_SANITY_SCENARIOS } from './benchmark/scenarios.js';
import {
  ARENA_CONFIG, TABLE_DEFAULTS, TIMING_DEFAULTS, CONFIG_LIMITS,
  CONNECTION_PRESETS, HISTORY_CONFIG, applyConfiguredFormDefaults, defaultConnections, defaultExtraHeaders,
} from './config/arena-config.js';
import {
  ACTION, RECENT_PUBLIC_HANDS,
  asNumber, round, clamp, summarizeError, ArenaRequestError, requestErrorCategory, decisionErrorCategory,
  retryDelayMs, sleepWithSignal, fetchJsonWithRetry, isUnsupportedToolChoiceError, mapGet, jsonSafe,
  normalizeBaseUrl, completionsUrl, openRouterDecisionsUrl, isOpenRouterConnection, isJevModel,
  effectiveProtocol, modelsUrl, parseHeaders, makeHeaders, combineAbort,
  playerCards, playerStack, currentBet, totalPot, potChipBreakdown, positionForSeat, tableMarkerSeats,
  describeAction, tryCandidate, legalActionCandidates, fallbackAction,
  serializeForAgent, assertDecisionState, extractTextContent, stripCodeFence,
  decideOpenAICompatible, decideJevDecisions, decideJevNative, decide, decideHierarchical, protocolCapabilityCache,
  registerModelCapabilities,
  heroHandSummary,
  BENCHMARK_MODES, DECISION_ARCHITECTURES, DEFAULT_BENCHMARK_MODE, DEFAULT_DECISION_ARCHITECTURE,
  REPRESENTATION_MODES, DEFAULT_REPRESENTATION_MODE, DECISION_ARCHITECTURE_VERSION,
  legalAggressiveSizes, buildHierarchicalDecision, familyCriteria, sizeCriteria,
  applyBenchmarkMode, renderDecisionState, aggregateActionProbabilitiesByFamily, probabilityStats, SIZE_LABELS,
  isAggressiveType, familyForActionType, FAMILY_LABELS, decisionClockPhase, isReasoningModel, wantsReasoning,
} from './lib/decision-core.js';
// Table sound effects. esbuild inlines these as data URLs at build time (see
// build.mjs), so the bundled and single-file builds both carry the audio and no
// separate asset request or MIME entry is needed.
import soundDeal from './assets/card-deal.mp3';
import soundBoard from './assets/board-cards.mp3';
import soundChip from './assets/chip-bet.mp3';
import soundChipDrop from './assets/chip-drop.mp3';
import soundAllIn from './assets/all-in-chips.mp3';
import soundWinner from './assets/winner-bell.mp3';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const els = {
  startTopBtn: $('#startTopBtn'), seatsBtn: $('#seatsBtn'), soundBtn: $('#soundBtn'), recordBtn: $('#recordBtn'), exportBtn: $('#exportBtn'), setupBtn: $('#setupBtn'), testsBtn: $('#testsBtn'), pauseBtn: $('#pauseBtn'), stopBtn: $('#stopBtn'),
  statusDot: $('#statusDot'), statusLabel: $('#statusLabel'), tournamentMeta: $('#tournamentMeta'),
  pokerTable: $('#pokerTable'), tableArena: $('#tableArena'), seatsLayer: $('#seatsLayer'), fxLayer: $('#fxLayer'), actionToast: $('#actionToast'), board: $('#board'), potChips: $('#potChips'), dealerMarker: $('#dealerMarker'), smallBlindMarker: $('#smallBlindMarker'), bigBlindMarker: $('#bigBlindMarker'), potValue: $('#potValue'), blindsValue: $('#blindsValue'), anteValue: $('#anteValue'), handValue: $('#handValue'), levelValue: $('#levelValue'),
  decisionPanelTitle: $('#decisionPanelTitle'), decisionEmpty: $('#decisionEmpty'), decisionCard: $('#decisionCard'), decisionPlayer: $('#decisionPlayer'), decisionModel: $('#decisionModel'), decisionPhase: $('#decisionPhase'), decisionClock: $('#decisionClock'), bankClock: $('#bankClock'), decisionHand: $('#decisionHand'), decisionStreet: $('#decisionStreet'), decisionPosition: $('#decisionPosition'), decisionOptionCount: $('#decisionOptionCount'), decisionActionLabel: $('#decisionActionLabel'), decisionActionHint: $('#decisionActionHint'), legalActions: $('#legalActions'), decisionReasoning: $('#decisionReasoning'), decisionLabelHand: $('#decisionLabelHand'), decisionLabelStreet: $('#decisionLabelStreet'), decisionLabelPosition: $('#decisionLabelPosition'), decisionLabelOptions: $('#decisionLabelOptions'),
  decisionFeed: $('#decisionFeed'), decisionFeedSummary: $('#decisionFeedSummary'), eventLog: $('#eventLog'), logSummary: $('#logSummary'), logTabCount: $('#logTabCount'), logSearch: $('#logSearch'), logFilter: $('#logFilter'), logClear: $('#logClear'), statsGrid: $('#statsGrid'),
  setupDialog: $('#setupDialog'), setupForm: $('#setupForm'), closeSetup: $('#closeSetup'), setupError: $('#setupError'), saveSettingsBtn: $('#saveSettingsBtn'), seatSummary: $('#seatSummary'),
  connectionsEditor: $('#connectionsEditor'), connectionRowTemplate: $('#connectionRowTemplate'), addConnectionBtn: $('#addConnectionBtn'),
  seatDialog: $('#seatDialog'), seatForm: $('#seatForm'), closeSeat: $('#closeSeat'), seatDialogTitle: $('#seatDialogTitle'), seatLockNotice: $('#seatLockNotice'),
  seatName: $('#seatName'), seatConnection: $('#seatConnection'), seatModel: $('#seatModel'), seatModelOptions: $('#seatModelOptions'), seatModelStatus: $('#seatModelStatus'), refreshModelsBtn: $('#refreshModelsBtn'), seatProtocol: $('#seatProtocol'), seatProvider: $('#seatProvider'), seatCaptureReasoning: $('#seatCaptureReasoning'), seatError: $('#seatError'), removeSeatBtn: $('#removeSeatBtn'), cancelSeatBtn: $('#cancelSeatBtn'), saveSeatBtn: $('#saveSeatBtn'),
  testsDialog: $('#testsDialog'), closeTests: $('#closeTests'), runTestsBtn: $('#runTestsBtn'), clearTestsBtn: $('#clearTestsBtn'), testsStatus: $('#testsStatus'), testsParticipants: $('#testsParticipants'), testsProgressLabel: $('#testsProgressLabel'), testsProgressFill: $('#testsProgressFill'), testsResults: $('#testsResults'),
  replayDialog: $('#replayDialog'), closeReplay: $('#closeReplay'), replayTitle: $('#replayTitle'), replayBadge: $('#replayBadge'), replaySubtitle: $('#replaySubtitle'), replayOpponents: $('#replayOpponents'), replayStreet: $('#replayStreet'), replayBoard: $('#replayBoard'), replayPot: $('#replayPot'), replayHero: $('#replayHero'), replaySummary: $('#replaySummary'), replayAction: $('#replayAction'), replayReason: $('#replayReason'), replayReasoning: $('#replayReasoning'), replayHistory: $('#replayHistory'), replayLegal: $('#replayLegal'), replayLegalSummary: $('#replayLegalSummary'), replayShareStatus: $('#replayShareStatus'), copyReplayImage: $('#copyReplayImage'), shareReplayImage: $('#shareReplayImage'), saveReplayImage: $('#saveReplayImage'),
};

let engineModule = null;
let director = null;
let currentState = null;
let clockTimer = null;
let rowSeq = 0;
let soundEnabled = false;
let audioContext = null;
let soundMasterGain = null;
let lastVisualState = null;
let lastProcessedEventId = null;
const MAX_LOBBY_SEATS = TABLE_DEFAULTS.maxPlayers;
const WINNER_REVIEW_MS = 2_000;
let seatAssignments = Array(MAX_LOBBY_SEATS).fill(null);
let editingSeatIndex = null;
let seatNameAuto = false;
let lobbyVisible = true;
let pendingAutostart = false;
let arenaMaxDecisions = 0;
const modelCatalogCache = new Map();
let capabilityPrime = null;
const OPENROUTER_DECISION_MODELS = Object.freeze([
  { id: 'typesafe/jev-1.13', name: 'TypeSafe · Jev 1.13 · Decisions API' },
  { id: '~typesafe/jev-latest', name: 'TypeSafe · Jev Latest · Decisions API' },
]);
let sanityResults = [];
let sanityRunAbort = null;
let activeInspectorTab = 'live';
const logView = { query: '', filter: 'all' };
let activeDecisionClockId = null;
let tableRecording = null;
let currentReplayEvent = null;
const renderMemo = { status: '', table: '', decision: '', feed: '', events: '', stats: '' };

function effectsAllowed() {
  return document.visibilityState === 'visible';
}
function animationsAllowed({ allowDuringRecording = false } = {}) {
  return (allowDuringRecording || !tableRecording)
    && effectsAllowed()
    && !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

function getAudioContext() {
  if (!audioContext) {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (Ctx) audioContext = new Ctx();
  }
  return audioContext;
}
function soundMaster() {
  const ctx = getAudioContext();
  if (!ctx) return null;
  if (!soundMasterGain) {
    soundMasterGain = ctx.createGain();
    soundMasterGain.gain.value = 1;
    soundMasterGain.connect(ctx.destination);
  }
  return soundMasterGain;
}
function tone(freq, duration = 0.05, gain = 0.035, offset = 0, type = 'sine') {
  if (!soundEnabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  const start = ctx.currentTime + offset;
  const osc = ctx.createOscillator(), amp = ctx.createGain();
  osc.type = type; osc.frequency.setValueAtTime(freq, start);
  amp.gain.setValueAtTime(0.0001, start); amp.gain.exponentialRampToValueAtTime(gain, start + 0.008);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  osc.connect(amp).connect(soundMaster() || ctx.destination); osc.start(start); osc.stop(start + duration + 0.02);
}

const TABLE_SOUND_URLS = Object.freeze({
  deal: soundDeal,
  board: soundBoard,
  chip: soundChip,
  fold: soundChipDrop,
  check: soundChipDrop,
  allin: soundAllIn,
  winner: soundWinner,
});
const TABLE_SOUND_GAIN = Object.freeze({ deal: 0.9, board: 0.7, chip: 0.8, fold: 0.8, check: 0.8, allin: 0.8, winner: 0.9 });
const tableSoundBuffers = new Map();
const tableSoundLoads = new Map();
let tableSoundsPreloaded = false;

function loadTableSound(kind) {
  const url = TABLE_SOUND_URLS[kind];
  if (!url) return Promise.resolve(null);
  if (tableSoundBuffers.has(kind)) return Promise.resolve(tableSoundBuffers.get(kind));
  if (tableSoundLoads.has(kind)) return tableSoundLoads.get(kind);
  const ctx = getAudioContext();
  if (!ctx || typeof fetch !== 'function') return Promise.resolve(null);
  const load = fetch(url)
    .then(response => { if (!response.ok) throw new Error(`Sound asset ${kind} unavailable`); return response.arrayBuffer(); })
    .then(bytes => ctx.decodeAudioData(bytes))
    .then(buffer => { tableSoundBuffers.set(kind, buffer); return buffer; })
    .catch(() => null)
    .finally(() => tableSoundLoads.delete(kind));
  tableSoundLoads.set(kind, load);
  return load;
}
function preloadTableSounds() {
  if (tableSoundsPreloaded) return;
  tableSoundsPreloaded = true;
  for (const kind of Object.keys(TABLE_SOUND_URLS)) void loadTableSound(kind);
}
// Synthesized cues remain as an immediate fallback while an asset is decoding
// (or if it can never be loaded), so feedback is never silent.
function playSynthTableSound(kind) {
  if (kind === 'deal' || kind === 'board') { tone(720, .035, .018, 0, 'triangle'); tone(510, .04, .014, .035, 'triangle'); }
  else if (kind === 'chip') { tone(1320, .028, .025, 0, 'square'); tone(940, .035, .018, .026, 'square'); }
  else if (kind === 'fold') { tone(240, .08, .018, 0, 'triangle'); }
  else if (kind === 'check') { tone(480, .035, .015, 0, 'sine'); }
  else if (kind === 'allin') { tone(300, .09, .022, 0, 'sawtooth'); tone(180, .12, .02, .07, 'sawtooth'); }
  else if (kind === 'winner') { tone(523, .12, .028, 0); tone(659, .12, .026, .1); tone(784, .18, .03, .2); }
}
function playTableSound(kind) {
  if (!soundEnabled) return;
  const ctx = getAudioContext();
  const buffer = tableSoundBuffers.get(kind);
  if (ctx && buffer) {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const source = ctx.createBufferSource(), amp = ctx.createGain();
    source.buffer = buffer;
    amp.gain.value = TABLE_SOUND_GAIN[kind] ?? 0.85;
    source.connect(amp).connect(soundMaster() || ctx.destination);
    source.start();
    return;
  }
  void loadTableSound(kind);
  playSynthTableSound(kind);
}
function isAllInDecision(event) {
  const action = event?.action || {};
  if (/\ball[- ]?in\b/i.test(action.description || '')) return true;
  const amount = Number(action.amount), stack = Number(event?.replay?.hero?.stack);
  return Number.isFinite(amount) && Number.isFinite(stack) && stack > 0 && amount >= stack;
}
function elementCenter(el, relativeTo) {
  if (!el || !relativeTo) return null;
  const r = el.getBoundingClientRect(), p = relativeTo.getBoundingClientRect();
  return { x: r.left - p.left + r.width / 2, y: r.top - p.top + r.height / 2 };
}
function flyChips(fromEl, toEl, count = 3, reverse = false) {
  // Sound is an event effect, not an animation. Keep it active while recording.
  playTableSound('chip');
  // Winner payouts remain visible in recordings; routine chip motion is
  // suppressed there to keep frame capture light.
  if (!animationsAllowed({ allowDuringRecording: reverse }) || !els.fxLayer || !fromEl || !toEl) return;
  const tight = els.pokerTable?.dataset?.density === 'tight';
  count = Math.min(count, tight ? (reverse ? 3 : 2) : (reverse ? 5 : 3));
  const from = elementCenter(fromEl, els.fxLayer), to = elementCenter(toEl, els.fxLayer);
  if (!from || !to) return;
  for (let i = 0; i < count; i++) {
    const chip = document.createElement('span'); chip.className = `flying-chip chip-${i % 3}`;
    chip.style.left = `${from.x - 8 + i * 3}px`; chip.style.top = `${from.y - 8 - i * 2}px`; els.fxLayer.append(chip);
    chip.animate([
      { transform: 'translate3d(0,0,0) scale(.8)', opacity: 0 },
      { opacity: 1, offset: .12 },
      { transform: `translate3d(${to.x - from.x}px, ${to.y - from.y}px, 0) scale(1.05)`, opacity: 1, offset: .84 },
      { transform: `translate3d(${to.x - from.x}px, ${to.y - from.y}px, 0) scale(.65)`, opacity: 0 },
    ], { duration: 520 + i * 55, delay: i * 45, easing: reverse ? 'cubic-bezier(.2,.8,.2,1)' : 'cubic-bezier(.2,.75,.15,1)', fill: 'forwards' }).finished.finally(() => chip.remove());
  }
}
function showActionToast(text, type = '') {
  if (!els.actionToast) return;
  els.actionToast.textContent = text;
  els.actionToast.className = `action-toast ${String(type).toLowerCase()}`;
  els.pokerTable?.classList.add('action-message-visible');
  clearTimeout(showActionToast.timer);
  showActionToast.timer = setTimeout(() => {
    els.actionToast.classList.add('hidden');
    els.pokerTable?.classList.remove('action-message-visible');
  }, 1550);
}
function seatEl(playerId) { return $(`.table-seat[data-player-id="${CSS.escape(String(playerId))}"]`, els.seatsLayer); }
function stopTableEffects() {
  clearTimeout(showActionToast.timer);
  els.actionToast?.classList.add('hidden');
  els.pokerTable?.classList.remove('action-message-visible');
  els.fxLayer?.replaceChildren();
  for (const el of $$('.table-seat.fold-flash, .table-seat.check-flash'))
    { el.classList.remove('fold-flash'); el.classList.remove('check-flash'); }
}
function animateNewHand(s) {
  if (!animationsAllowed()) return;
  requestAnimationFrame(() => {
    const cards = $$('.table-seat .playing-card', els.seatsLayer);
    const tableRect = els.pokerTable?.getBoundingClientRect();
    cards.forEach((card, i) => {
      const rect = card.getBoundingClientRect();
      const dx = tableRect ? (tableRect.left + tableRect.width * .5) - (rect.left + rect.width * .5) : 0;
      const dy = tableRect ? (tableRect.top + tableRect.height * .5) - (rect.top + rect.height * .5) : -80;
      const rotate = (i % 2 ? -1 : 1) * (8 + (i % 3) * 2);
      card.animate([
        { transform: `translate3d(${dx}px,${dy}px,0) rotate(${rotate}deg) scale(.82)`, opacity: 0 },
        { opacity: 1, offset: .18 },
        { transform: 'translate3d(0,0,0) rotate(0deg) scale(1)', opacity: 1 }
      ], { duration: 520, delay: 34 * i, easing: 'cubic-bezier(.16,.88,.24,1)', fill: 'both' });
    });
  });
}
function animateBoardCards(previousCount, currentCount) {
  if (!animationsAllowed() || currentCount <= previousCount) return;
  requestAnimationFrame(() => {
    $$('.board .card', els.board).slice(previousCount, currentCount).forEach((card, i) => {
      card.animate([
        { transform: 'translateY(-18px) rotateY(88deg) scale(.88)', opacity: .15 },
        { transform: 'translateY(0) rotateY(0deg) scale(1)', opacity: 1 }
      ], { duration: 420, delay: i * 100, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' });
    });
  });
}
function processVisualEffects(s) {
  const events = s?.events || [];
  const previous = lastVisualState;
  if (['STOPPED', 'ERROR'].includes(s?.status)) {
    if (events.length) lastProcessedEventId = events.at(-1).id;
    lastVisualState = s;
    stopTableEffects();
    return;
  }
  // Recording disables routine motion, but it must not disable sound/event processing.
  if (!effectsAllowed()) {
    if (events.length) lastProcessedEventId = events.at(-1).id;
    lastVisualState = s;
    return;
  }
  if (s?.table && (!previous?.table || s.table.handNumber !== previous.table.handNumber)) {
    if ($$('.table-seat .playing-card', els.seatsLayer).length) playTableSound('deal');
    animateNewHand(s);
  }
  const prevBoard = previous?.table?.board?.length || 0, nextBoard = s?.table?.board?.length || 0;
  if (s?.table?.handNumber === previous?.table?.handNumber && nextBoard > prevBoard) {
    playTableSound('board');
    animateBoardCards(prevBoard, nextBoard);
  }

  let start = 0;
  if (lastProcessedEventId) { const idx = events.findIndex(e => e.id === lastProcessedEventId); start = idx >= 0 ? idx + 1 : Math.max(0, events.length - 4); }
  for (const e of events.slice(start)) {
    if (e.type === 'DECISION') {
      const seat = seatEl(e.playerId), pot = $('.hud-pot', document);
      const type = e.action?.type || '';
      if ([ACTION.CALL, ACTION.BET, ACTION.RAISE].includes(type)) {
        flyChips(seat, pot, type === ACTION.RAISE ? 4 : 3);
        if (isAllInDecision(e)) playTableSound('allin');
      }
      if (type === ACTION.FOLD && seat) {
        if (animationsAllowed()) { seat.classList.add('fold-flash'); setTimeout(() => seat.classList.remove('fold-flash'), 650); }
        playTableSound('fold');
      }
      if (type === ACTION.CHECK && seat) {
        if (animationsAllowed()) { seat.classList.add('check-flash'); setTimeout(() => seat.classList.remove('check-flash'), 500); }
        playTableSound('check');
      }
      // The action already lives immediately above this player's cards. Keep
      // the middle of the felt clear instead of repeating it there.
    }
    if (e.type === 'HAND_END') {
      const before = new Map((previous?.table?.players || []).filter(Boolean).map(p => [p.id, Number(p.stack || 0)]));
      const payloadIds = (e.winners || []).map(w => w?.playerId ?? w?.id ?? w).filter(Boolean);
      const fromStacks = (s?.table?.players || [])
        .filter(p => p && Number(p.stack || 0) > (before.get(p.id) ?? Number(p.stack || 0)))
        .map(p => p.id);
      const winnerIds = [...new Set([...payloadIds, ...fromStacks])];
      const pot = $('.hud-pot', document);
      winnerIds.forEach((playerId, i) => setTimeout(() => flyChips(pot, seatEl(playerId), 5, true), i * 130));
      if (winnerIds.length) playTableSound('winner');
    }
    if (e.type === 'TOURNAMENT_END') playTableSound('winner');
  }
  if (events.length) lastProcessedEventId = events.at(-1).id;
  lastVisualState = s;
}

function injectedEnvironmentConfig() {
  const raw = globalThis.__POKERTOOLS_ENV__;
  if (!raw || typeof raw !== 'object') return null;
  const connections = Array.isArray(raw.connections) ? raw.connections.filter(c => c && c.baseUrl) : [];
  const players = Array.isArray(raw.players) ? raw.players.filter(p => p && p.model) : [];
  if (!connections.length && !players.length) return null;
  const settings = raw.settings && typeof raw.settings === 'object'
    ? {
      startingStack: Math.max(CONFIG_LIMITS.startingStack.min, Math.round(Number(raw.settings.startingStack) || TABLE_DEFAULTS.startingStack)),
      autostart: Boolean(raw.settings.autostart),
      maxDecisions: Math.max(0, Math.round(Number(raw.settings.maxDecisions) || 0)),
    }
    : null;
  return {
    settings,
    connections: connections.map((c, index) => ({
      id: String(c.id || `env-connection-${index + 1}`),
      name: String(c.name || 'API'),
      kind: ['openai','openrouter','typesafe'].includes(c.kind) ? c.kind : 'openai',
      baseUrl: String(c.baseUrl || CONNECTION_PRESETS.openai),
      apiKey: String(c.apiKey || ''),
      headers: String(c.headers || ''),
    })),
    players: players.slice(0, MAX_LOBBY_SEATS).map((player, index) => ({
      lobbySeat: clamp(Math.round(Number(player.lobbySeat ?? index)), 0, MAX_LOBBY_SEATS - 1),
      name: String(player.name || `Player ${index + 1}`),
      connectionId: String(player.connectionId || connections[0]?.id || ''),
      model: String(player.model || ''),
      protocol: String(player.protocol || 'tool'),
      provider: String(player.provider || ''),
      captureReasoning: Boolean(player.captureReasoning),
    })),
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}
function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }
function formatDuration(ms) {
  const total = Math.max(0, Math.round(asNumber(ms) / 1000));
  const minutes = Math.floor(total / 60), seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
function fmtHud(n) {
  const value = asNumber(n);
  const abs = Math.abs(value);
  if (abs < 10_000) return fmt(value);
  const units = ['', 'K', 'M', 'B', 'T', 'Q'];
  const tier = Math.min(units.length - 1, Math.floor(Math.log10(abs) / 3));
  if (tier <= 0) return fmt(value);
  const scaled = value / (1000 ** tier);
  const digits = Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
  return `${Number(scaled.toFixed(digits)).toLocaleString('en-US', { maximumFractionDigits: digits })}${units[tier]}`;
}
function shortModel(model = '') { const bits = String(model).replace(/^~/, '').split('/'); return bits.at(-1) || model; }
function displayModelName(model = '') {
  const raw = shortModel(model).trim();
  const lower = raw.toLowerCase();
  if (!raw) return 'Model';
  if (lower.startsWith('jev')) return 'Jev';
  if (lower.startsWith('gemma')) return 'Gemma';
  if (lower.startsWith('qwen')) return lower.includes('flash') ? 'Qwen Flash' : 'Qwen';
  if (lower.startsWith('claude')) return 'Claude';
  if (lower.startsWith('deepseek')) return 'DeepSeek';
  if (lower.startsWith('llama')) return 'Llama';
  if (lower.startsWith('mistral') || lower.startsWith('ministral')) return 'Mistral';
  if (lower.startsWith('gpt-oss')) return 'GPT OSS';
  if (lower.startsWith('gpt')) return 'GPT';
  if (/^o[134](?:-|$)/i.test(raw)) return raw.match(/^o[134]/i)?.[0]?.toUpperCase() || raw;
  if (lower.startsWith('glm')) return 'GLM';
  const simplified = raw
    .replace(/[-_]?v?\d+(?:\.\d+)+(?:[-_]|$).*/i, '')
    .replace(/[-_]?\d+(?:b|m|k)(?:[-_].*)?$/i, '')
    .replace(/[-_]+$/g, '')
    .trim();
  return simplified ? simplified.replace(/(^|[-_\s])([a-z])/g, (_, a, b) => `${a}${b.toUpperCase()}`) : raw;
}
function visiblePlayerName(name = '', model = '') {
  return /^Player\s+\d+$/i.test(String(name).trim()) ? displayModelName(model) : String(name || displayModelName(model));
}
function protocolDisplay(protocol = '') {
  const value = String(protocol || '').toLowerCase();
  if (value === 'json_schema') return 'JSON Schema';
  if (value === 'jev_decisions' || value === 'openrouter-decisions') return 'Jev Decisions';
  if (value === 'jev_native') return 'Jev Native';
  if (value === 'prompt_json') return 'Prompt JSON';
  if (value === 'tool') return 'Tool';
  return protocol ? String(protocol).replaceAll('_', ' ') : 'Protocol';
}
function ordinal(value) {
  const n = Number(value) || 0, mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}TH`;
  return `${n}${n % 10 === 1 ? 'ST' : n % 10 === 2 ? 'ND' : n % 10 === 3 ? 'RD' : 'TH'}`;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, Math.max(0, ms))); }
function storageGet(key) { try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; } }
function storageSet(key, value) { try { globalThis.localStorage?.setItem(key, value); return true; } catch { return false; } }
function id(prefix = 'id') { return `${prefix}-${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`; }
function cardHtml(card, empty = false, extraClass = '', rankOnlyCorners = false) {
  if (!card || empty) return `<div class="card empty ${extraClass}" aria-hidden="true"><span class="card-back-mark">♠</span></div>`;
  const raw = String(card).trim();
  const normalized = raw.replace(/10/i, 'T');
  const match = normalized.match(/^([2-9TJQKA])([shdc♠♥♦♣])$/i);
  const suitMap = { s: '♠', h: '♥', d: '♦', c: '♣', '♠': '♠', '♥': '♥', '♦': '♦', '♣': '♣' };
  const rank = match ? match[1].toUpperCase() : raw.slice(0, -1).toUpperCase();
  const suit = match ? suitMap[match[2].toLowerCase()] || match[2] : suitMap[raw.slice(-1).toLowerCase()] || raw.slice(-1);
  const red = suit === '♥' || suit === '♦';
  const corner = `<span class="card-corner"><b>${escapeHtml(rank)}</b>${rankOnlyCorners ? '' : `<i>${escapeHtml(suit)}</i>`}</span>`;
  const bottomCorner = `<span class="card-corner bottom"><b>${escapeHtml(rank)}</b>${rankOnlyCorners ? '' : `<i>${escapeHtml(suit)}</i>`}</span>`;
  return `<div class="card ${red ? 'red' : 'black'} ${rankOnlyCorners ? 'rank-only-corners' : ''} ${extraClass}" aria-label="${escapeHtml(rank + suit)}">${corner}<span class="card-suit">${escapeHtml(suit)}</span>${bottomCorner}</div>`;
}
function tableCardHtml(card, kind = 'board') {
  if (!card) return kind === 'board'
    ? '<span class="board-card board-card--empty" aria-label="Empty community card slot"></span>'
    : '';
  const raw = String(card).trim().replace(/10/i, 'T');
  const match = raw.match(/^([2-9TJQKA])([shdc♠♥♦♣])$/i);
  const suitMap = { s: '♠', h: '♥', d: '♦', c: '♣', '♠': '♠', '♥': '♥', '♦': '♦', '♣': '♣' };
  const rank = match ? match[1].toUpperCase() : raw.slice(0, -1).toUpperCase();
  const suit = match ? suitMap[match[2].toLowerCase()] || match[2] : suitMap[raw.slice(-1).toLowerCase()] || raw.slice(-1);
  const red = suit === '♥' || suit === '♦';
  return `<span class="playing-card ${kind === 'hole' ? 'hole-card' : 'board-card'} ${red ? 'red' : ''}" data-rank="${escapeHtml(rank)}" data-suit="${escapeHtml(suit)}" aria-label="${escapeHtml(rank + suit)}"></span>`;
}
function potChipsHtml(pot, { smallBlind = 0, bigBlind = 0, ante = 0 } = {}) {
  return potChipBreakdown(pot, { smallBlind, bigBlind, ante }).map(({ color, value, count, shown }) => {
    const chips = Array.from({ length: shown }, () => `<span class="pot-chip chip-${color}"></span>`).join('');
    const overflow = count > shown ? ` data-chip-count="×${count}"` : '';
    return `<span class="chip-stack"${overflow} title="${count} × ${fmt(value)} chips" aria-label="${count} ${color} chips worth ${fmt(value)} each">${chips}</span>`;
  }).join('');
}

async function loadPokerTools() {
  engineModule = { createBrowserEngine: createPokerToolsBrowserEngine };
  return engineModule;
}
function publicWinnerSummary(winners, players = []) {
  if (!Array.isArray(winners)) return [];
  const byId = new Map((players ?? []).filter(Boolean).map(p => [p.id, p]));
  return winners.map(w => {
    if (typeof w === 'string') {
      const player = byId.get(w);
      const seat = player ? players.findIndex(p => p?.id === player.id) : null;
      return { seat: seat >= 0 ? seat + 1 : null, playerId: w, playerName: player?.name ?? null, amount: null };
    }
    if (!w || typeof w !== 'object') return { value: String(w) };
    const rawSeat = Number.isInteger(w.seat) ? w.seat : (Number.isInteger(w.playerSeat) ? w.playerSeat : null);
    const seatPlayer = rawSeat != null ? players?.[rawSeat] : null;
    const playerId = w.playerId ?? w.id ?? seatPlayer?.id ?? null;
    const player = playerId ? byId.get(playerId) : seatPlayer;
    const resolvedSeat = rawSeat != null ? rawSeat : (player ? players.findIndex(p => p?.id === player.id) : null);
    return {
      seat: resolvedSeat != null && resolvedSeat >= 0 ? resolvedSeat + 1 : null,
      playerId,
      playerName: w.playerName ?? w.name ?? player?.name ?? null,
      amount: w.amount ?? w.winnings ?? w.payout ?? null,
      handRank: w.handRank ?? null,
    };
  });
}
function publicDecisionAction(e) {
  return {
    street: e.street ?? null,
    playerId: e.playerId ?? null,
    playerName: e.playerName ?? null,
    position: e.position ?? null,
    action: {
      type: e.action?.type ?? null,
      amount: e.action?.amount ?? null,
      description: e.action?.description ?? e.action?.type ?? null,
    },
    potBefore: e.potBefore ?? null,
  };
}
function buildCurrentHandPublicActions(events, currentHand) {
  return (events ?? []).filter(e => e.type === 'DECISION' && Number(e.handNumber) === Number(currentHand)).map(publicDecisionAction);
}
function buildPublicTournamentMemory(events, currentHand, limitHands = RECENT_PUBLIC_HANDS) {
  const completed = (events ?? []).filter(e => e.type === 'HAND_END' && Number(e.handNumber) < Number(currentHand)).slice(-limitHands);
  return completed.map(end => ({
    handNumber: end.handNumber,
    board: Array.isArray(end.board) ? end.board : [],
    winners: Array.isArray(end.winners) ? end.winners.map(w => ({ playerId: w.playerId ?? null, playerName: w.playerName ?? null, amount: w.amount ?? null })) : [],
    stacksAfter: Array.isArray(end.stacks) ? end.stacks.map(x => ({ seat: x.seat, name: x.name, stack: x.stack })) : [],
    actions: (events ?? []).filter(e => e.type === 'DECISION' && e.handNumber === end.handNumber).map(publicDecisionAction),
  }));
}
function pct(n, d) { return d > 0 ? round(n / d, 3) : 0; }
function buildPublicPlayerStats(events, players, currentHand) {
  const completedHandNumbers = new Set((events ?? []).filter(e => e.type === 'HAND_END' && Number(e.handNumber) < Number(currentHand)).map(e => Number(e.handNumber)));
  const decisions = (events ?? []).filter(e => e.type === 'DECISION' && completedHandNumbers.has(Number(e.handNumber)));
  const handEnds = (events ?? []).filter(e => e.type === 'HAND_END' && completedHandNumbers.has(Number(e.handNumber)));
  const handStarts = (events ?? []).filter(e => e.type === 'HAND_START' && completedHandNumbers.has(Number(e.handNumber)));
  return (players ?? []).map(player => {
    const rows = decisions.filter(e => e.playerId === player.id);
    const preflop = rows.filter(e => e.street === 'PREFLOP');
    const dealtHands = new Set(handStarts.filter(e => Array.isArray(e.playerIds) && e.playerIds.includes(player.id)).map(e => Number(e.handNumber)));
    if (!dealtHands.size) for (const e of rows) dealtHands.add(Number(e.handNumber));
    const vpipHands = new Set(preflop.filter(e => ['CALL','BET','RAISE'].includes(e.action?.type)).map(e => e.handNumber));
    const pfrHands = new Set(preflop.filter(e => ['BET','RAISE'].includes(e.action?.type)).map(e => e.handNumber));
    const aggressive = rows.filter(e => ['BET','RAISE'].includes(e.action?.type)).length;
    const calls = rows.filter(e => e.action?.type === 'CALL').length;
    const checks = rows.filter(e => e.action?.type === 'CHECK').length;
    const folds = rows.filter(e => e.action?.type === 'FOLD').length;
    const foldOpportunities = rows.filter(e => (e.legalActions ?? []).some(action => action.type === 'FOLD')).length;
    let wins = 0;
    const observedHands = new Set(dealtHands);
    for (const end of handEnds) {
      if ((end.winners ?? []).some(w => (w.playerId ?? w.id ?? w) === player.id)) { wins++; observedHands.add(Number(end.handNumber)); }
    }
    const strategicActions = aggressive + calls + checks + folds;
    return {
      playerId: player.id,
      playerName: player.name,
      sampleHands: observedHands.size,
      preflopSamples: dealtHands.size,
      decisions: rows.length,
      vpipPct: pct(vpipHands.size, dealtHands.size),
      pfrPct: pct(pfrHands.size, dealtHands.size),
      aggressionPct: pct(aggressive, aggressive + calls + folds),
      foldPct: pct(folds, foldOpportunities),
      callPct: pct(calls, strategicActions),
      checkPct: pct(checks, strategicActions),
      wins,
    };
  });
}
function spectatorState(engine, tournamentMeta = {}) {
  if (!engine) return null;
  const state = engine.state;
  const bb = Math.max(1, asNumber(state.bigBlind, 1));
  return {
    handNumber: tournamentMeta.handNumber ?? state.handNumber ?? 0, street: state.street, board: state.board ?? [], buttonSeat: state.buttonSeat,
    playersRemaining: tournamentMeta.playersRemaining ?? null, startingPlayers: tournamentMeta.startingPlayers ?? null,
    actionTo: state.actionTo, smallBlind: state.smallBlind, bigBlind: state.bigBlind, ante: state.ante, blindLevel: state.blindLevel, pot: totalPot(state),
    players: (state.players ?? []).map((p, seat) => p ? {
      id: p.id, name: p.name, seat, stack: playerStack(p), stackBB: round(playerStack(p) / bb, 1), cards: playerCards(p), currentBet: currentBet(state, seat),
      status: p.status, position: positionForSeat(state, seat),
    } : null),
    markers: tableMarkerSeats(state), winners: state.winners ?? null,
  };
}

function buildBlindStructure(config) {
  const levels = [];
  let sb = Math.max(1, Math.round(config.smallBlind));
  let bb = Math.max(sb * 2, Math.round(config.bigBlind));
  let ante = Math.max(0, Math.round(config.ante || 0));
  const multiplier = clamp(Number(config.blindMultiplier) || TABLE_DEFAULTS.blindMultiplier, CONFIG_LIMITS.blindMultiplier.min, CONFIG_LIMITS.blindMultiplier.max);
  const safe = value => Number.isSafeInteger(value) && value >= 0;
  for (let i = 0; i < 60; i++) {
    if (!safe(sb) || !safe(bb) || !safe(ante)) break;
    levels.push({ smallBlind: sb, bigBlind: bb, ante });
    const nextSb = Math.max(sb + 1, Math.round(sb * multiplier));
    const nextBb = Math.max(nextSb * 2, Math.round(bb * multiplier));
    const nextAnte = ante > 0 ? Math.max(1, Math.round(ante * multiplier)) : 0;
    if (!safe(nextSb) || !safe(nextBb) || !safe(nextAnte)) break;
    sb = nextSb; bb = nextBb; ante = nextAnte;
  }
  if (!levels.length) throw new Error('Unable to build a safe blind structure');
  return levels;
}
function normalizeConfig(input = {}) {
  const players = Array.isArray(input.players) ? input.players.slice(0, MAX_LOBBY_SEATS) : [];
  const connections = Array.isArray(input.connections) ? input.connections : [];
  if (players.length < 2) throw new Error('At least 2 players are required');
  if (!connections.length) throw new Error('Add at least one API connection');
  const names = new Set();
  const connIds = new Set(connections.map(c => c.id));
  const usedConnectionIds = new Set(players.map(p => p.connectionId));
  const cleanConnections = connections.filter(c => usedConnectionIds.has(c.id)).map(c => {
    if (!c.name) throw new Error('Every used connection must have a name');
    if (!c.baseUrl) throw new Error(`Base URL is missing: ${c.name}`);
    if ((isOpenRouterConnection(c) || c.kind === 'typesafe') && !c.apiKey) throw new Error(`API key is missing: ${c.name}`);
    parseHeaders(c.headers);
    return { ...c, baseUrl: normalizeBaseUrl(c.baseUrl) };
  });
  const smallBlind = Math.max(CONFIG_LIMITS.smallBlind.min, Math.round(Number(input.smallBlind) || TABLE_DEFAULTS.smallBlind));
  const bigBlind = Math.max(CONFIG_LIMITS.bigBlind.min, Math.round(Number(input.bigBlind) || TABLE_DEFAULTS.bigBlind));
  if (bigBlind < smallBlind * 2) throw new Error('Big blind must be at least twice the small blind');
  return {
    id: id('tournament'), name: 'pokertools-arena', startingStack: Math.max(CONFIG_LIMITS.startingStack.min, Math.round(Number(input.startingStack) || TABLE_DEFAULTS.startingStack)),
    smallBlind, bigBlind, ante: Math.max(CONFIG_LIMITS.ante.min, Math.round(Number(input.ante) || TABLE_DEFAULTS.ante)),
    handsPerLevel: Math.max(CONFIG_LIMITS.handsPerLevel.min, Math.round(Number(input.handsPerLevel) || TABLE_DEFAULTS.handsPerLevel)), blindMultiplier: clamp(Number(input.blindMultiplier) || TABLE_DEFAULTS.blindMultiplier, CONFIG_LIMITS.blindMultiplier.min, CONFIG_LIMITS.blindMultiplier.max),
    actionSeconds: clamp(Number(input.actionSeconds) || TIMING_DEFAULTS.actionSeconds, CONFIG_LIMITS.actionSeconds.min, CONFIG_LIMITS.actionSeconds.max), timeBankSeconds: clamp(Number(input.timeBankSeconds) || TIMING_DEFAULTS.timeBankSeconds, CONFIG_LIMITS.timeBankSeconds.min, CONFIG_LIMITS.timeBankSeconds.max),
    lowTimeSeconds: clamp(Number.isFinite(Number(input.lowTimeSeconds)) ? Number(input.lowTimeSeconds) : TIMING_DEFAULTS.lowTimeSeconds, CONFIG_LIMITS.lowTimeSeconds.min, CONFIG_LIMITS.lowTimeSeconds.max),
    lowTimeFraction: clamp(Number.isFinite(Number(input.lowTimeFraction)) ? Number(input.lowTimeFraction) : TIMING_DEFAULTS.lowTimeFraction, CONFIG_LIMITS.lowTimeFraction.min, CONFIG_LIMITS.lowTimeFraction.max),
    betweenActionsMs: clamp(Number(input.betweenActionsMs) || TIMING_DEFAULTS.betweenActionsMs, CONFIG_LIMITS.betweenActionsMs.min, CONFIG_LIMITS.betweenActionsMs.max), betweenHandsMs: clamp(Number(input.betweenHandsMs) || TIMING_DEFAULTS.betweenHandsMs, CONFIG_LIMITS.betweenHandsMs.min, CONFIG_LIMITS.betweenHandsMs.max),
    connections: cleanConnections,
    benchmarkMode: input.benchmarkMode === BENCHMARK_MODES.RAW ? BENCHMARK_MODES.RAW : DEFAULT_BENCHMARK_MODE,
    decisionArchitecture: input.decisionArchitecture === DECISION_ARCHITECTURES.FLAT ? DECISION_ARCHITECTURES.FLAT : DEFAULT_DECISION_ARCHITECTURE,
    representation: REPRESENTATION_MODES.includes(input.representation) ? input.representation : DEFAULT_REPRESENTATION_MODE,
    spectatorExplanations: Boolean(input.spectatorExplanations),
    maxDecisions: Math.max(0, Math.round(Number(input.maxDecisions) || 0)),
    players: players.map((raw, index) => {
      const lobbySeat = clamp(Math.round(Number(raw.lobbySeat ?? index)), 0, MAX_LOBBY_SEATS - 1);
      const name = String(raw.name || `Player ${lobbySeat + 1}`).trim().slice(0, 40);
      const nameKey = name.toLocaleLowerCase();
      if (names.has(nameKey)) throw new Error(`Duplicate player name: ${name}`);
      names.add(nameKey);
      if (!connIds.has(raw.connectionId)) throw new Error(`Connection missing for ${name}`);
      const model = String(raw.model || '').trim();
      if (!model) throw new Error(`Model missing for ${name}`);
      return { id: `player-${lobbySeat + 1}`, seat: index, lobbySeat, name, connectionId: raw.connectionId, model, protocol: raw.protocol || 'tool', provider: String(raw.provider || '').trim(), captureReasoning: raw.captureReasoning === true, temperature: clamp(Number(raw.temperature) || 0.3, 0, 2) };
    }),
  };
}

class TournamentDirector {
  constructor({ onUpdate = () => {} } = {}) {
    this.onUpdate = onUpdate; this.status = 'IDLE'; this.config = null; this.engine = null; this.currentDecision = null; this.events = [];
    this.stats = {}; this.timeBanks = {}; this.eliminations = []; this.handNumber = 0; this.startedAt = null; this.finishedAt = null; this.winner = null;
    this.abortController = null; this.pauseResolvers = []; this.runPromise = null;
    this.explanationChain = Promise.resolve();
    this.decisionBudget = 0; this.decisionCount = 0; this.budgetReached = false;
    this.persistTimer = null; this.publicStatsVersion = 0; this.publicStatsCache = []; this.publicStatsCacheVersion = -1; this.publicStatsCacheHand = -1;
  }
  publicConfig() {
    if (!this.config) return null;
    return {
      ...this.config,
      connections: this.config.connections.map(({ apiKey, headers, ...c }) => ({ ...c })),
      players: this.config.players.map(p => ({ ...p })),
    };
  }
  async start(rawConfig) {
    if (!engineModule) await loadPokerTools();
    if (['RUNNING', 'PAUSED'].includes(this.status)) throw new Error('Tournament already running');
    this.config = normalizeConfig(rawConfig); this.status = 'RUNNING'; this.startedAt = Date.now(); this.finishedAt = null; this.winner = null;
    this.events = []; this.eliminations = []; this.handNumber = 0; this.currentDecision = null; this.abortController = new AbortController(); this.stats = {}; this.timeBanks = {};
    this.decisionBudget = this.config.maxDecisions; this.decisionCount = 0; this.budgetReached = false;
    this.publicStatsVersion = 0; this.publicStatsCache = []; this.publicStatsCacheVersion = -1; this.publicStatsCacheHand = -1;
    this.engine = engineModule.createBrowserEngine({
      smallBlind: this.config.smallBlind, bigBlind: this.config.bigBlind, ante: this.config.ante, maxPlayers: this.config.players.length,
      blindStructure: buildBlindStructure(this.config), timeBankSeconds: this.config.timeBankSeconds, rakePercent: 0, validateIntegrity: true,
    });
    for (const player of this.config.players) {
      this.engine.sit(player.seat, player.id, player.name, this.config.startingStack);
      this.timeBanks[player.id] = this.config.timeBankSeconds * 1000;
      this.stats[player.id] = { decisions: 0, invalid: 0, modelErrors: 0, providerErrors: 0, rateLimits: 0, timeouts: 0, autoFallbacks: 0, protocolFallbacks: 0, retries: 0, totalLatencyMs: 0, lastAction: null, lastActionType: null, lastActionAmount: null, lastReason: '' };
    }
    this.logEvent('TOURNAMENT_START', { config: this.publicConfig() }); this.broadcast();
    this.runPromise = this.run().catch(err => {
      if (this.status !== 'STOPPED') { this.status = 'ERROR'; this.logEvent('TOURNAMENT_ERROR', { error: summarizeError(err) }); this.broadcast(); }
    });
    return this.snapshot();
  }
  pause() {
    if (this.status === 'RUNNING') {
      this.status = 'PAUSED';
      if (this.currentDecision && !this.currentDecision.pausedAt) this.currentDecision.pausedAt = Date.now();
      this.broadcast();
    }
  }
  resume() {
    if (this.status === 'PAUSED') {
      if (this.currentDecision?.pausedAt) {
        this.currentDecision.pausedMs = (this.currentDecision.pausedMs || 0) + Math.max(0, Date.now() - this.currentDecision.pausedAt);
        this.currentDecision.pausedAt = null;
      }
      this.status = 'RUNNING';
      for (const resolve of this.pauseResolvers.splice(0)) resolve();
      this.broadcast();
    }
  }
  stop() { if (['RUNNING', 'PAUSED'].includes(this.status)) { this.status = 'STOPPED'; this.abortController?.abort(); for (const resolve of this.pauseResolvers.splice(0)) resolve(); this.persistLightweight(); this.broadcast(); } }
  async waitIfPaused() { while (this.status === 'PAUSED') await new Promise(resolve => this.pauseResolvers.push(resolve)); if (this.status === 'STOPPED') throw new Error('Tournament stopped'); }
  playersRemaining() { return (this.engine?.state?.players ?? []).map((p, seat) => ({ p, seat })).filter(({ p }) => p && playerStack(p) > 0); }
  tournamentMeta() {
    const startingPlayers = this.config?.players.length ?? 0;
    const eliminatedPlayerIds = this.eliminations.map(e => e.playerId);
    return {
      handNumber: this.handNumber,
      playersRemaining: this.playersRemaining().length,
      startingPlayers, levelIndex: this.engine?.state?.blindLevel ?? 0, eliminatedPlayerIds,
      benchmarkMode: this.config?.benchmarkMode ?? DEFAULT_BENCHMARK_MODE,
      decisionArchitecture: this.config?.decisionArchitecture ?? DEFAULT_DECISION_ARCHITECTURE,
      representation: this.config?.representation ?? DEFAULT_REPRESENTATION_MODE,
    };
  }
  snapshot() {
    const statsHand = this.status === 'FINISHED' ? this.handNumber + 1 : this.handNumber;
    if (this.config && (this.publicStatsCacheVersion !== this.publicStatsVersion || this.publicStatsCacheHand !== statsHand)) {
      this.publicStatsCache = buildPublicPlayerStats(this.events, this.config.players, statsHand);
      this.publicStatsCacheVersion = this.publicStatsVersion;
      this.publicStatsCacheHand = statsHand;
    }
    const publicPlayerStats = this.config ? this.publicStatsCache : [];
    return { tournamentId: this.config?.id ?? null, status: this.status, config: this.publicConfig(), startedAt: this.startedAt, finishedAt: this.finishedAt, winner: this.winner,
      eliminations: [...this.eliminations], currentDecision: this.currentDecision, table: spectatorState(this.engine, this.tournamentMeta()), stats: this.stats, publicPlayerStats, timeBanks: this.timeBanks, events: this.events.slice(-HISTORY_CONFIG.snapshotEvents) };
  }
  broadcast() { this.onUpdate(this.snapshot()); }
  logEvent(type, data = {}) {
    const event = { id: id('event'), at: Date.now(), type, ...jsonSafe(data) };
    this.events.push(event);
    this.schedulePersist(); return event;
  }
  schedulePersist() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => { this.persistTimer = null; this.persistLightweight(); }, 900);
  }
  persistLightweight() {
    try {
      const state = this.snapshot();
      const lightweight = { ...state, events: state.events.slice(-HISTORY_CONFIG.persistedEvents), currentDecision: null };
      storageSet('pokertoolsArenaLastState', JSON.stringify(lightweight));
    } catch {}
  }
  async run() {
    while (['RUNNING', 'PAUSED'].includes(this.status)) {
      await this.waitIfPaused();
      const remaining = this.playersRemaining();
      if (remaining.length <= 1) { this.finish(remaining[0]?.p ?? null); return; }
      if (this.handNumber > 0 && this.handNumber % this.config.handsPerLevel === 0) {
        try { this.engine.nextBlindLevel(); this.logEvent('BLINDS_UP', { level: this.engine.state.blindLevel, smallBlind: this.engine.state.smallBlind, bigBlind: this.engine.state.bigBlind, ante: this.engine.state.ante }); }
        catch (err) { this.logEvent('BLINDS_UP_FAILED', { error: summarizeError(err) }); }
      }
      await this.startHand(); await this.playHand(); this.completeHand(); this.broadcast();
      if (this.budgetReached) { this.logEvent('DECISION_BUDGET_REACHED', { decisions: this.decisionCount, budget: this.decisionBudget }); this.stop(); return; }
      await this.waitIfPaused(); await sleep(Math.max(WINNER_REVIEW_MS, this.config.betweenHandsMs));
    }
  }
  pruneBustedSeats() {
    const failures = [];
    for (const p of (this.engine?.state?.players ?? [])) {
      if (!p || playerStack(p) > 0) continue;
      try { this.engine.stand(p.id); } catch (error) { failures.push(`${p.name}: ${summarizeError(error)}`); }
    }
    if (failures.length) throw new Error(`Could not remove busted player(s): ${failures.join('; ')}`);
  }
  async startHand() {
    await this.waitIfPaused(); this.pruneBustedSeats();
    for (const stat of Object.values(this.stats)) { stat.lastAction = null; stat.lastActionType = null; stat.lastActionAmount = null; }
    this.handStartStacks = Object.fromEntries((this.engine?.state?.players ?? []).filter(Boolean).map(p => [p.id, playerStack(p)]));
    this.engine.deal();
    this.handNumber = this.engine.state.handNumber;
    this.logEvent('HAND_START', {
      handNumber: this.handNumber,
      buttonSeat: this.engine.state.buttonSeat,
      smallBlind: this.engine.state.smallBlind,
      bigBlind: this.engine.state.bigBlind,
      ante: this.engine.state.ante,
      playerIds: (this.engine.state.players ?? []).filter(p => p && playerStack(p) > 0).map(p => p.id),
    }); this.broadcast();
  }
  handComplete() {
    const s = this.engine.state;
    if (Array.isArray(s.winners) && s.winners.length > 0 && s.actionTo == null) return true;
    const aliveInHand = (s.activePlayers ?? []).filter(seat => s.players?.[seat] && playerStack(s.players[seat]) >= 0);
    return s.actionTo == null && (s.street === 'SHOWDOWN' || aliveInHand.length <= 1) && Array.isArray(s.winners);
  }
  async playHand() {
    let guard = 0;
    while (!this.handComplete()) {
      if (++guard > 500) throw new Error('Hand action guard exceeded 500 actions');
      await this.waitIfPaused();
      const state = this.engine.state, seat = state.actionTo;
      if (seat == null) { if (Array.isArray(state.winners) && state.winners.length) break; await sleep(10); continue; }
      const player = state.players?.[seat]; if (!player) throw new Error(`No player at action seat ${seat}`);
      if (state.street === 'SHOWDOWN') {
        const show = { type: ACTION.SHOW, playerId: player.id, cardIndices: [0, 1] };
        if (this.engine.validate(show)?.valid) { this.engine.act(show); this.logEvent('AUTO_SHOW', { playerId: player.id, playerName: player.name }); this.broadcast(); continue; }
        const muck = { type: ACTION.MUCK, playerId: player.id };
        if (this.engine.validate(muck)?.valid) { this.engine.act(muck); this.logEvent('AUTO_MUCK', { playerId: player.id, playerName: player.name }); this.broadcast(); continue; }
      }
      const legalActions = legalActionCandidates(this.engine, seat); if (!legalActions.length) throw new Error(`No legal actions for ${player.name}`);
      const agent = this.config.players.find(p => p.id === player.id); if (!agent) throw new Error(`No agent config for ${player.id}`);
      await this.takeDecision(agent, seat, legalActions); this.broadcast(); await this.waitIfPaused(); await sleep(this.config.betweenActionsMs);
    }
  }
  async takeDecision(agent, seat, legalActions) {
    const decisionId = id(`d-h${this.handNumber}-s${seat + 1}`), baseMs = this.config.actionSeconds * 1000, bankBefore = this.timeBanks[agent.id] ?? 0, totalMs = baseMs + bankBefore;
    const recentHands = buildPublicTournamentMemory(this.events, this.handNumber);
    const publicPlayerStats = buildPublicPlayerStats(this.events, this.config.players, this.handNumber);
    const actionHistory = buildCurrentHandPublicActions(this.events, this.handNumber);
    const baseState = serializeForAgent(this.engine, seat, this.tournamentMeta(), legalActions, recentHands, publicPlayerStats, actionHistory);
    const stateForAgent = assertDecisionState(applyBenchmarkMode(baseState, this.config.benchmarkMode)), startedAt = Date.now();
    const connection = this.config.connections.find(c => c.id === agent.connectionId);
    const architecture = this.config.decisionArchitecture === DECISION_ARCHITECTURES.FLAT ? 'flat' : 'hierarchical';
    const sizesForFamily = family => legalAggressiveSizes(this.engine, seat, family);
    let hierarchy = null;
    if (architecture === 'hierarchical') {
      hierarchy = buildHierarchicalDecision(stateForAgent, { legalActions: stateForAgent.legalActions });
      if (hierarchy.aggressiveFamily) {
        const engineSizes = sizesForFamily(hierarchy.aggressiveFamily);
        hierarchy.stage2 = { ...hierarchy.stage2, sizes: engineSizes, criteria: sizeCriteria(engineSizes) };
      }
    }
    this.currentDecision = {
      id: decisionId, playerId: agent.id, playerName: agent.name, seat, model: agent.model, connection: connection?.name ?? agent.connectionId, provider: agent.provider || 'auto',
      protocol: effectiveProtocol(agent, connection), handNumber: this.handNumber, street: this.engine.state.street, position: positionForSeat(this.engine.state, seat),
      startedAt, baseMs, timeBankMs: bankBefore, lowTimeMs: Math.round(this.config.lowTimeSeconds * 1000), lowTimeFraction: this.config.lowTimeFraction, pausedMs: 0, pausedAt: null, architecture,
      hierarchy: hierarchy ? { families: hierarchy.families, stage1: hierarchy.stage1, stage2: hierarchy.stage2, aggressiveFamily: hierarchy.aggressiveFamily } : null,
      legalActions: legalActions.map(({ id: actionId, type, amount, description }) => ({ id: actionId, type, amount, description })),
    };
    this.logEvent('DECISION_START', this.currentDecision); this.broadcast();
    const stats = this.stats[agent.id]; let result = null, error = null, errorCategory = null, elapsed = 0;
    const pausedTotal = () => (this.currentDecision?.pausedMs || 0) + (this.currentDecision?.pausedAt ? Math.max(0, Date.now() - this.currentDecision.pausedAt) : 0);
    const recordIncident = (incident) => {
      if (incident?.category === 'rate_limit') stats.rateLimits++;
      else if (incident?.category === 'provider') stats.providerErrors++;
    };
    // Live reasoning: streamed deltas repaint at most every 120 ms, and only a
    // short tail rides on the live decision so broadcasts stay small. The full
    // text is accumulated locally and persisted once the decision settles.
    const liveReasoning = { family: '', sizing: '', flat: '' };
    let reasoningPaintAt = 0;
    const onDelta = info => {
      if (this.currentDecision?.id !== decisionId) return;
      const key = info.stage === 'size' ? 'sizing' : info.stage === 'flat' ? 'flat' : 'family';
      if (info.channel === 'reasoning') liveReasoning[key] = info.text;
      this.currentDecision.reasoning = { stage: info.stage, channel: info.channel, text: reasoningTail(info.text) };
      const now = Date.now();
      if (now - reasoningPaintAt >= 120) { reasoningPaintAt = now; this.broadcast(); }
    };
    try {
      const before = performance.now();
      if (architecture === 'hierarchical') {
        result = await decideHierarchical({
          agent, connection, state: stateForAgent, legalActions, decisionId, timeoutMs: totalMs,
          abortSignal: this.abortController?.signal, pauseClock: this.currentDecision,
          representationMode: this.config.representation, sizesForFamily,
          onStage: info => { if (this.currentDecision?.id === decisionId) { this.currentDecision.stage = info; this.broadcast(); } },
          onDelta,
        });
      } else {
        result = await decide(agent, connection, { state: stateForAgent, legalActions, decisionId, timeoutMs: totalMs, abortSignal: this.abortController?.signal, pauseClock: this.currentDecision, representationMode: this.config.representation, onDelta });
      }
      elapsed = Math.max(0, Math.round(performance.now() - before - pausedTotal()));
      for (const incident of result?.meta?.incidents || []) recordIncident(incident);
      stats.retries += Number(result?.meta?.retryCount || 0);
      if (result?.meta?.protocolFallbackTriggered) stats.protocolFallbacks++;
      if (this.currentDecision?.id !== decisionId) throw new Error('Decision became stale');
    } catch (err) {
      elapsed = Math.max(0, Date.now() - startedAt - pausedTotal()); error = err;
      for (const incident of err?.incidents || []) recordIncident(incident);
      errorCategory = (elapsed >= totalMs - 30 || err?.name === 'AbortError') ? 'timeout' : decisionErrorCategory(err);
      if (errorCategory === 'timeout') stats.timeouts++;
      else if (errorCategory === 'rate_limit') stats.rateLimits++;
      else if (errorCategory === 'provider') stats.providerErrors++;
      else { stats.modelErrors++; stats.invalid++; }
    }
    if (this.status === 'STOPPED') throw new Error('Tournament stopped');
    await this.waitIfPaused();
    const elapsedActive = Math.max(0, Date.now() - startedAt - pausedTotal());
    this.timeBanks[agent.id] = Math.max(0, bankBefore - Math.max(0, elapsedActive - baseMs));
    let chosen = result?.action ?? null, forced = false;
    if (chosen && architecture === 'hierarchical') {
      const engineAction = isAggressiveType(chosen.type)
        ? { type: chosen.type, playerId: agent.id, amount: Math.max(1, Math.round(asNumber(chosen.amount))) }
        : { type: chosen.type, playerId: agent.id };
      if ((isAggressiveType(chosen.type) && !Number.isFinite(Number(chosen.amount))) || !this.engine.validate(engineAction)?.valid) {
        error = new Error('Returned hierarchical action was no longer legal'); errorCategory = 'model'; stats.modelErrors++; stats.invalid++; chosen = null;
      } else {
        const known = legalActionCandidates(this.engine, seat).find(a => a.type === chosen.type && (chosen.amount == null || Number(a.amount) === Number(chosen.amount)));
        chosen = { ...chosen, id: chosen.id ?? known?.id ?? null, description: chosen.description || known?.description || describeAction(chosen.type, chosen.amount, this.engine.state, seat), engineAction };
      }
    } else if (chosen) {
      const fresh = legalActionCandidates(this.engine, seat).find(a => a.id === chosen.id && a.type === chosen.type && a.amount === chosen.amount);
      if (!fresh || !this.engine.validate(fresh.engineAction)?.valid) {
        error = new Error('Returned action was no longer legal'); errorCategory = 'model'; stats.modelErrors++; stats.invalid++; chosen = null;
      } else chosen = fresh;
    }
    if (!chosen) { chosen = fallbackAction(legalActionCandidates(this.engine, seat)); forced = true; stats.autoFallbacks++; }
    if (!chosen) throw new Error(`No fallback action for ${agent.name}`);
    this.engine.act(chosen.engineAction);
    const fallbackReason = errorCategory ? errorCategory.replace('_', ' ') : 'invalid response';
    const reportedLatency = result?.primaryDecisionLatencyMs != null ? Math.max(0, result.primaryDecisionLatencyMs - pausedTotal()) : (result?.latencyMs != null ? Math.max(0, result.latencyMs - pausedTotal()) : elapsed);
    const typedReason = architecture === 'hierarchical' && result?.family
      ? `Typed decision · ${String(result.family.choice).toUpperCase()}${result.sizing ? ` ${SIZE_LABELS[result.sizing.choice] ?? result.sizing.choice}` : ''}`
      : '';
    stats.decisions++; stats.totalLatencyMs += reportedLatency; stats.lastAction = chosen.description; stats.lastActionType = chosen.type; stats.lastActionAmount = chosen.amount ?? null;
    this.decisionCount++;
    if (this.decisionBudget > 0 && this.decisionCount >= this.decisionBudget) this.budgetReached = true;
    stats.lastReason = result?.publicReason || typedReason || (forced ? `Automatic ${chosen.description} after ${fallbackReason}.` : '');
    const reasoningLog = architecture === 'hierarchical'
      ? { family: capReasoning(result?.reasoning?.family ?? liveReasoning.family), sizing: capReasoning(result?.reasoning?.sizing ?? liveReasoning.sizing) }
      : { flat: capReasoning(typeof result?.reasoning === 'string' ? result.reasoning : liveReasoning.flat) };
    const decisionMeta = result?.meta ? {
      ...result.meta,
      decisionArchitecture: architecture === 'hierarchical' ? DECISION_ARCHITECTURE_VERSION : 'flat-v1',
      family: result.family ? { choice: result.family.choice, probabilities: result.family.probabilities ?? null, confidence: result.family.confidence ?? null, latencyMs: result.family.latencyMs ?? null } : null,
      sizing: result.sizing ? { choice: result.sizing.choice, probabilities: result.sizing.probabilities ?? null, confidence: result.sizing.confidence ?? null, latencyMs: result.sizing.latencyMs ?? null, amount: result.sizing.amount ?? null } : null,
      finalAction: { type: chosen.type, amount: chosen.amount ?? null },
    } : null;
    this.logEvent('DECISION', {
      decisionId, handNumber: this.handNumber, street: stateForAgent.street, position: stateForAgent.hero.position, potBefore: stateForAgent.pot,
      playerId: agent.id, playerName: agent.name, connection: connection?.name,
      protocol: result?.meta?.method ?? effectiveProtocol(agent, connection), requestedProtocol: effectiveProtocol(agent, connection), protocolFallback: result?.meta?.protocolFallback ?? null,
      configuredModel: agent.model, resolvedModel: result?.model ?? agent.model, provider: agent.provider || 'auto',
      action: { id: chosen.id, type: chosen.type, amount: chosen.amount, description: chosen.description }, forced,
      legalActions: legalActions.map(a => ({ id: a.id, type: a.type, amount: a.amount ?? null, description: a.description })),
      latencyMs: reportedLatency, primaryDecisionLatencyMs: result?.primaryDecisionLatencyMs ?? reportedLatency,
      timeBankUsedMs: Math.max(0, Math.min(bankBefore, elapsed - baseMs)), timeBankRemainingMs: this.timeBanks[agent.id],
      publicReason: stats.lastReason, usage: result?.usage ?? null, decisionMeta, reasoning: reasoningLog,
      benchmarkMode: this.config.benchmarkMode, decisionArchitecture: architecture, representation: this.config.representation,
      replay: {
        handNumber: stateForAgent.tournament?.handNumber ?? this.handNumber,
        street: stateForAgent.street,
        board: stateForAgent.board ?? [],
        pot: stateForAgent.pot,
        blinds: stateForAgent.blinds,
        buttonSeat: stateForAgent.buttonSeat,
        betting: stateForAgent.betting,
        hero: stateForAgent.hero,
        heroHand: stateForAgent.heroHand ?? null,
        opponents: stateForAgent.opponents,
        actionHistory: stateForAgent.actionHistory,
        legalActions: stateForAgent.legalActions,
      },
      errorCategory, error: error ? summarizeError(error) : null,
    });
    if (this.config.spectatorExplanations) this.enqueueSpectatorExplanation({ decisionId, agent, connection, stateForAgent, chosen });
    if (result?.meta?.protocolFallbackTriggered && result?.meta?.method === 'json_schema') {
      agent.protocol = 'json_schema';
      const lobbySeat = Number(agent.lobbySeat);
      if (Number.isInteger(lobbySeat) && seatAssignments[lobbySeat]?.model === agent.model && seatAssignments[lobbySeat]?.connectionId === agent.connectionId) {
        seatAssignments[lobbySeat].protocol = 'json_schema';
        saveSeatAssignments();
      }
    }
    this.currentDecision = null;
  }
  enqueueSpectatorExplanation({ decisionId, agent, connection, stateForAgent, chosen }) {
    if (!connection || !['openai', 'openrouter'].includes(connection.kind) || isJevModel(agent.model)) return this.explanationChain;
    this.explanationChain = this.explanationChain.then(async () => {
      if (this.status === 'STOPPED' || this.status === 'ERROR') return;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const body = {
          model: agent.model,
          messages: [
            { role: 'system', content: 'You are a spectator commentator. Explain a poker move in one short descriptive sentence. This explanation never affects the game.' },
            { role: 'user', content: `Hero action: ${chosen.description}. State: ${JSON.stringify({ street: stateForAgent.street, board: stateForAgent.board, pot: stateForAgent.pot, hero: stateForAgent.hero, betting: stateForAgent.betting })}. One short spectator-facing sentence.` },
          ],
          temperature: 0.5, max_tokens: 80,
        };
        const response = await fetch(completionsUrl(connection.baseUrl), { method: 'POST', headers: makeHeaders(connection), body: JSON.stringify(body), signal: controller.signal });
        if (!response.ok) return;
        const payload = await response.json().catch(() => ({}));
        const text = stripCodeFence(extractTextContent(payload?.choices?.[0]?.message)).trim().slice(0, 220);
        if (!text) return;
        this.logEvent('SPECTATOR_EXPLANATION', { decisionId, playerId: agent.id, configuredModel: agent.model, text });
        this.broadcast();
      } catch {}
      finally { clearTimeout(timer); }
    });
    return this.explanationChain;
  }
  completeHand() {
    const state = this.engine.state;
    this.logEvent('HAND_END', { handNumber: this.handNumber, board: state.board, winners: publicWinnerSummary(state.winners, state.players), stacks: (state.players ?? []).map((p, seat) => p ? ({ seat: seat + 1, id: p.id, name: p.name, stack: playerStack(p) }) : null).filter(Boolean) });
    this.publicStatsVersion++;
    const newlyEliminated = this.config.players.map(player => {
      const seat = (state.players ?? []).findIndex(x => x?.id === player.id);
      const p = seat >= 0 ? state.players[seat] : null;
      const already = this.eliminations.some(e => e.playerId === player.id);
      return p && playerStack(p) <= 0 && !already ? { player, seat, startStack: asNumber(this.handStartStacks?.[player.id]) } : null;
    }).filter(Boolean).sort((a, b) => b.startStack - a.startStack || a.seat - b.seat);
    const survivors = this.playersRemaining().length;
    newlyEliminated.forEach((row, index) => {
      const elimination = { playerId: row.player.id, playerName: row.player.name, place: Math.max(2, survivors + 1 + index), handNumber: this.handNumber, at: Date.now() };
      this.eliminations.push(elimination); this.logEvent('ELIMINATION', elimination);
    });
  }
  finish(player) {
    const configured = player ? this.config.players.find(p => p.id === player.id) : null;
    this.winner = player ? { playerId: player.id, playerName: player.name, model: configured?.model ?? null, protocol: configured?.protocol ?? null, stack: playerStack(player) } : null;
    this.finishedAt = Date.now(); this.status = 'FINISHED'; this.currentDecision = null; this.logEvent('TOURNAMENT_END', { winner: this.winner, hands: this.handNumber }); this.persistLightweight(); this.broadcast();
  }
  exportJsonl() { return this.events.map(e => JSON.stringify(e)).join('\n') + '\n'; }
}

function connectionOptionsHtml(selected = '') {
  const rows = $$('.connection-row', els.connectionsEditor);
  return rows.map(row => {
    const id = row.dataset.id, name = $('[data-field=name]', row).value.trim() || id;
    return `<option value="${escapeHtml(id)}" ${id === selected ? 'selected' : ''}>${escapeHtml(name)}</option>`;
  }).join('');
}
function refreshSeatConnectionSelect(selected = null) {
  if (!els.seatConnection) return;
  const old = selected ?? els.seatConnection.value;
  els.seatConnection.innerHTML = connectionOptionsHtml(old);
  if (!els.seatConnection.value && els.seatConnection.options.length) els.seatConnection.selectedIndex = 0;
  applySeatProtocolRules();
}
function connectionPresetUrl(kind) {
  return CONNECTION_PRESETS[kind] || CONNECTION_PRESETS.openai;
}
function shouldReplacePresetUrl(value) {
  const normalized = normalizeBaseUrl(value);
  return !normalized || [
    ...Object.values(CONNECTION_PRESETS),
  ].includes(normalized);
}
function addConnectionRow(connection = {}) {
  const row = els.connectionRowTemplate.content.firstElementChild.cloneNode(true);
  row.dataset.id = connection.id || `conn-${++rowSeq}`;
  $('[data-field=name]', row).value = connection.name || `API ${rowSeq}`;
  $('[data-field=kind]', row).value = connection.kind || 'openai';
  $('[data-field=baseUrl]', row).value = connection.baseUrl || connectionPresetUrl(connection.kind || 'openai');
  $('[data-field=apiKey]', row).value = connection.apiKey || '';
  const headersInput = $('[data-field=headers]', row);
  headersInput.value = connection.headers || defaultExtraHeaders(connection.kind || 'openai');
  $('[data-field=name]', row).addEventListener('input', () => refreshSeatConnectionSelect());
  $('[data-field=kind]', row).addEventListener('change', event => {
    const baseInput = $('[data-field=baseUrl]', row);
    if (shouldReplacePresetUrl(baseInput.value)) baseInput.value = connectionPresetUrl(event.target.value);
    const nameInput = $('[data-field=name]', row);
    if (!nameInput.value.trim() || nameInput.value === 'API' || /^API \d+$/.test(nameInput.value) || nameInput.value === 'OpenRouter' || nameInput.value === 'TypeSafe') {
      nameInput.value = event.target.value === 'openrouter' ? 'OpenRouter' : event.target.value === 'typesafe' ? 'TypeSafe' : `API ${rowSeq}`;
    }
    const defaultOpenRouterHeaders = defaultExtraHeaders('openrouter');
    if (event.target.value === 'openrouter' && !headersInput.value.trim()) headersInput.value = defaultOpenRouterHeaders;
    if (event.target.value !== 'openrouter' && headersInput.value.trim() === defaultOpenRouterHeaders) headersInput.value = '';
    refreshSeatConnectionSelect();
  });
  $('[data-field=kind]', row).addEventListener('change', () => {
    const kind = $('[data-field=kind]', row).value;
    const url = $('[data-field=baseUrl]', row);
    if (kind === 'typesafe' && (!url.value || url.value.includes('openrouter.ai'))) url.value = CONNECTION_PRESETS.typesafe;
    if (kind === 'openrouter' && (!url.value || url.value.includes('typesafe.ai'))) url.value = CONNECTION_PRESETS.openrouter;
    if (kind === 'openai' && (!url.value || url.value.includes('typesafe.ai'))) url.value = CONNECTION_PRESETS.openai;
    refreshSeatConnectionSelect();
  });
  $('.remove-connection', row).addEventListener('click', () => {
    if (els.connectionsEditor.children.length <= 1) return;
    const removedId = row.dataset.id;
    row.remove();
    for (let i = 0; i < seatAssignments.length; i++) {
      if (seatAssignments[i]?.connectionId === removedId) seatAssignments[i] = { ...seatAssignments[i], connectionId: '' };
    }
    refreshSeatConnectionSelect();
    renderLobbyIfVisible();
  });
  $('.test-connection', row).addEventListener('click', () => testConnectionRow(row));
  els.connectionsEditor.append(row);
  refreshSeatConnectionSelect();
}
function readConnections() {
  return $$('.connection-row', els.connectionsEditor).map(row => ({
    id: row.dataset.id, name: $('[data-field=name]', row).value.trim(), kind: $('[data-field=kind]', row).value,
    baseUrl: $('[data-field=baseUrl]', row).value.trim(), apiKey: $('[data-field=apiKey]', row).value.trim(), headers: $('[data-field=headers]', row).value.trim(),
  }));
}
async function testConnectionRow(row) {
  const status = $('.connection-status', row), button = $('.test-connection', row);
  button.disabled = true; status.textContent = 'testing…';
  try {
    const connection = readConnections().find(c => c.id === row.dataset.id);
    if (!connection?.baseUrl) throw new Error('Base URL is required');
    if ((isOpenRouterConnection(connection) || connection.kind === 'typesafe') && !connection.apiKey) throw new Error('API key is required for this preset');
    if (connection.kind === 'openai' || connection.kind === 'openrouter') {
      const response = await fetch(modelsUrl(connection.baseUrl), { method: 'GET', headers: makeHeaders(connection) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message ?? payload?.message ?? `HTTP ${response.status}`);
      registerModelCapabilities(Array.isArray(payload?.data) ? payload.data : []);
      const count = Array.isArray(payload?.data) ? payload.data.length : '?';
      status.textContent = `Connected · ${count} models`;
      status.className = 'connection-status tiny good-text';
    } else {
      const response = await fetch(normalizeBaseUrl(connection.baseUrl), { method: 'POST', headers: makeHeaders(connection), body: '{}' });
      if (response.status === 401 || response.status === 403) throw new Error(`HTTP ${response.status}: key rejected`);
      status.textContent = `Connected · HTTP ${response.status}`;
      status.className = 'connection-status tiny good-text';
    }
  } catch (err) {
    status.textContent = `✕ ${summarizeError(err)}${String(err).includes('Failed to fetch') ? ' (often CORS)' : ''}`;
    status.className = 'connection-status tiny bad-text';
  } finally { button.disabled = false; }
}
function connectionById(id) {
  const row = $$('.connection-row', els.connectionsEditor).find(r => r.dataset.id === id);
  return row ? { id, name: $('[data-field=name]', row).value.trim(), kind: $('[data-field=kind]', row).value, baseUrl: $('[data-field=baseUrl]', row).value.trim() } : null;
}
function fullConnectionById(id) {
  return readConnections().find(connection => connection.id === id) || null;
}
function modelCacheKey(connection) {
  return `${connection?.kind || ''}|${normalizeBaseUrl(connection?.baseUrl || '')}`;
}
function setModelStatus(text, tone = 'muted') {
  if (!els.seatModelStatus) return;
  els.seatModelStatus.textContent = text;
  els.seatModelStatus.dataset.tone = tone;
}
function mergeOpenRouterModelCatalog(models = []) {
  const byId = new Map();
  for (const model of [...OPENROUTER_DECISION_MODELS, ...models]) {
    const id = typeof model === 'string' ? model : model?.id;
    if (!id) continue;
    byId.set(id, { id, name: typeof model === 'string' ? model : (model?.name || id) });
  }
  return [...byId.values()];
}
function renderModelOptions(models, currentValue = '') {
  if (!els.seatModelOptions) return;
  const normalized = (models || []).map(model => typeof model === 'string' ? ({ id: model, name: model }) : model).filter(model => model?.id);
  const byId = new Map(normalized.map(model => [model.id, model]));
  if (currentValue && !byId.has(currentValue)) byId.set(currentValue, { id: currentValue, name: currentValue });
  const rows = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  els.seatModelOptions.innerHTML = rows.map(model => `<option value="${escapeHtml(model.id)}" label="${escapeHtml(model.name || model.id)}"></option>`).join('');
}
async function refreshSeatModelCatalog({ force = false } = {}) {
  const connection = fullConnectionById(els.seatConnection?.value);
  const currentValue = els.seatModel?.value?.trim() || '';
  if (!connection) {
    renderModelOptions([], currentValue);
    setModelStatus('Choose a connection first.');
    return;
  }
  if (!['openai', 'openrouter'].includes(connection.kind)) {
    renderModelOptions([], currentValue);
    setModelStatus('Enter the model ID accepted by this endpoint.');
    return;
  }
  const key = modelCacheKey(connection);
  if (!force && modelCatalogCache.has(key)) {
    const models = modelCatalogCache.get(key);
    renderModelOptions(models, currentValue);
    setModelStatus(`${models.length} models available.`, 'good');
    return;
  }
  setModelStatus('Loading models…');
  if (els.refreshModelsBtn) els.refreshModelsBtn.disabled = true;
  try {
    const response = await fetch(modelsUrl(connection.baseUrl), { method: 'GET', headers: makeHeaders(connection) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.error?.message ?? payload?.message ?? `HTTP ${response.status}`);
    registerModelCapabilities(Array.isArray(payload?.data) ? payload.data : []);
    const catalogModels = Array.isArray(payload?.data) ? payload.data.map(model => ({ id: model?.id, name: model?.name || model?.id })).filter(model => model.id) : [];
    const models = isOpenRouterConnection(connection) ? mergeOpenRouterModelCatalog(catalogModels) : catalogModels;
    modelCatalogCache.set(key, models);
    renderModelOptions(models, currentValue);
    setModelStatus(`${models.length} models available.`, 'good');
  } catch (err) {
    const models = isOpenRouterConnection(connection) ? mergeOpenRouterModelCatalog([]) : [];
    modelCatalogCache.set(key, models);
    renderModelOptions(models, currentValue);
    setModelStatus(models.length ? `Catalog unavailable; Jev shortcuts remain available.` : `Model list unavailable. Enter an ID manually.`, 'bad');
  } finally {
    if (els.refreshModelsBtn) els.refreshModelsBtn.disabled = false;
  }
}
function defaultSeatDraft(seatIndex) {
  const firstRow = $('.connection-row', els.connectionsEditor);
  const connectionId = firstRow?.dataset.id || '';
  const conn = connectionById(connectionId);
  return {
    lobbySeat: seatIndex,
    name: `Player ${seatIndex + 1}`,
    connectionId,
    model: conn?.kind === 'typesafe' ? 'jev-latest' : '',
    protocol: conn?.kind === 'typesafe' ? 'jev_native' : 'tool',
    provider: '',
    captureReasoning: false,
  };
}
function applySeatProtocolRules() {
  const conn = connectionById(els.seatConnection.value);
  const kind = conn?.kind || 'openrouter';
  const openRouter = isOpenRouterConnection(conn);
  const jevViaOpenRouter = openRouter && isJevModel(els.seatModel.value);
  const jevSeat = kind === 'typesafe' || jevViaOpenRouter;
  document.querySelector('.seat-provider-field')?.classList.toggle('hidden', !openRouter || jevViaOpenRouter);
  document.querySelector('.seat-reasoning-field')?.classList.toggle('hidden', jevSeat);
  if (els.seatCaptureReasoning) {
    els.seatCaptureReasoning.disabled = jevSeat;
    const alreadyReasoning = isReasoningModel(els.seatModel.value.trim());
    document.querySelector('.seat-reasoning-help')?.classList.toggle('hidden', !els.seatCaptureReasoning.checked || alreadyReasoning);
  }
  [...els.seatProtocol.options].forEach(option => {
    option.disabled = (option.value === 'jev_native' && kind !== 'typesafe') || (option.value === 'jev_decisions' && !openRouter);
  });
  if (kind === 'typesafe') {
    els.seatProtocol.value = 'jev_native';
    els.seatProvider.disabled = true;
    if (!els.seatModel.value || els.seatModel.value.includes('/')) els.seatModel.value = 'jev-latest';
  } else if (jevViaOpenRouter) {
    els.seatProtocol.value = 'jev_decisions';
    els.seatProvider.disabled = true;
  } else {
    if (['jev_native', 'jev_decisions'].includes(els.seatProtocol.value)) els.seatProtocol.value = 'tool';
    els.seatProvider.disabled = !openRouter;
    if (els.seatModel.value === 'jev-latest') els.seatModel.value = '';
  }
}
function updateSeatSummary() {
  const count = seatAssignments.filter(Boolean).length;
  if (els.seatSummary) els.seatSummary.textContent = `${count} / ${MAX_LOBBY_SEATS} seated`;
}
function syncSeatNameFromModel() {
  if (!seatNameAuto || editingSeatIndex == null) return;
  const model = els.seatModel.value.trim();
  els.seatName.value = model ? displayModelName(model) : `Player ${editingSeatIndex + 1}`;
}
function openSeatEditor(seatIndex) {
  if (!Number.isInteger(seatIndex) || seatIndex < 0 || seatIndex >= MAX_LOBBY_SEATS) return;
  editingSeatIndex = seatIndex;
  const locked = Boolean(director && ['RUNNING', 'PAUSED'].includes(director.status));
  const draft = seatAssignments[seatIndex] ? { ...seatAssignments[seatIndex] } : defaultSeatDraft(seatIndex);
  els.seatDialogTitle.textContent = `Seat ${seatIndex + 1}`;
  const placeholderName = `Player ${seatIndex + 1}`;
  const storedName = String(draft.name || '').trim();
  seatNameAuto = !storedName || /^player\s+\d+$/i.test(storedName) || (Boolean(draft.model) && storedName === displayModelName(draft.model));
  els.seatName.value = seatNameAuto && draft.model ? displayModelName(draft.model) : (storedName || placeholderName);
  refreshSeatConnectionSelect(draft.connectionId || '');
  if (draft.connectionId && [...els.seatConnection.options].some(option => option.value === draft.connectionId)) els.seatConnection.value = draft.connectionId;
  els.seatModel.value = draft.model || '';
  els.seatProtocol.value = draft.protocol || 'tool';
  els.seatProvider.value = draft.provider || '';
  if (els.seatCaptureReasoning) els.seatCaptureReasoning.checked = Boolean(draft.captureReasoning);
  applySeatProtocolRules();
  syncSeatNameFromModel();
  void refreshSeatModelCatalog();
  els.seatError.classList.add('hidden');
  els.seatLockNotice.classList.toggle('hidden', !locked);
  for (const control of [els.seatName, els.seatConnection, els.seatModel, els.seatProtocol, els.seatProvider]) control.disabled = locked || (control === els.seatProvider && (!isOpenRouterConnection(connectionById(els.seatConnection.value)) || isJevModel(els.seatModel.value)));
  if (els.seatCaptureReasoning) els.seatCaptureReasoning.disabled = locked || els.seatCaptureReasoning.disabled;
  els.saveSeatBtn.disabled = locked;
  els.removeSeatBtn.disabled = locked || !seatAssignments[seatIndex];
  if (!els.seatDialog.open) els.seatDialog.showModal();
  syncChoicePickers();
  if (!locked) requestAnimationFrame(() => { els.seatName.focus(); els.seatName.select(); });
}
function readSeatDraft() {
  return {
    lobbySeat: editingSeatIndex,
    name: els.seatName.value.trim(),
    connectionId: els.seatConnection.value,
    model: els.seatModel.value.trim(),
    protocol: els.seatProtocol.value,
    provider: els.seatProvider.disabled ? '' : els.seatProvider.value.trim(),
    captureReasoning: Boolean(els.seatCaptureReasoning && !els.seatCaptureReasoning.disabled && els.seatCaptureReasoning.checked),
  };
}
function readSeatPlayers() {
  return seatAssignments.map((p, lobbySeat) => p ? ({ ...p, lobbySeat }) : null).filter(Boolean).sort((a, b) => a.lobbySeat - b.lobbySeat);
}
function saveSeatAssignments() {
  const raw = collectSetupRaw(false);
  saveSetupWithoutSecrets(raw);
  updateSeatSummary();
  renderLobbyIfVisible();
}
function restoreSeatAssignments(rows = []) {
  seatAssignments = Array(MAX_LOBBY_SEATS).fill(null);
  const sources = rows;
  sources.slice(0, MAX_LOBBY_SEATS).forEach((player, index) => {
    const lobbySeat = clamp(Math.round(Number(player.lobbySeat ?? index)), 0, MAX_LOBBY_SEATS - 1);
    let connectionId = player.connectionId || '';
    if (!connectionId && player.connectionName) {
      const match = $$('.connection-row', els.connectionsEditor).find(r => $('[data-field=name]', r).value.trim() === player.connectionName);
      connectionId = match?.dataset.id || '';
    }
    seatAssignments[lobbySeat] = {
      lobbySeat,
      name: player.name || `Player ${lobbySeat + 1}`,
      connectionId,
      model: player.model || '',
      protocol: player.protocol || 'tool',
      provider: player.provider || '',
      captureReasoning: player.captureReasoning === true,
    };
  });
  updateSeatSummary();
}
function collectSetupRaw(includeSecrets = true) {
  const fd = new FormData(els.setupForm);
  const connections = readConnections();
  return {
    startingStack: Number(fd.get('startingStack')), smallBlind: Number(fd.get('smallBlind')), bigBlind: Number(fd.get('bigBlind')), ante: Number(fd.get('ante')),
    handsPerLevel: Number(fd.get('handsPerLevel')), blindMultiplier: Number(fd.get('blindMultiplier')), actionSeconds: Number(fd.get('actionSeconds')), timeBankSeconds: Number(fd.get('timeBankSeconds')),
    lowTimeSeconds: Number(fd.get('lowTimeSeconds')), lowTimeFraction: Number(fd.get('lowTimeFraction')),
    betweenActionsMs: Number(fd.get('betweenActionsMs')), betweenHandsMs: Number(fd.get('betweenHandsMs')),
    benchmarkMode: String(fd.get('benchmarkMode') || DEFAULT_BENCHMARK_MODE),
    decisionArchitecture: String(fd.get('decisionArchitecture') || DEFAULT_DECISION_ARCHITECTURE),
    representation: String(fd.get('representation') || DEFAULT_REPRESENTATION_MODE),
    spectatorExplanations: fd.get('spectatorExplanations') === 'on' || fd.get('spectatorExplanations') === 'true',
    maxDecisions: arenaMaxDecisions,
    connections: includeSecrets ? connections : connections.map(({ apiKey, ...c }) => ({ ...c, apiKey: '' })),
    players: readSeatPlayers(),
  };
}
function saveSetupWithoutSecrets(raw) {
  try {
    const safe = { ...raw, connections: raw.connections.map(({ apiKey, headers, ...c }) => ({ ...c, headers: '' })) };
    storageSet('pokertoolsArenaBrowserConfig', JSON.stringify(safe));
  } catch {}
}
async function primeModelCapabilities() {
  const targets = (() => { try { return readConnections(); } catch { return []; } })()
    .filter(connection => connection?.baseUrl && ['openai', 'openrouter'].includes(connection.kind));
  await Promise.all(targets.map(async connection => {
    try {
      const response = await fetch(modelsUrl(connection.baseUrl), { method: 'GET', headers: makeHeaders(connection) });
      if (!response.ok) return;
      const payload = await response.json().catch(() => ({}));
      registerModelCapabilities(Array.isArray(payload?.data) ? payload.data : []);
    } catch {}
  }));
}
function restoreSetup() {
  applyConfiguredFormDefaults(els.setupForm);
  let saved = null; try { saved = JSON.parse(storageGet('pokertoolsArenaBrowserConfig')); } catch {}
  const injected = injectedEnvironmentConfig();
  const conns = injected?.connections?.length ? injected.connections : (saved?.connections?.length ? saved.connections : defaultConnections());
  conns.forEach(addConnectionRow);
  restoreSeatAssignments(injected?.players?.length ? injected.players : (saved?.players?.length ? saved.players : []));
  capabilityPrime = primeModelCapabilities();
  if (saved) for (const [key, value] of Object.entries(saved)) {
    if (key === 'players' || key === 'connections') continue;
    const input = els.setupForm.elements.namedItem(key); if (!input) continue;
    if (input.type === 'checkbox') input.checked = Boolean(value); else input.value = value;
  }
  if (injected?.settings) for (const [key, value] of Object.entries(injected.settings)) {
    if (value == null) continue;
    const input = els.setupForm.elements.namedItem(key); if (!input) continue;
    if (input.type === 'checkbox') input.checked = Boolean(value); else input.value = value;
  }
  if (injected?.settings) {
    pendingAutostart = Boolean(injected.settings.autostart);
    arenaMaxDecisions = Math.max(0, Number(injected.settings.maxDecisions) || 0);
  }
}
function renderLobbyIfVisible() {
  if (lobbyVisible && (!director || !['RUNNING', 'PAUSED'].includes(director.status))) renderTable(currentState || { status: 'IDLE', events: [] });
}

const TABLE_MIN_PLAYERS = TABLE_DEFAULTS.minPlayers;

function visualSeatAngle(index, count) {
  const safeCount = Math.max(TABLE_MIN_PLAYERS, Math.min(MAX_LOBBY_SEATS, Math.round(Number(count) || TABLE_MIN_PLAYERS)));
  const safeIndex = ((Math.round(Number(index) || 0) % safeCount) + safeCount) % safeCount;
  const step = 360 / safeCount;
  const startDeg = safeCount === 2 ? 90 : (safeCount % 2 === 0 ? 90 + step / 2 : 90);
  return (startDeg + safeIndex * step) * Math.PI / 180;
}

function seatRectsOverlap(a, b, gap = 7) {
  return !(a.right + gap <= b.left || b.right + gap <= a.left || a.bottom + gap <= b.top || b.bottom + gap <= a.top);
}

function seatLayoutDiagnostics(seats, tableRect, insetX, insetY) {
  const rects = seats.map(seat => seat.getBoundingClientRect());
  const overflow = rects.some(rect => (
    rect.left < tableRect.left + insetX - 0.5 ||
    rect.right > tableRect.right - insetX + 0.5 ||
    rect.top < tableRect.top + insetY - 0.5 ||
    rect.bottom > tableRect.bottom - insetY + 0.5
  ));
  let overlaps = 0;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) if (seatRectsOverlap(rects[i], rects[j])) overlaps++;
  }
  return { rects, overflow, overlaps };
}

function clampSeatIntoTable(seat, tableRect, insetX, insetY) {
  const rect = seat.getBoundingClientRect();
  let dx = 0, dy = 0;
  const leftLimit = tableRect.left + insetX;
  const rightLimit = tableRect.right - insetX;
  const topLimit = tableRect.top + insetY;
  const bottomLimit = tableRect.bottom - insetY;
  if (rect.left < leftLimit) dx += leftLimit - rect.left;
  if (rect.right > rightLimit) dx -= rect.right - rightLimit;
  if (rect.top < topLimit) dy += topLimit - rect.top;
  if (rect.bottom > bottomLimit) dy -= rect.bottom - bottomLimit;
  if (dx) seat.style.left = `${parseFloat(seat.style.left || '0') + dx}px`;
  if (dy) seat.style.top = `${parseFloat(seat.style.top || '0') + dy}px`;
}

function densityOrderForTable(tableRect, seatCount, lobby) {
  const width = tableRect.width, height = tableRect.height;
  const crowded = seatCount >= 9;
  if (width < 430 || height < 430) return ['micro'];
  if (width < 620 || height < 500) return ['tight', 'micro'];
  if (width < 820 || height < 565 || (crowded && width < 880)) return ['compact', 'tight', 'micro'];
  return lobby ? ['roomy', 'compact', 'tight', 'micro'] : ['roomy', 'compact', 'tight', 'micro'];
}

function seatVisualSlot(seat, fallbackIndex, lobby, liveCount) {
  if (lobby) {
    const slot = Number(seat.dataset.lobbySeat);
    return { index: Number.isInteger(slot) ? slot : fallbackIndex, count: MAX_LOBBY_SEATS };
  }
  const visualIndex = Number(seat.dataset.visualIndex);
  const visualCount = Number(seat.dataset.visualCount);
  return {
    index: Number.isInteger(visualIndex) ? visualIndex : fallbackIndex,
    count: Number.isInteger(visualCount) && visualCount >= TABLE_MIN_PLAYERS ? visualCount : liveCount,
  };
}

function seatPositionOnFelt(seat, slot, tableRect, feltRect, density, lobby) {
  const angle = visualSeatAngle(slot.index, slot.count);
  const feltLeft = feltRect.left - tableRect.left;
  const feltTop = feltRect.top - tableRect.top;
  const centerX = feltLeft + feltRect.width / 2;
  const centerY = feltTop + feltRect.height / 2;

  const scaleByDensity = {
    roomy: [1.22, 1.34],
    compact: [1.2, 1.31],
    tight: [1.18, 1.28],
    micro: [1.15, 1.24],
  };
  let [scaleX, scaleY] = scaleByDensity[density] || scaleByDensity.compact;
  if (lobby) { scaleX += 0.012; scaleY += 0.012; }

  const radiusX = Math.max(1, feltRect.width * 0.5 * scaleX);
  const radiusY = Math.max(1, feltRect.height * 0.5 * scaleY);
  return {
    x: centerX + Math.cos(angle) * radiusX,
    y: centerY + Math.sin(angle) * radiusY,
  };
}

function positionTableMarker(marker, seat, tangentOffset = 0) {
  const felt = $('.table-felt', els.pokerTable);
  if (!marker || !felt || !seat) { if (marker) marker.hidden = true; return; }
  const feltRect = felt.getBoundingClientRect(), seatRect = seat.getBoundingClientRect();
  const dx = seatRect.left + seatRect.width / 2 - (feltRect.left + feltRect.width / 2);
  const dy = seatRect.top + seatRect.height / 2 - (feltRect.top + feltRect.height / 2);
  const length = Math.hypot(dx, dy) || 1;
  const rx = Math.max(1, feltRect.width / 2 - 18), ry = Math.max(1, feltRect.height / 2 - 18);
  const edgeScale = 1 / Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
  marker.hidden = false;
  marker.style.left = `${feltRect.width / 2 + dx * edgeScale + (-dy / length) * tangentOffset}px`;
  marker.style.top = `${feltRect.height / 2 + dy * edgeScale + (dx / length) * tangentOffset}px`;
}
function updateTableMarkers() {
  const seats = [...els.seatsLayer.querySelectorAll('.table-seat[data-seat]')];
  const markerSeat = role => {
    const target = currentState?.table?.markers?.[role];
    return Number.isInteger(target) ? seats.find(seat => Number(seat.dataset.seat) === target) : null;
  };
  const dealer = markerSeat('buttonSeat');
  const sb = markerSeat('smallBlindSeat');
  const bb = markerSeat('bigBlindSeat');
  const shared = dealer && dealer === sb;
  positionTableMarker(els.dealerMarker, dealer, shared ? -11 : 0);
  positionTableMarker(els.smallBlindMarker, sb, shared ? 11 : 0);
  positionTableMarker(els.bigBlindMarker, bb);
}

function layoutTableSeats({ lobby = false } = {}) {
  const seats = [...els.seatsLayer.querySelectorAll('.table-seat')];
  if (!seats.length) return;
  const tableRect = els.tableArena.getBoundingClientRect();
  const felt = $('.table-scene', els.pokerTable);
  const feltRect = felt?.getBoundingClientRect();
  if (!tableRect.width || !tableRect.height || !feltRect?.width || !feltRect?.height) return;

  const animated = lobby && els.pokerTable.classList.contains('lobby-mode');
  if (animated) els.pokerTable.classList.add('lobby-measure');

  const densities = densityOrderForTable(tableRect, seats.length, lobby);
  let chosen = densities.at(-1) || 'micro';

  for (const density of densities) {
    els.pokerTable.dataset.density = density;
    els.pokerTable.dataset.seatCount = String(seats.length);
    void els.pokerTable.offsetHeight;

    const insetX = density === 'micro' ? 4 : density === 'tight' ? 6 : 10;
    const insetY = density === 'micro' ? 4 : density === 'tight' ? 6 : 9;

    seats.forEach((seat, index) => {
      const slot = seatVisualSlot(seat, index, lobby, seats.length);
      const pos = seatPositionOnFelt(seat, slot, tableRect, feltRect, density, lobby);
      seat.style.left = `${Math.round(pos.x * 10) / 10}px`;
      seat.style.top = `${Math.round(pos.y * 10) / 10}px`;
      seat.dataset.visualSlot = `${slot.index + 1}/${slot.count}`;
    });

    seats.forEach(seat => clampSeatIntoTable(seat, tableRect, insetX, insetY));
    const diagnostics = seatLayoutDiagnostics(seats, tableRect, insetX, insetY);
    chosen = density;
    if (!diagnostics.overflow && diagnostics.overlaps === 0) break;
  }

  els.pokerTable.dataset.density = chosen;
  updateTableMarkers();
  requestAnimationFrame(() => {
    const currentRect = els.tableArena.getBoundingClientRect();
    if (currentRect.width && currentRect.height) {
      const inset = chosen === 'micro' ? 4 : chosen === 'tight' ? 6 : 9;
      seats.forEach(seat => clampSeatIntoTable(seat, currentRect, inset, inset));
      updateTableMarkers();
    }
    if (animated) requestAnimationFrame(() => els.pokerTable.classList.remove('lobby-measure'));
  });
}

function lobbySeatHtml(seatIndex) {
  const player = seatAssignments[seatIndex];
  if (!player) {
    return `<div class="table-seat" data-lobby-seat="${seatIndex}"><button type="button" class="empty-seat" aria-label="Configure empty seat ${seatIndex + 1}">
      <span class="empty-seat-icon" aria-hidden="true"></span><span class="empty-seat-copy"><span class="empty-seat-title">Sit here</span><span class="empty-seat-subtitle">Empty seat ${seatIndex + 1}</span></span>
    </button></div>`;
  }
  const conn = connectionById(player.connectionId);
  return `<div class="table-seat table-seat--pending" data-lobby-seat="${seatIndex}"><button type="button" class="seat-card seat-card--pending" aria-label="Edit ${escapeHtml(player.name)} in seat ${seatIndex + 1}">
    <span class="seat-name">${escapeHtml(visiblePlayerName(player.name, player.model))}</span><span class="seat-stack seat-stack--pending">WAITING</span>
    <span class="seat-model">${escapeHtml(shortModel(player.model))}</span><span class="seat-bb seat-bb--pending">— BB</span>
    <span class="seat-connection sr-only">${escapeHtml(conn?.name || 'Connection')}</span>
  </button></div>`;
}
function renderLobbyTable() {
  els.pokerTable.classList.add('lobby-mode');
  els.seatsLayer.innerHTML = Array.from({ length: MAX_LOBBY_SEATS }, (_, i) => lobbySeatHtml(i)).join('');
  layoutTableSeats({ lobby: true });
  els.board.innerHTML = Array.from({ length: 5 }, () => tableCardHtml(null)).join('');
  if (els.potChips) els.potChips.innerHTML = '';
  const count = seatAssignments.filter(Boolean).length;
  els.potValue.textContent = `${count}/${MAX_LOBBY_SEATS}`;
  els.blindsValue.textContent = '—';
  els.anteValue.textContent = '—';
  els.handValue.textContent = '—';
  els.levelValue.textContent = '—';
}
function renderStatus(s) {
  const status = s?.status || 'IDLE';
  els.statusLabel.textContent = status;
  els.statusDot.className = `status-dot ${status.toLowerCase()}`;
  const running = ['RUNNING', 'PAUSED'].includes(status);
  els.pauseBtn.classList.toggle('hidden', !running);
  els.stopBtn.classList.toggle('hidden', !running);
  els.startTopBtn.classList.toggle('hidden', running);
  els.seatsBtn.classList.toggle('hidden', running || !['STOPPED', 'FINISHED', 'ERROR'].includes(status));
  els.setupBtn.disabled = running;
  els.testsBtn.disabled = running;
  const pauseLabel = $('.action-label', els.pauseBtn);
  if (pauseLabel) pauseLabel.textContent = status === 'PAUSED' ? 'Resume' : 'Pause';
  const pauseIcon = $('.action-icon', els.pauseBtn);
  if (pauseIcon) pauseIcon.textContent = status === 'PAUSED' ? '▶' : 'Ⅱ';
  els.pauseBtn.title = status === 'PAUSED' ? 'Resume tournament' : 'Pause tournament';
  els.exportBtn.disabled = !(s?.events?.length);
  const seated = seatAssignments.filter(Boolean).length;
  if (lobbyVisible && !running) els.tournamentMeta.textContent = `${seated} model${seated === 1 ? '' : 's'} seated · click a seat to edit`;
  else if (s?.table && s?.status === 'FINISHED' && s?.winner) els.tournamentMeta.textContent = `Winner · ${displayModelName(s.winner.model || '')} · ${fmt(s.winner.stack)} chips · ${s.table.handNumber} hands`;
  else if (s?.table && s?.status === 'PAUSED') els.tournamentMeta.textContent = `Paused · Hand ${s.table.handNumber} · Level ${Number(s.table.blindLevel || 0) + 1} · ${s.table.playersRemaining ?? s.config?.players.length ?? 0}/${s.table.startingPlayers ?? s.config?.players.length ?? 0} left`;
  else if (s?.table) els.tournamentMeta.textContent = `Hand ${s.table.handNumber} · Level ${Number(s.table.blindLevel || 0) + 1} · ${s.table.playersRemaining ?? s.config?.players.length ?? 0}/${s.table.startingPlayers ?? s.config?.players.length ?? 0} left`;
  else els.tournamentMeta.textContent = 'Seat 2–10 models, then press ▶';
}
function renderTable(s) {
  const running = ['RUNNING', 'PAUSED'].includes(s?.status);
  if (lobbyVisible && !running) { renderLobbyTable(); return; }
  const table = s?.table;
  if (!table) { renderLobbyTable(); return; }
  els.pokerTable.classList.remove('lobby-mode');
  const players = table.players.filter(Boolean);
  const configuredPlayers = Array.isArray(s.config?.players) ? s.config.players : [];
  const visualCount = Math.max(TABLE_MIN_PLAYERS, Math.min(MAX_LOBBY_SEATS, players.length));
  const eliminatedIds = new Set((s.eliminations ?? []).map(e => e.playerId));
  els.seatsLayer.innerHTML = players.map((p, i) => {
    const cfg = configuredPlayers.find(x => x.id === p.id) || {}, stat = s.stats?.[p.id] || {};
    const visualIndex = i;
    const active = table.actionTo === p.seat || s.currentDecision?.playerId === p.id, isWinner = s.status === 'FINISHED' && s.winner?.playerId === p.id, busted = !isWinner && (eliminatedIds.has(p.id) || p.status === 'BUSTED'), allIn = p.status === 'ALL_IN' && !busted;
    const elimination = (s.eliminations ?? []).find(e => e.playerId === p.id);
    const actionText = s.status === 'FINISHED' ? (isWinner ? 'WINNER · 1ST' : elimination ? `${ordinal(elimination.place)} · ELIMINATED` : (stat.lastAction || '')) : (stat.lastAction || (busted ? 'ELIMINATED' : allIn ? 'ALL IN' : ''));
    const actionKind = isWinner ? 'winner' : String(stat.lastActionType || '').toLowerCase();
    const shownAction = active && s.status !== 'FINISHED' ? 'THINKING' : actionText;
    const action = tableActionParts(shownAction, active ? 'thinking' : actionKind, active ? null : stat.lastActionAmount);
    return `<div class="table-seat ${active ? 'turn-active' : ''} ${isWinner ? 'winner' : ''} ${busted ? 'busted' : ''} ${allIn ? 'all-in' : ''}" data-player-id="${escapeHtml(p.id)}" data-seat="${p.seat}" data-lobby-seat="${Number(cfg.lobbySeat ?? i)}" data-visual-index="${visualIndex}" data-visual-count="${visualCount}" data-position="${escapeHtml(p.position || '')}">
      <div class="seat-card">
        <i class="seat-turn" aria-hidden="true"></i><span class="seat-name">${escapeHtml(visiblePlayerName(p.name, cfg.model))}</span><span class="seat-stack">${fmt(p.stack)}</span>
        <span class="seat-model">${escapeHtml(shortModel(cfg.model))}</span><span class="seat-bb">${Number(p.stackBB || 0).toFixed(1)} BB</span>
      </div>
      <span class="hole-cards" aria-hidden="true">${[0, 1].map(k => tableCardHtml(p.cards?.[k], 'hole')).join('')}</span>
      ${action ? `<span class="table-action ${active ? 'thinking' : actionKind}" aria-label="${escapeHtml(shownAction)}"><span class="table-action-icon">${action.icon}</span><span class="table-action-name">${escapeHtml(action.name)}</span>${action.value ? `<span class="table-action-value">${escapeHtml(action.value)}</span>` : ''}</span>` : ''}
    </div>`;
  }).join('');
  layoutTableSeats();
  els.board.innerHTML = Array.from({ length: 5 }, (_, i) => tableCardHtml(table.board?.[i])).join('');
  if (els.potChips) els.potChips.innerHTML = potChipsHtml(table.pot, table);
  els.potValue.textContent = fmtHud(table.pot);
  els.potValue.title = fmt(table.pot);
  els.blindsValue.textContent = `${fmtHud(table.smallBlind)} / ${fmtHud(table.bigBlind)}`;
  els.blindsValue.title = `${fmt(table.smallBlind)} / ${fmt(table.bigBlind)}`;
  els.anteValue.textContent = table.ante ? fmtHud(table.ante) : '—';
  els.anteValue.title = table.ante ? fmt(table.ante) : 'No ante';
  els.handValue.textContent = table.handNumber ?? '—';
  els.handValue.title = table.handNumber == null ? '' : `Hand ${table.handNumber}`;
  els.levelValue.textContent = Number(table.blindLevel ?? 0) + 1;
  els.levelValue.title = `Level ${Number(table.blindLevel ?? 0) + 1}`;
}
function tableActionParts(text, kind = '', actionAmount = null) {
  const value = String(text || '').trim();
  if (!value) return null;
  const amount = actionAmount == null ? (value.match(/(?:^|\s)([\d,.]+(?:K|M)?)(?:\s|$)/i)?.[1] || '') : fmt(actionAmount);
  const label = { thinking: 'THINKING', raise: 'RAISE', bet: 'BET', call: 'CALL', check: 'CHECK', fold: 'FOLD', winner: 'WINNER', all_in: 'ALL IN' }[kind];
  const name = label || value;
  const icon = kind === 'fold' ? '×' : kind === 'check' ? '✓' : kind === 'call' ? '→' : kind === 'raise' ? '↗' : kind === 'bet' || kind === 'all_in' ? '↑' : kind === 'winner' ? '★' : '•';
  return { icon, name, value: amount };
}
function clearTurnRings(keep = null) {
  for (const el of $$('.table-seat.turn-active')) if (el !== keep) el.classList.remove('turn-active');
}
function stopClock() {
  if (clockTimer) { cancelAnimationFrame(clockTimer); clearTimeout(clockTimer); }
  clockTimer = null; activeDecisionClockId = null;
  clearTurnRings();
}
function startClock(decision) {
  if (!decision) { stopClock(); return; }
  if (activeDecisionClockId === decision.id && clockTimer) return;
  stopClock(); activeDecisionClockId = decision.id;
  const frame = () => {
    const now = decision.pausedAt || Date.now();
    const elapsed = Math.max(0, now - decision.startedAt - (decision.pausedMs || 0));
    const phase = decisionClockPhase({
      baseMs: decision.baseMs,
      timeBankMs: decision.timeBankMs,
      elapsedMs: elapsed,
      lowTimeMs: Number.isFinite(Number(decision.lowTimeMs)) ? Number(decision.lowTimeMs) : TIMING_DEFAULTS.lowTimeSeconds * 1000,
      lowTimeFraction: Number.isFinite(Number(decision.lowTimeFraction)) ? Number(decision.lowTimeFraction) : TIMING_DEFAULTS.lowTimeFraction,
    });
    els.decisionClock.textContent = (phase.shownMs / 1000).toFixed(1);
    setBankClock(decision.pausedAt
      ? 'Paused'
      : (phase.inBank
        ? `Time bank ${(phase.bankLeft / 1000).toFixed(1)}s`
        : (decision.timeBankMs > 0 ? `Bank ${(decision.timeBankMs / 1000).toFixed(0)}s` : 'On the clock')));
    const seat = seatEl(decision.playerId);
    clearTurnRings(seat);
    if (seat) {
      seat.classList.add('turn-active');
      seat.style.setProperty('--turn', phase.ringFraction.toFixed(4));
      seat.classList.toggle('turn-low', phase.isLow);
    }
    if (activeDecisionClockId === decision.id) clockTimer = setTimeout(frame, tableRecording ? 100 : 50);
  };
  frame();
}
function latestDecisionEvent(s) {
  const events = s?.events || [];
  for (let i = events.length - 1; i >= 0; i--) if (events[i]?.type === 'DECISION') return events[i];
  return null;
}
function compactPercent(value) { return `${Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)}%`; }
function deterministicHandLabel(heroCards, board) {
  const hand = heroHandSummary(heroCards, board);
  return hand ? hand.category : null;
}
function confidenceBand(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  return v < 0.34 ? 'LOW' : v < 0.67 ? 'MEDIUM' : 'HIGH';
}
function aggressionTendency(value) {
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  const labels = ['Very passive', 'Cautious', 'Balanced', 'Aggressive', 'Maximum pressure'];
  const idx = clamp(Math.round(v), 0, 4);
  const direction = v > 2.6 ? 'Aggressive' : v < 1.4 ? 'Passive' : 'Balanced';
  return `${v.toFixed(1)} / 4 · ${labels[idx]} → ${direction}`;
}
function probabilityStrip(entries, labelFor, limit = 4) {
  const rows = Object.entries(entries ?? {})
    .filter(([, value]) => Number.isFinite(Number(value)))
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, limit);
  if (!rows.length) return '';
  return `<div class="probability-strip">${rows.map(([id, probability]) => {
    const pct = Math.round(Number(probability) * 100);
    const label = labelFor(id);
    return `<span class="probability-item" title="${escapeHtml(label)} — ${pct}%"><b>${escapeHtml(label)}</b><i><u style="width:${Math.max(2, pct)}%"></u></i><em>${pct}%</em></span>`;
  }).join('')}</div>`;
}
function decisionTelemetryHtml(event, { limit = 4 } = {}) {
  const meta = event?.decisionMeta || {};
  const labelFor = id => (event?.legalActions || []).find(a => a.id === id)?.description || id;
  const familyLabel = key => familyCriteria([String(key).toLowerCase()])[String(key).toLowerCase()] ?? String(key).toUpperCase();
  const sizeLabel = key => SIZE_LABELS[String(key).toLowerCase()] ?? String(key).toUpperCase();
  const parts = [];
  if (meta.family?.probabilities && typeof meta.family.probabilities === 'object') {
    parts.push('<div class="telemetry-group"><span class="telemetry-caption">Selected family</span>' + probabilityStrip(meta.family.probabilities, familyLabel, limit) + '</div>');
    if (meta.sizing?.probabilities && typeof meta.sizing.probabilities === 'object') {
      parts.push('<div class="telemetry-group"><span class="telemetry-caption">Sizing</span>' + probabilityStrip(meta.sizing.probabilities, sizeLabel, limit) + '</div>');
    }
  } else if (meta.probabilities && typeof meta.probabilities === 'object') {
    const familyMass = aggregateActionProbabilitiesByFamily(meta.probabilities, event?.legalActions, { labelResolver: id => ({ description: labelFor(id) }) });
    const ordered = {};
    for (const key of ['check', 'bet', 'call', 'raise', 'fold', 'other']) if (Number.isFinite(Number(familyMass[key]))) ordered[key] = familyMass[key];
    parts.push('<div class="telemetry-group"><span class="telemetry-caption">Aggregated from legacy flat action probabilities</span>' + probabilityStrip(ordered, familyLabel, 6) + '</div>');
    parts.push('<div class="telemetry-group"><span class="telemetry-caption">Individual flat actions</span>' + probabilityStrip(meta.probabilities, labelFor, limit) + '</div>');
  }
  const facts = [];
  const familyConfidence = meta.family?.confidence ?? meta.confidence;
  if (Number.isFinite(Number(familyConfidence))) {
    const band = confidenceBand(familyConfidence);
    facts.push(`<span>Confidence <b>${band ? `${band} · ` : ''}${compactPercent(familyConfidence)}</b></span>`);
  }
  if (Number.isFinite(Number(meta.sizing?.confidence))) facts.push(`<span>Size confidence <b>${compactPercent(meta.sizing.confidence)}</b></span>`);
  if (Number.isFinite(Number(meta.aggression))) facts.push(`<span>Aggression tendency <b>${escapeHtml(aggressionTendency(meta.aggression))}</b></span>`);
  if (Number.isFinite(Number(meta.bluffSpot))) facts.push(`<span>Bluff opportunity (spot) <b>${compactPercent(meta.bluffSpot)}</b></span>`);
  const reasoningTokens = event?.usage?.completion_tokens_details?.reasoning_tokens;
  if (reasoningTokens) facts.push(`<span>Reasoning <b>${reasoningTokens} tokens</b></span>`);
  if (facts.length) parts.push(`<div class="decision-facts">${facts.join('')}</div>`);
  return parts.join('');
}
// Full reasoning is persisted (capped); the live card shows only a rolling tail.
function reasoningTail(text, limit = 420) {
  const value = String(text || '');
  return value.length > limit ? `…${value.slice(-limit)}` : value;
}
function capReasoning(text, limit = 8000) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}
function decisionReasoningText(event) {
  const reasoning = event?.reasoning;
  if (!reasoning) return '';
  return [reasoning.family, reasoning.sizing, reasoning.flat].filter(Boolean).join('\n\n');
}
function reasoningExcerpt(text, limit = 220) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}
function renderLiveReasoning(d) {
  const node = els.decisionReasoning;
  if (!node) return;
  const live = d?.reasoning ?? null;
  const text = String(live?.text || '').trim();
  node.classList.toggle('hidden', !text);
  if (!text) { node.innerHTML = ''; return; }
  const label = live?.stage === 'size' ? 'Size reasoning' : live?.stage === 'flat' ? 'Reasoning' : 'Action reasoning';
  node.innerHTML = `<span class="decision-reasoning-label">${escapeHtml(label)}${live?.channel === 'content' ? ' · answer' : ''}</span><span class="decision-reasoning-text">${escapeHtml(text)}</span>`;
}
function setDecisionContext({ hand = '—', street = '—', position = '—', options = '—', label = 'Legal actions', hint = 'Choose one', labels = null } = {}) {
  els.decisionHand.textContent = hand ?? '—';
  els.decisionStreet.textContent = String(street ?? '—').replaceAll('_', ' ');
  els.decisionPosition.textContent = position || '—';
  els.decisionOptionCount.textContent = options ?? '—';
  els.decisionActionLabel.textContent = label;
  setActionHint(hint);
  const names = Array.isArray(labels) && labels.length === 4 ? labels : ['Hand', 'Street', 'Position', 'Options'];
  els.decisionLabelHand.textContent = names[0];
  els.decisionLabelStreet.textContent = names[1];
  els.decisionLabelPosition.textContent = names[2];
  els.decisionLabelOptions.textContent = names[3];
}
function setBankClock(text) { els.bankClock.textContent = text; els.bankClock.title = text; }
function setActionHint(text) { els.decisionActionHint.textContent = text; els.decisionActionHint.title = text; }
function championBadgeHtml() {
  return '<span class="champion-badge" role="img" aria-label="Tournament champion">'
    + '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<path d="M6.6 2.6h10.8v4.7a5.4 5.4 0 0 1-10.8 0V2.6Z"/>'
    + '<path d="M10.7 12.4h2.6V15h-2.6z"/>'
    + '<path d="M7.2 15h9.6v2.1H7.2z"/>'
    + '<path d="M5.6 18.2h12.8v2.3H5.6z"/>'
    + '</svg></span>';
}
function renderDecision(s) {
  if (['STOPPED', 'ERROR'].includes(s?.status)) { stopClock(); return; }
  const d = s?.currentDecision;
  const last = latestDecisionEvent(s);
  const shouldShowCard = Boolean(d || last || seatAssignments.filter(Boolean).length);
  els.decisionEmpty.classList.toggle('hidden', shouldShowCard);
  els.decisionCard.classList.toggle('hidden', !shouldShowCard);
  if (!shouldShowCard) { stopClock(); return; }

  const finished = s?.status === 'FINISHED' && Boolean(s?.winner);
  els.decisionCard.classList.toggle('winner-card', finished);
  els.decisionPanelTitle.classList.toggle('winner-title', finished);

  if (d) {
    const paused = s?.status === 'PAUSED';
    els.decisionPanelTitle.textContent = 'Decision';
    els.decisionPhase.textContent = paused ? 'PAUSED' : 'THINKING';
    els.decisionPhase.className = `decision-phase ${paused ? 'paused' : 'thinking'}`;
    els.decisionPlayer.textContent = displayModelName(d.model);
    els.decisionPlayer.title = d.model;
    els.decisionModel.textContent = `${d.connection || 'Connection'} · ${protocolDisplay(d.protocol)}`;
    renderLiveReasoning(d);
    if (d.architecture === 'hierarchical') {
      const stage = d.stage ?? d.hierarchy?.stage1 ?? null;
      const families = stage?.families ?? d.hierarchy?.families ?? [];
      if (stage?.stage === 'size') {
        setDecisionContext({ hand: d.handNumber ?? s?.table?.handNumber ?? '—', street: d.street ?? s?.table?.street ?? '—', position: d.position ?? '—', options: stage.sizes?.length ?? 0, label: `${String(stage.family).toUpperCase()} size`, hint: 'Stage 2 of 2 · sizing' });
        els.legalActions.innerHTML = (stage.sizes ?? []).map(size => `<span class="action-chip stage-chip">${escapeHtml(SIZE_LABELS[size.id] ?? size.id)} · ${escapeHtml(size.label)}</span>`).join('') || '<span class="action-chip">No legal sizes</span>';
      } else {
        setDecisionContext({ hand: d.handNumber ?? s?.table?.handNumber ?? '—', street: d.street ?? s?.table?.street ?? '—', position: d.position ?? '—', options: families.length, label: 'Action family', hint: 'Stage 1 of 2 · action' });
        const criteria = stage?.criteria ?? familyCriteria(families);
        els.legalActions.innerHTML = families.map(family => `<span class="action-chip stage-chip">${escapeHtml(criteria[family] ?? family)}</span>`).join('') || '<span class="action-chip">…</span>';
      }
      startClock(d);
      return;
    }
    setDecisionContext({ hand: d.handNumber ?? s?.table?.handNumber ?? '—', street: d.street ?? s?.table?.street ?? '—', position: d.position ?? '—', options: d.legalActions?.length ?? 0, label: 'Legal actions', hint: 'Choosing…' });
    els.legalActions.innerHTML = d.legalActions.map(a => `<span class="action-chip" title="${escapeHtml(a.id)}">${escapeHtml(a.description)}</span>`).join('');
    startClock(d);
    return;
  }

  renderLiveReasoning(null);
  stopClock();
  if (finished) {
    const winnerLast = [...(s.events || [])].reverse().find(e => e.type === 'DECISION' && e.playerId === s.winner.playerId) || last;
    const hands = s.table?.handNumber || 0;
    const players = s.table?.startingPlayers ?? s.config?.players?.length ?? null;
    const eliminated = Array.isArray(s.eliminations) ? s.eliminations.length : 0;
    const runnerUp = [...(s.eliminations || [])].reverse().find(e => e.place === 2) || (s.eliminations || [])[0] || null;
    const duration = (s.startedAt && s.finishedAt) ? formatDuration(s.finishedAt - s.startedAt) : null;
    els.decisionPanelTitle.textContent = 'Tournament complete';
    els.decisionPhase.textContent = 'WINNER';
    els.decisionPhase.className = 'decision-phase winner';
    els.decisionPlayer.textContent = displayModelName(s.winner.model || s.winner.playerName || 'Tournament winner');
    els.decisionPlayer.title = s.winner.model || s.winner.playerName || '';
    els.decisionModel.textContent = `${fmt(s.winner.stack)} chips${duration ? ` · ${duration}` : ''}`;
    els.decisionClock.innerHTML = championBadgeHtml();
    els.decisionClock.title = 'Tournament champion';
    setBankClock(winnerLast ? `Won on hand ${winnerLast.handNumber ?? hands}` : 'All hands settled');
    const modelForPlayer = (playerId) => (s.config?.players || []).find(p => p.id === playerId)?.model || '';
    const standings = [
      { place: 1, model: s.winner.model || '', name: s.winner.playerName || '', meta: `${fmt(s.winner.stack)} chips` },
      ...(s.eliminations || []).map(e => ({ place: e.place, model: modelForPlayer(e.playerId), name: e.playerName || '', meta: `out · hand ${e.handNumber}` })),
    ].sort((a, b) => a.place - b.place);
    const medal = place => place === 1 ? '🥇' : place === 2 ? '🥈' : '🥉';
    setDecisionContext({
      labels: ['Players', 'Hands', 'Eliminated', 'Runner-up'],
      hand: players != null ? String(players) : '—',
      street: String(hands),
      position: String(eliminated),
      options: runnerUp ? displayModelName(modelForPlayer(runnerUp.playerId) || runnerUp.playerName || '') : '—',
      label: 'Final standings',
      hint: winnerLast ? `Won with ${winnerLast.action?.description || 'the final hand'}` : 'Complete',
    });
    els.legalActions.innerHTML = `<div class="winner-podium">${standings.map(row => `<div class="podium-row${row.place === 1 ? ' first' : ''}"><span class="podium-medal">${medal(row.place)}</span><span class="podium-name" title="${escapeHtml(row.model || row.name)}">${escapeHtml(displayModelName(row.model || row.name || ''))}</span><span class="podium-meta">${escapeHtml(row.meta)}</span></div>`).join('')}</div>`;
    return;
  }

  els.decisionPanelTitle.textContent = 'Decision';
  if (last) {
    const paused = s?.status === 'PAUSED';
    els.decisionPhase.textContent = paused ? 'PAUSED' : 'LAST';
    els.decisionPhase.className = `decision-phase ${paused ? 'paused' : 'settled'}`;
    els.decisionPlayer.textContent = displayModelName(last.configuredModel || last.resolvedModel || '');
    els.decisionPlayer.title = last.configuredModel || last.resolvedModel || '';
    els.decisionModel.textContent = `${last.connection || 'Connection'} · ${protocolDisplay(last.protocol || last.requestedProtocol)}`;
    els.decisionClock.textContent = `${(((last.latencyMs || 0) / 1000) || 0).toFixed(1)}s`;
    setBankClock(paused ? 'Reading mode' : 'Awaiting next');
    setDecisionContext({ hand: last.handNumber ?? s?.table?.handNumber ?? '—', street: last.street ?? '—', position: last.position ?? '—', options: 1, label: 'Last action', hint: 'See history' });
    els.legalActions.innerHTML = `<span class="action-chip selected">${escapeHtml(last.action?.description || 'No action')}</span>`;
  } else {
    els.decisionPhase.textContent = 'READY';
    els.decisionPhase.className = 'decision-phase settled';
    els.decisionPlayer.textContent = 'Waiting for first decision';
    els.decisionModel.textContent = 'Configured models are ready';
    els.decisionClock.textContent = '—';
    setBankClock('Idle');
    setDecisionContext({ hand: '—', street: '—', position: '—', options: '—', label: 'Decision stream', hint: 'Not started' });
    els.legalActions.innerHTML = '<span class="action-chip">Start the tournament to stream model actions here.</span>';
  }
}
// Pinned at the top of Decision history while a seat is deciding. It is a plain
// div (nothing to replay yet) and is replaced by the normal completed row when
// the DECISION event lands and currentDecision clears.
function liveFeedRowHtml(d) {
  const model = d.model || '';
  const stage = d.stage?.stage === 'size'
    ? `${String(d.stage.family || '').toUpperCase()} size`
    : d.architecture === 'hierarchical' ? 'Action family' : 'Legal actions';
  const reasoning = String(d.reasoning?.text || '').trim();
  const isAnswer = d.reasoning?.channel === 'content';
  const bodyHtml = reasoning
    ? `<div class="decision-reasoning-excerpt live"><span class="decision-reasoning-label">${isAnswer ? 'Streaming answer' : 'Streaming reasoning'}</span>${escapeHtml(reasoningExcerpt(reasoning, 260))}</div>`
    : '<div class="decision-reason live"><span class="live-pulse" aria-hidden="true"></span>Thinking…</div>';
  const elapsed = d.startedAt ? Math.max(0, Date.now() - d.startedAt - (d.pausedMs || 0)) : 0;
  return `<div class="decision-item decision-history-item live" aria-label="Live decision by ${escapeHtml(displayModelName(model))}">`
    + `<div class="decision-item-head"><strong title="${escapeHtml(model)}">${escapeHtml(displayModelName(model))}</strong><span class="decision-item-action live-action"><span class="live-pulse" aria-hidden="true"></span>LIVE</span></div>`
    + `<div class="decision-reason">${escapeHtml(stage)}${d.street ? ` · ${escapeHtml(String(d.street))}` : ''}${d.position ? ` · ${escapeHtml(d.position)}` : ''}</div>`
    + bodyHtml
    + `<div class="decision-meta mono">${escapeHtml(d.connection || '')} · ${escapeHtml(shortModel(model))} · ${(elapsed / 1000).toFixed(1)}s<span class="decision-replay-hint">streaming</span></div>`
    + '</div>';
}
function renderFeed(s) {

  const feedArchive = eventArchive(s);
  const events = feedArchive.filter(e => e.type === 'DECISION').slice(-HISTORY_CONFIG.recentDecisions).reverse();
  const explanations = new Map(feedArchive.filter(e => e.type === 'SPECTATOR_EXPLANATION').map(e => [e.decisionId, e.text]));
  const liveHtml = s?.currentDecision ? liveFeedRowHtml(s.currentDecision) : '';
  const rowsHtml = events.map(e => {
    const infra = [];
    if (e.protocolFallback) infra.push(e.protocolFallback);
    if (e.decisionMeta?.retryCount) infra.push(`retry ${e.decisionMeta.retryCount}`);
    if (e.errorCategory) infra.push(e.errorCategory.replace('_', ' '));
    if (e.forced) infra.push('AUTO FALLBACK');
    const telemetry = decisionTelemetryHtml(e);
    const reason = explanations.get(e.decisionId) || e.publicReason || (e.decisionMeta?.family ? 'Typed decision (no text rationale)' : 'No public rationale');
    const reasoning = decisionReasoningText(e);
    const reasoningHtml = reasoning ? `<div class="decision-reasoning-excerpt" title="${escapeHtml(reasoning)}"><span class="decision-reasoning-label">Reasoning</span>${escapeHtml(reasoningExcerpt(reasoning))}</div>` : '';
    return `<button type="button" class="decision-item decision-history-item ${e.error ? 'error' : ''}" data-decision-id="${escapeHtml(e.id)}" aria-label="Replay ${escapeHtml(displayModelName(e.configuredModel || e.resolvedModel || ''))} decision"><div class="decision-item-head"><strong title="${escapeHtml(e.configuredModel || e.resolvedModel || '')}">${escapeHtml(displayModelName(e.configuredModel || e.resolvedModel || ''))}</strong><span class="decision-item-action">${escapeHtml(e.action?.description || '—')}</span></div><div class="decision-reason">${escapeHtml(reason)}</div>${reasoningHtml}${telemetry ? `<div class="decision-item-telemetry">${telemetry}</div>` : ''}<div class="decision-meta mono">${escapeHtml(e.connection || '')} · ${escapeHtml(shortModel(e.resolvedModel || e.configuredModel || ''))} · ${e.primaryDecisionLatencyMs || e.latencyMs || 0}ms${infra.length ? ` · ${escapeHtml(infra.join(' · '))}` : ''}${e.error ? ` · ${escapeHtml(e.error)}` : ''}<span class="decision-replay-hint">View hand ↗</span></div></button>`;
  }).join('');
  els.decisionFeed.innerHTML = (liveHtml || rowsHtml)
    ? `${liveHtml}${rowsHtml}`
    : '<div class="empty-state">No decisions yet.</div>';
  if (els.decisionFeedSummary) {
    els.decisionFeedSummary.textContent = s?.currentDecision
      ? `${events.length} settled · 1 live`
      : events.length ? `${events.length} most recent` : 'Newest first';
  }
}
function eventArchive(s = currentState) {
  if (director?.events?.length) return director.events;
  return s?.events || [];
}
function eventCategory(event) {
  const type = String(event?.type || 'EVENT');
  if (type.includes('ERROR') || event?.error || event?.errorCategory) return 'errors';
  if (type === 'DECISION' || type === 'DECISION_START' || type === 'SPECTATOR_EXPLANATION') return 'decisions';
  if (['HAND_START','HAND_END','BLINDS_UP','ELIMINATION','AUTO_SHOW','AUTO_MUCK'].includes(type)) return 'hands';
  return 'system';
}
function eventDetail(event) {
  if (!event) return '';
  if (event.type === 'DECISION') return `${displayModelName(event.configuredModel || event.resolvedModel || event.playerName)} → ${event.action?.description || event.action?.type || 'action'}${event.error ? ` · ${event.error}` : ''}`;
  if (event.type === 'DECISION_START') return `${displayModelName(event.model || event.playerName || '')} · ${String(event.street || '').toUpperCase()} · ${event.position || '—'}`;
  if (event.type === 'HAND_START') return `Hand ${event.handNumber} · blinds ${fmt(event.smallBlind)}/${fmt(event.bigBlind)}${event.ante ? ` · ante ${fmt(event.ante)}` : ''}`;
  if (event.type === 'HAND_END') {
    const winners = (event.winners || []).map(w => replayDisplayName(w?.playerId ?? w?.id, w?.playerName ?? w?.name)).filter(Boolean);
    return `Hand ${event.handNumber}${winners.length ? ` · ${winners.join(', ')}` : ''}`;
  }
  if (event.type === 'ELIMINATION') return `${replayDisplayName(event.playerId, event.playerName)} · ${ordinal(event.place)} place · hand ${event.handNumber ?? '—'}`;
  if (event.type === 'BLINDS_UP') return `Level ${Number(event.level || 0) + 1} · ${fmt(event.smallBlind)}/${fmt(event.bigBlind)}${event.ante ? ` · ante ${fmt(event.ante)}` : ''}`;
  if (event.type === 'TOURNAMENT_START') return `${event.config?.players?.length || currentState?.config?.players?.length || 0} models · starting stack ${fmt(event.config?.startingStack || currentState?.config?.startingStack || 0)}`;
  if (event.type === 'TOURNAMENT_END') return event.winner?.model ? `${displayModelName(event.winner.model)} · ${event.hands || event.handNumber || '—'} hands` : replayDisplayName(event.winner?.playerId, event.winner?.playerName);
  if (event.type === 'TOURNAMENT_ERROR') return event.error || 'Tournament error';
  if (event.type === 'DECISION_BUDGET_REACHED') return `${fmt(event.decisions)} decisions · budget ${fmt(event.budget)}`;
  if (event.error) return String(event.error);
  return '';
}
function eventMeta(event) {
  const bits = [];
  if (event.handNumber != null && !['HAND_START','HAND_END'].includes(event.type)) bits.push(`Hand ${event.handNumber}`);
  if (event.street) bits.push(String(event.street).toUpperCase());
  if (event.position) bits.push(String(event.position));
  const latency = event.primaryDecisionLatencyMs || event.latencyMs;
  if (latency) bits.push(`${fmt(latency)} ms`);
  if (event.protocol || event.requestedProtocol) bits.push(protocolDisplay(event.protocol || event.requestedProtocol));
  if (event.errorCategory) bits.push(String(event.errorCategory).replaceAll('_', ' '));
  return bits.join(' · ');
}
function eventMatchesView(event) {
  if (logView.filter !== 'all' && eventCategory(event) !== logView.filter) return false;
  const query = logView.query.trim().toLowerCase();
  if (!query) return true;
  const haystack = [event.type, eventDetail(event), eventMeta(event), event.playerName, event.configuredModel, event.resolvedModel, event.connection, event.error].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(query);
}
function renderEvents(s) {
  const archive = eventArchive(s);
  const events = archive.filter(eventMatchesView).reverse();
  if (els.logTabCount) els.logTabCount.textContent = archive.length > 999 ? '999+' : String(archive.length);
  if (els.logSummary) {
    const suffix = events.length === archive.length ? 'full run' : `${events.length} shown`;
    els.logSummary.textContent = `${archive.length.toLocaleString()} event${archive.length === 1 ? '' : 's'} · ${suffix}`;
  }
  els.eventLog.innerHTML = events.map(e => {
    const category = eventCategory(e);
    const detail = eventDetail(e);
    const meta = eventMeta(e);
    const time = new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const replayable = e.type === 'DECISION';
    const tag = replayable ? 'button' : 'div';
    const attrs = replayable ? ` type="button" data-decision-id="${escapeHtml(e.id)}" aria-label="Replay ${escapeHtml(detail || 'decision')}"` : '';
    return `<${tag}${attrs} class="event-row event-${category}${e.error || e.type?.includes?.('ERROR') ? ' has-error' : ''}">
      <span class="event-rail" aria-hidden="true"></span>
      <span class="event-main"><span class="event-row-head"><span class="event-type">${escapeHtml(e.type.replaceAll('_', ' '))}</span><time class="event-time mono" datetime="${new Date(e.at).toISOString()}">${escapeHtml(time)}</time></span>${detail ? `<span class="event-detail">${escapeHtml(detail)}</span>` : ''}${meta ? `<span class="event-meta mono">${escapeHtml(meta)}</span>` : ''}</span>
      ${replayable ? '<span class="event-open" aria-hidden="true">↗</span>' : ''}
    </${tag}>`;
  }).join('') || '<div class="empty-state log-empty">No events match these filters.</div>';
}

function renderStats(s) {
  if (!s?.config) { els.statsGrid.innerHTML = '<div class="empty-state">Statistics will appear after the tournament starts.</div>'; return; }
  const publicById = new Map((s.publicPlayerStats ?? []).map(row => [row.playerId, row]));
  els.statsGrid.innerHTML = s.config.players.map(p => {
    const st = s.stats?.[p.id] || {}, poker = publicById.get(p.id) || {}, tableP = s.table?.players?.find?.(x => x?.id === p.id), avg = st.decisions ? Math.round(st.totalLatencyMs / st.decisions) : 0;
    const pc = value => `${Math.round(Number(value || 0) * 100)}%`;
    return `<div class="stat-card"><div class="stat-top"><div><div class="stat-name">${escapeHtml(visiblePlayerName(p.name, p.model))}</div><div class="stat-model mono">${escapeHtml(p.model)} · ${escapeHtml(effectiveProtocol(p, s.config.connections.find(c => c.id === p.connectionId)))}</div></div><strong>${fmt(tableP?.stack || 0)}</strong></div>
      <div class="poker-profile"><div title="Voluntarily put chips in pot"><b>${pc(poker.vpipPct)}</b><span>VPIP</span></div><div title="Preflop raise"><b>${pc(poker.pfrPct)}</b><span>PFR</span></div><div title="Aggression frequency"><b>${pc(poker.aggressionPct)}</b><span>AFq</span></div><div title="Fold when folding was legal"><b>${pc(poker.foldPct)}</b><span>FOLD</span></div><div><b>${poker.sampleHands || 0}</b><span>HANDS</span></div></div>
      <div class="stat-values"><div class="metric"><b>${st.decisions || 0}</b><span>moves</span></div><div class="metric"><b>${avg}ms</b><span>avg</span></div><div class="metric"><b>${st.autoFallbacks || 0}</b><span>auto</span></div></div><div class="stat-reliability"><span><b>${st.modelErrors || 0}</b> model</span><span><b>${st.providerErrors || 0}</b> provider</span><span><b>${st.rateLimits || 0}</b> rate</span><span><b>${st.timeouts || 0}</b> timeout</span><span><b>${st.protocolFallbacks || 0}</b> protocol</span><span><b>${st.retries || 0}</b> retry</span></div></div>`;
  }).join('');
}
function tableRenderSignature(s) {
  const running = ['RUNNING', 'PAUSED'].includes(s?.status);
  if (lobbyVisible && !running) {
    return JSON.stringify(['lobby', seatAssignments.map(p => p ? [p.name, p.model, p.protocol, p.connectionId, p.provider, Boolean(p.captureReasoning)] : null)]);
  }
  const t = s?.table;
  if (!t) return JSON.stringify(['empty', s?.status || 'IDLE']);
  return JSON.stringify([
    s?.status, s?.winner?.playerId || null, t.handNumber, t.street, t.pot, t.smallBlind, t.bigBlind, t.ante, t.blindLevel, t.actionTo,
    t.board || [], (s?.eliminations || []).map(e => e.playerId),
    (t.players || []).filter(Boolean).map(p => [p.id, p.stack, p.stackBB, p.status, p.position, p.currentBet, p.cards || [], s?.stats?.[p.id]?.lastAction || ''])
  ]);
}
function statusRenderSignature(s) {
  return JSON.stringify([s?.status || 'IDLE', lobbyVisible, seatAssignments.filter(Boolean).length, s?.table?.handNumber, s?.table?.blindLevel, s?.table?.playersRemaining, s?.table?.startingPlayers]);
}
function decisionRenderSignature(s) {
  const d = s?.currentDecision;
  const last = latestDecisionEvent(s);
  return JSON.stringify([d ? [d.id, d.playerId, d.model, d.protocol, d.provider, d.startedAt, d.baseMs, d.timeBankMs, d.pausedMs || 0, Boolean(d.pausedAt), d.architecture || null, d.stage || null, d.legalActions] : null, last?.id || null, s?.status || 'IDLE', seatAssignments.filter(Boolean).length]);
}
function feedRenderSignature(s) {
  const completed = (s?.events || [])
    .filter(e => e.type === 'DECISION' || e.type === 'SPECTATOR_EXPLANATION')
    .slice(-24)
    .map(e => `${e.type}:${e.id}`);
  const live = s?.currentDecision;
  // Include the in-progress decision so the pinned live row repaints as the
  // reasoning tail grows, then settles into the completed row when it clears.
  if (live) completed.push(`LIVE:${live.id}:${live.stage?.stage ?? ''}:${live.reasoning?.text ?? ''}`);
  return completed.join('|');
}
function eventsRenderSignature(s) { const ev = eventArchive(s); return `${ev.length}:${ev.at(-1)?.id || ''}:${logView.filter}:${logView.query}`; }
function statsRenderSignature(s) {
  if (!s?.config) return 'none';
  return JSON.stringify([(s.config.players || []).map(p => p.id), s.stats, s.publicPlayerStats, (s.table?.players || []).filter(Boolean).map(p => [p.id,p.stack])]);
}
function render(s, { force = false } = {}) {
  currentState = s;
  if (els.logTabCount) {
    const eventCount = eventArchive(s).length;
    els.logTabCount.textContent = eventCount > 999 ? '999+' : String(eventCount);
  }
  const statusSig = statusRenderSignature(s);
  if (force || renderMemo.status !== statusSig) { renderMemo.status = statusSig; renderStatus(s); }
  const tableSig = tableRenderSignature(s);
  if (force || renderMemo.table !== tableSig) { renderMemo.table = tableSig; renderTable(s); }
  const decisionSig = decisionRenderSignature(s);
  if (force || renderMemo.decision !== decisionSig) { renderMemo.decision = decisionSig; renderDecision(s); }
  if (activeInspectorTab === 'live') {
    const sig = feedRenderSignature(s);
    if (force || renderMemo.feed !== sig) { renderMemo.feed = sig; renderFeed(s); }
  } else if (activeInspectorTab === 'log') {
    const sig = eventsRenderSignature(s);
    if (force || renderMemo.events !== sig) { renderMemo.events = sig; renderEvents(s); }
  } else if (activeInspectorTab === 'stats') {
    const sig = statsRenderSignature(s);
    if (force || renderMemo.stats !== sig) { renderMemo.stats = sig; renderStats(s); }
  }
  if (s?.status === 'FINISHED' && tableRecording && !tableRecording.stopping) setTimeout(() => stopTableRecording(), 900);
  if (!(lobbyVisible && !['RUNNING', 'PAUSED'].includes(s?.status))) processVisualEffects(s);
}
function openSetup({ preserveError = false } = {}) { if (!preserveError) els.setupError.classList.add('hidden'); if (!els.setupDialog.open) els.setupDialog.showModal(); syncChoicePickers(); }
function cloneJson(value) { return JSON.parse(JSON.stringify(value)); }
function sanityAgents() {
  const connections = readConnections();
  return readSeatPlayers()
    .map(player => ({ ...player, id: player.id || `player-${player.lobbySeat + 1}`, connection: connections.find(c => c.id === player.connectionId) }))
    .filter(row => row.connection);
}
function sanityProtocolLabel(agent) {
  const protocol = effectiveProtocol(agent, agent.connection);
  return protocol === 'jev_decisions' ? 'Jev Decisions' : protocol === 'jev_native' ? 'Jev native' : protocol.replace('_', ' ');
}
function renderSanityParticipants(agents = sanityAgents()) {
  if (!els.testsParticipants) return;
  if (!agents.length) {
    els.testsParticipants.innerHTML = '<div class="tests-no-models">No configured seats yet. Close this window and click a seat to add a model.</div>';
    return;
  }
  els.testsParticipants.innerHTML = agents.map((agent, index) => `<div class="tests-model-chip">
    <span class="tests-model-index">${index + 1}</span>
    <span class="tests-model-copy"><strong>${escapeHtml(displayModelName(agent.model))}</strong><small title="${escapeHtml(agent.model)}">${escapeHtml(shortModel(agent.model))}</small></span>
    <span class="tests-model-protocol">${escapeHtml(sanityProtocolLabel(agent))}</span>
  </div>`).join('');
}
function updateSanityProgress(agents = sanityAgents()) {
  const total = DECISION_SANITY_SCENARIOS.length * agents.length;
  const completed = sanityResults.filter(r => !r.running).length;
  if (els.testsProgressLabel) els.testsProgressLabel.textContent = `${completed} / ${total} decisions`;
  if (els.testsProgressFill) els.testsProgressFill.style.width = `${total ? (completed / total) * 100 : 0}%`;
}
function sanityModelSummary(agent) {
  const rows = sanityResults.filter(r => r.agentId === agent.id && !r.running);
  const pass = rows.filter(r => r.pass).length;
  const errors = rows.filter(r => r.error).length;
  const miss = rows.length - pass - errors;
  const avg = rows.length ? Math.round(rows.reduce((sum, r) => sum + Number(r.latencyMs || 0), 0) / rows.length) : 0;
  return { rows, pass, miss, errors, avg };
}
function renderSanityResults() {
  if (!els.testsResults) return;
  const agents = sanityAgents();
  renderSanityParticipants(agents);
  updateSanityProgress(agents);

  if (!sanityResults.length) {
    const catalog = DECISION_SANITY_SCENARIOS.map((scenario, index) => `<div class="tests-catalog-row">
      <span class="tests-catalog-no">${String(index + 1).padStart(2, '0')}</span>
      <span class="tests-catalog-main"><strong>${escapeHtml(scenario.title)}</strong><small>${escapeHtml(scenario.category)} · expected ${escapeHtml(scenario.expectedTypes.join(' / '))}</small></span>
    </div>`).join('');
    els.testsResults.innerHTML = `<div class="tests-empty-explainer"><strong>What will run?</strong><span>${DECISION_SANITY_SCENARIOS.length} deterministic spots × ${agents.length || 0} seated model${agents.length === 1 ? '' : 's'}. Each cell below is one real model request.</span></div><div class="tests-catalog">${catalog}</div>`;
    return;
  }

  const summaries = agents.map(agent => {
    const m = sanityModelSummary(agent);
    const totalExpected = DECISION_SANITY_SCENARIOS.length;
    const pct = totalExpected ? Math.round((m.pass / totalExpected) * 100) : 0;
    return `<article class="tests-model-summary">
      <div class="tests-model-summary-head"><div><strong>${escapeHtml(displayModelName(agent.model))}</strong><small>${escapeHtml(shortModel(agent.model))}</small></div><b>${m.pass}/${totalExpected}</b></div>
      <div class="tests-score-bar"><i style="width:${pct}%"></i></div>
      <div class="tests-model-metrics"><span><b>${m.pass}</b> pass</span><span><b>${m.miss}</b> miss</span><span><b>${m.errors}</b> error</span><span><b>${m.avg || 0}ms</b> avg</span></div>
    </article>`;
  }).join('');

  const byKey = new Map(sanityResults.map(r => [`${r.scenarioId}|${r.agentId}`, r]));
  const scenarios = DECISION_SANITY_SCENARIOS.map((scenario, index) => {
    const modelRows = agents.map(agent => {
      const r = byKey.get(`${scenario.id}|${agent.id}`);
      if (!r) return `<div class="tests-agent-result pending"><div class="tests-agent-result-head"><strong>${escapeHtml(displayModelName(agent.model))}</strong><span>PENDING</span></div><p>Waiting for this model.</p></div>`;
      if (r.running) return `<div class="tests-agent-result running"><div class="tests-agent-result-head"><strong>${escapeHtml(displayModelName(agent.model))}</strong><span><i class="test-state-dot"></i> RUNNING</span></div><p>Request in progress…</p></div>`;
      if (r.error) return `<div class="tests-agent-result error"><div class="tests-agent-result-head"><strong>${escapeHtml(displayModelName(agent.model))}</strong><span>ERROR</span></div><b>${r.latencyMs || 0} ms</b><p>${escapeHtml(r.error)}</p></div>`;
      return `<div class="tests-agent-result ${r.pass ? 'pass' : 'miss'}"><div class="tests-agent-result-head"><strong>${escapeHtml(displayModelName(agent.model))}</strong><span>${r.pass ? 'PASS' : 'MISS'}</span></div><div class="tests-agent-action"><b>${escapeHtml(r.actionDescription || r.actionType || '—')}</b><small>${r.latencyMs || 0} ms · ${escapeHtml(r.protocol || sanityProtocolLabel(agent))}</small></div>${r.publicReason ? `<p>${escapeHtml(r.publicReason)}</p>` : ''}</div>`;
    }).join('');
    return `<article class="tests-scenario-card">
      <header class="tests-scenario-head"><span class="tests-scenario-number">${String(index + 1).padStart(2, '0')}</span><div><small>${escapeHtml(scenario.category)}</small><strong>${escapeHtml(scenario.title)}</strong></div><span class="tests-expected">Expected: ${escapeHtml(scenario.expectedTypes.join(' / '))}</span></header>
      <p class="tests-scenario-note">${escapeHtml(scenario.note)}</p>
      <div class="tests-agent-results">${modelRows}</div>
    </article>`;
  }).join('');

  const completed = sanityResults.filter(r => !r.running);
  const passed = completed.filter(r => r.pass).length;
  const errored = completed.filter(r => r.error).length;
  const missed = completed.length - passed - errored;
  els.testsResults.innerHTML = `<div class="tests-summary-line"><div><strong>Model summary</strong><span>Compare sanity pass rate, reliability and latency. Do not treat this as a GTO ranking.</span></div><div class="tests-summary-pills"><span><b>${passed}</b> pass</span><span><b>${missed}</b> miss</span><span><b>${errored}</b> error</span></div></div><div class="tests-model-summaries">${summaries}</div><div class="tests-scenarios" style="--test-model-count:${Math.max(1, agents.length)}">${scenarios}</div>`;
}
async function runDecisionSanitySuite() {
  if (sanityRunAbort) return;
  if (director && ['RUNNING','PAUSED'].includes(director.status)) {
    els.testsStatus.textContent = 'Stop or finish the tournament before running the suite.';
    return;
  }
  const agents = sanityAgents();
  renderSanityParticipants(agents);
  if (!agents.length) {
    els.testsStatus.textContent = 'No models to test. Configure at least one seat first.';
    updateSanityProgress(agents);
    return;
  }
  for (const agent of agents) {
    if (!agent.model || !agent.connection?.baseUrl || ((isOpenRouterConnection(agent.connection) || agent.connection.kind === 'typesafe') && !agent.connection?.apiKey)) {
      els.testsStatus.textContent = `Missing model or connection details for ${displayModelName(agent.model)}.`;
      return;
    }
  }
  sanityRunAbort = new AbortController();
  sanityResults = [];
  els.runTestsBtn.disabled = true;
  els.runTestsBtn.textContent = 'Running…';
  els.clearTestsBtn.textContent = 'Stop run';
  els.clearTestsBtn.classList.add('danger');
  const total = DECISION_SANITY_SCENARIOS.length * agents.length;
  let ordinalRun = 0;
  els.testsStatus.textContent = `Running ${DECISION_SANITY_SCENARIOS.length} spots across ${agents.length} model${agents.length === 1 ? '' : 's'}, sequentially to reduce rate-limit noise.`;
  renderSanityResults();
  try {
    for (let scenarioIndex = 0; scenarioIndex < DECISION_SANITY_SCENARIOS.length; scenarioIndex++) {
      const scenario = DECISION_SANITY_SCENARIOS[scenarioIndex];
      for (const agent of agents) {
        if (sanityRunAbort.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        ordinalRun++;
        els.testsStatus.textContent = `Request ${ordinalRun}/${total} · Spot ${scenarioIndex + 1}/${DECISION_SANITY_SCENARIOS.length} · ${displayModelName(agent.model)}`;
        const placeholder = { scenarioId:scenario.id, agentId:agent.id, agentName:agent.name, model:agent.model, running:true };
        sanityResults.push(placeholder); renderSanityResults();
        const decisionId = id(`sanity-${scenario.id}`);
        const legalActions = scenario.state.legalActions.map(a => ({ ...a }));
        const state = cloneJson(scenario.state);
        const started = performance.now();
        try {
          const result = await decide(agent, agent.connection, { state, legalActions, decisionId, timeoutMs: 45_000, abortSignal: sanityRunAbort.signal });
          Object.assign(placeholder, {
            running:false, pass:scenario.expectedTypes.includes(result.action?.type), actionType:result.action?.type ?? null,
            actionDescription:result.action?.description ?? null, publicReason:result.publicReason ?? '', latencyMs:Math.round(performance.now()-started),
            protocol:result.meta?.protocol ?? effectiveProtocol(agent, agent.connection), error:null,
          });
        } catch (err) {
          Object.assign(placeholder, { running:false, pass:false, error:summarizeError(err), latencyMs:Math.round(performance.now()-started) });
        }
        renderSanityResults();
      }
    }
    const completed = sanityResults.filter(r => !r.running);
    els.testsStatus.textContent = `Complete · ${completed.filter(r=>r.pass).length}/${completed.length} decisions matched the sanity expectations.`;
  } catch (err) {
    if (err?.name === 'AbortError') {
      const done = sanityResults.filter(r => !r.running).length;
      sanityResults = sanityResults.filter(r => !r.running);
      els.testsStatus.textContent = `Stopped · ${done}/${total} decisions completed.`;
    } else els.testsStatus.textContent = `Suite stopped: ${summarizeError(err)}`;
  } finally {
    sanityRunAbort = null;
    els.runTestsBtn.disabled = false;
    els.runTestsBtn.textContent = 'Run all models';
    els.clearTestsBtn.textContent = 'Clear results';
    els.clearTestsBtn.classList.remove('danger');
    renderSanityResults();
  }
}
function openTests() {
  const agents = sanityAgents();
  renderSanityParticipants(agents);
  renderSanityResults();
  if (!sanityResults.length) els.testsStatus.textContent = agents.length ? `Ready · ${DECISION_SANITY_SCENARIOS.length} spots × ${agents.length} model${agents.length === 1 ? '' : 's'} = ${DECISION_SANITY_SCENARIOS.length * agents.length} API decisions.` : 'Configure at least one seat to run the suite.';
  if (!els.testsDialog.open) els.testsDialog.showModal();
}

const TABLE_RECORDING_CONFIG = Object.freeze({
  frameRate: 24,
  maxWidth: 1920,
  maxHeight: 1080,
  minBitrate: 6_000_000,
  maxBitrate: 14_000_000,
  bitsPerPixelPerFrame: 0.14,
  audioBitsPerSecond: 160_000,
  background: '#07090b',
});

function recorderMimeType(hasAudio = true) {
  if (!globalThis.MediaRecorder) return '';
  const candidates = hasAudio
    ? [
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp9,opus',
        'video/webm',
      ]
    : [
        'video/webm;codecs=vp8',
        'video/webm;codecs=vp9',
        'video/webm',
      ];
  return candidates.find(type => MediaRecorder.isTypeSupported?.(type)) || '';
}

function recordingVideoBitrate({ width, height, frameRate = TABLE_RECORDING_CONFIG.frameRate }) {
  const pixelsPerSecond = Math.max(1, width) * Math.max(1, height) * Math.max(1, frameRate);
  return Math.round(clamp(
    pixelsPerSecond * TABLE_RECORDING_CONFIG.bitsPerPixelPerFrame,
    TABLE_RECORDING_CONFIG.minBitrate,
    TABLE_RECORDING_CONFIG.maxBitrate,
  ));
}

function setRecordButton(active, label = null) {
  if (!els.recordBtn) return;
  document.documentElement.classList.toggle('is-recording', active);
  els.recordBtn.classList.toggle('active', active);
  els.recordBtn.setAttribute('aria-pressed', String(active));
  const icon = $('.action-icon', els.recordBtn);
  const text = $('.action-label', els.recordBtn);
  if (icon) icon.textContent = active ? '■' : '●';
  if (text) text.textContent = label || (active ? 'Stop rec' : 'Record');
  els.recordBtn.title = active ? 'Stop table recording and save video' : 'Record poker table with shared tab/system audio';
  els.recordBtn.setAttribute('aria-label', els.recordBtn.title);
}

function saveRecordingBlob(blob) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `pokertools-arena-${stamp}.webm`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function evenRecordingDimension(value) {
  const rounded = Math.max(2, Math.round(Number(value) || 2));
  return rounded % 2 ? rounded - 1 : rounded;
}

function fitRecordingSize(sourceWidth, sourceHeight) {
  const width = Math.max(2, Number(sourceWidth) || 2);
  const height = Math.max(2, Number(sourceHeight) || 2);
  const scale = Math.min(
    1,
    TABLE_RECORDING_CONFIG.maxWidth / width,
    TABLE_RECORDING_CONFIG.maxHeight / height,
  );
  return {
    width: evenRecordingDimension(width * scale),
    height: evenRecordingDimension(height * scale),
  };
}

function captureViewportMetrics(sourceWidth, sourceHeight) {
  const viewport = globalThis.visualViewport;
  const cssWidth = Math.max(1, viewport?.width || document.documentElement.clientWidth || innerWidth || 1);
  const cssHeight = Math.max(1, viewport?.height || document.documentElement.clientHeight || innerHeight || 1);
  const width = Math.max(2, Number(sourceWidth) || cssWidth);
  const height = Math.max(2, Number(sourceHeight) || cssHeight);
  return {
    cssWidth,
    cssHeight,
    sourceWidth: width,
    sourceHeight: height,
    scaleX: width / cssWidth,
    scaleY: height / cssHeight,
    offsetX: viewport?.offsetLeft || 0,
    offsetY: viewport?.offsetTop || 0,
  };
}

function tableCropSourceRect(sourceWidth, sourceHeight) {
  const rect = els.pokerTable.getBoundingClientRect();
  const metrics = captureViewportMetrics(sourceWidth, sourceHeight);
  const leftCss = rect.left - metrics.offsetX;
  const topCss = rect.top - metrics.offsetY;
  const sx = clamp(Math.round(leftCss * metrics.scaleX), 0, Math.max(0, metrics.sourceWidth - 2));
  const sy = clamp(Math.round(topCss * metrics.scaleY), 0, Math.max(0, metrics.sourceHeight - 2));
  const sw = clamp(Math.round(rect.width * metrics.scaleX), 2, metrics.sourceWidth - sx);
  const sh = clamp(Math.round(rect.height * metrics.scaleY), 2, metrics.sourceHeight - sy);
  return { sx, sy, sw, sh };
}

function createTableRecordingCanvas(sourceWidth, sourceHeight) {
  const source = tableCropSourceRect(sourceWidth, sourceHeight);
  const output = fitRecordingSize(source.sw, source.sh);
  const canvas = document.createElement('canvas');
  canvas.width = output.width;
  canvas.height = output.height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Canvas video recording is not available in this browser');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'medium';
  return { canvas, ctx, crop: source };
}

function paintTableRecordingFrame(recording, source, sourceWidth, sourceHeight) {
  const { ctx, canvas } = recording;
  if (!ctx || !canvas || !source) return false;
  const crop = recording.crop || tableCropSourceRect(sourceWidth, sourceHeight);
  ctx.globalCompositeOperation = 'copy';
  ctx.fillStyle = TABLE_RECORDING_CONFIG.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  try {
    ctx.drawImage(
      source,
      crop.sx, crop.sy, crop.sw, crop.sh,
      0, 0, canvas.width, canvas.height,
    );
    return true;
  } catch {
    return false;
  } finally {
    ctx.globalCompositeOperation = 'source-over';
  }
}

function createCaptureVideo(stream) {
  const video = document.createElement('video');
  // Mute only the hidden preview element to prevent echo. The original shared
  // audio track remains live and is muxed directly into the recording.
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.setAttribute('aria-hidden', 'true');
  Object.assign(video.style, {
    position: 'fixed',
    inset: '0 auto auto 0',
    width: '2px',
    height: '2px',
    opacity: '0.001',
    pointerEvents: 'none',
    zIndex: '-1',
  });
  // Keep the captured audio off this muted preview element entirely.
  video.srcObject = new MediaStream(stream.getVideoTracks());
  document.body.append(video);
  return video;
}

function createCaptureAudioMonitor(track) {
  if (!track || track.getSettings?.().suppressLocalAudioPlayback !== true) return null;
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.controls = false;
  audio.setAttribute('aria-hidden', 'true');
  Object.assign(audio.style, { position: 'fixed', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
  audio.srcObject = new MediaStream([track]);
  document.body.append(audio);
  void audio.play().catch(() => {});
  return audio;
}

function waitForCaptureVideo(video, track) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      track?.removeEventListener?.('ended', onEnded);
      video.removeEventListener('loadedmetadata', onReady);
      video.removeEventListener('resize', onReady);
      callback(value);
    };
    const onReady = () => {
      if (video.videoWidth > 0 && video.videoHeight > 0) finish(resolve);
    };
    const onEnded = () => finish(reject, new Error('Screen sharing ended before recording started'));
    const timeoutId = setTimeout(
      () => finish(reject, new Error('Timed out waiting for the shared tab video')),
      8000,
    );
    track?.addEventListener?.('ended', onEnded, { once: true });
    video.addEventListener('loadedmetadata', onReady);
    video.addEventListener('resize', onReady);
    onReady();
  });
}

function supportsTimestampedVideoPipeline() {
  return typeof globalThis.MediaStreamTrackProcessor === 'function'
    && typeof globalThis.MediaStreamTrackGenerator === 'function'
    && typeof globalThis.VideoFrame === 'function';
}

function createTimestampedVideoPipeline(recording) {
  if (!supportsTimestampedVideoPipeline()) return null;
  try {
    const processor = new MediaStreamTrackProcessor({ track: recording.captureTrack });
    const generator = new MediaStreamTrackGenerator({ kind: 'video' });
    const reader = processor.readable.getReader();
    const writer = generator.writable.getWriter();
    generator.contentHint = 'detail';
    recording.processorReader = reader;
    recording.generatorWriter = writer;
    recording.outputVideoTrack = generator;
    return generator;
  } catch {
    recording.processorReader = null;
    recording.generatorWriter = null;
    recording.outputVideoTrack = null;
    return null;
  }
}

function startTimestampedVideoPump(recording) {
  const reader = recording.processorReader;
  const writer = recording.generatorWriter;
  if (!reader || !writer) return;
  const fallbackDuration = Math.round(1_000_000 / TABLE_RECORDING_CONFIG.frameRate);
  recording.videoPumpPromise = (async () => {
    try {
      while (!recording.stopping) {
        const { value: frame, done } = await reader.read();
        if (done || !frame) break;
        try {
          const width = frame.displayWidth || frame.codedWidth || recording.sourceWidth;
          const height = frame.displayHeight || frame.codedHeight || recording.sourceHeight;
          if (writer.desiredSize != null && writer.desiredSize <= 0) continue;
          if (!paintTableRecordingFrame(recording, frame, width, height)) continue;
          const timestamp = Number.isFinite(frame.timestamp) ? frame.timestamp : Math.round(performance.now() * 1000);
          const duration = Number.isFinite(frame.duration) && frame.duration > 0 ? frame.duration : fallbackDuration;
          const outputFrame = new VideoFrame(recording.canvas, { timestamp, duration });
          try {
            await writer.write(outputFrame);
          } finally {
            outputFrame.close();
          }
        } finally {
          frame.close();
        }
      }
    } catch (error) {
      if (!recording.stopping && tableRecording === recording) {
        recording.pipelineError = error;
        if (recording.recorder?.state !== 'inactive') recording.recorder.stop();
      }
    }
  })();
}

function createFallbackCanvasPipeline(recording) {
  const stream = recording.canvas.captureStream(TABLE_RECORDING_CONFIG.frameRate);
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('Could not create the table recording video track');
  track.contentHint = 'detail';
  recording.canvasStream = stream;
  recording.outputVideoTrack = track;
  return track;
}

function startFallbackVideoPump(recording) {
  const frameInterval = 1000 / TABLE_RECORDING_CONFIG.frameRate;
  let previousPaint = -frameInterval;
  const loop = timestamp => {
    if (recording.stopping || tableRecording !== recording) return;
    if (timestamp - previousPaint >= frameInterval - 1) {
      const video = recording.captureVideo;
      if (video?.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        paintTableRecordingFrame(recording, video, video.videoWidth, video.videoHeight);
      }
      previousPaint = timestamp;
    }
    recording.animationFrameId = requestAnimationFrame(loop);
  };
  const video = recording.captureVideo;
  if (video?.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    paintTableRecordingFrame(recording, video, video.videoWidth, video.videoHeight);
  }
  recording.animationFrameId = requestAnimationFrame(loop);
}

function startTableRecordingVideo(recording) {
  if (recording.processorReader) startTimestampedVideoPump(recording);
  else startFallbackVideoPump(recording);
}

function stopTableRecordingVideo(recording) {
  if (!recording) return;
  if (recording.animationFrameId != null) cancelAnimationFrame(recording.animationFrameId);
  recording.animationFrameId = null;
  try { recording.processorReader?.cancel?.(); } catch {}
  try { recording.generatorWriter?.close?.(); } catch {}
  recording.processorReader = null;
  recording.generatorWriter = null;
}

function disposeTableRecording(recording) {
  if (!recording) return;
  stopTableRecordingVideo(recording);
  try { recording.captureVideo?.pause?.(); } catch {}
  if (recording.captureVideo) {
    recording.captureVideo.srcObject = null;
    recording.captureVideo.remove();
  }
  try { recording.audioMonitor?.pause?.(); } catch {}
  if (recording.audioMonitor) { recording.audioMonitor.srcObject = null; recording.audioMonitor.remove(); }
  recording.canvasStream?.getTracks?.().forEach(track => track.stop());
  try { recording.outputVideoTrack?.stop?.(); } catch {}
  recording.captureStream?.getTracks?.().forEach(track => track.stop());
  recording.canvas?.remove?.();
}

function finalizeTableRecording(recording, mimeType) {
  const blob = new Blob(recording.chunks, { type: recording.recorder.mimeType || mimeType || 'video/webm' });
  const error = recording.pipelineError;
  disposeTableRecording(recording);
  if (tableRecording === recording) tableRecording = null;
  setRecordButton(false);
  if (blob.size) saveRecordingBlob(blob);
  if (error) showActionToast(`Recording stopped: ${summarizeError(error)}`, 'fold');
}

async function startTableRecording() {
  if (tableRecording || !els.pokerTable) return;
  const canTimestampVideo = supportsTimestampedVideoPipeline();
  const canCanvasVideo = typeof HTMLCanvasElement.prototype.captureStream === 'function';
  if (!navigator.mediaDevices?.getDisplayMedia || !globalThis.MediaRecorder || (!canTimestampVideo && !canCanvasVideo)) {
    showActionToast('Table recording is not supported in this browser', 'fold');
    return;
  }

  let captureStream = null;
  let captureVideo = null;
  let audioMonitor = null;
  let recording = null;

  try {
    captureStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: 'browser',
        frameRate: { ideal: TABLE_RECORDING_CONFIG.frameRate, max: TABLE_RECORDING_CONFIG.frameRate },
        width: { ideal: TABLE_RECORDING_CONFIG.maxWidth },
        height: { ideal: TABLE_RECORDING_CONFIG.maxHeight },
      },
      audio: { suppressLocalAudioPlayback: false },
      preferCurrentTab: true,
      selfBrowserSurface: 'include',
      surfaceSwitching: 'exclude',
      systemAudio: 'include',
      windowAudio: 'system',
    });

    const captureTrack = captureStream.getVideoTracks()[0];
    if (!captureTrack) throw new Error('No video track was shared');
    const displaySurface = captureTrack.getSettings?.().displaySurface;
    if (displaySurface && displaySurface !== 'browser') {
      throw new Error('Please share this browser tab, not a window or the entire screen.');
    }
    try { captureTrack.contentHint = 'detail'; } catch {}
    try {
      await captureTrack.applyConstraints?.({
        frameRate: { ideal: TABLE_RECORDING_CONFIG.frameRate, max: TABLE_RECORDING_CONFIG.frameRate },
      });
    } catch {}

    const sourceAudioTrack = captureStream.getAudioTracks()[0] || null;
    if (sourceAudioTrack?.applyConstraints) {
      try { await sourceAudioTrack.applyConstraints({ suppressLocalAudioPlayback: { exact: false } }); }
      catch { try { await sourceAudioTrack.applyConstraints({ suppressLocalAudioPlayback: false }); } catch {} }
    }
    if (soundEnabled) { try { await getAudioContext()?.resume(); } catch {} }
    audioMonitor = createCaptureAudioMonitor(sourceAudioTrack);
    // Mux the original shared-audio track directly so its capture timestamps
    // stay aligned with the timestamp-preserving video pipeline.
    const audioTrack = sourceAudioTrack;

    captureVideo = createCaptureVideo(captureStream);
    await captureVideo.play().catch(() => {});
    await waitForCaptureVideo(captureVideo, captureTrack);

    const sourceWidth = Math.max(2, captureVideo.videoWidth || innerWidth || 2);
    const sourceHeight = Math.max(2, captureVideo.videoHeight || innerHeight || 2);
    const { canvas, ctx, crop } = createTableRecordingCanvas(sourceWidth, sourceHeight);

    recording = {
      recorder: null,
      recorderStream: null,
      captureStream,
      captureTrack,
      captureVideo,
      canvas,
      ctx,
      crop,
      canvasStream: null,
      outputVideoTrack: null,
      processorReader: null,
      generatorWriter: null,
      videoPumpPromise: null,
      animationFrameId: null,
      sourceWidth,
      sourceHeight,
      audioTrack,
      sourceAudioTrack,
      audioMonitor,
      chunks: [],
      stopping: false,
      pipelineError: null,
    };

    let outputVideoTrack = canTimestampVideo ? createTimestampedVideoPipeline(recording) : null;
    if (outputVideoTrack) {
      captureVideo.pause();
      captureVideo.srcObject = null;
      captureVideo.remove();
      captureVideo = null;
      recording.captureVideo = null;
    } else {
      if (!canCanvasVideo) throw new Error('This browser cannot create a recording video track');
      outputVideoTrack = createFallbackCanvasPipeline(recording);
    }

    const tracks = [outputVideoTrack];
    if (audioTrack) tracks.push(audioTrack);
    const recorderStream = new MediaStream(tracks);
    recording.recorderStream = recorderStream;

    const mimeType = recorderMimeType(Boolean(audioTrack));
    const videoBitsPerSecond = recordingVideoBitrate({
      width: canvas.width,
      height: canvas.height,
      frameRate: TABLE_RECORDING_CONFIG.frameRate,
    });
    const options = { videoBitsPerSecond };
    if (audioTrack) options.audioBitsPerSecond = TABLE_RECORDING_CONFIG.audioBitsPerSecond;
    if (mimeType) options.mimeType = mimeType;

    const recorder = new MediaRecorder(recorderStream, options);
    recording.recorder = recorder;
    tableRecording = recording;

    recorder.addEventListener('dataavailable', event => {
      if (event.data?.size) recording.chunks.push(event.data);
    });
    recorder.addEventListener('stop', () => finalizeTableRecording(recording, mimeType), { once: true });
    recorder.addEventListener('error', event => {
      if (tableRecording !== recording) return;
      recording.pipelineError = event.error || new Error('Recording failed');
      recording.stopping = true;
      stopTableRecordingVideo(recording);
      if (recorder.state !== 'inactive') recorder.stop();
      else finalizeTableRecording(recording, mimeType);
    });
    captureTrack.addEventListener('ended', () => {
      if (tableRecording === recording && recorder.state !== 'inactive') stopTableRecording();
    }, { once: true });

    recorder.start(500);
    startTableRecordingVideo(recording);
    setRecordButton(true);
    showActionToast(
      `Recording · ${canvas.width}×${canvas.height} · ${TABLE_RECORDING_CONFIG.frameRate} fps · ${audioTrack ? 'shared audio' : 'no audio — enable Share audio'}`,
      audioTrack ? 'check' : 'fold',
    );
  } catch (err) {
    if (recording) disposeTableRecording(recording);
    else {
      try { audioMonitor?.pause?.(); } catch {}
      if (audioMonitor) { audioMonitor.srcObject = null; audioMonitor.remove(); }
      captureStream?.getTracks?.().forEach(track => track.stop());
      if (captureVideo) {
        captureVideo.srcObject = null;
        captureVideo.remove();
      }
    }
    tableRecording = null;
    setRecordButton(false);
    showActionToast(summarizeError(err), 'fold');
  }
}

function stopTableRecording() {
  const recording = tableRecording;
  if (!recording || recording.stopping) return;
  recording.stopping = true;
  stopTableRecordingVideo(recording);
  if (recording.recorder.state !== 'inactive') {
    try { recording.recorder.requestData?.(); } catch {}
    recording.recorder.stop();
    return;
  }
  finalizeTableRecording(recording, recording.recorder.mimeType);
}

function modelForPlayerId(playerId) {
  return currentState?.config?.players?.find?.(p => p.id === playerId)?.model || '';
}
function replayDisplayName(playerId, fallbackName = '') {
  const model = modelForPlayerId(playerId);
  return model ? displayModelName(model) : (/^Player\s+\d+$/i.test(String(fallbackName || '')) ? fallbackName : (fallbackName || 'Model'));
}
function replayHistoryRow(row) {
  const label = replayDisplayName(row?.playerId, row?.playerName);
  const action = row?.action?.description || row?.action?.type || 'Action';
  return `<div class="replay-history-row"><span><b>${escapeHtml(label)}</b>${row?.position ? `<small>${escapeHtml(row.position)}</small>` : ''}</span><strong>${escapeHtml(action)}</strong></div>`;
}
function replayLegalActionsHtml(actions, chosenAction) {
  if (!Array.isArray(actions) || !actions.length) return '<div class="empty-state">No legal actions stored.</div>';
  return `<div class="replay-legal-list">${actions.map((action, index) => {
    const selected = action.id === chosenAction?.id || (!chosenAction?.id && action.type === chosenAction?.type);
    const label = action.description || action.type || action.id || `Action ${index + 1}`;
    return `<div class="replay-legal-option ${selected ? 'selected' : ''}">
      <span class="replay-legal-index">${selected ? '✓' : index + 1}</span>
      <span class="replay-legal-copy"><strong>${escapeHtml(label)}</strong><small>${escapeHtml(action.id || action.type || '')}</small></span>
      ${selected ? '<span class="replay-legal-picked">Chosen</span>' : ''}
    </div>`;
  }).join('')}</div>`;
}
function openDecisionReplay(eventId) {
  const event = eventArchive(currentState).find(e => e.id === eventId && e.type === 'DECISION');
  if (!event || !els.replayDialog) return;
  currentReplayEvent = event;
  if (els.replayShareStatus) els.replayShareStatus.textContent = event.replay ? 'Creates a 1080×1350 PNG from this exact replay snapshot.' : 'This older event has limited replay data; the image will include the available decision details.';
  if (els.shareReplayImage) els.shareReplayImage.classList.toggle('hidden', !(navigator.share && navigator.canShare));
  const replay = event.replay;
  const modelName = displayModelName(event.configuredModel || event.resolvedModel || event.playerName || 'Model');
  els.replayTitle.textContent = `${modelName} decision`;
  els.replayBadge.textContent = `HAND ${event.handNumber || replay?.handNumber || '—'} · ${event.street || replay?.street || '—'}`;
  els.replaySubtitle.textContent = replay ? 'Exact decision snapshot captured immediately before the model acted.' : 'This older decision does not contain a replay snapshot.';
  els.replayAction.textContent = event.action?.description || event.action?.type || '—';
  els.replayReason.textContent = replayReasonText(event);
  const reasoningText = decisionReasoningText(event);
  if (els.replayReasoning) {
    els.replayReasoning.classList.toggle('hidden', !reasoningText);
    els.replayReasoning.innerHTML = reasoningText
      ? `<span class="decision-reasoning-label">Model reasoning · raw, unvetted scratch work</span><p>${escapeHtml(reasoningText)}</p>`
      : '';
  }

  if (!replay) {
    els.replayOpponents.innerHTML = '';
    els.replayStreet.textContent = event.street || '—';
    els.replayBoard.innerHTML = Array.from({ length: 5 }, () => cardHtml(null, true, 'replay-card')).join('');
    els.replayPot.textContent = `POT ${fmt(event.potBefore || 0)}`;
    els.replayHero.innerHTML = `<div class="replay-unavailable">Snapshot unavailable for decisions recorded before replay capture was enabled.</div>`;
    els.replaySummary.innerHTML = `<span>Position <b>${escapeHtml(event.position || '—')}</b></span><span>Latency <b>${fmt(event.latencyMs || 0)} ms</b></span>`;
    els.replayHistory.innerHTML = '<div class="empty-state">No snapshot history stored.</div>';
    els.replayLegal.innerHTML = '<div class="empty-state">No legal-action snapshot stored.</div>';
    if (els.replayLegalSummary) els.replayLegalSummary.textContent = 'Unavailable';
    els.replayDialog.showModal();
    return;
  }

  const opponents = replay.opponents || [];
  els.replayOpponents.innerHTML = opponents.map(o => `<div class="replay-opponent"><div class="replay-player-identity"><b>${escapeHtml(replayDisplayName(o.id, o.name))}</b><small>${escapeHtml(o.position || `Seat ${o.seat || '—'}`)}</small></div><div class="replay-player-stack"><strong>${fmt(o.stack)}</strong><small>${Number(o.stackBB || 0).toFixed(1)} BB</small></div></div>`).join('');
  els.replayStreet.textContent = String(replay.street || '—').toUpperCase();
  els.replayBoard.innerHTML = Array.from({ length: 5 }, (_, i) => cardHtml(replay.board?.[i], !replay.board?.[i], 'replay-card')).join('');
  els.replayPot.textContent = `POT ${fmt(replay.pot || 0)}`;
  const hero = replay.hero || {};
  els.replayHero.innerHTML = `<div class="replay-hero-head"><div class="replay-player-identity"><b>${escapeHtml(modelName)}</b><small>${escapeHtml(hero.position || '—')}</small></div><div class="replay-player-stack"><strong>${fmt(hero.stack)}</strong><small>${Number(hero.stackBB || 0).toFixed(1)} BB</small></div></div><div class="replay-hero-cards">${[0,1].map(i => cardHtml(hero.cards?.[i], !hero.cards?.[i], 'replay-hole', true)).join('')}</div>`;
  const b = replay.betting || {};
  els.replaySummary.innerHTML = [
    ['Stack', fmt(hero.stack)], ['Pot', fmt(replay.pot)], ['To call', fmt(b.toCall)], ['Effective call', fmt(b.effectiveCall)],
    ['Blinds', `${fmt(replay.blinds?.smallBlind)} / ${fmt(replay.blinds?.bigBlind)}`], ['Position', hero.position || '—']
  ].map(([k,v]) => `<span>${escapeHtml(k)} <b>${escapeHtml(v)}</b></span>`).join('');
  els.replayHistory.innerHTML = (replay.actionHistory || []).length ? replay.actionHistory.map(replayHistoryRow).join('') : '<div class="empty-state">No actions before this decision.</div>';
  const legalActions = replay.legalActions || [];
  els.replayLegal.innerHTML = replayLegalActionsHtml(legalActions, event.action);
  if (els.replayLegalSummary) els.replayLegalSummary.textContent = `${legalActions.length} option${legalActions.length === 1 ? '' : 's'} · chosen highlighted`;
  const handLabel = replay.heroHand?.category || deterministicHandLabel(hero.cards, replay.board);
  if (handLabel) els.replaySummary.insertAdjacentHTML('beforeend', `<span>Deterministic hand evaluation <b>${escapeHtml(handLabel)}</b></span>`);
  els.replayReason.innerHTML = `<div class="replay-reason-text">${escapeHtml(replayReasonText(event))}</div>${decisionTelemetryHtml(event, { limit: 99 })}`;
  els.replayDialog.showModal();
}


function replayShareFilename(event) {
  const model = displayModelName(event?.configuredModel || event?.resolvedModel || event?.playerName || 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'model';
  return `pokertools-arena-${model}-hand-${event?.handNumber || 'x'}.png`;
}
function roundedRect(ctx, x, y, w, h, r, fill, stroke = null, lineWidth = 1) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y); ctx.arcTo(x + w, y, x + w, y + h, rr); ctx.arcTo(x + w, y + h, x, y + h, rr); ctx.arcTo(x, y + h, x, y, rr); ctx.arcTo(x, y, x + w, y, rr); ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
}
function wrapCanvasText(ctx, text, x, y, maxWidth, lineHeight, maxLines = 8) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  let line = '', lines = [];
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = word; }
    else line = test;
    if (lines.length >= maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (words.length && lines.length === maxLines) {
    let last = lines[maxLines - 1];
    while (ctx.measureText(`${last}…`).width > maxWidth && last.length > 2) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last.replace(/[.,;:]?$/, '')}…`;
  }
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * lineHeight));
  return y + lines.length * lineHeight;
}
function parsePokerCard(code) {
  if (!code || typeof code !== 'string' || code.length < 2) return null;
  const suitCode = code.at(-1).toLowerCase();
  const rank = code.slice(0, -1).toUpperCase();
  const suits = { h: ['♥', '#e95667'], d: ['♦', '#e95667'], c: ['♣', '#151a1f'], s: ['♠', '#151a1f'] };
  return suits[suitCode] ? { rank, suit: suits[suitCode][0], color: suits[suitCode][1] } : null;
}
function drawShareCard(ctx, code, x, y, w = 90, h = 126) {
  const card = parsePokerCard(code);
  roundedRect(ctx, x, y, w, h, 12, card ? '#f7f7f2' : '#15211c', card ? '#d8ddd8' : '#294138', 2);
  if (!card) {
    ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.font = '700 30px system-ui'; ctx.textAlign = 'center'; ctx.fillText('♠', x + w/2, y + h/2 + 10); ctx.textAlign = 'left'; return;
  }
  const rankSize = Math.max(13, Math.round(w * 0.34)), suitSize = Math.max(18, Math.round(w * 0.54));
  ctx.fillStyle = card.color; ctx.font = `900 ${rankSize}px system-ui`; ctx.fillText(card.rank, x + Math.max(5, w * .13), y + Math.max(16, h * .27));
  ctx.font = `900 ${suitSize}px system-ui`; ctx.textAlign = 'center'; ctx.fillText(card.suit, x + w/2, y + h/2 + suitSize * .28); ctx.textAlign = 'left';
}
function replayReasonText(event) {
  const explanation = eventArchive(currentState).filter(e => e.type === 'SPECTATOR_EXPLANATION' && e.decisionId === event?.decisionId).at(-1);
  if (explanation?.text) return explanation.text;
  if (event?.publicReason) return event.publicReason;
  const meta = event?.decisionMeta || {};
  const familyLabel = key => familyCriteria([String(key).toLowerCase()])[String(key).toLowerCase()] ?? String(key).toUpperCase();
  const sizeLabel = key => SIZE_LABELS[String(key).toLowerCase()] ?? String(key).toUpperCase();
  const pairs = (obj, label, limit) => Object.entries(obj ?? {}).filter(([, v]) => Number.isFinite(Number(v))).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, limit).map(([k, v]) => `${label(k)} ${Math.round(Number(v) * 100)}%`).join(' · ');
  const lines = [];
  if (meta.family?.probabilities) lines.push(`Family  ${pairs(meta.family.probabilities, familyLabel, 3)}`);
  if (meta.sizing?.probabilities) lines.push(`Size  ${pairs(meta.sizing.probabilities, sizeLabel, 3)}`);
  else if (meta.probabilities) {
    const familyMass = aggregateActionProbabilitiesByFamily(meta.probabilities, event?.legalActions, { labelResolver: id => ({ description: (event?.legalActions || []).find(a => a.id === id)?.description || id }) });
    lines.push(`Family (aggregated)  ${pairs(familyMass, familyLabel, 4)}`);
  }
  if (Number.isFinite(Number(meta.family?.confidence))) lines.push(`Confidence  ${confidenceBand(meta.family.confidence)} · ${compactPercent(meta.family.confidence)}`);
  return lines.length ? lines.join('\n') : (meta.family ? 'Typed decision; no text rationale.' : 'No public rationale was returned.');
}
function replayProbabilityRows(event, limit = 5) {
  const meta = event?.decisionMeta || {};
  const familyLabel = key => familyCriteria([String(key).toLowerCase()])[String(key).toLowerCase()] ?? String(key).toUpperCase();
  const sizeLabel = key => SIZE_LABELS[String(key).toLowerCase()] ?? String(key).toUpperCase();
  const ranked = (values, label, group, take) => Object.entries(values ?? {})
    .filter(([, value]) => Number.isFinite(Number(value)))
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, take)
    .map(([key, value]) => ({ label: label(key), value: clamp(Number(value), 0, 1), group }));
  if (meta.family?.probabilities) {
    const familyRows = ranked(meta.family.probabilities, familyLabel, 'Family', meta.sizing?.probabilities ? 3 : limit);
    return [...familyRows, ...ranked(meta.sizing?.probabilities, sizeLabel, 'Size', Math.max(0, limit - familyRows.length))].slice(0, limit);
  }
  if (meta.probabilities) {
    const familyMass = aggregateActionProbabilitiesByFamily(meta.probabilities, event?.legalActions, { labelResolver: id => ({ description: (event?.legalActions || []).find(action => action.id === id)?.description || id }) });
    return ranked(familyMass, familyLabel, 'Family', limit);
  }
  return [];
}
function makeReplayShareCanvas(event) {
  const replay = event?.replay || {};
  const hero = replay.hero || {};
  const modelName = displayModelName(event?.configuredModel || event?.resolvedModel || event?.playerName || 'Model');
  const action = event?.action?.description || event?.action?.type || 'Decision';
  const canvas = document.createElement('canvas'); canvas.width = 1080; canvas.height = 1350;
  const ctx = canvas.getContext('2d');
  const bg = ctx.createLinearGradient(0, 0, 1080, 1350); bg.addColorStop(0, '#090c0e'); bg.addColorStop(1, '#101614'); ctx.fillStyle = bg; ctx.fillRect(0,0,1080,1350);
  const glow = ctx.createRadialGradient(540, 565, 30, 540, 565, 520); glow.addColorStop(0,'rgba(22,102,68,.36)'); glow.addColorStop(1,'rgba(4,20,14,0)'); ctx.fillStyle=glow; ctx.fillRect(0,190,1080,780);
  ctx.fillStyle='rgba(235,243,238,.55)'; ctx.font='800 23px system-ui'; ctx.fillText('♠  pokertools-arena',72,74);
  ctx.fillStyle='rgba(210,220,214,.34)'; ctx.font='700 14px ui-monospace,monospace'; ctx.fillText('MODEL BENCHMARK TABLE  ·  DECISION REPLAY',72,104);
  ctx.fillStyle='#f4f7f5'; ctx.font='900 58px system-ui'; ctx.fillText(modelName,72,190);
  ctx.fillStyle='rgba(211,221,215,.56)'; ctx.font='700 20px ui-monospace,monospace'; ctx.fillText(`HAND ${event?.handNumber || replay.handNumber || '—'}  ·  ${(event?.street || replay.street || '—').toUpperCase()}  ·  ${event?.latencyMs || 0} ms`,72,228);
  roundedRect(ctx,72,260,936,82,24,'rgba(184,236,111,.08)','rgba(184,236,111,.28)',2);
  ctx.fillStyle='#dff5b9'; ctx.font='900 30px system-ui'; ctx.fillText(action,100,312);
  roundedRect(ctx,72,382,936,470,210,'#0b4d32','#1e2a25',16);
  const felt = ctx.createRadialGradient(540,595,40,540,595,430); felt.addColorStop(0,'#126342'); felt.addColorStop(1,'#093b28'); ctx.fillStyle=felt; ctx.beginPath(); ctx.ellipse(540,617,442,209,0,0,Math.PI*2); ctx.fill();
  ctx.fillStyle='rgba(231,242,235,.18)'; ctx.font='900 38px system-ui'; ctx.textAlign='center'; ctx.fillText('pokertools-arena',540,490); ctx.font='700 12px system-ui'; ctx.fillText('model benchmark table',540,516); ctx.textAlign='left';
  const board = replay.board || [];
  const bw=86,bh=120,gap=12,total=5*bw+4*gap,start=(1080-total)/2;
  for(let i=0;i<5;i++) drawShareCard(ctx,board[i],start+i*(bw+gap),545,bw,bh);
  ctx.fillStyle='rgba(236,243,239,.60)'; ctx.font='800 18px ui-monospace,monospace'; ctx.textAlign='center'; ctx.fillText(`POT ${fmt(replay.pot ?? event?.potBefore ?? 0)}   ·   BLINDS ${fmt(replay.blinds?.smallBlind ?? 0)}/${fmt(replay.blinds?.bigBlind ?? 0)}`,540,700); ctx.textAlign='left';
  roundedRect(ctx,350,727,380,105,18,'rgba(8,14,16,.82)','rgba(184,236,111,.23)',2);
  ctx.fillStyle='#f2f5f3'; ctx.font='850 23px system-ui'; ctx.fillText(modelName,375,762);
  ctx.fillStyle='rgba(213,224,217,.50)'; ctx.font='700 15px ui-monospace,monospace'; ctx.fillText(`${hero.position || event?.position || '—'}  ·  ${fmt(hero.stack ?? 0)} chips`,375,789);
  drawShareCard(ctx,hero.cards?.[0],613,739,46,64); drawShareCard(ctx,hero.cards?.[1],668,739,46,64);
  const b=replay.betting||{};
  const metrics=[['STACK',fmt(hero.stack ?? 0)],['TO CALL',fmt(b.toCall ?? 0)],['POSITION',hero.position||event?.position||'—'],['LATENCY',`${event?.latencyMs||0} ms`]];
  metrics.forEach((m,i)=>{const x=72+i*234;roundedRect(ctx,x,892,216,78,15,'rgba(255,255,255,.028)','rgba(255,255,255,.06)',1);ctx.fillStyle='rgba(210,220,214,.38)';ctx.font='800 12px ui-monospace,monospace';ctx.fillText(m[0],x+16,918);ctx.fillStyle='#e8eeea';ctx.font='900 22px system-ui';ctx.fillText(m[1],x+16,950)});
  roundedRect(ctx,72,1004,936,226,22,'rgba(255,255,255,.026)','rgba(255,255,255,.065)',1);
  const probabilityRows = replayProbabilityRows(event);
  const telemetryHeading = probabilityRows.length ? 'JEV DECISION PROBABILITIES' : 'PUBLIC RATIONALE';
  ctx.fillStyle='rgba(211,221,215,.42)'; ctx.font='800 13px ui-monospace,monospace'; ctx.fillText(telemetryHeading,98,1036);
  if (probabilityRows.length) {
    probabilityRows.forEach((row, index) => {
      const y = 1066 + index * 30, percent = Math.round(row.value * 100);
      ctx.fillStyle = 'rgba(211,221,215,.68)'; ctx.font = '700 15px system-ui'; ctx.textAlign = 'left'; ctx.fillText(`${row.group} · ${row.label}`.slice(0, 34), 98, y);
      roundedRect(ctx, 430, y - 12, 480, 8, 4, 'rgba(255,255,255,.075)');
      roundedRect(ctx, 430, y - 12, Math.max(4, 480 * row.value), 8, 4, row.group === 'Size' ? '#6db9ff' : '#f4c85a');
      ctx.fillStyle = '#eef4f0'; ctx.font = '900 15px ui-monospace,monospace'; ctx.textAlign = 'right'; ctx.fillText(`${percent}%`, 982, y); ctx.textAlign = 'left';
    });
  } else {
    ctx.fillStyle='#d9e1dc'; ctx.font='600 25px system-ui'; wrapCanvasText(ctx, replayReasonText(event),98,1080,884,36,5);
  }
  ctx.fillStyle='rgba(211,221,215,.32)'; ctx.font='700 14px ui-monospace,monospace'; ctx.fillText(`${event?.connection || ''}  ·  ${event?.protocol || event?.requestedProtocol || ''}`,98,1202);
  ctx.fillStyle='rgba(216,225,219,.30)'; ctx.font='700 15px system-ui'; ctx.fillText('pokertools-arena.github.io',72,1300);
  ctx.textAlign='right'; ctx.fillText('AI poker decision snapshot',1008,1300); ctx.textAlign='left';
  return canvas;
}
function canvasToPngBlob(canvas) { return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not encode PNG')), 'image/png', 1)); }
async function createReplayShareBlob() {
  if (!currentReplayEvent) throw new Error('Open a decision replay first.');
  return canvasToPngBlob(makeReplayShareCanvas(currentReplayEvent));
}
async function saveReplayImage() {
  try {
    const blob = await createReplayShareBlob(); const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = replayShareFilename(currentReplayEvent); document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000);
    if (els.replayShareStatus) els.replayShareStatus.textContent = 'PNG saved · 1080×1350';
  } catch (err) { if (els.replayShareStatus) els.replayShareStatus.textContent = `Could not save image: ${summarizeError(err)}`; }
}
async function copyReplayImage() {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Image clipboard is not supported by this browser. Use Save PNG instead.');
    const blob = await createReplayShareBlob(); await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    if (els.replayShareStatus) els.replayShareStatus.textContent = 'PNG copied to clipboard · ready to paste.';
  } catch (err) { if (els.replayShareStatus) els.replayShareStatus.textContent = summarizeError(err); }
}
async function shareReplayImage() {
  try {
    const blob = await createReplayShareBlob(); const file = new File([blob], replayShareFilename(currentReplayEvent), { type:'image/png' });
    if (!navigator.share || !navigator.canShare?.({ files:[file] })) throw new Error('Native image sharing is not supported here. Use Save PNG instead.');
    await navigator.share({ title:'pokertools-arena decision replay', text:`${displayModelName(currentReplayEvent?.configuredModel || currentReplayEvent?.resolvedModel || '')} · ${currentReplayEvent?.action?.description || 'Decision'}`, files:[file] });
    if (els.replayShareStatus) els.replayShareStatus.textContent = 'Share sheet opened.';
  } catch (err) { if (err?.name !== 'AbortError' && els.replayShareStatus) els.replayShareStatus.textContent = summarizeError(err); }
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'application/x-ndjson' }), url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const choicePickers = new Map();
function syncChoicePicker(select) {
  const picker = choicePickers.get(select);
  if (!picker) return;
  picker.replaceChildren(...[...select.options].map((option, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice-option';
    button.role = 'radio';
    button.dataset.optionIndex = String(index);
    button.textContent = option.textContent;
    button.disabled = select.disabled || option.disabled;
    button.setAttribute('aria-checked', String(option.value === select.value));
    return button;
  }));
  picker.dataset.optionCount = String(select.options.length);
  picker.setAttribute('aria-disabled', String(select.disabled));
}
function syncChoicePickers() {
  for (const select of choicePickers.keys()) syncChoicePicker(select);
}
function enhanceSelect(select) {
  if (!(select instanceof HTMLSelectElement) || choicePickers.has(select)) return;
  const picker = document.createElement('span');
  const id = select.id || select.name || `select-${choicePickers.size + 1}`;
  picker.className = 'choice-picker';
  picker.role = 'radiogroup';
  picker.setAttribute('aria-label', select.getAttribute('aria-label') || `Choose ${id.replace(/[-_]/g, ' ')}`);
  select.classList.add('native-select-enhanced');
  select.insertAdjacentElement('afterend', picker);
  choicePickers.set(select, picker);
  syncChoicePicker(select);
  picker.addEventListener('click', event => {
    const optionButton = event.target.closest('.choice-option');
    if (!optionButton || optionButton.disabled) return;
    const option = select.options[Number(optionButton.dataset.optionIndex)];
    if (!option) return;
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    syncChoicePicker(select);
  });
  picker.addEventListener('keydown', event => {
    const options = $$('.choice-option:not(:disabled)', picker);
    const index = options.indexOf(document.activeElement);
    if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1;
      const next = options[(index + direction + options.length) % options.length];
      next?.focus(); next?.click();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault(); const next = options[event.key === 'Home' ? 0 : options.length - 1]; next?.focus(); next?.click();
    }
  });
  select.addEventListener('change', () => syncChoicePicker(select));
}

$$('select').forEach(enhanceSelect);
new MutationObserver(records => {
  for (const record of records) {
    if (record.target instanceof HTMLSelectElement && choicePickers.has(record.target)) syncChoicePicker(record.target);
    for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (node.matches('select')) enhanceSelect(node);
      $$('select', node).forEach(enhanceSelect);
    }
  }
}).observe(document.body, { childList: true, subtree: true });

const tooltipEl = document.createElement('div');
tooltipEl.className = 'ui-tooltip';
tooltipEl.id = 'ui-tooltip';
tooltipEl.setAttribute('role', 'tooltip');
let tooltipTarget = null;

function tooltipHost() {
  const dialogs = $$('dialog[open]');
  return dialogs.length ? dialogs[dialogs.length - 1] : document.body;
}
function positionTooltip(target) {
  const gap = 9, margin = 8;
  const rect = target.getBoundingClientRect();
  const tipRect = tooltipEl.getBoundingClientRect();
  let placement = 'bottom';
  let top = rect.bottom + gap;
  if (top + tipRect.height > window.innerHeight - margin && rect.top - gap - tipRect.height >= margin) {
    placement = 'top';
    top = rect.top - gap - tipRect.height;
  }
  top = clamp(top, margin, Math.max(margin, window.innerHeight - margin - tipRect.height));
  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  left = clamp(left, margin, Math.max(margin, window.innerWidth - margin - tipRect.width));
  tooltipEl.style.top = `${Math.round(top)}px`;
  tooltipEl.style.left = `${Math.round(left)}px`;
  tooltipEl.dataset.placement = placement;
  tooltipEl.style.setProperty('--tip-arrow', `${Math.round(clamp(rect.left + rect.width / 2 - left, 12, Math.max(12, tipRect.width - 12)))}px`);
}
function showTooltip(target) {
  const text = target.dataset.tip;
  if (!text || target === tooltipTarget) return;
  hideTooltip();
  tooltipTarget = target;
  tooltipEl.textContent = text;
  const host = tooltipHost();
  if (tooltipEl.parentElement !== host) host.append(tooltipEl);
  tooltipEl.classList.add('is-visible');
  positionTooltip(target);
  target.setAttribute('aria-describedby', 'ui-tooltip');
}
function hideTooltip() {
  if (!tooltipTarget) return;
  tooltipTarget.removeAttribute('aria-describedby');
  tooltipTarget = null;
  tooltipEl.classList.remove('is-visible');
}
const TIP_SELECTOR = '[data-tip]';
const tipTargetFrom = event => (event.target instanceof Element ? event.target.closest(TIP_SELECTOR) : null);
document.addEventListener('pointerover', event => { const target = tipTargetFrom(event); if (target) showTooltip(target); }, true);
document.addEventListener('pointerout', event => {
  const target = tipTargetFrom(event);
  if (target && target === tooltipTarget && !(event.relatedTarget instanceof Element && target.contains(event.relatedTarget))) hideTooltip();
}, true);
document.addEventListener('focusin', event => { const target = tipTargetFrom(event); if (target) showTooltip(target); }, true);
document.addEventListener('focusout', event => { const target = tipTargetFrom(event); if (target && target === tooltipTarget) hideTooltip(); }, true);
document.addEventListener('keydown', event => { if (event.key === 'Escape') hideTooltip(); }, true);
window.addEventListener('scroll', () => { if (tooltipTarget) positionTooltip(tooltipTarget); }, true);
window.addEventListener('resize', hideTooltip, { passive: true });

els.decisionFeed?.addEventListener('click', event => {
  const item = event.target.closest('[data-decision-id]');
  if (item) openDecisionReplay(item.dataset.decisionId);
});
els.eventLog?.addEventListener('click', event => {
  const item = event.target.closest('[data-decision-id]');
  if (item) openDecisionReplay(item.dataset.decisionId);
});
els.eventLog?.addEventListener('keydown', event => {
  if (!['Enter',' '].includes(event.key)) return;
  const item = event.target.closest('[data-decision-id]');
  if (item) { event.preventDefault(); openDecisionReplay(item.dataset.decisionId); }
});
els.closeReplay?.addEventListener('click', () => els.replayDialog.close());
els.saveReplayImage?.addEventListener('click', saveReplayImage);
els.copyReplayImage?.addEventListener('click', copyReplayImage);
els.shareReplayImage?.addEventListener('click', shareReplayImage);

els.soundBtn.addEventListener('click', async () => {
  soundEnabled = !soundEnabled;
  const label = $('.action-label', els.soundBtn);
  if (label) label.textContent = soundEnabled ? 'Sound on' : 'Sound';
  els.soundBtn.setAttribute('aria-pressed', String(soundEnabled));
  els.soundBtn.classList.toggle('active', soundEnabled);
  els.soundBtn.title = soundEnabled ? 'Disable table sounds' : 'Enable table sounds';
  els.soundBtn.setAttribute('aria-label', els.soundBtn.title);
  if (soundEnabled) { try { await getAudioContext()?.resume(); } catch {} preloadTableSounds(); playTableSound('chip'); }
});

els.recordBtn?.addEventListener('click', () => tableRecording ? stopTableRecording() : void startTableRecording());
els.testsBtn.addEventListener('click', openTests);
els.closeTests.addEventListener('click', () => els.testsDialog.close());
els.runTestsBtn.addEventListener('click', runDecisionSanitySuite);
els.clearTestsBtn.addEventListener('click', () => {
  if (sanityRunAbort) { sanityRunAbort.abort(); return; }
  sanityResults = []; els.testsStatus.textContent = 'Results cleared.'; renderSanityResults();
});
els.setupBtn.addEventListener('click', openSetup);
els.closeSetup.addEventListener('click', () => els.setupDialog.close());
els.addConnectionBtn.addEventListener('click', () => addConnectionRow({ name: `API ${els.connectionsEditor.children.length + 1}`, kind: ARENA_CONFIG.connections.defaultKind, baseUrl: connectionPresetUrl(ARENA_CONFIG.connections.defaultKind) }));
els.pauseBtn.addEventListener('click', () => { if (!director) return; currentState?.status === 'PAUSED' ? director.resume() : director.pause(); });
els.stopBtn.addEventListener('click', () => {
  if (!director) return;
  stopClock(); stopTableEffects();
  director.stop();
});
els.exportBtn.addEventListener('click', () => { if (!director?.events?.length) return; downloadText(`${director.config?.id || 'pokertools-arena'}.jsonl`, director.exportJsonl()); });
els.logSearch?.addEventListener('input', () => {
  logView.query = els.logSearch.value || '';
  renderMemo.events = '';
  if (activeInspectorTab === 'log') renderEvents(currentState || { events: [] });
});
els.logFilter?.addEventListener('change', () => {
  logView.filter = els.logFilter.value || 'all';
  renderMemo.events = '';
  if (activeInspectorTab === 'log') renderEvents(currentState || { events: [] });
});
els.logClear?.addEventListener('click', () => {
  logView.query = '';
  logView.filter = 'all';
  if (els.logSearch) els.logSearch.value = '';
  if (els.logFilter) els.logFilter.value = 'all';
  renderMemo.events = '';
  renderEvents(currentState || { events: [] });
  els.logSearch?.focus();
});
els.seatsBtn.addEventListener('click', () => {
  if (director && ['RUNNING', 'PAUSED'].includes(director.status)) return;
  void startConfiguredTournament();
});
els.seatsLayer.addEventListener('click', event => {
  const seat = event.target.closest('[data-lobby-seat]');
  if (!seat || !els.seatsLayer.contains(seat)) return;
  const seatIndex = Number(seat.dataset.lobbySeat);
  if (Number.isInteger(seatIndex)) openSeatEditor(seatIndex);
});

els.closeSeat.addEventListener('click', () => els.seatDialog.close());
els.cancelSeatBtn.addEventListener('click', () => els.seatDialog.close());
for (const dialog of [els.setupDialog, els.seatDialog, els.testsDialog, els.replayDialog]) {
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    if (!inside) dialog.close();
  });
  dialog.addEventListener('close', hideTooltip);
}
els.seatConnection.addEventListener('change', () => { applySeatProtocolRules(); syncSeatNameFromModel(); void refreshSeatModelCatalog(); });
els.seatModel.addEventListener('input', () => { applySeatProtocolRules(); syncSeatNameFromModel(); });
els.seatName.addEventListener('input', () => { seatNameAuto = false; });
els.seatProtocol.addEventListener('change', applySeatProtocolRules);
els.seatCaptureReasoning?.addEventListener('change', applySeatProtocolRules);
els.refreshModelsBtn?.addEventListener('click', () => void refreshSeatModelCatalog({ force: true }));
els.removeSeatBtn.addEventListener('click', () => {
  if (editingSeatIndex == null || (director && ['RUNNING', 'PAUSED'].includes(director.status))) return;
  seatAssignments[editingSeatIndex] = null;
  saveSeatAssignments();
  els.seatDialog.close();
});
els.seatForm.addEventListener('submit', event => {
  event.preventDefault();
  if (editingSeatIndex == null || (director && ['RUNNING', 'PAUSED'].includes(director.status))) return;
  els.seatError.classList.add('hidden');
  try {
    const draft = readSeatDraft();
    if (!draft.name) throw new Error('Player name is required');
    if (!draft.connectionId || !connectionById(draft.connectionId)) throw new Error('Choose an API connection');
    if (!draft.model) throw new Error('Model is required');
    const duplicate = seatAssignments.some((p, i) => i !== editingSeatIndex && p && p.name.trim().toLowerCase() === draft.name.toLowerCase());
    if (duplicate) throw new Error(`Another seat already uses the name “${draft.name}”`);
    seatAssignments[editingSeatIndex] = draft;
    saveSeatAssignments();
    els.seatDialog.close();
  } catch (err) {
    els.seatError.textContent = summarizeError(err);
    els.seatError.classList.remove('hidden');
  }
});

els.setupForm.addEventListener('submit', event => {
  event.preventDefault();
  els.setupError.classList.add('hidden');
  try {
    const raw = collectSetupRaw(true);
    for (const connection of raw.connections) parseHeaders(connection.headers);
    normalizeConfig(raw);
    saveSetupWithoutSecrets(raw);
    els.setupDialog.close();
    render(currentState || { status: 'IDLE', events: [] });
  } catch (err) {
    els.setupError.textContent = summarizeError(err);
    els.setupError.classList.remove('hidden');
  }
});

async function startConfiguredTournament() {
  if (director && ['RUNNING', 'PAUSED'].includes(director.status)) return;
  const raw = collectSetupRaw(true);
  if (raw.players.length < 2) {
    lobbyVisible = true;
    render(currentState || { status: 'IDLE', events: [] });
    showActionToast('Seat at least 2 models', 'fold');
    return;
  }
  if (capabilityPrime) { try { await capabilityPrime; } catch {} }
  els.startTopBtn.disabled = true;
  const startLabel = $('.action-label', els.startTopBtn);
  if (startLabel) startLabel.textContent = 'Starting…';
  try {
    if (!engineModule) await loadPokerTools();
    saveSetupWithoutSecrets(raw);
    director = new TournamentDirector({ onUpdate: render });
    lobbyVisible = false;
    lastVisualState = null;
    lastProcessedEventId = null;
    await director.start(raw);
  } catch (err) {
    lobbyVisible = true;
    els.setupError.textContent = summarizeError(err);
    els.setupError.classList.remove('hidden');
    openSetup({ preserveError: true });
    render(currentState || { status: 'IDLE', events: [] });
  } finally {
    els.startTopBtn.disabled = false;
    if (startLabel) startLabel.textContent = 'Start';
  }
}
els.startTopBtn.addEventListener('click', startConfiguredTournament);

function activateInspectorTab(tab, { focus = false } = {}) {
  activeInspectorTab = tab.dataset.tab || 'live';
  $$('.tab').forEach(t => {
    const active = t === tab;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
    t.tabIndex = active ? 0 : -1;
  });
  $$('.tab-panel').forEach(p => {
    const active = p.id === `tab-${tab.dataset.tab}`;
    p.classList.toggle('active', active);
    p.hidden = !active;
  });
  if (focus) tab.focus();
  if (!currentState) return;
  if (activeInspectorTab === 'live') { renderMemo.feed = feedRenderSignature(currentState); renderFeed(currentState); }
  else if (activeInspectorTab === 'log') { renderMemo.events = eventsRenderSignature(currentState); renderEvents(currentState); }
  else if (activeInspectorTab === 'stats') { renderMemo.stats = statsRenderSignature(currentState); renderStats(currentState); }
}
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => activateInspectorTab(tab));
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = $$('.tab');
    const current = tabs.indexOf(tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    activateInspectorTab(tabs[next], { focus: true });
  });
});

window.addEventListener('beforeunload', event => {
  if (tableRecording) disposeTableRecording(tableRecording);
  if (director && ['RUNNING', 'PAUSED'].includes(director.status)) { event.preventDefault(); event.returnValue = ''; }
});

restoreSetup(); render({ status: 'IDLE', events: [] });
if (pendingAutostart) {
  pendingAutostart = false;
  setTimeout(() => { void startConfiguredTournament(); }, 600);
}
loadPokerTools().catch(err => {
  els.setupError.textContent = `PokerTools browser build failed to load: ${summarizeError(err)}. Check your internet connection or CDN access.`;
  els.setupError.classList.remove('hidden'); openSetup({ preserveError: true });
});
let resizeTimer = null;
function relayoutForViewport() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    requestAnimationFrame(() => {
      if (currentState && !lobbyVisible) {
        renderMemo.table = '';
        render(currentState, { force: true });
        layoutTableSeats();
      } else {
        renderMemo.table = '';
        renderLobbyTable();
        layoutTableSeats({ lobby: true });
      }
    });
  }, 90);
}
window.addEventListener('resize', relayoutForViewport, { passive: true });
window.addEventListener('orientationchange', relayoutForViewport, { passive: true });
if (globalThis.visualViewport) visualViewport.addEventListener('resize', relayoutForViewport, { passive: true });
if ('ResizeObserver' in globalThis) {
  const tableResizeObserver = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => layoutTableSeats({ lobby: lobbyVisible }), 50);
  });
  tableResizeObserver.observe(els.pokerTable);
}
