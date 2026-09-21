# pokertools-arena 0.16.2 — benchmark methodology & results

Generated: 2026-09-19T18:19:58.352Z
Methodology: paired fixed-state corpus; deterministic interleaving with recorded experiment seed.

## Totals (single source of truth)

poker decisions: 79 · model calls: 97 · HTTP requests: 97 · retries: 0 · decision errors: 0 · fallbacks: 0

> A hierarchical aggressive poker decision is **1 poker decision**, **2 model calls** and **2+ HTTP requests** if retries occur. These counters are never interchangeable.

## 1. Methodology

Fixed-state paired corpus is the primary architecture comparison; every state is identical across flat and hierarchical, execution is deterministically interleaved with a recorded seed, family and sizing correctness are reported separately, and behavioral proportions carry Wilson 95% intervals. Real tournaments are end-to-end validation only.

Streamed model reasoning is captured for spectators and stored beside each decision in the JSONL export. It is **display-only**: no seat ever receives another seat's reasoning, and the reasoning text is never re-ingested into a prompt, so the information policy and the paired comparison are unchanged.

## 2. Strict correctness

| Architecture | Family accuracy | Sizing (given family) | Final accuracy | n |
| --- | --- | --- | --- | --- |
| flat |  23/24 (96%) |  4/4 (100%) |  23/24 (96%) | 24 |
| hierarchical |  24/24 (100%) |  3/4 (75%) |  23/24 (96%) | 24 |

## 3. Family correctness

| Model | Architecture | Family correct | Family accuracy | 95% CI | n |
| --- | --- | --- | --- | --- | --- |
| Gemma | flat | 14/14 | 100% | 78%–100% | 14 |
| Gemma | hierarchical | 14/14 | 100% | 78%–100% | 14 |
| Qwen | flat | 5/6 | 83% | 44%–97% | 6 |
| Qwen | hierarchical | 6/6 | 100% | 61%–100% | 6 |
| Jev | flat | 6/6 | 100% | 61%–100% | 6 |
| Jev | hierarchical | 6/6 | 100% | 61%–100% | 6 |

## 4. Sizing correctness (conditional on correct family)

| Model | Architecture | Sizing correct | Sizing accuracy | 95% CI | n |
| --- | --- | --- | --- | --- | --- |
| Gemma | flat | 2/2 | 100% | 34%–100% | 2 |
| Gemma | hierarchical | 2/2 | 100% | 34%–100% | 2 |
| Qwen | flat | 1/1 | 100% | 21%–100% | 1 |
| Qwen | hierarchical | 0/1 | 0% | 0%–79% | 1 |
| Jev | flat | 1/1 | 100% | 21%–100% | 1 |
| Jev | hierarchical | 1/1 | 100% | 21%–100% | 1 |

## 5. Action fragmentation

_No fragmentation data._

## 6. Flat vs hierarchical paired comparison

| Model | Flat family | Hier family | Family agreement | 95% CI | Flips | n |
| --- | --- | --- | --- | --- | --- | --- |
| Gemma | 14/14 (100%) | 14/14 (100%) | 96% | 82%–99% | 1 | 27 |
| Qwen | 5/6 (83%) | 6/6 (100%) | 83% | 44%–97% | 1 | 6 |
| Jev | 6/6 (100%) | 6/6 (100%) | 100% | 61%–100% | 0 | 6 |

## 7. Strategy vs Raw cognition

Strategy (deterministic heroHand for every model) and Raw cognition (models infer hand strength) are separate benchmark tracks and are never aggregated into one model score.

## 8. Representation sensitivity

_No data._

## 9. Performance

| Model | Architecture | Poker decisions | Model calls | HTTP requests | Mean latency | P95 | Tokens | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Gemma | paired | 55 | 69 | — | 1857ms | 2237ms | 63031 | — |
| Qwen | paired | 12 | 14 | — | 6797ms | 9262ms | 15062 | — |
| Jev | paired | 12 | 14 | — | 581ms | 1314ms | 16609 | — |

## 10. Real tournament behavior (end-to-end validation)

No real tournament A/B run was attached to this release.

## 11. Jev telemetry

| Architecture | Aggressive family mass | Selected family probability | Top−second gap | Family entropy (bits) | Sizing entropy (bits) |
| --- | --- | --- | --- | --- | --- |
| flat | 0% | 0% | 82% | 0.401 | — |
| hierarchical | 37% | 86% | 73% | 0.469 | 0.424 |

## 12. Fairness verification

- Fixed corpus states are byte-identical across architecture variants except for the action contract.
- Paired flat/hierarchical runs use the same hero cards, board, stacks, history, memory and public stats.
- Representation variants carry identical semantic state (offline assertion).
- Strategy mode supplies a deterministic heroHand to every model; Raw mode supplies it to none.
- Jev and chat adapters receive exactly the same family and size enums (offline assertion).
- The total action clock is shared across both hierarchical stages.
- Spectator explanations are disabled in rigorous runs; when enabled they are isolated and counter-separated.
- No per-model production prompt tuning exists and no provider-specific poker facts are injected.
- Diagnostic-only hidden information is structurally impossible in tournament mode.

## 13. Limitations

- Behavioral proportion estimates are only as strong as the cell sample size; small cells carry wide Wilson intervals.
- Paired architecture agreement measures decision-policy stability on fixed states, not win-rate superiority.
- Tournament win rate is not a conclusion at these sample sizes, and tournament trajectories diverge after the first different action.
- Provider rate limits and model version drift can affect reproducibility even for identical fixed states.
