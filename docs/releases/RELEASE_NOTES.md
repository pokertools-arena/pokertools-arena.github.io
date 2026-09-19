# Release notes

## 0.4.7 — Maintenance

- **Pot pays out to the winner.** The pot→winner chip animation never fired.
  `processVisualEffects` read `lastVisualState` *after* `animateNewHand` and
  `animateBoardCards` had already advanced it, so at a hand boundary the
  `HAND_END` stack diff compared a state against itself and matched no winners.
  The previous state is now snapshotted before any helper runs, and the payout
  is driven by the `HAND_END` winner payload (with the stack diff as fallback),
  so chips fly from the pot to every winner and the win sound plays.

## 0.4.6 — Maintenance

- **Seat cards clear their last action each hand.** `stats.lastAction` was only
  ever written, never reset, so every player card kept showing the previous
  hand's action into the next deal. `startHand` now clears the last action for
  every seat. Eliminations still display, because they are derived from the
  elimination list at render time rather than stored as `lastAction`.

## 0.4.5 — Maintenance

- **Stop now freezes the display.** Stopping a tournament clears the decision
  clock and cancels every table effect still in flight (chip flies, action
  toast, fold/check flashes and their pending timers). Previously the turn ring
  and clock kept counting and queued animations finished after the run had
  stopped, because the last broadcast still carried `currentDecision` and the
  effects queue was never drained. `renderDecision` and `processVisualEffects`
  now hard-stop on `STOPPED`/`ERROR`.

## 0.4.4 — Maintenance

- **Cleaner decision logs.** Removed the repeated spectator caption ("This
  model returns typed decisions rather than a text rationale…") that appeared on
  every typed decision in the live feed and the replay panel. Typed decisions
  already show their selected family/size plus confidence telemetry, so logs are
  concise and no longer restate that a rationale is absent. `SPECTATOR_NOTE` and
  its CSS were removed; release checks guard against reintroduction.

## 0.4.3 — Maintenance

- **Seat editor name.** Opening a seat restored from `.env` or saved
  configuration now shows the model-derived name (for example `Gemma`) instead
  of the generic `Player 1`, matching the table, lobby and stats surfaces. The
  name follows the chosen model until it is edited by hand.
- **Close buttons.** Dialog close buttons and the remove-connection button use a
  centered inline SVG cross instead of a baseline-aligned text `×`, so the glyph
  is vertically centered.

## 0.4.2 — Maintenance

- **Decision sanity suite model attribution.** Seat assignments restored from
  `.env` or saved configuration had no `id`, so every sanity agent shared an
  undefined id. Each model summary then counted every model's decisions (for
  example `24/10` when only 10 spots exist) and every scenario column rendered
  the last model's result. Sanity agents now derive the same stable
  `player-<seat>` id the tournament uses, so each model is reported separately.

## 0.4.1 — Maintenance

A maintenance release on top of the 0.4.0 methodology work.

### Tooltips

- Modal tooltips are rendered by a single fixed-position element attached to the
  topmost open `<dialog>`. They escape the modal's overflow clipping, flip above
  the trigger when there is no room below, and stay inside the viewport, so every
  information tooltip is fully visible.

### Launcher

- The local launcher binds a fresh HTTP server per port attempt. When the default
  port is already in use it now starts exactly once (one banner, one browser
  window) on the next free port instead of starting twice.

### CI

- Real-API diagnostics have a credential preflight. When the `OPENAI_*`
  repository secrets are not configured the diagnostics job is skipped with a
  notice instead of failing a published release.

## 0.4.0 — Methodology, reproducibility and repository organization

This release does not redesign the 0.3.0 decision foundations. It makes the
benchmark more rigorous, separates the questions being answered, and reorganizes
the repository so there is one source of truth for code, tools, tests and
documentation.

### Repository

- Browser application source now lives under `src/` (`src/app.js`,
  `src/index.html`, `src/styles.css`, `src/lib/decision-core.js`,
  `src/benchmark/scenarios.js`, `src/env/arena-env.js`, `src/shims/crypto.cjs`,
  `src/assets/`). There are no duplicate root copies.
- Developer-only implementation lives under `tools/diagnostics/` and
  `tools/release/`; tests are grouped into `tests/unit`, `tests/integration`,
  `tests/real` and `tests/analysis`; documentation lives under `docs/`.
