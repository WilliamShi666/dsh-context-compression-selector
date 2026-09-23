# DeepSeek-V4.1-Flash 支持 —— 端到端验证报告（t5）

> **验证对象**：工作区未提交变更（基线 `08e3db27fa232393ed2fcc756c0cfc0b591654ca`，即 `HEAD`）
> **验证者**：e2e-tester（t5，attempt 1）
> **验证时刻**：2026-09-23
> **验证性质**：**真实打包 / 真实安装 / 真实路由**的端到端行为验证，**不是**重跑单元测试
> **判定基准**：任务 t5 的 5 项验收要求 ＋ `docs/specs/2026-09-23-deepseek-v4.1-flash-support-spec.md`（FROZEN）

---

## 0. 结论（Verdict）

**verdict = `pass`**（就 t5 的 5 项验收要求而言）

**理由摘要**：本次修复的**核心行为已在真实安装链路上被实测证明**，且与**改动前**（已发布的 npm `0.1.0` = `HEAD` 基线）形成**决定性对照**：

| 验收项 | 结果 | 关键实测 |
| --- | --- | --- |
| ① packed 安装链路真实执行 | ✅ | `pnpm test:e2e:packed` **exit 0**；tarball 内 `assets/deepseek-v4.1-flash/` 3 文件哈希与 manifest **逐字节一致** |
| ② `deepseek-flash` exact 计数 + 压缩改写**真实落地** | ✅ | 真实 tarball 安装后：surface `exact-tokenizer`、`tokenizerId=deepseek-ai/DeepSeek-V4.1-Flash`、revision `dba1be0a…`；**落地 4 次改写**（fresh/history×2/tail-trim），`failOpen=false`。**改动前同一探针：0 次改写、全 fail-open** |
| ③ `deepseek-v4-pro` 行为与改动前一致 | ✅ | 前后**逐字段相同**（surface `5207→5213` tokens、同一 artifact、4 次改写同组件同顺序） |
| ④ 含图片候选仍 exact-ineligible、估算值与 golden 一致 | ✅ | 改写 0 次、原事件完好；`800x600 → 317 / upper 1024`；**31/31 golden 尺寸逐格一致** |
| ⑤ 未知 id 仍 fail-closed；资产校验失败仍抛错 | ✅ | 未知 id：`unavailable` + 4 组件 `exact-tokenizer-unavailable`、0 改写；篡改资产：3 条抛错路径 + 路由 fail-closed（且 V4-Pro 不受连带影响） |

**无 blocker / high / medium 缺陷。** 发现 **3 项 low 级观察**（§7），均**不影响** t5 的 5 项验收，且**其中 2 项为改动前既存**（非本次引入）。按任务要求「如实记录」，全部列出并给出复现步骤。

---

## 1. 验证环境与方法（可复现）

### 1.1 环境

```console
$ node --version
v26.7.0
$ pnpm --version
11.7.0
$ df -h . | tail -1
/dev/disk3s5   228Gi  112Gi   69Gi    62%   /System/Volumes/Data
```

**必须**带 `npm_config_cache=/tmp/npmcache`：本机 `~/.npm` 有 root 属主残留，packed E2E 首次会以 `EPERM` 失败（**环境问题，非代码缺陷**；t4 已记录，本报告全部命令均带该变量）。

### 1.2 两条独立证据链

本报告刻意使用**两条互相独立的证据链**，避免「自证」：

| 链路 | 内容 | 回答的问题 |
| --- | --- | --- |
| **A. 仓库自带发布门** | `pnpm test:e2e:packed`（内部 `npm pack` → 本地 registry → `pnpm add` 真实安装 → 官方 clone 生命周期） | 「发布产物本身是否完整、安装链路是否可用」 |
| **B. 我自建的独立探针** | 把 **A 产出的真实 tarball** 装进**我自己的 consumer**，用**安装后的 runtime 包**构造 `deepseek-flash` 路由并驱动压缩 | 「安装后的代码**在默认模型路由上**是否真的工作」 |

**链路 B 的必要性**（这是本任务最关键的方法论点）：

> 仓库自带发布门 `scripts/packed-components-smoke.mjs:23` 的 `const MODEL = 'deepseek-v4-flash'` 是**退役兼容别名**，**不是**本次修复的主体路由。全仓 `scripts/` 对**默认 id** `deepseek-flash` 的引用数为 **0**：
>
> ```console
> $ grep -c "'deepseek-flash'" scripts/packed-components-smoke.mjs scripts/packed-install-e2e.mjs
> scripts/packed-components-smoke.mjs:0
> scripts/packed-install-e2e.mjs:0
> ```
>
> 而 `deepseek-flash` 是 **DSH 的默认 DeepSeek 模型**（`@deepseek-ai/dsh-llm-deepseek` 的 `DEFAULT_MODELS[0].id === 'deepseek-flash'`）。**别名能通过，默认路由仍可能是坏的**——这正是「测试通过但行为未交付」的缺口。因此链路 B **不在**现有发布门覆盖范围内，属**独立验证**（见 §6）。

### 1.3 改动前基线（对照组）的取得

对照组 = **npm registry 上已发布的 `dsh-context-compression-selector-runtime@0.1.0`**。已核验它与 `HEAD` 基线**等价**：

```console
$ git show HEAD:packages/runtime/src/deepseek-v4-tokenizer.ts | grep -n "modelIds"
38:  modelIds: Object.freeze(['deepseek-v4-flash', 'deepseek-v4-pro']),
53:  modelIds: Object.freeze(['deepseek-v4-flash-vision-exp']),

$ git show HEAD:packages/runtime/src/deepseek-official-pricing.ts | grep -n "OfficialDeepSeekModelId" -A 4
14:export type OfficialDeepSeekModelId =
15:  | 'deepseek-v4-flash'
17:  | 'deepseek-v4-flash-vision-exp'
```

即 `HEAD` 的 `deepseek-flash` **既无 tokenizer 映射、也无价格行**——与实测的对照组行为完全吻合（§3.1、§4.1）。

### 1.4 ⚠️ 一个必须记录的陷阱（我实际踩到，非产品缺陷）

首次搭建链路 B 时，我直接 `pnpm add <local-runtime.tgz> <selector.tgz>`，结果 **selector 声明的精确依赖 `dsh-context-compression-selector-runtime: "0.1.0"` 被 pnpm 从 npm registry 解析**，装进了**已发布的旧 runtime**，而**不是**我指定的本地 tarball：

