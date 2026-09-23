# DeepSeek-V4.1-Flash 支持 — 发布就绪清单（t6 集成收口）

> 锚点：交付为工作树，基线 HEAD `08e3db2`，首个提交即本清单所述提交。
> 版本：**0.1.1**。撰写时刻：2026-09-23。

## 1. 结论

**可以发布。** 全部门禁绿、两路复审通过、端到端验证通过，唯一未执行的两个动作（`npm publish` / `git push`）等待用户授权。

## 2. 全门实测结果（captain 第一手，非转述）

| # | 命令 | 结果 |
| --- | --- | --- |
| 1 | `pnpm typecheck` | exit 0 |
| 2 | `npx vitest run` | **515 passed \| 1 skipped (516)**，22 test files |
| 3 | `pnpm build` | exit 0 |
| 4 | `pnpm test:built` | 1 passed |
| 5 | `pnpm verify:release` | `release verification: OK` |
| 6 | `pnpm test:e2e:packed` | **exit 0**（在默认路由 `deepseek-flash` 下） |

> 环境注记：本机 `~/.npm` 存在 root 属主残留，所有 npm/pnpm 命令须带 `npm_config_cache=/tmp/npmcache`，否则首次 EPERM。此为环境问题，非代码缺陷。

## 3. 核心行为已被决定性对照证明

t5 未重跑单元测试，而是把**发布门产出的真实 tarball** 装入自建 consumer，用**真实 DSH 路由名 `deepseek-official`** 驱动 `deepseek-flash`：

| 观察项 | 改动后 | 改动前（npm 已发布 `0.1.0` ≡ HEAD） |
| --- | --- | --- |
| surface kind | `exact-tokenizer` | `unavailable` |
| tokenizerId | `deepseek-ai/DeepSeek-V4.1-Flash` @ `dba1be0a…` | — |
| **rewriteCount** | **4**（带递减精确 token 证据） | **0** |
| **failOpen** | **false** | **true** |
| 4 个组件 | 正常改写 | 全 `exact-tokenizer-unavailable` |

即「插件在 Harness 默认模型上不再空转」已实测证明。另：`deepseek-v4-pro` 前后逐字段一致（surface 5213 tokens、同一 artifact、同 4 组件改写），价格 tuple 与 `modelVersion` 逐字符不变；`deepseek-flash` 价格 `unpriced` → `priced`；含图候选改写 0 次、原事件完好；31/31 golden 逐格一致（800×600 → 317 / 1024）；未知 id 仍 fail-closed，资产篡改 3 条抛错路径 + 路由 fail-closed 且 V4-Pro 不受连带影响。

## 4. 版本号：0.1.0 → 0.1.1

**依据：公开 API 无破坏性变更。** 用 `git archive HEAD` 提取基线源码逐条比对，公开导出语句与基线**完全一致**（`IDENTICAL export statements`）；无任何 tokenizer / artifact 符号进入公开 API；运行时公开导出数 22（与基线相同，`countSurfaceCounts` 以 `@internal` 导出且未进 `index.ts`）。

**成对升级（必须一致，否则 `verify:release` 直接 fail）**：
- `package.json`、`packages/runtime/package.json`、`packages/selector/package.json` 的 `version` → `0.1.1`
- `packages/selector/package.json` 的 `dsh-context-compression-selector-runtime` 依赖 → `0.1.1`
- `pnpm-lock.yaml` 已随之更新（`pnpm install --no-frozen-lockfile`）

## 5. 提交范围

**应提交**：
- 30 个已修改的 tracked 文件（`packages/runtime/src|tests|assets`、`scripts/`、三处 README、`CHANGELOG.md`、`.gitignore`、三个 `package.json`、`pnpm-lock.yaml`）
- 本次新增：`packages/runtime/tests/measurement-identity.spec.ts`、`packages/runtime/tests/fixtures/{PROVENANCE.md,vision-official-sweep.json}`
- 流程产物：`docs/plans/2026-09-23-gitnexus-plan-v41-flash-support.md`、`docs/specs/2026-09-23-deepseek-v4.1-flash-support-spec.md`、`docs/reviews/` 下 6 份文档

