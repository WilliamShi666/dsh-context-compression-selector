# dsh-context-compression-selector

English | [中文](README.zh.md)

An unofficial community Product Bundle for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It adds a Web profile selector and an auditable, model-free tool-context compression runtime without patching Harness core.

## One plugin, two packages

Users install only `dsh-context-compression-selector`. Its exact dependency, `dsh-context-compression-selector-runtime`, contains reducers, recovery, audit records, TailTrim, and the verified offline DeepSeek tokenizer. Keeping the packages separate preserves Host/UI and runtime boundaries; it does not require a second installation command.

| Package | Role | Install directly? |
|---|---|---:|
| `dsh-context-compression-selector` | DSH Bundle, settings UI, preset overlay | yes |
| `dsh-context-compression-selector-runtime` | runtime library/plugin | no; installed automatically |

## Compatibility

| Selector release | Verified Harness | Node.js |
|---|---|---|
| `0.1.0-beta.1` | `dsh-v0.1.1-rc.2` / public packages `0.1.1-rc.2` | `^22.19.0` or `>=24` |

Other Harness versions are not yet claimed compatible. Lossy rewrites currently require the bundled tokenizer to recognize the exact model id: `deepseek-v4-flash` or `deepseek-v4-pro`. Unknown models fail open and keep original context.

## Install

Install the NPM Bundle into a Harness profile (for example, `web`):

```sh
dsh plugin --profile web add dsh-context-compression-selector@beta
dsh --profile web --dump-config
```

The dump should contain a `# == dsh-context-compression-selector` layer. Start or restart that WSL profile through your normal Harness process manager. Do not run a duplicate Harness instance merely to install the plugin.

Upgrade or remove it with the same official plugin command:

```sh
dsh plugin --profile web up dsh-context-compression-selector
dsh plugin --profile web remove dsh-context-compression-selector
```

The Bundle decorates every preset except the exact built-in `minimal` id. Switching among non-Minimal presets preserves the saved compression settings. Minimal pauses plugin compression but does not delete those settings; leaving Minimal restores their availability.

## Profiles and defaults

The UI provides `off`, `native`, `balanced`, `cache-strict`, `savings`, `adaptive`, and `custom`. The Custom token defaults are:

- Fresh `8192 -> 3072`
- Aggregate `32768 -> 12288`
- History trigger `500000`, keep 4 turns / `128000` tokens, minimum reclaim `96000`
- `prefixPolicy=pressure-break`
- TailTrim disabled, trigger `700000`

Each Session freezes the complete settings document when this mounted runtime first observes it. Later setting changes affect subsequently observed Sessions, not the already-frozen Session. A runtime remount or Host restart creates a new in-process freeze lifetime.

## Runtime evidence

Harness logs contain content-free lines prefixed with `context-compression audit `. The JSON record after the prefix distinguishes:

- `policy-frozen` and `policy-resolved`;
- `component-evaluation` for disabled/skipped components and the reason/threshold;
- `rewrite` only after a standard `compaction/prune` and its replacement commit, including component, stage, reducer, exact token before/after values, tokenizer identity, and Session event seqs;
- `failure` for fail-open runtime errors;
- `native-auto-compact` only after the core emits `compaction/summary`.

Fresh, Aggregate, History, TailTrim, plugin Native pruning, and core Native auto-compact are therefore not conflated. Logs never include prompt text, tool arguments, tool-result content, or credentials.

`policy-frozen` contains the complete selector settings and resolved deployment configuration observed when that Session first reaches the runtime. It is a Harness logger record, not a custom Session event: retention therefore follows the operator's Harness log sink. Keep those logs when a durable audit trail is required. Committed context changes remain independently durable as official `compaction/prune` plus replacement events in the Session log. Harness `0.1.1-rc.2` exposes no stable plugin-owned data-directory API, so this release does not invent or hard-code a path below `~/.dsh`.

TailTrim is Custom-only and default-off. It replaces at most one complete, finished, non-error tool-only group with a recoverable reference using only official `compaction/prune` plus `user/message` replacement events. The original append-only events remain available through the plugin-owned `context_compression_retrieve` tool.

## Usage, Adaptive, and cache limits

The runtime uses public `Session` request headers/context and official `TokenMeter.measure()`. Request-level usage is authoritative only when the official baseline reports usage. The public `0.1.1-rc.2` surface does not expose enough route-keyed cache-split telemetry for the plugin to prove ordinary Adaptive History savings, so that cost gate fails closed; confirmed capacity pressure remains an independent safety override. The checked-in price catalog is manually maintained and is an estimate, not per-tool-result cost attribution.

Fork subagents inherit the parent's Session prefix through native Harness behavior; spawn subagents do not. The project verifies identical serialized fork prefixes, but implements no provider-specific prefix id, breakpoint, TTL, or cross-Session cache API. DeepSeek may naturally reuse an identical serialized prefix. A cache hit is claimed only when official response usage supplies consistent request-level cache hit/miss fields; it cannot identify which tool result hit cache.

## Development and verification

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
pnpm verify:release
pnpm pack:dry-run
```

Release verification also installs the two real tarballs into an unmodified official Harness `dsh-v0.1.1-rc.2` checkout. Workspace-source tests are not treated as packed-install proof.

## Security and license

Report vulnerabilities according to [SECURITY.md](SECURITY.md). This project is MIT licensed and is not affiliated with or endorsed by DeepSeek. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for DeepSeek Harness-derived code and the bundled official tokenizer provenance.
