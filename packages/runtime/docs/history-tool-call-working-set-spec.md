# History / microcompact：按 agent 工具调用保护近期工作集

状态：提案，尚未实现

## 目标与边界

将插件的 History / microcompact 从“保护最近若干个 Harness turn 加一个 token 尾窗”改为“超过该 Profile 的 History 触发阈值后，保护最近 10 次已完成的 agent 工具调用”。这是一项面向所有插件 Profile 的策略变更，不是只为 Balanced 调整。

所有实现只修改本仓库的 runtime、selector UI、配置、审计、测试和 npm Bundle。不得修改 DeepSeek Harness 核心、会话事件格式、内置压缩器、provider 或 DSH UI。插件继续只消费现有公开的 `tool/call`、`tool/result` 和 Session surface API。

此前发现的 `deepseek-official` tokenizer route alias 是独立的插件内兼容性修复：需回填到本仓库的 `measurement.ts` 并测试，但不属于本 History 策略改动。

## 现有问题

当前 History 用外层 `turn` 保护近期内容。一个 turn 通常是一次用户消息驱动的 agent 处理周期，不是一次工具调用：一次“探索代码库”的用户请求可以在同一 turn 内产生几十个 Bash、Read、Grep 或 Web 调用。这样它们会被整体保护，即使其中大部分已经很旧；反过来，连续输入几条没有工具输出的用户消息也会推进保护窗口。

用户消息不是 History 的可替换对象，保护它们的外层 turn 对 History 没有实际约束意义。现有的 `historyKeepRecentTokens` 也会让“近期保护”取决于个别结果的大小，而不是 agent 最近实际使用过的工具交互数量。

## 统一语义

### 触发条件不变

每个 Profile 仍使用自己的 History gate、`historyTriggerTokens` 和 `historyMinReclaimTokens`。当且仅当：

1. 运行到了插件的 `pressure` 阶段；
2. Profile 的 History gate 允许执行；
3. 所有活动工具结果的精确 token 总数严格大于该 Profile 的 `historyTriggerTokens`；

History 才会规划 microcompact。Fresh、Aggregate、Native 和 TailTrim 的各自 trigger/reducer 不因这条规则而变。

### 两部分近期工作集

一条可计数记录是一个仍在活动 surface 中、能按 `callId` 与 agent 发出的 `tool/call` 配对的 `tool/result`。计数顺序使用该调用在活动会话 surface 中的原始发生顺序，不能使用外层 turn，也不能使用之后压缩替换事件的 seq。

- 精确保护最新 10 条已完成调用；不足 10 条时全部保护。
- 用户消息、assistant 文本、`turn/start`、`turn/end`、`step/start`、`step/end` 都不计数，也不因它们的数量改变选择结果。
- 尚未产生 `tool/result` 的未完成调用不占槽位，也不是压缩候选。
- `context_compression_retrieve` 也算一次 agent 工具调用并占一个槽位，以保证“最后十次调用完全不动”的字面语义；但它本身继续永远不可被 History 重写。
- 已经是 History 占位符的结果继续占槽位，但不能再次被 History 重写。

在调用数量保护之外，保留一个 `64000` token 的工具结果尾窗。从最新活动 `tool/result` 向较早结果逐条累计精确 token；每一条先加入保护集、再判断累计值是否已达到或超过 `64000`。因此，刚好使累计值跨过 `64000` 的那一条也受保护。这个尾窗同样不包含用户消息或 assistant 文本。

最终保护集是“最近 10 次调用保护集”和“最近 `64000` token 工具结果尾窗”的并集。排除它后，History 由旧到新选择安全结果，沿用现有可恢复占位符/富结果 reducer。达到 `max(historyMinReclaimTokens, totalTokens - historyTriggerTokens)` 后停止；若最终无法达到最小回收量，则整个 History 批次不提交。精确 tokenizer 不可用、结果形态不安全或 recovery tool 缺失时继续 fail-open。

删除 `historyKeepRecentTurns`，保留并将标准 Profile 的 `historyKeepRecentTokens` 统一为 `64000`。近期工作集因此同时保证最近工具交互数量和最近工具结果的内容规模。

## 各 Profile 的计划与初始参数

首版只替换“保护集的计算方法”，保留现有各 Profile 的触发和回收数值。这样可以先验证工作集语义，而不把“何时触发”“保留什么”“一次回收多少”三个变量同时改变。下表中的“建议首版”是待实现值；“后续调参”只有在带真实工具输出的可重复测试证明需要时才进行。

