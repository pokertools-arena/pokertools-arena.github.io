# Release notes

## 0.8.0 — tab-audio recording with timestamp-preserving A/V sync

- **Recordings capture the current tab's own audio.** The recorder now requests
  audio from `getDisplayMedia()` (`audio: true`, `systemAudio: 'exclude'`) and
  muxes the returned display-media audio track straight into the `MediaRecorder`
  stream. The previous per-recording Web Audio
  `MediaStreamAudioDestinationNode` was removed, so the exported WebM carries the
  tab's real output instead of a re-routed copy of the table's own cues.
- **Timestamp-preserving video pipeline.** When the browser exposes
  `MediaStreamTrackProcessor` / `MediaStreamTrackGenerator` / `VideoFrame`, each
  captured source frame is cropped to the table on the canvas and re-emitted as
  a `VideoFrame` that keeps the source capture `timestamp` and `duration`. Audio
  and video therefore share the same capture clock.
- **Real-time backpressure guard.** The pump reads `writer.desiredSize` and drops
  frames while the generator is saturated, so a slow encoder cannot build a
  delayed video queue.
- **Fixed-rate canvas fallback kept.** Browsers without the timestamped media-
  track APIs fall back to the existing `canvas.captureStream(30)` painter, so
  recording still works everywhere the old path did.
- **Higher quality ceiling.** Maximum output size rose from 1920×1080 to
  2560×1440, the adaptive video bitrate range to 10–28 Mbps, and the audio target
  bitrate to 192 kbps. High-quality canvas scaling, `contentHint = "detail"` for
  UI/text, and a 30 FPS stability target are retained.
- **More robust lifecycle.** The crop canvas is sized from the actual capture
  video dimensions, and generated tracks, readers, writers, the capture video and
  the source stream are all torn down on stop or failure. Pipeline errors now
  surface as a toast when the recording is finalized instead of failing
  silently, and the recorder chunk interval dropped to 500 ms.

## 0.7.0 — table sound effects and recorded audio

- **Real sound effects replace the synthesized tones.** The table now plays six
  role-named MP3 cues: `card-deal`, `board-cards`, `chip-bet`, `chip-drop`
  (fold/check), `all-in-chips` and `winner-bell`. The oscillator cues remain as
  an immediate fallback while an asset is still decoding.
- **Audio assets are normalized and renamed.** Every clip was peak-normalized
  to −1.5 dBFS with a safety limiter, resampled to 44.1 kHz and re-encoded to
  192 kbps MP3. Mono sources are duplicated to stereo with an explicit pan so
  the power-preserving upmix cannot shave 3 dB. Files lost their vendor/ID
  prefixes in favour of their role (`oxidvideos-placing-playing-card-522514.mp3`
  → `card-deal.mp3`, and so on).
- **Assets ship inside the bundle.** The MP3s are imported as `dataurl` assets
  (`build.mjs`), so the bundled `dist/app.js` and the single-file
  `pokertools-arena.html` both carry the audio — no separate asset request, no
  extra MIME entry, and audio still works when the single file is opened from
  `file://`.
- **Recordings now include the game audio.** All cues are mixed through a single
  master gain that also feeds a `MediaStreamAudioDestinationNode`. When a table
  recording starts, a fresh destination's audio track is muxed with the canvas
  video track and handed to `MediaRecorder` (`video/webm;codecs=vp8,opus`,
  128 kbps audio), so the exported WebM contains exactly the table sounds that
  played. The destination is disconnected and its track stopped when the
  recording ends. Sound must be enabled for cues to play (and therefore to be
  recorded).
- **Audio and video stay in sync.** The 0.6.9 manual `captureStream(0)` +
  `requestFrame()` path was removed: a stream created with rate `0` carries no
  frame-rate metadata, so `MediaRecorder` stretched the video timeline against
  the real-time audio track (audio ended up ahead of the picture). The canvas is
  now sampled by the browser at a fixed 30 FPS, which keeps the video timeline
  continuous even if a paint is skipped. Each recording also gets its own audio
  destination, so a long-lived node's clock offset can no longer push the audio
  ahead.

### Notes