```console
$ node diag3.mjs   # 错误安装：拿到的是 npm 上已发布的旧 runtime
deepseek-flash   => {"kind":"unavailable", ...}
deepseek-v4-flash => {"tokenizerId":"deepseek-ai/DeepSeek-V4-Pro", ...}
```

这**一度看起来像「`deepseek-flash` 仍然坏」的真实缺陷**。加 `pnpm-workspace.yaml` override 后即恢复正常：

```yaml
# /tmp/t5-consumer/pnpm-workspace.yaml
overrides:
  dsh-context-compression-selector-runtime: file:/tmp/t5-artifacts/dsh-context-compression-selector-runtime-0.1.0.tgz
```

```console
$ node diag3.mjs   # 修正后：拿到真实本地 tarball
deepseek-flash                 => {"kind":"exact-tokenizer","tokenizerId":"deepseek-ai/DeepSeek-V4.1-Flash","tokenizerRevision":"dba1be0a40aa45a94ad051997016db3960a90277"}
deepseek-v4-flash              => {"kind":"exact-tokenizer","tokenizerId":"deepseek-ai/DeepSeek-V4.1-Flash","tokenizerRevision":"dba1be0a40aa45a94ad051997016db3960a90277"}
deepseek-v4-pro                => {"kind":"exact-tokenizer","tokenizerId":"deepseek-ai/DeepSeek-V4-Pro","tokenizerRevision":"0e1a0e5e52aea73055f50fef6f2423db370265b6"}
deepseek-v4-flash-vision-exp   => {"kind":"exact-tokenizer","tokenizerId":"deepseek-ai/DeepSeek-V4.1-Flash","tokenizerRevision":"dba1be0a40aa45a94ad051997016db3960a90277"}
deepseek-flash-2               => {"kind":"unavailable","reason":"canonical text: no verified bundled tokenizer for model \"deepseek-flash-2\""}
```

> **给后续验证者的提示**：用 tarball 做独立验证时，若被测包有**同版本的精确依赖**，必须用 override 强制指向本地 tarball，否则会静默测到 registry 上的旧版本。**本报告 §3 之后的所有结论均取自修正后的安装。**

---

## 2. 验收项 ①：packed 安装链路的真实执行证据

### 2.1 命令与结论

```console
$ npm_config_cache=/tmp/npmcache pnpm test:e2e:packed
...
EXIT=0
```

- **退出码 0**（`/tmp/t5-packed-e2e-full.log:3965` → `EXIT=0`）
- 共执行 **2 次**独立全绿（一次前台 tail 观察，一次完整落盘），另有一次带 `DSH_SELECTOR_ARTIFACT_DIR` 的产物保留运行
- 模式为 **release**（fail-closed），非 dev 跳过模式：

```json
  "installCommand": "pnpm add dsh-context-compression-selector@latest",
  "e2eMode": "release",
  "upgradeLeg": "installed",
  "artifactSource": "fresh-pack",
  "selector": "0.1.0",
  "runtime": "0.1.0",
  "runtimeInstalledTransitively": true,
```

即：**升级腿真实执行**（`installed`：先装已发布 `0.1.0-beta.2`，再 `pnpm up` 到候选版）、**官方 clean-harness 生命周期真实执行**（`officialCloneSmoke`，tag `dsh-v0.1.1-rc.2`、commit `b150a551…`、`status: clean`）——两条 fail-closed 守卫均未被跳过。

### 2.2 打包产物内容与哈希一致性

```console
$ tar tzf /tmp/t5-artifacts/dsh-context-compression-selector-runtime-0.1.0.tgz | grep assets | sort
package/assets/deepseek-v4.1-flash/LICENSE.DeepSeek-V4.1-Flash.txt
package/assets/deepseek-v4.1-flash/manifest.json
package/assets/deepseek-v4.1-flash/tokenizer.json
package/assets/deepseek-v4.1-flash/tokenizer_config.json
package/assets/deepseek-v4/LICENSE.DeepSeek-V4-Pro.txt
package/assets/deepseek-v4/manifest.json
package/assets/deepseek-v4/tokenizer.json
package/assets/deepseek-v4/tokenizer_config.json
```

**新资产目录 `assets/deepseek-v4.1-flash/` 确实存在**，且 3 个文件与 manifest **逐字节 + SHA-256 一致**：

```console
$ python3 -c "... sha256 逐文件比对 manifest ..."
tokenizer.json:                bytes 6367257==6367257 True, sha256 match True
tokenizer_config.json:         bytes 801==801           True, sha256 match True
LICENSE.DeepSeek-V4.1-Flash.txt: bytes 1084==1084       True, sha256 match True
```

与发布门自报一致（`/tmp/t5-packed-e2e-full.log:3800-3811`）：

```json
  "tokenizerArtifacts": {
    "deepseek-v4":         { "bytes": 6367146, "sha256": "8f9f37ca37fdc4f5fd36d5cf4d3b0e8392edb4e894fd10cc0d70b4957c8633cf" },
    "deepseek-v4.1-flash": { "bytes": 6367257, "sha256": "c90dfa01249db1be4245780a052ede752e1361c612ac6d08e2bdada7d599476b" }
  },
```

**旧目录零残留**（复核 captain 的预验证）：

```console
$ tar tzf ...runtime-0.1.0.tgz | grep -c "deepseek-v4-vision-exp"
0
$ tar xzOf ...runtime-0.1.0.tgz package/lib/index.js | grep -c "deepseek-v4-vision-exp"
0
$ tar xzOf ...runtime-0.1.0.tgz package/lib/index.js | grep -c "DeepSeek-V4-Flash-Vision-Exp"
0
```

tarball 哈希（两次独立打包**同哈希**，可复核）：

```
8b37c553a85de16b31c6da466a5f5b4616bf5258f9fb6e55ab270fd63aa2aa1e  dsh-context-compression-selector-runtime-0.1.0.tgz
d68fb42f8457e3db519082a5ad1dcbcecf8292d8c017b9b2345de65b6c497d3f  dsh-context-compression-selector-0.1.0.tgz
```

### 2.3 `verify:release`

```console
$ npm_config_cache=/tmp/npmcache pnpm verify:release
$ node scripts/verify-release.mjs
release verification: OK
EXIT=0
```

**结论：✅ 达成。** packed 链路真实执行且全绿；新资产目录存在、哈希与 manifest 一致、旧目录零残留。

---

## 3. 验收项 ②（本次核心）：`deepseek-flash` 路由下 exact 计数可用且压缩改写**真实落地**

### 3.1 决定性对照实验

**同一探针、同一模型 id、同一 profile 配置**，仅**被测 runtime 版本**不同（新版 tarball vs 改动前已发布版）。provider 使用 **DSH 真实路由名 `deepseek-official`**（`@deepseek-ai/dsh-llm-deepseek` 的 `PROVIDER = "deepseek-official"`）。

