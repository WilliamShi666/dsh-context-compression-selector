# Changelog

All notable changes use this file. The project follows semantic versioning after `0.1.0`.

## 0.2.0 - 2026-10-16

The same build now mounts on both Harness generations. Every `@deepseek-ai/dsh-*` peer widens from a 0.1.x-only range to the dual-target range `^0.1.1-rc.2 || ^0.2.0-rc.1`, and the two settings surfaces are acquired by capability rather than by version. No DeepSeek Harness core code is modified, and the `dsh web` launch command is unchanged: the Harness resolves an in-box bundle from the running installation first, so a profile-local copy never shadows it.

### Added

- Harness 0.2.0 support alongside the existing 0.1.x target. Both generations mount the same published artifact: the client acquires its settings surface through a per-generation `ctx.inject` and programs against one internal `SettingsFace` adapter, so the selector renders on either without a generation switch at build time.
- Live settings editing on Harness 0.2.0. The entry `Config` gains `profile` and `autoCompactThresholdPercent`, both declared volatile, so the Host exposes them in this entry's configuration form and a change takes effect without remounting the plugin. `readLiveConfigField` reads a volatile field as a plain value through the global `Symbol.for('cosmokit.volatile.write')` protocol — the symbol rather than a `get` probe, so an ordinary object exposing `get` passes through untouched, and no dependency on the Host's own `cosmokit` copy is introduced.
- `Config` declares the `volatile` key on this package's schemastery floor (3.18.1), whose `Meta` predates it. The declaration matches the Host's own 3.18.4 key, so the two agree rather than diverge, and being type-level only it adds no runtime dependency. The fields use `.extra('volatile', true)` rather than `.volatile()` because 3.18.1's `Schema` has no such method; `meta.volatile` round-trips through `toJSON()` on both versions.

### Changed

- The selector's settings acquisition on Harness 0.2.0 reads the entry's configuration form (`ctx.configForms` / `whileServed` / `get`) and writes through it. That form serves only the entry's Host-declared volatile fields, so the versioned Custom policy is not editable there and the surface does not offer it: the injected face carries `customEditable`, and on 0.2.0 the Custom editor and the Custom hint are withheld rather than shown and silently dropped. The explicit Custom *selection* on 0.2.0 is unaffected and still resolves.
- The selected profile now reaches the generated composition. On 0.1.x the profile lives in the shared `context-compression` document that the generated composition's runtime entry reads live; 0.2.0 has no shared document, so a selection made on the selector entry never crossed into the composition's own runtime entry and had no effect. `PresetOverlayOptions.profile` carries it into the pruner's config instead. The profile also joins the generated file's content identity, so switching profiles produces a new file rather than reusing one bound to the previous selection.
- The current Session's agent preset is read structurally (`session-preset.ts`) across both generations: 0.1.x keeps `agentPreset` on each list row and names the current Session in `current`, while 0.2.0 moved the preset to the `agentPreset` Session projection and marks the current Session by the main view's `retainedBy.mainView` retention. A Session whose preset is not yet known still reads `undefined`, which callers treat as "do not block".
- The Auto Compact threshold resolves through the same capability split, and the 80% fallback constant is now named (`DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT`) rather than written inline.
- The disclosure chevron is resolved across generations at runtime: 0.1.x exports `IconChevronDownOutline14`, 0.2.0 renamed the artwork to `IconChevronDownOutlineRegular`. Neither name exists on the other generation, so the lookup is a namespace read and a future rename degrades to a missing glyph instead of a failed component.
- The client entry's static service list drops `settingsScope`. The composition-level `dsh.client.inject` manifest field is unchanged.

### Fixed

- Web boot aborted with `1 entry did not activate` on Harness 0.2.0. The client declared `settingsScope` as a static dependency, but 0.2.0 provides no such service, so the entry's fiber stayed `pending` forever while the boot gate reads exactly that fiber. Each settings surface is now acquired in its own `ctx.inject` sub-fiber, where a missing service leaves only the sub-fiber pending and the entry still reaches `active`.
- The runtime no longer throws on Harness 0.2.0. Its settings read called `settings.get(namespace)`, and 0.2.0's `settings` service has no `get` at all — the call raised a `TypeError` rather than merely failing to find a document, which took down the mount. Both settings reads are now capability-guarded and return `undefined` on a generation that has no such surface, which the existing fallback path already handles.
- The 0.1.x settings registration lease is skipped on 0.2.0, whose settings service has no `register`; the lease previously assumed the 0.1.x namespace surface.
- The compact sidebar no longer renders the full Custom parameter editor. The gate on the sidebar's custom-editor branch was inverted, and the editor's `disabled` state was computed from the wrong predicate; both are corrected against the surface axis (`showCustomEditor`) and the generation axis (`customEditable`) separately.

