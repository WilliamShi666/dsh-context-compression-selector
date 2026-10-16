# dsh-context-compression-selector

> An auditable tool-result context-compression selector for DeepSeek Harness.

[中文说明](README.zh.md) · [Interactive courseware](https://github.com/WilliamShi666/Slides-that-explain-dsh-context-compression-selector#english) · [中文课件](https://github.com/WilliamShi666/Slides-that-explain-dsh-context-compression-selector#中文) · [Report an issue](https://github.com/WilliamShi666/dsh-context-compression-selector/issues)

> [!NOTE]
> **What's new in 0.2.1:**
>
> - **Fixes a blank settings panel on Harness 0.2.0.** The 0.2.0 settings section aborted with React error #185 (`Maximum update depth exceeded`) — its navigation entry appeared but the panel drew nothing. The 0.2.0 adapter composed a fresh settings document on every snapshot read, and `useSyncExternalStore` compares consecutive snapshots by reference, so it never settled. The document is now memoized against the form's own snapshot. **If you installed 0.2.0, upgrade to 0.2.1.**
> - **The same build now runs on DeepSeek Harness 0.2.x as well as 0.1.x.** Every `@deepseek-ai/dsh-*` peer widens to `^0.1.1-rc.2 || ^0.2.0-rc.1`, and the selector picks its settings surface by capability instead of by version, so one published artifact mounts on either generation. No Harness core code is modified, and the `dsh web` launch command is unchanged.
> - **Web boot no longer aborts on 0.2.0.** The selector used to declare a 0.1.x-only settings service as a static dependency; 0.2.0 does not provide it, which left the plugin entry pending and aborted the whole page. Each settings surface is now acquired in its own sub-fiber.
> - **Live settings editing on 0.2.0**, through the entry's volatile config fields. The versioned Custom policy is not editable on 0.2.0, where the settings form serves only those fields, so the UI withholds the Custom editor there instead of offering an edit that would be dropped. Explicitly selecting Custom still works.
> - On 0.2.0 the selected profile now reaches the generated composition, which it previously did not.
>
> See [CHANGELOG.md](CHANGELOG.md) for the full release history.

> [!IMPORTANT]
> This project currently supports **DeepSeek models only**. Its lossless measurement and lossy tool-result compression depend on the bundled official DeepSeek tokenizers. The exact supported model IDs in this release are `deepseek-flash`, `deepseek-v4-flash`, `deepseek-v4-pro`, and `deepseek-v4-flash-vision-exp`. Other DeepSeek Harness models, including non-DeepSeek providers, fail open and retain their original tool results.

## What it is

Long-running agent tasks can accumulate a large amount of tool output. This community plugin adds selectable, auditable policies for reducing that tool-result context without modifying DeepSeek Harness core.

- **Fresh** pre-compresses a newly oversized tool-result segment before the model receives it.
- **Aggregate** pre-compresses fresh material again when it still grows beyond its configured budget.
- **History / micro-compact** replaces eligible old tool results while preserving recent working context.
- **TailTrim** is an optional Custom-only tail reduction path.
- **Native** preserves the original Harness-style head/middle/tail tool-result trimming as one explicit profile.

The plugin records the selected policy and each decision: stage, reducer, trigger, skip reason, and exact token counts where available.

## Settings UI

Choose a compression profile from DeepSeek Harness settings, and set the Auto Compact trigger level in the same section. Settings are frozen when a session first observes them, so changing a setting affects new sessions rather than silently changing an active task.

### Auto Compact threshold

The selector settings section exposes `autoCompact.thresholdPercent`: an integer between 50% and 90% (step 1%), defaulting to 80%. Enter any valid value, such as 73%, directly in the field. Values outside the recommended 70–85% band show a risk note but remain savable. The level is written into the generated `compaction-basic` composition as `thresholdRatio` and, from the same read, into the plugin runtime's deployment config, so one standing generation can never run Auto Compact and micro compact on two different thresholds. It rescales the standard-profile History trigger, minimum reclaim, recent-token tail, and the micro-compact last-chance deadline `D = floor(A × 0.875)` around `A = floor(C × a)`, where `a = thresholdPercent / 100` is used as a floating-point ratio — the same arithmetic order `compaction-basic` itself uses. At the default 80% on a 1M context the previous numbers are reproduced exactly. Fresh, Aggregate, Native single-result budgets, the 10-call working set, and the Auto Compact retain ratio are unchanged in this release; Custom stays manual.

![Context Compression Selector settings UI](docs/assets/context-compression-selector-settings.png)


## Who should use it

This is an advanced plugin. It is not designed to be friendly to most users without background knowledge of agent context, tool-result compression, context windows, prompt caching, and the difference between deterministic tool-result compression and model-driven auto-compaction.

If those terms are unfamiliar, start with the companion [interactive courseware](https://github.com/WilliamShi666/Slides-that-explain-dsh-context-compression-selector#english). It explains the mechanisms, profiles, trade-offs, and practical usage before you change compression settings.

## Model support and safety

The runtime ships pinned official DeepSeek V4 tokenizer assets and verifies their SHA-256 hashes. Exact token measurement is a safety requirement: without it, the plugin does not perform a lossy rewrite.

| Model route | Served by | Selector compression |
| --- | --- | --- |
| `deepseek-flash` | `DeepSeek-V4.1-Flash` | Supported: exact text counting plus bounded image-token estimates; image-bearing rewrite candidates remain exact-ineligible and intact |
| `deepseek-v4-flash` | `DeepSeek-V4.1-Flash` | Supported |
| `deepseek-v4-flash-vision-exp` | `DeepSeek-V4.1-Flash` | Supported: exact text counting plus bounded image-token estimates; image-bearing rewrite candidates remain exact-ineligible and intact |
| `deepseek-v4-pro` | `DeepSeek-V4-Pro` | Supported |
| Other DeepSeek model IDs | — | Not supported; fail open |
| Non-DeepSeek models in DeepSeek Harness | — | Not supported; fail open |

The V4.1-Flash routes are served by a bundled official tokenizer pinned at `deepseek-ai/DeepSeek-V4.1-Flash` revision `dba1be0a40aa45a94ad051997016db3960a90277`; `deepseek-v4-pro` keeps its own separately pinned `deepseek-ai/DeepSeek-V4-Pro` tokenizer. The two vocabularies are deliberately never treated as aliases of each other. Vision image tokens use a line-by-line port of the official V4.1 image processor (patch size 14, downsample ratio 3, 1024-token cap, min pixels 295936, and no aspect clamp because the official config pins `max_wh_ratio` to `null`), validated against golden fixtures generated by executing the official Python implementation. The V4.1 block length is exactly `nLlmH * (nLlmW + 1) + 2` and carries no alignment padding, so it does not depend on the absolute serialized position. A valid image is reported as `tokenizer-estimate` at that block length, with 1024 tokens retained as the per-image conservative upper bound. If dimensions are malformed or cannot be evaluated, the plugin charges a fixed 256-token fallback instead of making the visual surface unavailable. These values are deliberately approximate because the adapter's final request-image projection — including per-route pixel-budget overrides and byte-cap reprojection — is not exposed through the current measurement seam; an 800×800 upload projected to 512×512 can therefore differ materially from its intrinsic estimate. The estimate improves pressure accounting but never authorizes a lossy rewrite: image-bearing tool-result candidates remain exact-ineligible and are never rewritten, deleted, or counted as zero. Exposing projected dimensions upstream would allow a later exact counter.

“Fail open” means the original tool result remains in context and an auditable skip or failure record is emitted. The selector does not estimate tokens with character counts and must not be treated as a generic multi-provider compressor.

## Pre-compression and historical compression are different

**Fresh and Aggregate are pre-compression, not History compression.** They reduce a newly produced tool result before it is first sent to the model. The reducer selects a safe strategy from the tool name, command arguments, and content evidence—for example JSON, search, file read, Git, package, build, test, or shell output. Because this only bounds new material and does not rewrite the serialized prompt prefix already sent to the provider, it does not break an existing prompt cache.

**History / micro-compact is historical compression.** It selects old tool results outside the protected working set, then replaces each selected result in active context with a short, recoverable multi-line placeholder beginning `[Old tool result content cleared from active context]`. The placeholder retains the tool name, status, source reference, and retrieval instruction, while the original durable event remains recoverable. This intentionally rewrites an already-sent prefix, so it breaks or restarts the prompt cache. History protects the union of the newest 10 agent tool calls and the latest 64,000 tool-result tokens before it considers older results.

## How a profile is evaluated

```mermaid
flowchart TD
    A[Selected profile] --> B{Profile}
    B -- Off --> C[Leave tool results unchanged]
    B -- Native --> D[Native head-middle-tail trimming]
    B -- Balanced / Cache Strict / Savings / Adaptive / Custom --> E{Fresh eligible?}
    E -- Yes --> F[Fresh]
    E -- No --> G{Aggregate eligible?}
    F --> G
    G -- Yes --> H[Aggregate]
    G -- No --> I{History condition met?}
    H --> I
    I -- Yes --> J[History / micro-compact]
    I -- No --> K{Custom TailTrim enabled and safe?}
    J --> K
    K -- Yes --> L[TailTrim]
    K -- No --> M[Keep the remaining context]
    L --> M
    N[Harness/model native auto-compact] -. separate mechanism .-> M
```

An enabled mode is not guaranteed to run. Its trigger, safety checks, exact tokenizer availability, and required reclaim must all pass. For all selector profiles other than `native`, Harness-native head/middle/tail tool-result trimming is disabled so that the selector is the only tool-result compactor. Model-driven native auto-compaction remains a separate Harness/model mechanism and is only audited separately.

## Profiles

Profiles are orchestration policies, not separate compression algorithms. A profile composes the available methods by deciding which ones are enabled, their evaluation order, thresholds, retention set, minimum reclaim, and cache-safety trade-offs.

| Profile | Fresh / Aggregate | History | Native tool trimming | TailTrim |
| --- | --- | --- | --- | --- |
| Off | Disabled | Disabled | Disabled | Disabled |
| Native | Disabled | Disabled | Enabled (`4096 → 2048`) | Disabled |
| Balanced | `8192 → 3072` / `32768 → 12288` | Routine at `500000`; retain 10 recent calls and a 64,000-token tail | Disabled | Disabled |
| Cache Strict | Same as Balanced | Full-request last chance at `D = 700000`; once `D` is reached, the planner may run even when tool-result tokens are at or below `H = 600000` | Disabled | Disabled |
| Savings | `4096 → 1536` / `16384 → 4096` | Routine at `400000` | Disabled | Disabled |
| Adaptive | Same as Balanced | Conservative estimated routing at `500000`, with a capacity-pressure safety override | Disabled | Disabled |
| Custom | Configurable | Configurable | Disabled | Optional, disabled by default |

History protects the union of the newest 10 agent tool calls and the latest 64,000 tool-result tokens. Older eligible results are rewritten only when the policy can reclaim its required minimum. The History trigger, minimum-reclaim, and tail numbers in the table are the values at the default 80% Auto Compact level; they rescale with `A = floor(C × a)` (`a = thresholdPercent / 100`, floating-point ratio) once you change the threshold (see Auto Compact threshold above).

### Adaptive limitation and upstream capability request

The Adaptive profile is shown in the settings UI as **Conservative cost**. It is intentionally not a perfect adaptive cache optimizer: it makes a conservative estimate from the currently available request usage, model pricing, and same-tokenizer measurements, and fails closed when those inputs are incomplete. It cannot observe or control the exact cache breakpoint, cache allocation, or cache lifetime.

Perfect adaptive behavior requires DeepSeek to expose cache-breakpoint control and cache TTL/lifetime evidence. Those capabilities are not currently available to this plugin through public DeepSeek Harness or provider APIs. Upstream capability request: @deepseek-ai and [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).

## Compatibility

- Verified against DeepSeek Harness `dsh-v0.1.1-rc.2` and `dsh-v0.2.0-rc.2` using public plugin and profile APIs only.
- Requires Node `^22.19.0 || >=24`.
- The project contains only this Bundle and its runtime; it does not vendor or modify DeepSeek Harness core.
- This is an unofficial community project and is not affiliated with or endorsed by DeepSeek.

### Per-generation behavior

| Capability | Harness 0.1.x | Harness 0.2.x |
| --- | --- | --- |
| Settings surface | plugin namespace via `settingsScope` | the entry's own config form via `configForms` |
| Whole settings document | readable and writable | not available; per-entry form only |
| Profile / Auto Compact threshold | stored in the shared document | volatile config fields on the entry |
| Custom policy (versioned, v3) | editable and selectable | selectable, not editable |
| Selected profile reaches the generated composition | yes (shared document) | yes (written into the pruner config) |

Selecting `custom` remains available on 0.2.x, but its parameters cannot be edited from the settings page there, because the 0.2.x settings form serves only the entry's Host-declared volatile fields. The UI withholds the Custom editor rather than accepting edits that would be silently dropped.

## Development and security

Run the release-oriented local checks with:

```sh
pnpm run typecheck
pnpm run test
pnpm run test:built
pnpm run test:e2e:packed
pnpm run verify:release
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development expectations, [SECURITY.md](SECURITY.md) for vulnerability reporting, and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled tokenizer provenance and licenses.

## Install

The newest package release is `0.2.1` on the `latest` channel. Install the single Bundle entry package into a Harness profile:

```sh
dsh plugin --profile web add dsh-context-compression-selector@latest
dsh --profile web --dump-config
```

The selector package declares the Harness Bundle manifest field `dsh.bundle.patch`, so `dsh plugin --profile <name> add <package>` is the standard DeepSeek Harness installation path for an out-of-tree Bundle. Its exact-version runtime dependency, `dsh-context-compression-selector-runtime`, is installed automatically; do not install or wire the two packages separately.

Restart the selected profile after installation. The config dump should list the selector Bundle as active.

To update or remove it:

```sh
dsh plugin --profile web up dsh-context-compression-selector@latest
dsh plugin --profile web remove dsh-context-compression-selector
```

Existing beta users can move to this stable release with the same `up ...@latest` command.

One published artifact serves both Harness generations; there is no separate 0.1.x or 0.2.x package to choose between. Every `@deepseek-ai/dsh-*` peer declares `^0.1.1-rc.2 || ^0.2.0-rc.1`, covering the 0.1 line (`dsh-v0.1.1-rc.2`, `dsh-v0.1.2-alpha.5`) and the 0.2 line including its prereleases. The plugin uses only public Harness extension APIs and does not modify Harness core code.