**必须排除**（非本次改动，属既存未跟踪文件）：
- `.agent-teams/`（已加入 `.gitignore`，团队运行时状态）
- `.claude/`（26 个）、`AGENTS.md`、`CLAUDE.md`
- `docs/zcode-v2|v3|v4-review-remediation.zh.md`、`docs/deepseek-v4-vision-auto-compact-plan.zh.md`、`docs/plans/2026-09-02-*`、`docs/plans/2026-09-03-*`、`docs/assets/`
- `cleanup*.log`（另一会话的磁盘清理残留）

## 6. 本轮新增的三项修正（captain，均针对本次变更引入的不一致）

| # | 问题 | 处置 |
| --- | --- | --- |
| O-1 | 客户端 `pricing.disclosure` 仍写 `2026-08-25`，而 runtime 价格目录已升至 `2026-09-23`（相差 29 天，用户可见）；且 `profiles.client.spec.tsx` 把旧日期硬编码为正则期望，故被**锁定**而非检出 | 已改 `locales.ts`（EN/ZH）与测试正则为 `2026-09-23` |
| O-3 | 发布门 `packed-components-smoke.mjs` 用旧别名 `deepseek-v4-flash`，全仓对**默认 id** `deepseek-flash` 计数为 0 —— 即发布门**不覆盖本次修复的主体路由**，回归时仍会绿 | 已将 `MODEL` 改为 `'deepseek-flash'`，并在**该路由下重跑 packed E2E 取得 exit 0** |
| R1/R2/R3 | spec 声称 R2.8 偏离记录于 `PROVENANCE.md` 但实际不存在；R5.8a 自称「机检」而全仓无 README 表格机检；`absorb()` 侧同源守卫证据边界未标注 | 已补 PROVENANCE 偏离段、改为「人工核对」、在 spec R4.14 标注证据边界 |

## 7. 已知 caveat 与残余观察

- **审查快照 caveat（已按计划处理）**：r1/r2 复审均针对**未提交工作树**，其文件哈希仅对该快照有效。本提交完成后需按提交后 revision 复跑确认——已列入收尾步骤。
- **O-2（改动前既存，非本变更引入）**：`lastCompletedUsage` / `latestEnvelopeKey` 全仓无赋值点，adaptive 端到端 `usage` 链路不可达（实测止于 `usage-unavailable`）。故「adaptive cost 不再返回 `adaptive-unknown-price`」改为**直接调用已发布 bundle 的价格/判定函数**证明（`unpriced:"unknown model id"` → `priced` + 真实成本比较）。该端到端路径被更早的 `usage-unavailable` 遮蔽，不可观测。**不阻塞本次发布。**
- **独立验证陷阱（记录以免后人踩坑）**：用 tarball 独立验证时，若被测包有**同版本精确依赖**，pnpm 会从 registry 解析该依赖而非本地 tarball，导致**静默测到 registry 上的旧版本**——必须用 `pnpm-workspace.yaml` override 强制指向本地 tarball。t5 首次即踩到，一度误判为真实缺陷。

## 8. 待授权动作（captain 不会自行执行）

| 动作 | 说明 | 状态 |
| --- | --- | --- |
| 本地提交 + tag | 见第 5 节范围 | 已获用户授权，本清单同批执行 |
| `npm publish` | 发布 `dsh-context-compression-selector-runtime@0.1.1` 与 `dsh-context-compression-selector@0.1.1` | **已获用户授权** |
| `git push` | 推送提交与 tag 到 `origin`（`codex/beta-0.1.0-beta.3`） | **待授权** |

npm 认证已确认可用：`/-/whoami` 200、`npm owner ls dsh-context-compression-selector` 返回 `williamshi666 <zwshi20@outlook.com>`。

## 9. 收尾步骤

1. 提交 + 打 tag `v0.1.1`
2. **提交后复跑** 5 门 + `packed E2E`，关闭第 7 节的审查快照 caveat
3. 运行 GitNexus `detect_changes --scope all`，确认非 `partial` / `truncated`
4. `npm publish`（runtime 与 selector，顺序：runtime 先）
5. 待用户授权后 `git push`