- `build.mjs`, `bin/pokertools-arena.mjs`, every import, npm script, GitHub
  workflow and documentation link were updated for the new layout.

### Methodology

- **Paired fixed-state corpus** (`tools/diagnostics/corpus.js`): immutable,
  production-shaped decision states covering strict legality/dominance, value
  betting, bluffing, preflop, hand recognition and representation sensitivity.
  Gold answers exist only where strict dominance or an explicit synthetic
  opponent policy makes them deterministic.
- **Paired flat-vs-hierarchical test** (`tools/diagnostics/paired.js`): the same
  model, state, context, mode and representation under both architectures, with
  deterministic interleaving and a recorded `experimentSeed`. This is the
  primary architecture comparison; real tournaments are end-to-end validation.
- **Family vs sizing correctness** are reported separately, with sizing accuracy
  conditional on a correct family, plus final-action accuracy.
- **`fragmentation_flip_rate`**: the share of paired runs whose broad family
  changes when only the number of same-family sizing choices changes, across
  menus A/B/C/D and multiple states.
- **Exact entropy validation and domain labelling**: `familyEntropyBits`,
  `sizingEntropyBits` and `flatActionEntropyBits`; a generic “entropy” is never
  reported.
- **Standardized counters** (`tools/diagnostics/counters.js`): `pokerDecisions`,
  `familyModelCalls`, `sizingModelCalls`, `spectatorModelCalls`,
  `totalModelCalls`, `httpRequests`, `httpRetries`, `rateLimitResponses`,
  `decisionErrors`, `fallbackActions`, `protocolFallbacks`, with asserted
  relationships.
- **Wilson 95% confidence intervals and sample sizes** for behavioral
  proportions, so 2/2 and 100/100 are not presented with equal strength.
- **One generated summary** (`tools/diagnostics/report.js`) drives every
  human-readable report; a release test fails if committed documentation drifts
  from the machine-readable totals.
- **Spectator explanations default off** in rigorous runs; when enabled they are
  isolated and counted separately.
- **Size-bucket boundary audit** for tiny/huge stacks, min-bet/min-raise edges,
  all-in below min raise, all-in near LARGE, pot smaller than the big blind,
  heads-up, multiway and post-elimination states.

### Testing and CI

- `npm run test:unit`, `test:integration`, `test:real`, `test:tournament-ab`,
  `report:diagnostics` and `release:archive` replace the ad-hoc script names.
- CI runs install → build → release checks → unit/fairness → integration and
  never requires real API credentials. Real diagnostics run from a manual,
  secret-gated workflow.
- The release archive is built from the new layout, excludes secrets/logs/dist,
  and is verified by an archive-content regression test.

### Compatibility

- The browser build, GitHub Pages deployment, `npx pokertools-arena` launcher and
  automatic `.env` bootstrap are preserved.
- `@pokertools/engine@1.0.20` and `@pokertools/evaluator@1.0.20` are unchanged.
- The `.env` file is never moved, printed or archived.

## 0.3.0 — Fair hierarchical decisions, Strategy/Raw modes, deterministic hand evaluation

This release is a fairness and correctness release. It changes how the benchmark
turns a poker state into a decision so that CHECK, CALL, FOLD, BET and RAISE are
represented fairly for **every** model, regardless of how many bet sizes an
arena happens to generate.

### The problem

A single passive strategy was represented by one class (e.g. `CHECK`) while a
single aggressive strategy could be represented by many classes (`BET 1 BB`,
`BET 2 BB`, `BET 3 BB`, …, `BET ALL-IN`). Under a flat argmax this fragmenting
of the aggressive probability mass made passive actions look dominant even when
the model's total aggressive probability was larger.

### What changed

- **Hierarchical decision architecture (`hierarchical-v1`).** Every model is now
  asked two questions:
  1. **Action family** — `CHECK`/`BET` when nothing is owed, or
     `FOLD`/`CALL`/`RAISE` when facing a bet. Only legal families are exposed.
  2. **Size** — only when the family is `BET` or `RAISE`, from a deterministic,
     engine-validated size set (`SMALL`, `MEDIUM`, `LARGE`, `ALL_IN`).
  A single passive strategy is one family; a single aggressive strategy is one
  family. The model cannot change the family during the sizing step.