## 0.1.1 - 2026-09-23

### Added

- DeepSeek-V4.1-Flash support for the `deepseek-flash` default route: it now resolves an exact bundled tokenizer (`deepseek-ai/DeepSeek-V4.1-Flash` @ `dba1be0a40aa45a94ad051997016db3960a90277`) instead of failing closed, so exact-gated compression is no longer a no-op on the Harness default model.
- Official `deepseek-flash` pricing rows (USD `0.003/0.15/0.6` off-peak and `0.006/0.3/1.2` peak; CNY `0.02/1/4` off-peak and `0.04/2/8` peak) with `modelVersion` `DeepSeek-V4.1-Flash`, so adaptive cost authority is enabled on that route.

### Changed

- The bundled vision asset is re-anchored from the retired `deepseek-ai/DeepSeek-V4-Flash-Vision-Exp` repository to `deepseek-ai/DeepSeek-V4.1-Flash` (`packages/runtime/assets/deepseek-v4.1-flash/`). The `tokenizer.json` and `tokenizer_config.json` bytes are unchanged; only provenance and the license file move.
- `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are now served by the same V4.1-Flash artifact as `deepseek-flash`. `deepseek-v4-pro` keeps its own V4-Pro tokenizer, and the only V4-Pro change is dropping the retired `deepseek-v4-flash` alias from its manifest `modelIds`; the "untouched" part of this entry applies to `deepseek-v4-pro` only — its tokenizer bytes, `modelVersion`, and prices are unchanged.
- The two retired aliases `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are now **billed at the Flash price** instead of the withdrawn V4-Flash tuple, matching the official pricing page ("billed at the Flash price" / "按 Flash 价格计费"). New: USD `0.003/0.15/0.6` off-peak and `0.006/0.3/1.2` peak, CNY `0.02/1/4` off-peak and `0.04/2/8` peak, `modelVersion` `DeepSeek-V4.1-Flash`. Previous: USD `0.007/0.22/0.66` off-peak and `0.014/0.44/1.32` peak, CNY `0.05/1.5/4.5` off-peak and `0.10/3.0/9.0` peak, `modelVersion` `DeepSeek-V4-Flash-0731`. This is not cosmetic: the cache-hit/cache-miss spread narrows from `0.213` to `0.147`, which can turn a previously authorized Adaptive History decision on these routes into `cache-risk-not-clearly-paid-back`. `deepseek-v4-pro` pricing is deliberately unchanged.
- The `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` routes are a documented compatibility period only: the official pricing page marks those models as retired and says their requests are served by V4.1-Flash. If the aliases are withdrawn, the tokenizer mapping and the pricing rows for them must be re-evaluated together.
- Vision image-token arithmetic is re-ported to the official V4.1 `image_processor.py`: the per-image cap moves 384 → 1024 tokens, the minimum-pixel floor 147456 → 295936, and the aspect clamp is gone because the official config pins `vision_max_wh_ratio` to `null`. The block length is now exactly `nLlmH * (nLlmW + 1) + 2` and is independent of the serialized position, so the position-dependent compress/odd-row/alignment padding and the `safe_resize` budget loop are removed. Measured divergence from the previous port: 800×600 338–341 → 317, 1024×1024 346–349 → 652, 14×14 114–117 → 184.
- The vision estimator identity is bumped to `deepseek-ai/DeepSeek-V4.1-Flash/image-token-estimate` @ `dba1be0a40aa45a94ad051997016db3960a90277:v1` so audit rows from the two arithmetics cannot be confused. The fixed 256-token malformed-image fallback is unchanged.
- `vision-golden.json` is regenerated by executing the official V4.1 Python implementation; the position sweep is retained as explicit position-independence evidence rather than a varying-count sweep.

### Fixed