**改动后（真实 tarball 安装）：**

```console
$ T5_PROVIDER=deepseek-official node gate-probe.mjs deepseek-flash
GATE_PROBE {
 "runtimeVersion": "0.1.0",
 "model": "deepseek-flash",
 "surface": {
  "kind": "exact-tokenizer",
  "tokens": 5210,
  "tokenizerId": "deepseek-ai/DeepSeek-V4.1-Flash",
  "tokenizerRevision": "dba1be0a40aa45a94ad051997016db3960a90277"
 },
 "freshPruned": 1,
 "pressurePruned": 2,
 "rewriteCount": 4,
 "rewrites": [
  { "component": "fresh",     "stage": "fresh",    "reducer": "pi-tail",                    "tokensBefore": 1201, "tokensAfter": 239, "tokenizerId": "deepseek-ai/DeepSeek-V4.1-Flash", "tokenizerRevision": "dba1be0a40aa45a94ad051997016db3960a90277" },
  { "component": "history",   "stage": "pressure", "reducer": "historical-tool-result-aging", "tokensBefore": 239,  "tokensAfter": 140, "tokenizerId": "deepseek-ai/DeepSeek-V4.1-Flash", "tokenizerRevision": "dba1be0a40aa45a94ad051997016db3960a90277" },
  { "component": "history",   "stage": "pressure", "reducer": "historical-tool-result-aging", "tokensBefore": 1201, "tokensAfter": 129, "tokenizerId": "deepseek-ai/DeepSeek-V4.1-Flash", "tokenizerRevision": "dba1be0a40aa45a94ad051997016db3960a90277" },
  { "component": "tail-trim", "stage": "pressure", "reducer": "pair-preserving-tail-trim",    "tokensBefore": 131,  "tokensAfter": 56,  "tokenizerId": "deepseek-ai/DeepSeek-V4.1-Flash", "tokenizerRevision": "dba1be0a40aa45a94ad051997016db3960a90277" }
 ],
 "failOpen": false,
 "evaluations": [ { "component": "aggregate", "status": "skipped", "reason": "at-or-below-trigger" } ]
}
```

**改动前（npm 已发布 `0.1.0` = `HEAD`）：**

```console
$ T5_PROVIDER=deepseek-official node gate-probe.mjs deepseek-flash
GATE_PROBE {
 "runtimeVersion": "0.1.0",
 "model": "deepseek-flash",
 "surface": {
  "kind": "unavailable",
  "reason": "current surface: surface node 2: canonical text: no verified bundled tokenizer for model \"deepseek-flash\""
 },
 "freshPruned": 0,
 "pressurePruned": 0,
 "rewriteCount": 0,
 "rewrites": [],
 "failOpen": true,
 "evaluations": [
  { "component": "fresh",     "status": "skipped", "reason": "exact-tokenizer-unavailable" },
  { "component": "aggregate", "status": "skipped", "reason": "exact-tokenizer-unavailable" },
  { "component": "history",   "status": "skipped", "reason": "exact-tokenizer-unavailable" },
  { "component": "tail-trim", "status": "skipped", "reason": "exact-tokenizer-unavailable" }
 ]
}
```

### 3.2 这条对照证明了三件事

1. **exact 计数可用**：surface `kind === 'exact-tokenizer'`，`tokenizerId === 'deepseek-ai/DeepSeek-V4.1-Flash'`、`tokenizerRevision === 'dba1be0a40aa45a94ad051997016db3960a90277'`。
2. **压缩改写真实落地，非 fail-open**：`rewriteCount === 4`、`failOpen === false`；每次改写都带**递减的精确 token 证据**（`tokensBefore > tokensAfter`）且**每次改写都携带 V4.1-Flash 身份**。而**改动前同一探针 0 次改写、4 个组件全部 `exact-tokenizer-unavailable`** —— 这就是「插件在默认模型上不再空转」的直接证据。
3. **对照组的失败模式与 `HEAD` 源码一致**：`HEAD` 的 `modelIds` 不含 `deepseek-flash`（§1.3），故 fail-closed 是**预期**行为，而不是对照组配置错误。

> **注意**：`aggregate` 组件在新版下报 `at-or-below-trigger`（跳过）属**正常预算行为**，不是 fail-open —— 它带 `measurementKind: exact-tokenizer`（即 exact 可用、只是未越过触发阈值）。**判据是 `rewriteCount`/`failOpen`，不是「每个组件都必须改写」。**

### 3.3 id → artifact 映射总表（一眼证明映射正确）

同一安装下逐 id 解析（`mini-probe.mjs`）：

| model id | 改动后（真实 tarball） | 改动前（已发布 0.1.0 = HEAD） |
| --- | --- | --- |
| `deepseek-flash`（**默认**） | ✅ `exact-tokenizer` → **V4.1-Flash** `dba1be0a…` | ❌ `unavailable`（无映射） |
| `deepseek-v4-flash`（别名） | ✅ `exact-tokenizer` → **V4.1-Flash** `dba1be0a…` | ⚠️ `exact-tokenizer` → **V4-Pro** `0e1a0e5e…`（**错误**） |
| `deepseek-v4-flash-vision-exp` | ✅ `exact-tokenizer` → **V4.1-Flash** `dba1be0a…` | ⚠️ `exact-tokenizer` → **V4-Flash-Vision-Exp** `6821d6ad…`（已退役） |
| `deepseek-v4-pro` | ✅ `exact-tokenizer` → **V4-Pro** `0e1a0e5e…` | ✅ `exact-tokenizer` → **V4-Pro** `0e1a0e5e…`（**不变**） |
| `deepseek-flash-2`（未知） | ❌ `unavailable`（fail-closed） | ❌ `unavailable`（fail-closed） |

```console
$ node mini-probe.mjs   # 改动后
MINI_PROBE {
 "runtimeVersion": "0.1.0",
 "runtimeRoot": ".../dsh-context-compression-selector-runtime@file+..+..+..+tmp+t5-artifacts.../node_modules/dsh-context-compression-selector-runtime",
 "priceRowsForFlash": true,
 "flashInOfficialModelIds": true,
 "rows": [ ... ]
}
```

**三个 id（`deepseek-flash` / `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp`）解析为同一 V4.1 artifact 身份；`deepseek-v4-pro` 仍解析为 V4-Pro artifact。** 与 spec ①.1 完全一致。

### 3.4 补充：Adaptive profile 下的核心路径