- `npm test` now asserts the six asset files exist, the build inlines `.mp3`,
  the sound master/destination routing is present, and the recorder muxes the
  audio track.

## 0.6.10 — action-time default

- **Per-move clock now defaults to 20 seconds** (`TIMING_DEFAULTS.actionSeconds`),
  up from 12, giving each model more time before the decision timeout.
- **The setup form no longer disagrees with the constant.** The `Action time
  (s)` input was hard-coded to `value="12"`, and `collectSetupRaw()` reads that
  form value first, so the constant only applied as a fallback for an empty
  field. The input now defaults to `20`, so a default setup actually uses the
  intended value.
- **Drift guard.** The release check now asserts that
  `TIMING_DEFAULTS.actionSeconds` and the form's `value` stay equal, so a future
  change to one without the other fails the suite.

### Notes

- Saved setup configs and `.env`/launcher-injected settings still override the
  default, as before; this only changes the value shown and submitted by a
  fresh setup.
- Removed trailing whitespace on the tournament-meta assignment (no behavior
  change).

## 0.6.9 — recording refactor

- **Independent 30 FPS painter.** Table recording no longer follows
  `requestVideoFrameCallback()` from the shared-tab capture. A dedicated
  `requestAnimationFrame()` scheduler paints at most 30 FPS, so a high-refresh
  display cannot trigger redundant canvas work and the encoder never receives
  more frames than it is configured for.
- **Manual canvas frame submission.** When supported, the canvas is captured
  with `captureStream(0)` and each painted frame is pushed explicitly with
  `requestFrame()`. One encoded frame now corresponds to exactly one painted
  frame instead of relying on the browser's implicit canvas capture cadence. A
  30 FPS `captureStream()` fallback covers browsers without `requestFrame()`.
- **Capture request lowered to 30 FPS** (with a matching `applyConstraints`
  request) so the shared tab is not decoded at 60 FPS for frames that are
  discarded before encoding.
- **Output scaling capped at 1920×1080.** Frames keep their source-pixel density
  but are downscaled when the crop exceeds the cap, and never upscaled.
- **VP8 preferred for WebM.** The codec order is now VP8, then VP9, then generic
  WebM, favouring the encoder that sustains real-time canvas encoding most
  reliably.
- **Adaptive 6–16 Mbps bitrate.** The constant is replaced by a
  pixels-per-second calculation clamped to a 6–16 Mbps range.
- **Explicit lifecycle.** Recorder cleanup and finalization are centralized in
  `finalizeTableRecording`, with consistent handling of stop, capture-ended and
  recorder-error paths. The opaque full-frame repaint that avoids stale/white
  compositor artifacts is retained.
- Removed standalone historical/debug comments from `app.js`.

### Notes

- The `0.6.4` recording invariants in the release check were updated: the
  legacy `requestVideoFrameCallback` painter is gone, replaced by assertions for
  the 30 FPS scheduler, manual frame submission, the 1920×1080 cap, the
  VP8-first codec order, the adaptive bitrate and centralized finalization.
- Asset cache-busting moved to `0.6.5-recording-refactor`.

## 0.6.8 — DeepSeek reasoning budget

- **DeepSeek v4 is detected as a reasoning model.** The name heuristic only
  matched `deepseek-r1`/`deepseek-v3`, so `deepseek/deepseek-v4.1-flash` was
  given the small non-reasoning budget. Its hidden reasoning consumed all 320
  output tokens and returned an empty tool call, so aggressive hierarchical
  decisions failed with "Model did not call choose_action_family" and fell back
  automatically. The rule now covers `deepseek-[rv]<n>` (r1, v3, v4, …).
- **Larger reasoning budget.** Reasoning models now get `max_tokens: 2048`
  instead of 1024. DeepSeek v4's second (size) stage can spend well over 1024
  tokens on hidden reasoning before emitting a tool call; measured over repeated
  samples, 1024 failed intermittently while 2048 passed consistently.
- **Truncated stages are retried.** A reasoning model can still exhaust any fixed
  allowance on hidden reasoning (DeepSeek v4 does so roughly a quarter of the
  time on the size stage). When a stage returns no tool call because it hit the
  token limit (`finish_reason: length`), the arena now retries that stage once
  with a 4096-token budget and `reasoning: { effort: 'low' }` instead of forcing
  an automatic fallback. Five consecutive end-to-end DeepSeek decisions passed
  after this change.