- **One canonical decision contract.** `src/lib/decision-core.js` is the single
  source of truth for decision state, action families, sizing choices, Jev
  questions, chat schemas and the final engine action. Production, diagnostics
  and tests all use the same functions.
- **Deterministic sizing.** `legalAggressiveSizes(engine, seat, family)` clamps
  to the available stack, respects the minimum bet/raise, deduplicates and drops
  near-duplicate amounts, always includes all-in when materially distinct, and
  works for short stacks (a single `ALL_IN` or `SMALL`/`ALL_IN` is valid).
- **No prose in the primary decision.** Chat models no longer return
  `publicReason` inside the action call. The primary contract contains only
  typed decision fields. Spectator explanations are a separate, isolated,
  off-the-clock concern (disabled by default; Jev never gets fabricated prose).
- **Strategy / Raw benchmark modes.** A tournament-wide setting:
  * **Strategy** — every model receives a deterministic `heroHand`
    (`{ category, description }`) generated by `@pokertools/evaluator`.
  * **Raw cognition** — no `heroHand`; models infer strength from raw cards.
  The mode applies to all seats and is recorded in tournament state, logs,
  reports and replays. Opponent hand evaluations are never exposed.
- **Representation modes.** `canonical_json` (default), `compact_json` and
  `markdown`, applied to every seat.
- **Shared action clock.** The family and size calls share one abort signal and
  one action clock. A model does not receive a fresh timer for the sizing stage.
- **Decision event schema.** `decisionMeta` now carries
  `decisionArchitecture`, `family` and `sizing` (choice, probabilities,
  confidence, latency) plus `finalAction`. Events record `primaryDecisionLatencyMs`
  (family latency + sizing latency, excluding spectator explanations).
- **Legacy aggregation.** `aggregateActionProbabilitiesByFamily` folds old flat
  probability vectors into family mass for replay and log analysis, labelled
  “Aggregated from legacy flat action probabilities”. Historical selected actions
  are never changed.
- **Jev telemetry.** Internal identifiers (`A0`, `A1`, …) are translated through
  the actual choice map. Spectators see family probabilities, sizing
  probabilities, confidence bands, aggression tendency and bluff-opportunity
  telemetry rather than invented text rationales.
- **Diagnostics.** New `action_fragmentation`, `flat vs hierarchical`, `probe`
  matrix and family-entropy/telemetry sections in
  `tests/real/real-decision-diagnostics.mjs`; new offline fairness suite
  `tests/unit/hierarchical-decision-tests.mjs`; real tournament A/B harness
  `tests/real/real-tournament-ab.mjs`; concise summary builder
  `tests/analysis/diagnostics-summary.mjs`.

### Compatibility

- Flat legacy mode is retained **only** as a diagnostics baseline
  (`decisionArchitecture: "flat"`). Hierarchical is the production default.
- `@pokertools/engine@1.0.20` and `@pokertools/evaluator@1.0.20` are unchanged.
- Existing `.env` bootstrap, GitHub Pages and `npx pokertools-arena` workflows
  are unchanged.

### Measured effect (real API, 2026-09-19)

369 decisions across Gemma, Qwen and Jev, 0 request errors, 415 HTTP requests.

Action-fragmentation experiment on identical river states:

| Menu | Gemma | Qwen | Jev |
| --- | --- | --- | --- |
| A · CHECK / BET ALL-IN | 0% | 89% | 100% |
| B · CHECK / BET SMALL / ALL-IN | 0% | 56% | 56% |
| C · CHECK / BET SMALL / MEDIUM / LARGE / ALL-IN | 0% | 56% | 33% |
| D · hierarchical | 0% | 44% | 100% |

Jev's aggressive-selection rate collapsed from 100% to 33% purely by adding
almost-identical bet-size classes, and the hierarchical architecture restored
it to 100%. This is the option-count asymmetry the release removes. Jev's mean
family aggressive probability mass rose from 45% (fragmented flat) to 56%
(hierarchical), and its selected-family probability from 37% to 73%.

Strict diagnostics were preserved: Layer A (action-id mapping) 100%, Layer D
(strictly dominated) 100% flat / 94% hierarchical, Layer B (raw hand
recognition) 62% — the same cross-model weakness as before, and the reason
Strategy mode exists.