`profile: 'adaptive'` 下，改动后**历史组件能进入真实规划与成本裁决**（不再是 `exact-tokenizer-unavailable`）：

```console
$ node adaptive3.mjs deepseek-flash   # profile=adaptive, installed tarball
ADAPTIVE3 {
 "model": "deepseek-flash",
 "surfaceKind": "exact-tokenizer",
 "rewrites": [],
 "evals": [
  { "component": "history", "status": "skipped", "reason": "adaptive-cost-rejected", "historyMode": "adaptive", "measurementKind": "exact-tokenizer" },
  { "component": "tail-trim", "status": "disabled", "reason": "profile-policy", "historyMode": null, "measurementKind": null }
 ],
 "adaptiveLines": [
  "context-compression adaptive {\"sessionId\":\"ad3-deepseek-flash\",\"allowHistory\":false,\"reason\":\"usage-unavailable\",\"catalogVersion\":\"deepseek-official-2026-09-23\"}"
 ]
}
```

对照改动前（同 profile、同模型）：

```console
ADAPTIVE3 {
 "surfaceKind": "unavailable",
 "evals": [ { "component": "history", "status": "skipped", "reason": "exact-tokenizer-unavailable", "historyMode": "adaptive", "measurementKind": "unavailable" } ],
 "adaptiveLines": []
}
```

**这是 exact 可用性的关键区分**：改动后 `reason` 是 `adaptive-cost-rejected`（`measurementKind: exact-tokenizer`，即 **exact 可用**，只是成本裁决未放行），改动前是 `exact-tokenizer-unavailable`（**exact 不可用**）。二者含义完全不同。

**结论：✅ 达成。** `deepseek-flash` 路由下 exact 计数可用，压缩改写真实落地（4 次，带精确递减证据），**非** fail-open；且改动前为全 fail-open，对照决定性。

---

## 4. 验收项 ③：`deepseek-v4-pro` 行为与改动前一致

### 4.1 端到端行为逐字段对照

同一探针、同 provider（`deepseek-official`）、同 profile 配置：

| 观测量 | 改动后（tarball） | 改动前（已发布 0.1.0 = HEAD） | 一致？ |
| --- | --- | --- | --- |
| surface `kind` | `exact-tokenizer` | `exact-tokenizer` | ✅ |
| surface `tokens` | `5213` | `5213` | ✅ **逐字相同** |
| `tokenizerId` | `deepseek-ai/DeepSeek-V4-Pro` | `deepseek-ai/DeepSeek-V4-Pro` | ✅ |
| `tokenizerRevision` | `0e1a0e5e52aea73055f50fef6f2423db370265b6` | 同左 | ✅ |
| `freshPruned` / `pressurePruned` | `1` / `2` | `1` / `2` | ✅ |
| `rewriteCount` | `4` | `4` | ✅ |
| 改写组件序列 | `fresh, history, history, tail-trim` | 同左 | ✅ |
| `failOpen` | `false` | `false` | ✅ |

```console
===== v4-pro AFTER (local tarball) =====
surface: {'kind': 'exact-tokenizer', 'tokens': 5213, 'tokenizerId': 'deepseek-ai/DeepSeek-V4-Pro', 'tokenizerRevision': '0e1a0e5e52aea73055f50fef6f2423db370265b6'}
freshPruned 1 pressurePruned 2 rewriteCount 4 failOpen False
rewrite identities: [('deepseek-ai/DeepSeek-V4-Pro', '0e1a0e5e52aea73055f50fef6f2423db370265b6')]
components: ['fresh', 'history', 'history', 'tail-trim']
===== v4-pro BEFORE (published 0.1.0) =====
surface: {'kind': 'exact-tokenizer', 'tokens': 5213, 'tokenizerId': 'deepseek-ai/DeepSeek-V4-Pro', 'tokenizerRevision': '0e1a0e5e52aea73055f50fef6f2423db370265b6'}
freshPruned 1 pressurePruned 2 rewriteCount 4 failOpen False
rewrite identities: [('deepseek-ai/DeepSeek-V4-Pro', '0e1a0e5e52aea73055f50fef6f2423db370265b6')]
components: ['fresh', 'history', 'history', 'tail-trim']
```

**V4-Pro 仍用 V4-Pro 分词器**，端到端行为**逐字段无差异**。

### 4.2 价格：V4-Pro 自有 tuple 不变；`deepseek-flash` 解析为 `priced`

对**已发布 bundle** 直接调用其价格解析（off-peak）：

```console
$ node pricing-probe.mjs "$RD"   # 改动后
PRICING_PROBE {
 "catalogVersion": "deepseek-official-2026-09-23",
 "checkedAt": "2026-09-23T01:48:36+08:00",
 "resolutions": {
  "deepseek-flash":               { "kind": "priced", "modelVersion": "DeepSeek-V4.1-Flash",   "band": "off-peak", "inputCacheHit": "0.003", "inputCacheMiss": "0.15", "output": "0.6" },
  "deepseek-v4-flash":            { "kind": "priced", "modelVersion": "DeepSeek-V4.1-Flash",   "band": "off-peak", "inputCacheHit": "0.003", "inputCacheMiss": "0.15", "output": "0.6" },
  "deepseek-v4-flash-vision-exp": { "kind": "priced", "modelVersion": "DeepSeek-V4.1-Flash",   "band": "off-peak", "inputCacheHit": "0.003", "inputCacheMiss": "0.15", "output": "0.6" },
  "deepseek-v4-pro":              { "kind": "priced", "modelVersion": "DeepSeek-V4-Pro-0813",  "band": "off-peak", "inputCacheHit": "0.022", "inputCacheMiss": "0.66", "output": "1.98" },
  "deepseek-flash-vision":        { "kind": "unpriced", "reason": "unknown model id" },
  "gpt-4o":                       { "kind": "unpriced", "reason": "unknown model id" }
 }
}
```

对照改动前：

```console
$ node pricing-probe.mjs "$RD"   # 改动前
PRICING_PROBE {
 "catalogVersion": "deepseek-official-2026-08-25",
 "checkedAt": "2026-08-25T00:10:20+08:00",
 "resolutions": {
  "deepseek-flash":               { "kind": "unpriced", "reason": "unknown model id" },
  "deepseek-v4-flash":            { "kind": "priced", "modelVersion": "DeepSeek-V4-Flash-0731",      "inputCacheHit": "0.007", "inputCacheMiss": "0.22", "output": "0.66" },
  "deepseek-v4-flash-vision-exp": { "kind": "priced", "modelVersion": "DeepSeek-V4-Flash-Vision-Exp", "inputCacheHit": "0.007", "inputCacheMiss": "0.22", "output": "0.66" },
  "deepseek-v4-pro":              { "kind": "priced", "modelVersion": "DeepSeek-V4-Pro-0813",        "inputCacheHit": "0.022", "inputCacheMiss": "0.66", "output": "1.98" }
 }
}
```