| Profile | 当前/建议 History gate | 首版 trigger / 最小回收 | 近期保护 | 后续调参方向 |
| --- | --- | --- | --- | --- |
| `off` | disabled | 不触发 | 10 次调用 + `64000` token；无运行效果 | 无；保持关闭。 |
| `native` | disabled | 不触发；Native 头-中-尾裁剪仍独立 | 10 次调用 + `64000` token；无运行效果 | 无；不得把 History 偷偷加入 Native。 |
| `balanced` | `routine` | `500000 / 96000` tokens，保持不变 | 最近 10 次调用 + `64000` token 尾窗 | 作为基线。若保护集导致频繁无法达到 96k 回收，再只评估提高 trigger 或降低 min-reclaim 之一。 |
| `cache-strict` | `capacity-pressure` | `600000 / 128000` tokens，保持不变；路由上下文利用率至少 `70%` | 最近 10 次调用 + `64000` token 尾窗 | 不降低 trigger；它以稳定已发送前缀为优先。只在已确认容量压力时改写。 |
| `savings` | `routine` | `400000 / 128000` tokens | 最近 10 次调用 + `64000` token 尾窗 | 将 trigger 从 `450000` 提前到 `400000`，以更早回收旧工具结果；首版保留 `128000` 最小回收量，避免用一次很小的前缀改写交换缓存损失。 |
| `adaptive` | `adaptive`，容量压力可覆盖 | `500000 / 96000` tokens，保持不变 | 最近 10 次调用 + `64000` token 尾窗 | 先让现有成本判断评估新的候选批次；没有连续官方 usage/价格证据时不调低门槛。 |
| `custom` | `enabled + prefixPolicy` 决定 routine 或 capacity-pressure | 保留用户的 trigger/min-reclaim | 默认 10 次调用 + `64000` token 尾窗 | Custom v3 允许用户显式改两个保护值；默认/重置值为 10 与 `64000`。 |

TailTrim 不属于 History / microcompact，但它目前复用 History 的近期保护 helper。为避免同一 helper 同时拥有两套语义，TailTrim 也使用同一个“最近 N 次工具调用 + token 尾窗”保护集；它的独立 trigger、完整工具组条件和 reducer 不变。

## 参数与配置改动

近期保护参数为：

```ts
historyKeepRecentToolCalls: number
historyKeepRecentTokens: number
```

前者是非负安全整数；标准 Profile 都解析为 `10`，它不是 token 数，不受 `tokens` / `context-percent` 单位切换影响。后者保留现有 token 尾窗语义，标准 Profile 都解析为 `64000`。即使 `off`、`native` 的 History 被禁用，解析后的策略结构仍完整一致。

Custom 升为版本 3：

```ts
history: {
  enabled: boolean
  trigger: number
  keepRecentToolCalls: number
  keepRecentTokens: number
  minReclaim: number
}
```

Custom 编辑器显示“保护近期工具调用数”和“保护近期工具结果尾窗”，默认值分别为 10 与 `64000`。保留 Custom 的可编辑性：标准 Profile 固定这些默认值，只有明确选择 Custom 的用户可以改变它们。若产品决定“Custom 也必须固定为这些值”，可在实现前删去两个输入框；其余算法不受影响。

已有 Custom v1/v2 设置继续可读：插件将它们规范化为 v3，将 `keepRecentToolCalls` 设为 10，并将用户原有的 `keepRecent` 原样迁移为 `keepRecentTokens`。下一次用户保存 Custom 时写回 v3。部署配置中使用已删除的 `historyKeepRecentTurns` 则在插件加载时明确报错，提示改用 `historyKeepRecentToolCalls`；`historyKeepRecentTokens` 继续受支持。

## 审计与可观测性

`policy-frozen` 和 `policy-resolved` 记录新字段。History rewrite 仍记录 `component: "history"`、`stage: "pressure"`、History mode、reducer、精确 token 前后值和回收量。

为解释选择器结果，History 审计增加有限元数据：配置的保护调用数、尾窗 token 预算、活动已完成调用总数、实际受保护结果数。不得记录工具文本、工具参数、用户消息、call id 或 prompt。无需新增 DSH Session event 或修改 DSH 核心审计 schema。

## 验证计划

每个 History-enabled Profile 至少覆盖一次独立测试；不得只用 Balanced 证明实现。

1. 一个用户 turn 内连续完成至少 16 次调用并越过 trigger：最近 10 次总计约 `30000` token，继续向前累计到 `64000` token 的第 11 至第 15 次也不变；第 16 次（从最新向旧数）成为可选候选。
2. 将同一批调用切分到任意多个用户 turn：受保护和可压缩集合完全相同；只添加用户消息的 turn 不改变结果。
3. 包含并行调用、错误结果、富结果、已替换占位符和 `context_compression_retrieve`，验证计数顺序与不可重写规则。
4. `off` 和 `native` 即使工具输出很大也不执行 History；Native 仍按自己的逻辑运行。
5. Balanced、Savings 的 routine gate 在各自 trigger 之上执行；Cache Strict 只有确认容量压力时执行；Adaptive 在成本证据不足时跳过、容量压力时仍可执行；Custom 同时覆盖 routine 与 capacity-pressure。
6. 十条或更少调用、未达到 `64000` token 尾窗但所有调用都仍在尾窗内、精确 tokenizer 不可用、无安全候选或达不到最小回收量时，History 只留下可解释的跳过审计，不产生部分重写。
7. Custom v1/v2 规范化、v3 校验、浏览器输入、中文/英文文案、运行时公共测试、packed smoke、构建和 clean-install 发布验证均使用新字段。

## 风险与取舍

最近十条结果或 `64000` token 尾窗可能很大，导致旧结果不足以回收最小 token 数；此时跳过是对工作集保证的正确结果，而不是压缩器失效。Savings 的更激进候选参数必须先用同一任务的 token、缓存和结果可用性数据验证。

这会改变旧 Custom 文档的实际保留行为。将其统一为 10 次调用是可预测的迁移，但不等价于任何旧 turn/token 数。发布说明必须明确指出 Custom v3 和该语义变化。