- The selector's Adaptive price disclosure now reports `2026-09-23`, matching the re-verified price catalog. It still said `2026-08-25` after the catalog was re-checked, and a client-test regex pinned that literal, so the stale date was locked in rather than detected.
- The packed release smoke now drives `deepseek-flash` — the Harness default model id — instead of the legacy `deepseek-v4-flash` alias. The gate previously passed while never exercising the route this release exists to fix, so a regression on the default route would not have been caught. Alias mapping remains covered by the unit suite.

## 0.1.0 - 2026-09-03

### Added

- Stable release of DeepSeek V4 Flash Vision tokenizer integration for `deepseek-v4-flash-vision-exp`, including exact text counting and bounded image-token estimates.
- User-configurable model-driven Auto Compact threshold in the selector settings section.
- Auto Compact threshold linkage for each standard profile's History / micro-compact watermarks and related compression parameters.

### Changed

- The threshold editor now uses one direct numeric input; the slider and fixed quick-value buttons were removed.
- Runtime session-event access supports both the established Harness `events` accessor and the newer `snapshotEvents()` public API.

## 0.1.0-beta.4 - 2026-09-02

### Fixed

- Support the official DeepSeek Harness `dsh-v0.1.2-alpha.5` public API while retaining compatibility with the existing `0.1.1-rc.2` peer range. The plugin now owns the two small immutable-value helpers that the newer Harness no longer exports, and uses the same public `context-compression` namespace literal accepted by both Settings implementations. No Harness core code is modified.

## 0.1.0-beta.3 - 2026-09-01

### Scope

This is a staged release. Exact **text-class** token counting for `deepseek-v4-flash-vision-exp`, best-effort bounded **vision-class image** estimates, and the Auto Compact threshold/UI/audit work are delivered. Exact image measurement remains **BLOCKED upstream**: the current measurement seam exposes neither the adapter's projected request-image dimensions nor the absolute serialized position, so estimates cannot be promoted to `exact-tokenizer`.

### Added

- DeepSeek V4 Flash Vision support for `deepseek-v4-flash-vision-exp` via a separately bundled official tokenizer pinned at `deepseek-ai/DeepSeek-V4-Flash-Vision-Exp` revision `6821d6ad3681a4b137b066b76094fa82ebd0a380`. Text, reasoning, tool-call arguments, and pure-text tool results are counted exactly; image-bearing tool-result candidates stay fail-open.
- Vision image-token arithmetic ported line-by-line from the official `inference/image_processor.py` (patch size 14, downsample 3, 384-token cap, min pixels 147456, 8:1 aspect clamp, and position-dependent alignment padding), validated against golden fixtures generated by executing the official Python implementation. Valid intrinsic dimensions now produce `tokenizer-estimate` at the midpoint of all four alignment residues with a 384-token per-image upper bound; malformed or unevaluable dimensions use a documented 256-token fallback. Mixed text/image surfaces aggregate exact text and estimated images without promoting them to exact.
- `autoCompact.thresholdPercent` setting (default 80, integer 50–90, step 1) with one shared validation contract across the settings UI, the persisted schema, and the runtime resolver. The editor lives inside the context-compression selector settings section.
- Standard-profile History linkage to the Auto Compact watermark: `A = floor(C × a)` rescales the History trigger, minimum reclaim, and recent-token tail; `D = floor(A × 0.875)` replaces the fixed 0.7 capacity-pressure ratio as the micro-compact last-chance gate; one batch must justify its cache break by pulling the complete request back below the deadline. Defaults at 80% reproduce the previous numbers exactly.
- The preset overlay writes the saved threshold into the generated `compaction-basic` composition as `thresholdRatio` (with `retainRatio` pinned at 0.16) and, from the same read, into the plugin runtime's deployment config as `autoCompactThresholdPercent`, so one standing generation never runs Auto Compact and micro compact on two different thresholds. Any generation-identity change — threshold, source, or module paths, including equal-length ones — produces a new standing composition generation. Deterministic identity-derived stamps use an 8-hex whole-second window; equal-prefix identities can collide in that first window on a coarse filesystem, so the overlay observes the staging file's real `mtimeMs+size` key and escalates to later hash windows before the atomic rename. Content, permissions, and the final unique stamp are complete before publication; already-running sessions keep their frozen policy.
- `policy-resolved` audits now record the Auto Compact coordination facts (threshold percent, `A`, `D`, parameter source — including `deployment-override`/`mixed` when deployment config replaces linked History watermarks), the routed provider/model, and the bundled tokenizer identity.
- Persisted settings reject present-but-invalid sections (`profile: null`, `custom: null`, own-property `undefined`) before any schema default can absorb them; a malformed stored document freezes the session losslessly (`profile: off`, audited as `settingsInvalidFallback: lossless-off`) instead of silently enabling the lossy Balanced default. The browser decoder applies the same rule and canonicalizes legacy Custom v1/v2 documents to the same v3 document the runtime resolver produces.
- The History planner returns a discriminated outcome, and `component-evaluation` audits distinguish the full skip taxonomy: `below-profile-trigger`, `below-micro-deadline`, `exact-tokenizer-unavailable`, `no-safe-candidates` (only recovery-tool output or already-cleared results), `protected-working-set` (everything inside the protected tail), `insufficient-reclaim` and `cannot-reach-deadline-target` (with the reached/required token numbers), `adaptive-cost-rejected`, and `recovery-tool-unavailable`.