- `deepseek-flash`：`unpriced` → **`priced`**（`modelVersion: DeepSeek-V4.1-Flash`，USD `0.003/0.15/0.6`）✅
- 两个退役别名：旧 V4-Flash 价 → **Flash 价**（与 `deepseek-flash` **同一对象**）✅
- `deepseek-v4-pro`：`0.022/0.66/1.98` **逐字符不变**、`modelVersion` 仍 `DeepSeek-V4-Pro-0813` ✅（符合 R6.7/R6.8/R6.9b）
- 未知 id（`deepseek-flash-vision`、`gpt-4o`）：仍 `unpriced: unknown model id` ✅

### 4.3 adaptive cost 不再返回 `adaptive-unknown-price`

对**改动后** bundle 忠实复算 `ToolResultPruner.adaptiveHistoryAllowed` 的价格分支（`packages/runtime/src/index.ts:806-814` 的等价路径），输入 `reclaimed=1000, affected=25`：

```console
$ node gate-sim.mjs "$RD"   # 改动后
GATE_SIM {
 "catalogVersion": "deepseek-official-2026-09-23",
 "modelId": "deepseek-flash",
 "priceKind": "priced",
 "priceReason": null,
 "modelVersion": "DeepSeek-V4.1-Flash",
 "adaptiveBranch": {
  "allowHistory": false,
  "reason": "cache-risk-not-clearly-paid-back",
  "minimumRemovalValue": "3000000000",
  "maximumCacheLossPenalty": "3675000000"
 }
}
```

```console
$ node gate-sim.mjs "$RD"   # 改动前
GATE_SIM {
 "catalogVersion": "deepseek-official-2026-08-25",
 "modelId": "deepseek-flash",
 "priceKind": "unpriced",
 "priceReason": "unknown model id",
 "modelVersion": null,
 "adaptiveBranch": "adaptive-unknown-price:unknown model id"
}
```

**关键**：改动前该路由的 adaptive 判定**止步于** `adaptive-unknown-price`（**价格不可得，直接否决**）；改动后价格**解析成功**，判定推进到**真实的成本区间比较**（`cache-risk-not-clearly-paid-back`，带精确整数证据）。

这与 spec §3.3 / R3.2c 记录的动因**方向一致**：Flash 价使判定更严格（`hit/(miss-hit)` 阈值 `0.020408` vs 旧价 `0.032864`）。注意 `cache-risk-not-clearly-paid-back` 与 `adaptive-unknown-price` 是**不同**的语义——前者是「算过了，不划算」，后者是「没法算」。

> **一处必须如实说明的限定**：在**我的探针会话**中，adaptive 的**端到端**裁决实际止于更早的 `usage-unavailable`（见 §3.4 的 `adaptiveLines`），因为 `measureForCompaction` 的 `lastCompletedUsage` / `latestEnvelopeKey` 在当前代码里**从未被赋值**（§7 观察 O-2，**改动前既存**）。因此 §4.3 的 `adaptive-unknown-price → 真实比较` 是通过**对已发布 bundle 直接调用价格与判定函数**证明的（忠实复算其真实分支），**不是**通过端到端 `usage` 链路。这一点不削弱结论——「`deepseek-flash` 价格从 `unpriced` 变为 `priced`」是**决定性**的：只要 `usage` 链路将来被填充，该路由即进入真实比较而非 `adaptive-unknown-price`。但它确实意味着「adaptive cost 不再返回 `adaptive-unknown-price`」在当前端到端路径上**不可观测**（被更早的 `usage-unavailable` 遮蔽）。

**结论：✅ 达成。** V4-Pro 端到端行为与改动前**逐字段一致**、价格 tuple 与 `modelVersion` 逐字符不变；`deepseek-flash` 价格解析为 `priced`；adaptive 价格分支不再返回 `adaptive-unknown-price`（见上述限定）。

---

## 5. 验收项 ④：含图片候选仍 exact-ineligible，估算值与 golden 一致

### 5.1 含图片候选：改写 0 次、原事件完好

`deepseek-flash` 路由、`800x600` 图片（用户消息 + 含图 tool result）：

```console
$ node flash-probe.mjs vision
T5_PROBE {"label":"vision-path","model":"deepseek-flash",
 "estimate":{"kind":"tokenizer-estimate",
   "estimatorId":"deepseek-ai/DeepSeek-V4.1-Flash/image-token-estimate",
   "estimatorRevision":"dba1be0a40aa45a94ad051997016db3960a90277:v1",
   "tokens":317,"upperBoundTokens":1024},
 "currentSurfaceKind":"tokenizer-estimate",
 "intrinsicImageBlockEstimateTokens":634,
 "prunedFresh":0,"prunedPressure":0,
 "originalIntact":true,
 "evaluations":[
  {"component":"fresh","status":"skipped","reason":"exact-tokenizer-unavailable","measurementKind":"unavailable"},
  {"component":"aggregate","status":"skipped","reason":"exact-tokenizer-unavailable","measurementKind":"unavailable"},
  {"component":"history","status":"skipped","reason":"exact-tokenizer-unavailable","measurementKind":"unavailable"},
  {"component":"tail-trim","status":"skipped","reason":"exact-tokenizer-unavailable","measurementKind":"tokenizer-estimate"}]}
```

- **`prunedFresh === 0 && prunedPressure === 0`** → 含图候选**未被有损改写** ✅
- **`originalIntact === true`** → 原 `tool/result` 事件（含 `"type":"image"` 与 attachment 引用）**完好保留** ✅
- `currentSurfaceKind === 'tokenizer-estimate'` → 混合面**不宣称 exact** ✅
- `fresh` / `history` 均带 `exact-tokenizer-unavailable` 审计 → **exact 不资格**是有据可查的 ✅
- 注意 `tail-trim` 的 `measurementKind` 为 `tokenizer-estimate`（而非 `unavailable`）——它同样**未被授权改写**，与 spec R4.10「估算节点永不参与 exact 改写证明」一致

### 5.2 估算值与重生成的 golden fixtures 一致

对**已安装 runtime**逐尺寸复算，并与 `packages/runtime/tests/fixtures/vision-golden.json` 全部 31 个 `singleImages` 逐格比对：

