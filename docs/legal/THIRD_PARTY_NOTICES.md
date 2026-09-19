# Third-party notices

`pokertools-arena` bundles the following third-party packages at build time:

- **@pokertools/engine** (1.0.20) — MIT — the browser poker rules engine used to
  deal hands, validate legal actions and settle pots.
- **@pokertools/evaluator** (1.0.20) — MIT — deterministic five-card poker hand
  evaluation used to generate the Strategy-mode `heroHand` classification.

Development-only tooling:

- **esbuild** — MIT — used only to produce the static `dist/` build.

No third-party package is used to generate model decisions, prompts, scores or
fairness assertions.
