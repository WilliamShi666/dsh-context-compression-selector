# DeepSeek-V4.1-Flash 支持 —— Spec Review 复审（t11 / r2）

> **复审对象**：`t10`（repair-round-2）对 `t4` 的 F1–F11 的闭合
> **判定基准**：`docs/specs/2026-09-23-deepseek-v4.1-flash-support-spec.md`（含 captain 新增的 R2.8 裁定段与附录 C 的 A2 处置行）＋ `docs/plans/2026-09-23-gitnexus-plan-v41-flash-support.md`
> **前轮文档**：`docs/reviews/2026-09-23-v41-flash-spec-review.md`（r1，保留可追溯）
> **工作树**：HEAD `08e3db2`，交付为未提交工作树
> **复审者**：spec-reviewer（t11，attempt 1）

---

## 0. 结论（Verdict）

**verdict = `pass`**

t4 的 **11 条 findings 全部实质闭合**。核心行为契约（① 模型映射 / ② 视觉算术 / ③ 定价 / ④ fail-closed / ⑥ V4-Pro 冻结）在 r1 已被独立复现确认交付；本轮修复未引入任何行为回归，且 r1 中唯一一条 medium 级「安全不变量无测试证据」（F1）现已具备**经变异测试证明的**绊线。

另有 **3 条 low 级残余观察**（见 §3），均**不阻塞本 verdict**：它们不影响任何行为、映射或价格，其中 1 条是 captain 新增 spec 文本中的一句事实性失准（声称的 PROVENANCE 记录不存在），建议在最终提交前顺手修正。

---

## 1. F1–F11 逐条闭合判定

| # | r1 severity | 判定 | 证据（本轮核对当前工作树） |
| --- | --- | --- | --- |
| **F1** | medium | ✅ **闭合** | 新增 `packages/runtime/tests/measurement-identity.spec.ts`（4 例全绿）。R4.14 的操作范围是「同一**测量**内」，对应 `countSurfaceCounts` 的聚合守卫，已直达覆盖。**我以变异测试独立验证**：置空 `measurement.ts:381`（tokenizer）或 `:390`（image-estimator）→ 测试转红（`1 failed \| 514 passed`）；恢复后 `diff -q` 干净。**API 未扩大**：`countSurfaceCounts` 以 `@internal` 导出，`index.ts` 引用数 0，`lib/index.d.ts` 无声明，`lib/index.js` 公开导出数仍 **22**（实测）。 |
| **F2** | low | ✅ **闭合** | `deepseek-official-pricing.spec.ts:335` `flips the adaptive decision when the alias is billed at the Flash price`。费率经 `rates()` 辅助函数从 `resolveOfficialDeepSeekPrice` **实际解析**取得（`:336-353`），非硬编码；`:367` 断言 Flash 价下 `allowHistory: false` + `reason: 'cache-risk-not-clearly-paid-back'`，并保留旧价对照（`'0.007'`/`'0.22'` → allow）。 |
| **F3** | low | ✅ **闭合** | `deepseek-official-pricing.spec.ts:301` 断言 `modelVersion: 'DeepSeek-V4-Pro-0813'`，且该用例同时断言 V4-Pro 四组三元组未被 Flash 价覆盖。 |
| **F4** | low | ✅ **闭合**（captain 裁定） | 裁定为**不补**该不可达断言，并按要求同步文本：spec `:216-222` 新增「captain 裁定（对 R2.8 的有意偏离）」段；`deepseek-v4-vision-tokens.ts:263-274` 记录于 `safeResize` 文档注释。**是否满足「同步 spec 文本」：满足**（详见 §2.1）。裁定理由可复核：V4.1 下 `max_n_token` 恒 1024 + 单次闭式求解 ⇒ 断言不可达；我 r1 的 423,200 组扫描与执行者的 646,000 组扫描均 0 违例。 |
| **F5** | low | ✅ **闭合** | `public-runtime.spec.ts:2623` 断言 `'canonical image: provider "openai" is not the supported DeepSeek route'`；`:2627` 断言 `intrinsicImageBlockEstimateTokens === 0`；新增 `:2632+` 用例断言 R4.8 两条模板（`:2653` text、`:2658` image），并以 `view.countCanonicalText` 钉住精确字符串（`:2663`）。 |
| **F6** | low | ✅ **闭合** | `deepseek-v4-tokenizer.spec.ts` 已拆为四个逐字命名用例：`:129` byte-length、`:137` SHA-256、`:145` intact、`:149` keeps V4-Pro serving，与 spec R5.0 的 R-11/R-12/R-13/R-15 **逐字一致**；R-14（JSON）独立于 `:154`。 |
| **F7** | medium | ✅ **闭合** | `README.zh.md:50-58` 已改为三列表（模型路由 \| 服务模型 \| 选择器压缩），含 `deepseek-flash` 行；`deepseek-v4-pro` 正确标为 `DeepSeek-V4-Pro`。与 `README.md:50-56` 集合一致（4 个受支持 id）。 |
| **F8** | medium | ✅ **闭合** | `packages/runtime/README.md:7` 与 `README.zh.md:7` 已改为**逐 id 显式映射**（「`deepseek-flash`, `deepseek-v4-flash`, and `deepseek-v4-flash-vision-exp` are served by DeepSeek-V4.1-Flash; `deepseek-v4-pro` keeps its own DeepSeek-V4-Pro tokenizer」），序数/位置式表述已消除（全仓 grep `前三\|first three\|the last` 在四份 README 中 0 命中）。 |
| **F9** | medium | ✅ **闭合** | spec 附录 C `:855` 新增「计划 §12 A2」行（详见 §2.2）；`CHANGELOG.md:17` 有等价条目。**未越界**：我核对 `PRICES` 与 `DEEPSEEK_V41_FLASH_TOKENIZER_ARTIFACT.modelIds` 在本轮**未被改动**（见 §2.2）。 |
| **F10** | low | ✅ **闭合** | `measurement.ts` 中 `residue`/`compress-pad`/`alignment-padding extremes`/`absolute prompt position`/`midpoint` **全部 0 命中**。`:61-70` 与 `:168` 已改写为 V4.1 语义（位置无关块长度、`paddingMinimumTokens === paddingMaximumTokens`、不精确性仅源于 adapter 不可观测投影）。`build` 已重跑（本轮 exit 0）。 |
| **F11** | low | ✅ **闭合** | `PROVENANCE.md:83` 与 `:87` 均为 **162**，并注明构成「42 boundary sizes + 120 seeded random sizes, `SWEEP_SEED = 7`」；`162/162 identical, maximum 1017 (≤ 1024)` 与 fixture 实测一致。 |