```console
$ node golden-probe.mjs packages/runtime/tests/fixtures/vision-golden.json
GOLDEN_PROBE {
 "model": "deepseek-flash",
 "goldenSource": {
  "repository": "deepseek-ai/DeepSeek-V4.1-Flash",
  "revision": "dba1be0a40aa45a94ad051997016db3960a90277",
  "files": ["inference/image_processor.py", "config.json"]
 },
 "goldenParameters": {
  "visionPatchSize": 14, "visionDownsampleRatio": 3,
  "visionMaxNTokens": 1024, "visionMinPixels": 295936, "visionMaxWhRatio": null
 },
 "caseCount": 31,
 "matchCount": 31,
 "mismatches": [],
 "sample": [
  { "width": 14,  "height": 14,  "golden": 184, "installed": 184, "kind": "tokenizer-estimate", "match": true },
  { "width": 28,  "height": 14,  "golden": 202, "installed": 202, "kind": "tokenizer-estimate", "match": true },
  { "width": 56,  "height": 56,  "golden": 184, "installed": 184, "kind": "tokenizer-estimate", "match": true },
  { "width": 100, "height": 100, "golden": 184, "installed": 184, "kind": "tokenizer-estimate", "match": true }
 ],
 "case800x600": { "width": 800, "height": 600, "golden": 317, "installed": 317, "kind": "tokenizer-estimate", "match": true }
}
```

**31/31 逐格一致，零 mismatch**；`800x600 → 317`（upper bound `1024`）与发布门自报值一致。

发布门侧的独立确认（`/tmp/t5-packed-e2e-full.log:3888-3907`）：

```json
  "packedVisionSmoke": {
    "model": "deepseek-v4-flash-vision-exp",
    "tokenizer": { "repository": "deepseek-ai/DeepSeek-V4.1-Flash", "revision": "dba1be0a40aa45a94ad051997016db3960a90277" },
    "textSession": "exact-rewrites-with-vision-tokenizer",
    "imageSession": {
      "measurement": { "kind": "tokenizer-estimate",
        "estimatorId": "deepseek-ai/DeepSeek-V4.1-Flash/image-token-estimate",
        "estimatorRevision": "dba1be0a40aa45a94ad051997016db3960a90277:v1",
        "tokens": 317, "upperBoundTokens": 1024 },
      "currentSurfaceKind": "tokenizer-estimate",
      "exactRewriteIneligible": true,
      "originalIntact": true
    }
  }
```

且旧期望值 `340`/`384` 在门脚本中**零残留**（复核 captain 的预验证）：

```console
$ grep -rn "340\|384" scripts/packed-components-smoke.mjs scripts/packed-install-e2e.mjs
（无视觉期望值相关命中）
```

**结论：✅ 达成。** 含图候选仍 exact-ineligible、保持原样、原事件完好；估算值与 golden fixtures **31/31 一致**。

---

## 6. 验收项 ⑤：失败路径仍 fail-closed

### 6.1 未知模型 id 仍 fail-closed

```console
$ node gate-probe.mjs deepseek-flash-2   # 未知 id
"surface": { "kind": "unavailable", "reason": "current surface: surface node 2: canonical text: no verified bundled tokenizer for model \"deepseek-flash-2\"" },
"rewriteCount": 0,
"evaluations": [
 { "component": "fresh",     "status": "skipped", "reason": "exact-tokenizer-unavailable" },
 { "component": "aggregate", "status": "skipped", "reason": "exact-tokenizer-unavailable" },
 { "component": "history",   "status": "skipped", "reason": "exact-tokenizer-unavailable" },
 { "component": "tail-trim", "status": "skipped", "reason": "exact-tokenizer-unavailable" }
]
```

`surface.kind === 'unavailable'`、**0 次改写**、4 个组件全部 `exact-tokenizer-unavailable` —— 与改动前行为一致（§3.3）。**未知 id 不会因本次改动而被「顺带放行」。**

同时验证了「近似但不同」的 id 不会被前缀匹配误纳：`deepseek-flash-2` 与 `deepseek-flash-vision` 均为 `unavailable` / `unpriced`。

### 6.2 资产校验失败仍抛错

**(a) 校验接缝直接抛错**（对已安装 runtime 的 `createDeepSeekV4TokenizerFromAssets`）：

```console
$ node throw-probe.mjs "$RD" "$(dirname "$RD")"
THROW_PROBE {
 "healthy":        { "outcome": "constructed", "count": { "kind": "exact-tokenizer", "tokens": 2, "tokenizerId": "deepseek-ai/DeepSeek-V4.1-Flash", "tokenizerRevision": "dba1be0a40aa45a94ad051997016db3960a90277" } },
 "wrong-sha256":   { "outcome": "threw", "error": "DeepSeek tokenizer asset tokenizer.json failed SHA-256 verification" },
 "wrong-bytes":    { "outcome": "threw", "error": "DeepSeek tokenizer asset tokenizer.json has 6367257 bytes; expected 6367258" },
 "bad-config-sha": { "outcome": "threw", "error": "DeepSeek tokenizer asset tokenizer_config.json failed SHA-256 verification" }
}
```

3 条失败分支全部**抛错**（不是静默降级），且错误信息**区分**字节长度与哈希两类校验。

**(b) 真实篡改资产 → 路由 fail-closed，且不连带影响 V4-Pro**

对安装后的 `assets/deepseek-v4.1-flash/tokenizer.json` **追加 1 字节**（`6367257 → 6367258`）：

```console
=== 1) healthy baseline ===
 "deepseek-flash": { "kind": "exact-tokenizer", "tokenizerId": "deepseek-ai/DeepSeek-V4.1-Flash", ... }
=== 2) after appending 1 byte to assets/deepseek-v4.1-flash/tokenizer.json ===
   size now: 6367258
TAMPER_PROBE {
 "deepseek-flash": { "kind": "unavailable", "reason": "canonical text: no verified bundled tokenizer for model \"deepseek-flash\"" },
 "deepseek-v4-pro": { "kind": "exact-tokenizer", "tokens": 2, "tokenizerId": "deepseek-ai/DeepSeek-V4-Pro", "tokenizerRevision": "0e1a0e5e52aea73055f50fef6f2423db370265b6" }
}
=== 3) restored ===
   sha256: c90dfa01249db1be4245780a052ede752e1361c612ac6d08e2bdada7d599476b
```

同样的结论对 `tokenizer_config.json` 篡改成立：

```console
CONFIG_TAMPER {"kind":"unavailable","reason":"canonical text: no verified bundled tokenizer for model \"deepseek-flash\""}
```

