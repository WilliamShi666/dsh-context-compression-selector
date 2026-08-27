# 原生工具结果压缩接管规格

## 范围

本规格只约束选择器 Bundle 的工具结果压缩。不得修改 DeepSeek Harness 核心、内置 pruner、会话事件格式或 DSH UI。

## 机制

适用的 Harness preset 在插件的可逆 overlay 中移除 `@deepseek-ai/dsh-compaction-tool-result-pruner`，并以选择器 runtime 的同名 `toolResultPruner` 服务替换它。Harness 的 compaction-basic 继续调用这个公开服务；选择器据冻结的 Profile 决定允许哪一种 reducer。因此同一 Session 不会同时运行核心头尾裁剪和选择器 reducer。

## Profile 规则

| Profile | 选择器原生风格头—中间—尾 reducer | 其他选择器路径 |
| --- | --- | --- |
| `native` | 允许 | Fresh、Aggregate、History、TailTrim 均关闭 |
| `balanced` | 禁止 | 按 Balanced policy 运行 |
| `cache-strict` | 禁止 | 按 Cache Strict policy 运行 |
| `savings` | 禁止 | 按 Savings policy 运行 |
| `adaptive` | 禁止 | 按 Adaptive policy 运行 |
| `custom` | 禁止 | 只运行 Custom 明确启用的路径 |
| `off` | 禁止 | 不运行选择器工具结果压缩 |

这里的“禁止”同时排除两条路径：overlay 已移除核心 `@deepseek-ai/dsh-compaction-tool-result-pruner`，解析后的 `nativeToolResultEnabled` 也为 `false`。因此不会生成 `component: "native-tool-result"` 的选择器 rewrite。`native-auto-compact` 是 Harness/模型独立机制，不受本规格控制。

## 会话冻结

选择器首次观察 Session 时冻结 Profile 与 Custom 文档。之后修改全局设置只能影响新 Session，不能让已经采用 Balanced、Savings、Cache Strict、Adaptive 或 Custom 的 Session 在中途重新启用头—中间—尾裁剪。

## 验收

1. `resolvePolicy()` 对 `balanced`、`cache-strict`、`savings`、`adaptive`、`custom` 返回 `nativeToolResultEnabled: false`，对 `native` 返回 `true`。
2. 插件 runtime 的 pressure pass 仅在 `nativeToolResultEnabled` 为 `true` 时计划 `native-tool-result` rewrite。
3. preset overlay 测试证明生成 composition 中没有核心 pruner，只有选择器 runtime 的同名服务。
4. 所有源代码改动限定在本仓库；不修改 Harness worktree。