**汇总：11/11 闭合。**

---

## 2. captain 两处新增的独立核对（本轮重点）

### 2.1 spec R2.8 裁定段 —— ✅ 足以让后续 reviewer 判定为「有意偏离」

`docs/specs/2026-09-23-deepseek-v4.1-flash-support-spec.md:216-222` 的文本具备三个关键要素，我认为**充分**：

1. **显式定性**：标题即「captain 裁定（**对 R2.8 的有意偏离**）」，正文再述「属对 R2.8 的**有意偏离**」——读者不会误判为遗漏。
2. **可复核的理由**：三条编号理由，含参数域论证（`max_n_token` 恒 1024 + 单次闭式求解 ⇒ 不可达）与量化证据（646,000 组扫描、0 违例、最坏恰 1024）。
3. **作用域收口**：末句「本裁定**不免除 R2.8 的其余义务**（单次求解、无循环）」——明确偏离是点状的，不是整条规则的豁免。

**是否满足 captain 自设的「同步 spec 文本」要求：满足。** 裁定已写入 spec 正文（而非仅存在于 task output），且 `vision-tokens.ts:263-274` 有对应的源码级记录，含「Re-check this if `visionMaxNTokens` is ever set to a value the solver was not designed for」的前瞻条件——这一点尤其好，它给出了该偏离失效的触发条件。

**唯一瑕疵**：`:222` 声称该偏离「已同步记录于 … 以及 `packages/runtime/tests/fixtures/PROVENANCE.md`」，但 **PROVENANCE.md 中不存在该记录**（详见 §3 的 R1）。

### 2.2 spec 附录 C 的 A2 处置行 —— ✅ 三要素齐备，且未越界

`docs/specs/2026-09-23-deepseek-v4.1-flash-support-spec.md:855` 逐项核对：

| 要求 | 是否覆盖 | 原文对应 |
| --- | --- | --- |
| (a) 当前仍路由并计费 | ✅ | 「(a) 两个旧名 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 当前**仍路由 V4.1-Flash 并按其计费**（R3.2）」 |
| (b) 官方已标 retired 属兼容期 | ✅ | 「(b) 官方定价页脚注 (1) 已将其模型标注为 **retired**，故该路由属**兼容期行为**」 |
| (c) 撤回时须重评映射与定价 | ✅ | 「(c) 官方**撤回**这些别名时，必须**一并重评** ①.1 模型映射与 ③ 别名计费行——两者是独立契约但同源于同一次官方撤回」 |
| 不改变任何映射或价格 | ✅ | 行首明示「**记录为假设（不改变任何映射或价格）**」 |