**两点关键**：
1. 被篡改的 V4.1-Flash 资产使 `deepseek-flash` **fail-closed**（`unavailable`），而非静默用错词表产生错误计数；
2. **V4-Pro 完全不受影响**（仍 `exact-tokenizer`）——印证「每族 artifact 独立 assetRoot / integrity / cache」的设计（`deepseek-v4-tokenizer.ts:86-108`），即**一族损坏不会禁用另一族**。

**结论：✅ 达成。** 未知 id 仍 fail-closed；资产校验失败仍抛错且路由 fail-closed；跨族故障隔离成立。

---

## 7. 观察项（low，均不影响 t5 验收）

> 以下**全部如实记录**，并给出复现步骤。**O-2 / O-3 为改动前既存**（`HEAD` 即如此），非本次变更引入；O-1 为本次变更带来的**用户可见文案**与**目录版本**不同步。

### O-1（low）客户端价格披露文案仍写 `2026-08-25`，与已升级的目录版本不同步

**现象**：runtime 侧目录版本已升级，但 selector 客户端（面向用户的披露文案）**未随之更新**：

```console
$ grep -o "pricing.disclosure\": \"DeepSeek official prices checked [0-9-]*" \
    /tmp/t5-consumer/node_modules/dsh-context-compression-selector/lib/client.js
pricing.disclosure": "DeepSeek official prices checked 2026-08-25

$ grep -o "deepseek-official-2026-[0-9-]*" "$(cat .runtime-dir)/index.js" | sort -u
deepseek-official-2026-09-23
$ grep -o "2026-09-23T01:48:36+08:00" "$(cat .runtime-dir)/index.js" | head -1
2026-09-23T01:48:36+08:00
```

**改动前两者是同步的**（`2026-08-25` 对 `deepseek-official-2026-08-25`）：

```console
$ grep -o "pricing.disclosure\": ... [0-9-]*" /tmp/t5-before/.../client.js
pricing.disclosure": "DeepSeek official prices checked 2026-08-25
$ grep -o "deepseek-official-2026-[0-9-]*" /tmp/t5-before/.../index.js | sort -u
deepseek-official-2026-08-25
```

**影响**：用户看到的「价格复核于 2026-08-25」比实际目录复核时刻（`2026-09-23T01:48:36+08:00`）**旧约 29 天**。属**用户可见的文案陈旧**，非行为缺陷（价格数据本身正确）。

**为何未被门禁捕获**：
- `packages/selector/src/client/locales.ts` **未被本次变更改动**（`git diff --stat HEAD -- packages/selector/src/client/locales.ts` 输出为空）
- spec §13 明确「**不**授权修改 `packages/selector/`（该 UI 无模型 id 耦合）」
- 现有测试 `packages/selector/tests/profiles.client.spec.tsx:391-392` **把 `2026-08-25` 硬编码为正则期望**，因此该值被测试**锁定**而非被检测

**判定**：**不在 t5 验收范围**（t5 的 5 项均不含客户端文案）；且按 spec §13 属**未授权**改动范围。**不作为 t5 失败项**，但建议后续任务（或发布前）与 README/CHANGELOG 的日期口径一并处理。

**复现步骤**：
```bash
cd /tmp/t5-consumer
grep -o 'pricing.disclosure": "DeepSeek official prices checked [0-9-]*' \
  node_modules/dsh-context-compression-selector/lib/client.js
grep -o 'deepseek-official-2026-[0-9-]*' "$(cat .runtime-dir)/index.js" | sort -u
```

---

### O-2（low，**改动前既存**）`CompactionTokenView.lastCompletedUsage` / `latestEnvelopeKey` 从未被赋值，Adaptive 成本裁决在当前端到端路径上不可达

**现象**：`packages/runtime/src/measurement.ts` 声明了这两个可选字段，但**全仓无任何赋值点**：

```console
$ grep -rn "lastCompletedUsage" packages/ --include=*.ts --include=*.js | grep -v "readonly\|view.lastCompletedUsage"
（无输出 = 从未被赋值）
```

`HEAD` 亦如此（`git show HEAD:packages/runtime/src/measurement.ts` 只有 `:93` 的声明；`HEAD` 的 `index.ts:784` 只有读取）。

**后果**：`adaptiveHistoryAllowed` 在 `index.ts:790` 以 `usage-unavailable` 提前返回，因此 §4.3 的 `adaptive-unknown-price` 分支在**真实会话**中**不可观测**。实测：

```console
"adaptiveLines": ["context-compression adaptive {\"sessionId\":\"ad3-deepseek-flash\",\"allowHistory\":false,\"reason\":\"usage-unavailable\",\"catalogVersion\":\"deepseek-official-2026-09-23\"}"]
```

**判定**：**改动前既存**、**非本次引入**、**与本次 5 项验收无冲突**（本次修复的是**映射与定价**，`usage` 链路属另一议题）。但它**限制了「adaptive cost 不再返回 `adaptive-unknown-price`」这条要求的可观测强度**——因此我在 §4.3 明确标注该结论取自**直接调用已发布 bundle 的价格/判定函数**，而非端到端 `usage` 链路。**这不是失败，而是证据强度的如实界定。**

**复现步骤**：
```bash
grep -rn "lastCompletedUsage" packages/ --include=*.ts | grep -v readonly
cd /tmp/t5-consumer && node adaptive3.mjs deepseek-flash   # 观察 reason=usage-unavailable
```

---

### O-3（low，**改动前既存**）`deepseek-flash`（默认模型）不在任何发布门脚本的覆盖范围内

**现象**（本任务最关键的方法论点，§1.2 已述）：

```console
$ grep -c "'deepseek-flash'" scripts/packed-components-smoke.mjs scripts/packed-install-e2e.mjs
scripts/packed-components-smoke.mjs:0
scripts/packed-install-e2e.mjs:0

$ grep -n "^const MODEL" scripts/packed-components-smoke.mjs
23:const MODEL = 'deepseek-v4-flash'
```

**后果**：现有发布门只覆盖**退役别名** `deepseek-v4-flash`；**默认路由 `deepseek-flash` 无自动化覆盖**。这本身**正是**「别名能过、默认路由可能仍坏」这一缺口的成因——**本次修复恰好补上了该行为，但没有补上该覆盖**。

**为何不判 fail**：t5 的验收要求是「**验证**默认路由行为」，我已用**独立探针**完成（§3），并明确标注该覆盖**不在**现有发布门内。t5 的 inScope 是 `docs/reviews/`，**不含** `scripts/`（out of scope 明确列出 `scripts/`），因此**我无权**改门脚本。