### Notes

- The `reasoning` request parameter remains name-gated (not catalogue-gated):
  OpenRouter advertises `reasoning` support for almost every model, so treating
  that as a signal made models such as Gemma over-reason and exhaust the budget.
- Offline coverage asserts the DeepSeek r1/v3/v4 detection, the 2048 budget and
  the truncated-stage retry (via a stubbed fetch).

## 0.6.7 — Launcher builds, browser capability priming, scrollable decisions

- **`npm run start` builds first.** The launcher serves the prebuilt `dist/`
  bundle, but the `start` and `start:chrome` scripts did not rebuild it, so
  running the app from source could silently serve an older version. Both now
  run `npm run build` via `prestart` / `prestart:chrome` before starting the
  local server.
- **The browser primes model capabilities at startup.** 0.6.5 taught the
  decision core to omit `temperature` for models that do not support it, but the
  browser only loaded that metadata when the seat editor was opened. A start from
  `.env` or a saved setup never opened it, so a model such as `gpt-5.6-luna`
  still failed with "No endpoints found that can handle the requested
  parameters". Startup now fetches the configured OpenRouter catalogues and the
  tournament awaits that priming before its first request. The seat editor and
  connection test still prime it as before, and a failed fetch leaves the
  existing default behaviour.
- **Recent decisions scroll.** The inspector's decision stream is now a flex
  scroll region beneath the fixed-height current-decision panel, so it scrolls
  instead of being clipped once a tournament produces more entries than fit.
  Narrow/tablet layouts keep page-level scrolling.

### Notes

- `npm test` covers the new invariants: the scrollable panel, browser capability
  priming, and the `prestart` build hook.

## 0.6.6 — GLM reasoning budget and icon-only Start

- **GLM 4.5–5.3 are detected as reasoning models.** The name heuristic only
  matched `glm-4`, so `z-ai/glm-5.3-flash` was given the small non-reasoning
  completion budget. Its hidden reasoning then consumed all 320 output tokens and
  returned an empty tool call, so every hierarchical decision failed with
  "Model did not call choose_action_family" and was replaced by an automatic
  fallback. The rule now covers every numbered GLM version plus its vision/turbo
  and `latest` aliases, so the family and size stages get the 1024-token budget
  and the excluded 256-token reasoning cap.
- **Start is icon-only.** The primary Start control now uses the same
  `icon-only-action` treatment as Pause/Resume, Stop, Restart, Tests and
  Settings: just the `▶` glyph, a tooltip, and the accessible label. The
  narrow-viewport rules that re-expanded the Start label were removed, and the
  empty-lobby hint now reads "then press ▶".

### Notes

- Offline coverage now also asserts the reasoning-model detection for GLM 4.5,
  4.6, 4.7, 5, 5.3, 5v-turbo and `latest` in
  `tests/unit/model-capabilities-tests.mjs`.

## 0.6.5 — Capability-aware sampling parameters

- **`temperature` is sent only when the model supports it.** OpenRouter requests
  are routed with `require_parameters: true`, which hard-fails when any sent
  parameter has no supporting endpoint. GPT-5-class models dropped `temperature`,
  so every request to them returned "No endpoints found that can handle the
  requested parameters". The shared decision core now consults OpenRouter's
  per-model `supported_parameters` and omits `temperature` for models that do not
  advertise it.
- **Structural parameters stay strictly enforced.** `tools`, `response_format`
  (strict JSON Schema) and `max_tokens` are still sent with
  `require_parameters: true`, so the tool / JSON-Schema contract is never
  silently downgraded to an endpoint that ignores it. Models with no catalogue
  entry keep the previous default behaviour.
- **Capabilities are primed wherever a catalogue is loaded.** The browser seat
  editor and connection test register the catalogue with the decision core, and
  the real-API diagnostics, paired-corpus and tournament runners prime it once at
  startup. If the catalogue is unavailable, requests are unchanged.

### Notes

- Offline coverage: `tests/unit/model-capabilities-tests.mjs` proves temperature
  gating, structural-parameter preservation and tolerance of malformed catalogue
  entries.