**越界检查（我实测，非引用）**：本轮修复**未**触碰任何映射或价格——
- `deepseek-v4-tokenizer.ts:38` 仍为 `['deepseek-v4-pro']`，`:59` 仍为 `['deepseek-flash','deepseek-v4-flash','deepseek-v4-flash-vision-exp']`；
- `deepseek-official-pricing.ts` 中 `V41_FLASH_PRICES` = `DeepSeek-V4.1-Flash` / `0.003,0.15,0.6` / `0.006,0.3,1.2` / `0.02,1,4` / `0.04,2,8`，`deepseek-v4-pro` 仍为 `DeepSeek-V4-Pro-0813` + `0.022/0.66/1.98` 等四组；
- V4-Pro 三个冻结资产 `git diff --stat` **输出为空**；资产哈希复测全部匹配（`8f9f37ca…/6367146`、`6ac8c8dc…/801`、`1c8f573e…/1064`、`c90dfa01…/6367257`、`f2c6c602…/1084`）。

另注：captain 在附录 C 还顺带处置了 `t12`（R5.8 序数指代歧义，`:854`），新增 R5.8a/R5.8b/R5.8c（`:654-664`）。R5.8b「显式禁止把 V4-Pro 标为由 V4.1-Flash 服务」正确固化了我 r1 §5.1 提出的 spec 自身矛盾处置——**该处置方向正确**。

---

## 3. 残余观察（low，**不阻塞本 verdict**）

以下三条是**本轮修复新引入或新暴露**的 low 级问题，均不影响任何行为、映射或价格，故不构成 `needs_revision`。建议在最终提交前顺手修正 R1（一句话）。

### R1 — spec 声称的 PROVENANCE 记录不存在（事实性失准）

- **id**: R1
- **severity**: `low`
- **file:line**: `docs/specs/2026-09-23-deepseek-v4.1-flash-support-spec.md:222`
- **problem**: 该行声称 R2.8 偏离「已同步记录于 … `packages/runtime/tests/fixtures/PROVENANCE.md`」。实测该文件中 `R2.8` / `deviat` / `assert` 三个词的命中仅 2 处，且均无关（`:27` "cross-asserted against"、`:88` "re-asserts the fixture-backed subset"）；全文 110 行无任何 R2.8 偏离记录。spec 是「唯一判定基准」，其中一句关于自身证据链的陈述不成立，会让后续 reviewer 按图索骥而扑空——这正是 R5.8 想防的「文档声称 X、实际 Y」。**注**：该句是 captain 新增裁定段的一部分，非 t2 产物。
- **requiredFix**: 二选一（推荐前者，成本最低）——在 `PROVENANCE.md` 的「One port detail」节后补一段记录 R2.8 偏离（不可达论证 + 646,000 组扫描 + 「`visionMaxNTokens` 变更时须重检」），使 spec 的声称成立；或删去 `:222` 中「以及 `packages/runtime/tests/fixtures/PROVENANCE.md`」字样，只保留 `vision-tokens.ts` 这一处已核实存在的记录。

### R2 — `countCanonicalContent.absorb()` 的两处同源守卫仍无测试证据

- **id**: R2
- **severity**: `low`
- **file:line**: `packages/runtime/src/measurement.ts:193`（tokenizer）、`:203`（image-estimator）
- **problem**: r1 的 F1 点名了**两条** reason 字符串所在的两处守卫；本轮修复覆盖了 `countSurfaceCounts` 侧（`:381`、`:390`），但 `countCanonicalContent.absorb()` 侧（`:193`、`:203`）仍未被任何测试驱动。**我以变异测试逐点验证四个守卫位点**：置空 `:193` → `515 passed`（无测试转红）；置空 `:203` → `515 passed`；置空 `:381` → `1 failed`；置空 `:390` → `1 failed`。即 A/B 两位点是**未被覆盖**的。**为何仍判 low**：R4.14 的操作范围是「同一**测量**内」，其对应守卫是 surface 聚合侧（`:390`），该侧现已覆盖且经变异证明；A/B 属更窄的「同一 content walk」范围，且**经构造不可达**——`countImage` 恒返回模块常量 `DEEPSEEK_VISION_IMAGE_ESTIMATOR`（`:316-320`），`countText` 恒来自单一 tokenizer 实例，故单次 walk 内不可能出现两个身份。行为无缺陷，仅证据面不完整。
- **requiredFix**: 与 F1 同法处理——按仓库既有 `@internal` 模式导出 `countCanonicalContent`（或抽出 `absorb` 的身份判定为可测函数），在 `measurement-identity.spec.ts` 补两条直驱用例（tokenizer 身份变更 / estimator 身份变更）；`index.ts` 不得新增引用以保持公开导出数 22。若 captain 认为「不可达 + 已有 surface 侧覆盖」足以结案，请在 spec R4.14 段注明该判定范围（同 R2.8 裁定的处理方式），使证据边界显式化。