**建议**（交给 captain 决策，**不在 t5 范围**）：把 `packed-components-smoke.mjs:23` 的 `MODEL` 改为 `'deepseek-flash'`（或新增一条默认 id 路由断言），使发布门覆盖 DSH 默认模型——**这是防止该缺口回归的唯一机检手段**。

**复现步骤**：
```bash
grep -c "'deepseek-flash'" scripts/packed-components-smoke.mjs
grep -n "^const MODEL" scripts/packed-components-smoke.mjs
```

---

## 8. 验收项逐条对照

| # | 验收要求 | 结果 | 证据位置 |
| --- | --- | --- | --- |
| 1 | 报告存在于 `docs/reviews/2026-09-23-v41-flash-e2e-report.md` | ✅ | 本文件 |
| 2 | 含 packed 安装链路的真实执行证据（命令 + 关键输出） | ✅ | §2.1–§2.3（`pnpm test:e2e:packed` exit 0；`e2eMode: release`；`upgradeLeg: installed`；tarball 哈希 + 资产 manifest 逐文件比对） |
| 3 | 证明 `deepseek-flash` 路由下 exact 计数可用且压缩改写真实落地（非 fail-open） | ✅ | §3.1–§3.3（`exact-tokenizer` + V4.1-Flash 身份；**4 次改写**、`failOpen=false`；对照改动前 **0 次改写 / 全 fail-open**） |
| 4 | 证明 `deepseek-v4-pro` 行为与改动前一致 | ✅ | §4.1–§4.2（surface `5213` tokens、同一 artifact、同 4 组件改写，**逐字段相同**；价格 tuple 与 `modelVersion` 逐字符不变） |
| 5 | 证明含图片候选仍 exact-ineligible 且估算值与 golden 一致 | ✅ | §5.1–§5.2（改写 0 次、原事件完好、`tokenizer-estimate`；**31/31 golden 逐格一致**，`800x600 → 317/1024`） |
| 6 | 证明未知模型 id 仍 fail-closed | ✅ | §6.1（`unavailable`、0 改写、4 组件 `exact-tokenizer-unavailable`）；§6.2 追加资产篡改 fail-closed + 跨族隔离 |
| 7 | 给出整体 verdict 与任何失败的复现步骤 | ✅ | §0（`verdict = pass`）；§7 三项 low 观察**均附复现步骤**；无失败项 |

**两条 Verify 命令**：

| 命令 | 结果 |
| --- | --- |
| `pnpm test:e2e:packed` | ✅ **exit 0**（release 模式，两条 fail-closed 守卫均未跳过） |
| `pnpm verify:release` | ✅ **exit 0**（`release verification: OK`） |

---

## 9. 验证方法与局限（诚实声明）

**已做到**：
- 全部结论取自**真实 tarball 安装**后的代码（非 `src/`、非单测），且探针本身断言**安装路径落在 consumer 的 `node_modules` 内**（`resolved.startsWith(consumerRoot/node_modules/)`）。
- 使用**真实 DSH provider 路由名** `deepseek-official`（非臆造路由）。
- 建立**改动前/后对照**（npm 已发布 `0.1.0` ≡ `HEAD`），使「行为已交付」有**决定性**对照而非单边断言。
- 视觉估算与 golden 做**全量 31 例**比对（非抽样）。

**局限（不影响上述结论，但须声明）**：
1. **Adaptive 端到端 `usage` 链路不可达**（§7 O-2，改动前既存）：§4.3 的 `adaptive-unknown-price → 真实比较` 由**直接调用已发布 bundle 的价格与判定函数**证明，非端到端 `usage` 链路。
2. **§7 O-1 的客户端文案**未纳入验收（spec §13 未授权改 `packages/selector/`）。
3. 探针的**压缩预算参数**（`history.trigger: 3000`）为让 `history` 组件在探针会话中可达而设；该参数**对前后两侧完全相同**，故不影响对照有效性。首次使用 `7_800` 时 `history` 报 `below-profile-trigger`（正常预算行为），已据实调整并说明。
4. 探针脚本位于 `/tmp/t5-consumer` 与 `/tmp/t5-before`（**工作区之外**），因 t5 inScope 仅 `docs/reviews/`。所有命令与期望输出均在本报告中给出，可完整复现。

---

## 10. 附：验证脚本清单（供复核）

| 脚本（位于 `/tmp/t5-consumer/`，`/tmp/t5-before/` 为改动前对照） | 用途 |
| --- | --- |
| `flash-probe.mjs` | 主探针：route / vision / adaptive / native 四模式 |
| `gate-probe.mjs` | 压缩门对照实验（支持 `T5_PROVIDER` 指定真实路由名） |
| `mini-probe.mjs` | id → artifact 映射总表 |
| `golden-probe.mjs` | 31 例 golden 全量比对 |
| `pricing-probe.mjs` | 价格解析 + adaptive 判定 |
| `gate-sim.mjs` | 忠实复算 `adaptiveHistoryAllowed` 价格分支 |
| `adaptive3.mjs` | Adaptive profile 端到端 + 日志导出 |
| `throw-probe.mjs` | 资产校验抛错路径（4 分支） |
| `tamper-probe.mjs` | 真实篡改资产 → 路由 fail-closed |

**关键可复核命令**：

```bash
# ① 发布门（必须带 npm_config_cache）
npm_config_cache=/tmp/npmcache pnpm test:e2e:packed   # EXIT=0
npm_config_cache=/tmp/npmcache pnpm verify:release    # release verification: OK

# ② 默认路由核心行为（决定性对照）
cd /tmp/t5-consumer && T5_PROVIDER=deepseek-official node gate-probe.mjs deepseek-flash
cd /tmp/t5-before   && T5_PROVIDER=deepseek-official node gate-probe.mjs deepseek-flash

# ③ V4-Pro 不变性
cd /tmp/t5-consumer && T5_PROVIDER=deepseek-official node gate-probe.mjs deepseek-v4-pro
cd /tmp/t5-before   && T5_PROVIDER=deepseek-official node gate-probe.mjs deepseek-v4-pro

# ④ golden 全量
cd /tmp/t5-consumer && node golden-probe.mjs \
  /Users/williamshi666/Developers/dsh-context-compression-selector/packages/runtime/tests/fixtures/vision-golden.json
```

---

**verdict = `pass`**（就 t5 的 5 项验收要求而言）。核心行为契约已在真实安装链路上被实测证明并与改动前形成决定性对照；V4-Pro 逐字段不变；图片路径与失败路径均保持既有安全性质。三项 low 级观察已如实记录并附复现步骤，其中两项为改动前既存、一项为未授权范围内的用户可见文案。