### Known limitations

- Images never claim exact counts. The official expansion depends on the absolute prompt position (system prompt, chat-template framing, adapter image handles) and on the adapter's final request-image projection (including per-route `imagePixelBudget`/`imageDetail` overrides and byte-cap reprojection), none of which is exposed through the current measurement seam. Intrinsic/default estimates may therefore differ materially from provider accounting. Upstream capability requests remain projected request-image dimensions and the absolute serialized position exposed to token-meter extensions.
- History skips the whole batch whenever any tool-result candidate lacks an exact count, including image-bearing candidates, even though sibling text candidates are individually exact.
- Custom remains manual token mode; its History parameters do not follow the Auto Compact watermark.
- A vision token breakdown UI is not shipped; image estimates and the intrinsic alignment diagnostic are available on the measured token view, while lossy rewrite proofs still require exact counts.

### Deferred

- Audit `modality` field and the tokenizer artifact SHA-256 inside audit records (the audits already carry the routed provider/model and tokenizer identity).
- Publishing the (now complete) runtime skip-reason taxonomy as a user-facing documentation table.
- Custom-profile display of the A/D watermarks and an above-D warning; Custom remains fully manual.
- Vision token breakdown UI and promotion of image estimates to exact measurement.

## 0.1.0-beta.2 - 2026-08-28

### Fixed

- Resolve the official DeepSeek V4 Flash tokenizer route so Fresh and Aggregate can evaluate tool results for the supported V4 models.
- Run Cache Strict History at the real request boundary once its configured capacity-pressure condition is met; trigger the capacity condition at 70% routed-context utilization.
- Disable Harness-native head/middle/tail tool-result pruning whenever a selector profile is active, leaving the selector as the sole tool-result compactor.

### Changed

- Protect the newest 10 agent tool calls and a 64,000-token tool-result tail window before History/microcompact rewrites older results.

## 0.1.0-beta.1 - 2026-08-27

### Added

- One-install DeepSeek Harness Product Bundle backed by a separate exact-version runtime package.
- Web profile selector with preset-stable settings and an explicit built-in Minimal exception.
- Fresh, Aggregate, routine/capacity-aware History, Native tool-result pruning, and default-off Custom TailTrim.
- Standard-event TailTrim protocol using `compaction/prune` plus recoverable `user/message` replacement.
- Plugin-owned `context_compression_retrieve` recovery tool.
- Structured, content-free policy, evaluation, rewrite, failure, and Native auto-compact audit records.
- Pinned official DeepSeek V4 tokenizer assets with runtime SHA-256 validation and upstream license.
- Public-API component E2E, preset/Minimal, and parent/fork/spawn cache-prefix regression tests.

### Compatibility

- Verified against DeepSeek Harness `dsh-v0.1.1-rc.2` public packages.
- Exact tokenizer mapping is currently limited to `deepseek-v4-flash` and `deepseek-v4-pro`.

### Known limitations

- Adaptive ordinary History fails closed when public request-level route/cache evidence is incomplete; capacity pressure remains a separate safety override.
- Cache-prefix tests prove native fork inheritance and identical serialized prefixes, not a provider-specific cache allocation or a guaranteed DeepSeek cache hit.
- Settings snapshots and first-exposure decisions are process-local to the mounted runtime.