### R3 — R5.8a 自称「判定式（机检）」但无对应机检

- **id**: R3
- **severity**: `low`
- **file:line**: `docs/specs/2026-09-23-deepseek-v4.1-flash-support-spec.md:654`
- **problem**: R5.8a 末句写明「判定式（机检）：该行中「由 `DeepSeek-V4.1-Flash` 服务」的主语必须是恰好这 3 个 id，且不含 `deepseek-v4-pro`」，但全仓无任何测试或 `verify-release.mjs` 检查 README 表格（实测 `packages/runtime/tests/**` 与 `scripts/verify-release.mjs` 中 README 相关命中为 0）。当前 README 内容**正确**（我已逐行核对 `README.md:50-56` 与 `README.zh.md:50-58`），故无行为缺陷；问题是规则自称可机检而实际依赖人工，与 R5.8 的「文案与实现不符属 spec 违背」精神不一致。
- **requiredFix**: 二选一——把「（机检）」改为「（人工核对）」以如实描述；或在 `scripts/verify-release.mjs` 加一条轻量断言：解析 `README.md` / `README.zh.md` 的支持模型表，断言 `DeepSeek-V4.1-Flash` 行集合恰为 3 个 V4.1 id 且不含 `deepseek-v4-pro`、`DeepSeek-V4-Pro` 行恰为 `deepseek-v4-pro`。

---

## 4. 门禁与不变量复核（第一手实测）

| 项 | 结果 |
| --- | --- |
| `pnpm typecheck` | exit **0** |
| `pnpm test` | **515 passed \| 1 skipped (516)** |
| `pnpm build` | exit **0** |
| `pnpm test:built` | **1 passed** |
| `pnpm verify:release` | **OK** |
| V4-Pro 三个冻结资产 `git diff` | **空**（未改动） |
| 六个资产文件字节/SHA-256 | 全部与 spec 冻结值一致 |
| 公开导出面 | `lib/index.js` 导出数 **22**，`countSurfaceCounts` **不在**公开导出中 |
| 变异测试（四守卫位点） | `:381`/`:390` 转红（绊线真实）；`:193`/`:203` 不转红（见 R2） |

> 环境：npm 相关命令带 `npm_config_cache=/tmp/npmcache`（`~/.npm` root 残留）。按要求**未**运行 `pnpm test:e2e:packed`（t5 职责）。
> 变异测试全部在 `/tmp` 备份保护下进行，四次变异后均恢复，最终 `diff -q` 确认 `measurement.ts` 与原始逐字节相同——**工作树未被污染**。

---

## 5. Verdict 自洽性说明

| 判据 | 结果 |
| --- | --- |
| t4 的 11 条 findings 是否闭合？ | **11/11 闭合**（§1） |
| 是否有行为/映射/价格缺陷？ | **无**（§2.2 越界检查实测通过） |
| 是否有 blocker / high / medium 级未闭合项？ | **无** |
| 残余 low 级项是否影响交付？ | 否——R1 是一句文档失准，R2 是两条不可达守卫的证据面，R3 是一句规则措辞；均不改行为 |
| 因此 verdict | **`pass`** |

**给 captain 的收尾建议**：R1 建议在最终提交前修正（在 `PROVENANCE.md` 补一段 R2.8 偏离记录，一句话成本）；R2、R3 可作为已知残余项随提交记录，或在 spec 中以「captain 裁定」方式显式标注证据边界（与 R2.8 的处理方式一致）后结案。

---

**复审者声明**：本复审仅读取仓库，**未修改** `packages/`、`scripts/` 或 `docs/specs/` 下任何文件；本文件是唯一产出，位于 `docs/reviews/`。变异测试的临时改动已全部还原并经 `diff -q` 验证。
