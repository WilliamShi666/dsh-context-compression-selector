# dsh-context-compression-selector-runtime

Internal runtime package for the unofficial community Bundle [`dsh-context-compression-selector`](https://github.com/WilliamShi666/dsh-context-compression-selector). Most users should install the Bundle, not this package directly.

It provides deterministic Fresh, Aggregate, History, Native tool-result, and Custom TailTrim compression; a plugin-owned `context_compression_retrieve` recovery tool; structured audit records; and a pinned offline DeepSeek V4 tokenizer. It uses only public DeepSeek Harness `0.1.1-rc.2` APIs and does not patch Harness core.

Lossy rewrites require exact same-revision counts before and after replacement. Verified model ids are `deepseek-v4-flash` and `deepseek-v4-pro`; unknown models, unavailable assets, unsafe tool groups, and incomplete measurements fail open.

Audit log records use the prefix `context-compression audit ` and distinguish policy snapshots, skipped/disabled components, committed rewrites, fail-open errors, and observed core `compaction/summary` events. No audit record contains prompt or tool-result content.

The first `policy-frozen` record carries the complete settings/deployment snapshot. It is emitted through the Harness logger, so its retention follows the configured log sink; standard prune/replacement Session events remain the durable proof of committed rewrites. This package does not hard-code a private path below `~/.dsh`.

See the [repository README](https://github.com/WilliamShi666/dsh-context-compression-selector#readme) for installation, profiles, compatibility, Adaptive/cache limitations, and release evidence. Tokenizer provenance and checksums are in `assets/deepseek-v4/manifest.json` and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
