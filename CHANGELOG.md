# Changelog

All notable changes use this file. The project follows semantic versioning after `0.1.0`.

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
