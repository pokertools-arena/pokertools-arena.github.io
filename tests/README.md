# Tests

All tests are Node-based. There is no Playwright or headless-browser dependency; to watch the app in a real browser use `npm run start:chrome`.

Offline suites never make network calls. Real-API suites read connections and seats from `.env` automatically.

| Command | What it does |
| --- | --- |
| `npm test` | Build, release checks, offline unit/fairness suites and integration tests. |
| `npm run check` | `node --check` on entry points plus `tests/release-check.mjs`. |
| `npm run test:unit` | All `tests/unit/*` suites (corpus, hierarchy/fairness, methodology, sizing, paired, archive, report). |
| `npm run test:integration` | `@pokertools/engine/browser` integration and launcher `.env` bootstrap. |
| `npm run test:scenarios` | `tests/unit/decision-scenarios.mjs` — fixed in-app sanity scenarios. |
| `npm run test:diagnostics:offline` | `tests/unit/decision-diagnostics.mjs` — arena legality + diagnostic invariants. |
| `npm run test:hierarchical` | `tests/unit/hierarchical-decision-tests.mjs` — canonical hierarchy + fairness. |
| `npm run test:diagnostics:dry` | Print the real diagnostic plan without calling an API. |
| `npm run test:real` | Real paired fixed-state corpus + decision diagnostics using `.env`. |
| `npm run test:tournament-ab` | Real flat-vs-hierarchical tournament A/B using `.env`. |
| `npm run report:diagnostics` | Build `logs/release-<version>/summary.json` + `summary.md`. |
| `npm run report:release` | Same, and copy the pair to `docs/diagnostics/`. |
| `npm run analyze:decisions` | Offline analysis of a saved `tournament.jsonl`. |
| `npm run release:archive` | Build the source archive (excludes `.env`, secrets, logs, dist, node_modules). |

## Layout

- `tests/unit/` — deterministic, offline invariants.
- `tests/integration/` — installed-engine and launcher integration.
- `tests/real/` — real-API runners (paired corpus, diagnostics, tournament A/B).
- `tests/analysis/` — offline report/analysis builders.
- `tests/release-check.mjs` — static release invariants for the whole repository.

## Offline suites

### `release-check.mjs`

Static release invariants for the reorganized layout: source paths, bundle contract, UI element map, `.env` bootstrap assets, hierarchical decision architecture, benchmark/architecture settings, workflows and version metadata.

### `decision-scenarios.mjs`

Validates the fixed in-app sanity scenarios.

### `decision-diagnostics.mjs`

Arena legality (`toCall === 0` must never expose `FOLD`), representation semantic equivalence, context ablation, confidentiality, deterministic `heroHand`, memory parity and diagnostic isolation.

### `hierarchical-decision-tests.mjs`

The fairness contract: one canonical action-family set per engine state, deterministic/engine-validated sizing, identical Jev/chat enums, Strategy/Raw mode, legacy family aggregation, representation equivalence and a two-stage execution test that confirms both stages share one abort signal.

### `methodology-tests.mjs`

Exact Shannon entropy (`[1,0] → 0`, `[0.5,0.5] → 1`, `[0.9,0.1] → 0.468996`), domain-labelled entropy, Wilson intervals, standardized counters and their relationships, family-vs-sizing separation, corpus invariants, Strategy/Raw separation, paired-runner determinism and fragmentation flip rate.

### `size-bucket-tests.mjs`

Boundary audit of the deterministic sizing planner: tiny/huge stacks, min-bet and min-raise edges, all-in below the minimum raise, all-in near `LARGE`, pot smaller than the big blind, heads-up, multiway and post-elimination states.

### `paired-architecture-tests.mjs`

Paired flat/hierarchical mock runs, per-architecture family/sizing/final accuracy separation, fragmentation invariance across menu shapes A/B/C/D, and Strategy/Raw parity.

### `archive-content.mjs`

Builds the real release archive and verifies it contains the full reorganized tree while excluding `.env`, secrets, logs, `dist`, `node_modules` and generated bundles.

### `report-consistency.mjs`

Fails if `docs/diagnostics/SUMMARY.md` no longer matches the machine-readable `docs/diagnostics/summary.json`, or if the counters contradict themselves.

## Real-API suites

### `real-paired-corpus.mjs`

The primary architecture comparison. For each fixed corpus state the same model runs both architectures with deterministic interleaving and a recorded `experimentSeed`. Reports family agreement, family flips, family/sizing/final accuracy and, with `--fragmentation`, the A/B/C/D flip rate. Use `--cap`, `--reps` and `--delay` to bound requests.

Each decision is checkpointed to `<out>/paired-rows.jsonl` (and `<out>/frag-rows.jsonl` for fragmentation). If the run is interrupted, re-running the same command resumes from the checkpoint instead of restarting.

### `real-decision-diagnostics.mjs`

Layered strict/behavioral diagnostics across representations, contexts, heroHand and question ablations, plus the observation probe.

### `real-tournament-ab.mjs`

End-to-end behavioral validation under the same stack/blind/clock/memory settings. Win rate is intentionally not a conclusion at these sample sizes.

## Reports

`tests/analysis/release-report.mjs` reads the newest `paired-architecture.json`, `diagnostics-*.json` and `tournament-ab-*.json` and writes one `summary.json` plus `summary.md`. With `--docs` it copies both to `docs/diagnostics/`, which is the committed source of truth.