## 0.6.4 — Canvas-cropped table recording

- **Crop in a canvas instead of the compositor.** Recording now captures the
  whole current browser tab and paints the table's crop region into an opaque
  `<canvas>`, then records that canvas stream. Element/Region Capture could
  leave stale or white compositor tiles where transformed seats, shadows and
  filtered layers crossed the capture boundary; a full-frame canvas repaint per
  frame removes them.
- **Native source-pixel density.** The crop is taken from the shared video's
  real pixel dimensions rather than CSS pixels, so high-DPI displays no longer
  downscale cards into a soft image. The bitrate ceiling rises to 32 Mbps and
  the target frame rate to 60 fps to match.
- **Sturdier lifecycle.** The tab-share video, canvas, painters and both media
  streams are torn down through one `disposeTableRecording` path on stop, error
  and page unload, and capture is rejected unless the shared surface is a
  browser tab.

## 0.6.3 — Icon-only Restart

- **Restart is icon-only.** The `↻` control now matches the icon-only
  Pause/Resume, Stop, Settings and Tests buttons, so every header action except
  the primary Start shares one compact width. The tooltip and screen-reader
  label still announce "Restart with a new tournament".

## 0.6.2 — Icon-only Pause/Resume and Stop

- **Pause/Resume and Stop are icon-only.** Both header controls now match the
  icon-only Settings and Tests buttons, so the top bar keeps a stable, compact
  rhythm while a tournament runs. The icon still switches between pause (`Ⅱ`)
  and resume (`▶`), and the tooltip plus the screen-reader label continue to
  announce the full action name.

## 0.6.1 — Rail seat layout

- **Seats sit on the table rail.** Positions are now computed on an ellipse
  fitted to the felt rather than to the browser edges, with an even angular step
  per seat. Even-handed tables start between the cardinal axes, so 8- and 10-max
  tables place two seats across the top and bottom instead of piling one player
  in the exact middle. Heads-up keeps the familiar bottom/top layout. Live
  tables reserve a visual slot per configured player, so seats do not shift as
  players are eliminated.
- **Density is a fallback, not the primary fit.** The density ladder now only
  steps down when seats actually collide, so normal laptop and tablet widths
  keep comfortably readable player cards.
- **Single-file build resilience.** `build.mjs` matches asset references with an
  optional cache-busting query string and fails loudly if inlining ever misses,
  so `pokertools-arena.html` cannot silently ship with external links.
- **Inspector-first grid at 960–1180px.** The older stack/order rules no longer
  reorder the arena card into the wrong grid column on mid-size windows; a
  1024×768 window now keeps the table beside the inspector at tight density
  instead of squeezing it to a narrow strip.

### Notes

- The feed and replay again read spectator text from the full event archive and
  agree on which explanation wins (the latest for a decision).

## 0.6.0 — Observability and Log tab

- **Full in-memory event archive.** The director no longer discards events past
  3,000. Broadcast snapshots stay compact (last 300) and persisted state stays
  small (last 100), but the Log tab, decision replay and JSONL export now see
  every event from the current run.
- **Rebuilt Log tab.** Search, category filtering (decisions / hands / system /
  errors), a live event count, clearer rows with time, detail and metadata, error
  emphasis, and replay links for historical decisions.
- **Archive-backed replay.** Opening a decision from the Log or the feed reads
  the full archive, so older hands keep their snapshot and spectator text.
- **Safer modals.** A backdrop click only closes when it lands outside the
  dialog's border box, so clicks in dialog padding no longer dismiss it.
- **Dealing motion** now originates from the table centre.
- **Mobile polish:** `viewport-fit=cover`, safe-area padding, and continued
  `prefers-reduced-motion` support.

### Notes

- Feed and replay both read explanations from the archive and agree on which
  spectator explanation wins (the latest for a decision).

## 0.5.2 — Live resize without a reload

Resizing the window used to settle on the wrong layout until the page was
reloaded (a short window picked `micro` with 5.5px HUD text instead of `tight`
with 12px). Two causes, both fixed:

- **Mid-transition measurement.** `.lobby-seat` animates `left`/`top` over 240ms,
  so the density probe read a half-moved seat and chose a denser layout than the
  settled geometry warranted. A `lobby-measure` class now disables the seat
  transition for the measurement pass and restores it on the next frame.
- **Stale seat DOM on resize.** The resize handler re-positioned existing seats
  instead of rebuilding them, so media-query content changes never applied.
  It now re-renders and re-lays-out the seats, and also listens to
  `visualViewport` for mobile browser chrome changes.

Resize and reload now produce byte-identical layouts.

## 0.5.1 — Felt typography and short-viewport scaling

- **Exact felt identity sizes.** The tablecloth wordmark and spade are 46px and
  the `model benchmark table` subtitle is 12px, scaled down per density (38px at
  compact, 34px at tight/micro) so the felt never crowds the seats.
- **Centre column scales with the felt.** `streetLabel`, the board cards and the
  HUD now use container-relative sizes instead of fixed pixels, so the centre
  reads correctly on a wide desktop and a short window alike.
- **140×100 lobby seats** with a consistent card size for both empty and
  configured seats.
- **Short, wide viewports.** A 1220×520 window produces a wide-but-shallow felt;
  it is now laid out at tight density with readable 12px HUD values and an 11px
  street label, instead of collapsing to micro with 5.5px text. All ten seats
  remain inside the felt with no overlap.

## 0.5.0 — Inspector-first layout

- **Header moved into the inspector.** The brand, GitHub link and tournament
  controls now form the inspector's own header on the left. The table is the
  full-height right column, so the felt gains the vertical space the page bar
  used to occupy.
- **Larger tablecloth brand.** The felt identity (`pokertools-arena` and its
  spade) is roughly three times larger and readable across the table, scaled per
  density so it never crowds the seats.
- **Icon-only Tests.** Both Tests and Settings are now icon-only header buttons.
- **Bigger action icons.** Glyphs increased without enlarging the buttons.
- **Seat layout on small screens.** Narrow felts step straight to the micro
  density and inset the seat ring by what the table can actually spare, so all
  ten seats stay inside the felt with no overlap at phone widths.

## 0.4.9 — Maintenance

- **Accessible inspector tabs.** The Live / Log / Stats tabs are a real
  `role="tablist"`: `aria-selected`, `aria-controls`, roving `tabindex`, arrow /
  Home / End keyboard navigation, and `hidden` panels instead of display-only
  toggling.
- **Corrected poker statistics.** VPIP/PFR now use hands dealt (from
  `HAND_START.playerIds`) rather than only hands with a preflop decision, so a
  big blind walk counts. Aggression is reported as standard aggression frequency
  (`AFq`, aggressive / aggressive+calls+folds) instead of the aggression-factor
  ratio, and fold rate is measured against fold opportunities. Labels and
  tooltips were updated, and old logs without player ids still work.
- **Consistent time-bank charging.** Active elapsed time is billed once, after
  the request, for both successful and failed decisions. Provider/model failures
  no longer preserve a seat's bank while successes consume theirs.
- **Blind structure validation.** A big blind below twice the small blind is
  rejected, and the setup form now runs the same `normalizeConfig` validation as
  tournament start, so configuration errors surface on save instead of at Start.
- **Case-insensitive player names.** Duplicate-name detection folds case.
- **Feed and accessibility polish.** New spectator explanations trigger a feed
  re-render, sound and record buttons keep their `aria-label` in sync, and focus
  outlines, coarse-pointer hit targets and narrow-screen stat layouts were added.

## 0.4.8 — Maintenance

- **Compact header.** Left: the logo, `pokertools-arena`, and a backgroundless
  GitHub mark. Right: Start / Restart / Pause / Stop, Tests, and an icon-only
  Settings control. The `♟ Seats` button became **Restart**, shown only after a
  run has started and stopped or finished.
- **Sound and recording** moved into the table header (`arena-head`) beside the
  status they affect; **log download** moved into the `Log` tab that produces it.
- **Bank clock** now leads the right-hand clock block instead of trailing it.
- **Board cards on small screens** use the same rank-plus-center-suit language as
  the hole cards: the duplicated bottom-right corner and inline suit glyph are
  dropped at narrow widths and at compact/tight/micro densities.

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

