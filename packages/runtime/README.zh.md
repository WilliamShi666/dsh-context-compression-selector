# dsh-context-compression-selector-runtime

这是非官方社区 Bundle [`dsh-context-compression-selector`](https://github.com/WilliamShi666/dsh-context-compression-selector) 的内部运行时包。普通用户应安装入口 Bundle，不需要直接安装本包。

本包提供确定性的 Fresh、Aggregate、History、Native 工具结果与 Custom TailTrim 压缩，插件自有的 `context_compression_retrieve` 恢复工具，结构化审计记录，以及固定版本的离线 DeepSeek V4 tokenizer。它只使用 DeepSeek Harness `0.1.1-rc.2` 的公开 API，不修改 Harness 核心。

有损改写要求 replacement 前后取得同 revision 的 exact count。明确验证过的模型 id 为 `deepseek-v4-flash`、`deepseek-v4-pro`；未知模型、资产不可用、不安全工具组或计量不完整时均 fail-open。

审计日志以 `context-compression audit ` 开头，区分策略快照、组件关闭/跳过、已提交 rewrite、fail-open 错误和已观察到的核心 `compaction/summary`。审计记录不包含 prompt 或工具结果正文。

首次 `policy-frozen` 会携带完整 settings/deployment 快照。它通过 Harness logger 输出，因此保留期限由部署的日志 sink 决定；标准 prune/replacement Session event 仍是已提交 rewrite 的持久证据。本包不会在 `~/.dsh` 下硬编码私有路径。

安装、Profile、兼容性、Adaptive/cache 限制与发布证据见[仓库 README](https://github.com/WilliamShi666/dsh-context-compression-selector#readme)。Tokenizer 来源与校验和见 `assets/deepseek-v4/manifest.json` 和 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
