# DeepSeek-V4.1-Flash 支持 —— Spec Review（t4）

> **审查对象**：`t2` 的实现产物（工作区未提交变更，基线 `08e3db27fa232393ed2fcc756c0cfc0b591654ca`）
> **判定基准**：`docs/specs/2026-09-23-deepseek-v4.1-flash-support-spec.md`（FROZEN，①~⑥ 共 64 条规则）＋ 已批准计划 `docs/plans/2026-09-23-gitnexus-plan-v41-flash-support.md`
> **审查轴**：Spec（是否真正交付了冻结契约所要求的行为），**不**审查代码风格（那是 t3）
> **审查者**：spec-reviewer（t4，attempt 1）
> **审查时刻**：2026-09-23

---

## 0. 结论（Verdict）

**verdict = `needs_revision`**

**理由摘要**：核心行为契约（① 模型映射 / ② 视觉算术 / ③ 定价 / ④ fail-closed / ⑥ V4-Pro 冻结）**已真实交付**，且经本审查者独立复现（下载官方 `image_processor.py` 比对哈希、从零复算 31 行 golden 表 + 162 例 sweep、重新抓取官方定价页 EN/ZH、423,200 组尺寸模糊测试、六门命令全跑）。**未发现任何"测试通过但核心行为未交付"的算术/映射/定价缺口。**

判 `needs_revision` 的原因是**三处文档与一条安全不变量的证据缺口**，均可定点修复且不需要改动算术：

1. **`README.zh.md` 支持模型表未更新** —— R5.8 明文规定该表必须含 `deepseek-flash` 行与"由谁服务"列；实际只改了同一文件的其他段落（R5.8 自身规定此类偏离判 `needs_revision`）。
2. **`packages/runtime/README.md` / `README.zh.md` 的"由谁服务"归属被写反** —— 声称 `deepseek-v4-pro` 由 V4.1-Flash 服务、`deepseek-v4-flash-vision-exp` 由 V4-Pro 服务，与 ①.1 / R6.10 直接矛盾。这是**用户可见的事实错误**，且无任何测试能捕获它。
3. **R4.14（同一测量内估算器身份变更必须 fail-closed）无任何测试证据** —— 守卫代码存在（`measurement.ts:199-201`、`:382-384`），但 R2.12 恰好改了 `estimatorRevision`，spec 把这条列为必须机检的安全不变量，全仓搜索 `image estimator identity changed` 零命中。

其余为 low 级：P-9f 命名测试缺失、V4-Pro `modelVersion` 无断言、R2.8 的 `assert` 未移植、计划 §12 A2 未随交付文档保留、`PROVENANCE.md` 计数笔误、`measurement.ts` 源注释仍是旧算术措辞。

**没有任何 blocker / high finding**，因此不属于 `reject`；但存在 spec 明文判 `needs_revision` 的偏离，故也不判 `pass`。

---

## 1. 审查方法与独立复现证据

本审查**未转述 t2 的自述**，以下事实由审查者独立复现：

| # | 复现动作 | 结果 |
| --- | --- | --- |
| E1 | 独立 `curl` 官方 `inference/image_processor.py` @ `dba1be0a…` 并 `shasum -a 256` | `482759e3bcc4e9bb5ee582b244cc563f5d0e163d8b48dda91ebb7106e62f9272`，与 `vision-official-sweep.json#source.imageProcessorSha256` **逐字符相同**；且与审查者本机既有官方副本 `cmp` 逐字节相同 → **fixture 与官方实现同源，非手工填数** |
| E2 | 审查者独立 Python 移植官方 `plan_image_grid`/`safe_resize`/`solve_resize_ratio`，复算 `vision-golden.json` 全部 31 个 `singleImages` | **31/31 逐格一致**（`nLlmH`/`nLlmW`/`tokensAtStart0`），且与 spec ⑤.3.1 的 28 行 + 3 行跨文件引用**逐行相同** |
| E3 | 同一移植复算 `vision-official-sweep.json` 全部 162 例 | **162/162 逐格一致**，`maxTokens = 1017 ≤ 1024`，无超限 |
| E4 | 独立用真实 `@huggingface/tokenizers` 重跑 `tokenizer-golden.json` 12 例 | **12/12 一致**；`<｜deepseek_image｜>` flash=1 / pro=7，`<｜image｜>` flash=5 / pro=1（与 R-6/R-7 冻结值相同） |
| E5 | 重新抓取官方定价页 EN + ZH（HTTP 200） | 价格表 MODEL 列**只有** `deepseek-flash` 与 `deepseek-v4-pro`；USD `0.003/0.006`、`0.15/0.3`、`0.6/1.2`；CNY `0.02/0.04`、`1/2`、`4/8`；`MODEL VERSION = DeepSeek-V4.1-Flash`；脚注 (1) 与 spec §3.3 逐字引用**一致** |
| E6 | 逐字节校验 6 个资产文件 | 全部与 spec 冻结值一致（见 §3 ①） |
| E7 | `git diff` 校验 V4-Pro 三个冻结文件 | **输出为空**（tokenizer.json / tokenizer_config.json / LICENSE 均未改动） |
| E8 | 423,200 组尺寸模糊测试移植后的 `deepSeekVisionImageGrid` | **0 例超过 1024**，最大块长恰为 1024 |
| E9 | 六门命令全跑 | `typecheck` ✓ `test`（504 passed / 1 skipped）✓ `build` ✓ `test:built` ✓ `verify:release` ✓ `test:e2e:packed` ✓ |
| E10 | `gitnexus detect_changes --scope all` | 返回完整结果，**无 `partial`/`truncated` 标记**；`risk_level: high`（与计划 §4 Finding 6 预期的 HIGH 一致） |

> **环境提示（非代码缺陷）**：本机默认 npm cache（`~/.npm`）存在 root 属主残留，导致 `pnpm pack:dry-run` 与 `pnpm test:e2e:packed` 首次以 `EPERM` 失败；改用 `npm_config_cache=/tmp/t4-npmcache` 后**两者均绿**（packed E2E 退出码 0）。t5 复跑时请带上该环境变量，不要把它误判为 t2 的缺陷。

---

## 2. 逐条 Spec 判定（①~⑥）

### ① 模型 id → artifact 映射 —— ✅ **达成**

| 规则 | 判定 | 证据 |
| --- | --- | --- |
| R1.1 穷尽映射表 | 达成 | `deepseek-v4-tokenizer.ts:53-60` V4.1 artifact `modelIds` = 三 id；`:32-39` V4-Pro `modelIds` = `['deepseek-v4-pro']`；`:118` `artifactForModel` 用 `includes` 精确匹配，无前缀/别名回退 |
| R1.2 `modelIds` 顺序 + `deepseek-flash` 首位 | 达成 | `:59` 顺序为 `['deepseek-flash','deepseek-v4-flash','deepseek-v4-flash-vision-exp']`；R-4 用 `toEqual` 顺序敏感断言（`deepseek-v4-tokenizer.spec.ts:56-59`） |
| R1.3 V4-Pro `modelIds` 单元素 | 达成 | `:38`；且 `git diff packages/runtime/assets/deepseek-v4/manifest.json` **仅删除一行** `"deepseek-v4-flash"` |
| R1.4 manifest 与 TS 常量严格一致 | 达成 | R-8（`:178-192`）循环两族逐字段断言；审查者 E6 独立核对 manifest 内容与 spec 冻结 JSON 相同 |
| R1.5 三 id 返回**同一实例** | 达成 | R-2（`:32-40`）+ 额外 `shares one tokenizer instance`（`:50-54`，`toBe` 引用相等）；`registryCache` 键为 `artifact.origin` 对象引用（`:115`），两族 `origin` 是不同冻结对象 |
| R1.6 签名与返回顺序不变 | 达成 | `deepSeekV4TokenizerForModel` / `deepSeekTokenizerArtifacts` 签名未变；R-17（`:84-89`）断言 `[0]=V4-Pro`、`[1]=V4.1-Flash` |
| 1.5 打包清单 | 达成 | `packages/runtime/package.json` `files` 中该条目已改为 `"assets/deepseek-v4.1-flash/*"`，`"assets/deepseek-v4/*"` 未动；实测 `npm pack --dry-run` 确实打包了两个目录各 4 个文件（含 6.4MB `tokenizer.json`） |
| 1.4 资产迁移与哈希 | 达成 | E6：`tokenizer.json` 6367257/`c90dfa01…`、`tokenizer_config.json` 801/`6ac8c8dc…`、`LICENSE.DeepSeek-V4.1-Flash.txt` 1084/`f2c6c602…`；旧 license 文件已不存在 |
| **三个 id 是否"都真正可用"** | **达成** | 不只是 `deepseek-flash`：R-2 逐 id 断言三者 `countText` 身份；**图像能力门**由 `VISION_MODEL_IDS` 集合判定（`measurement.ts:108`），`public-runtime.spec.ts:2333-2358` 用 `it.each` 对**三个 id 逐一**断言 `kind === 'tokenizer-estimate'` + 正确的 `estimatorId`/`estimatorRevision`；另有 `deepseek-v4-flash` 别名单独用例（`:2582-2603`） |

### ② 视觉参数与算术 —— ✅ **达成**（含一条 low 级移植保真缺口）

| 规则 | 判定 | 证据 |
| --- | --- | --- |
| R2.1 `visionMaxWhRatio === undefined` | 达成 | `deepseek-v4-vision-tokens.ts:48`；V-1（spec ⑤.3 / 测试 `:43-61`）断言 `toBeUndefined()` 且 `?? null` 与 fixture JSON `null` 比较；守卫写成显式 `!== undefined && !== null`（`:173-176`），**未退化为 `width >= 0` 类恒真式** |
| R2.2 1024 / 295936 / revision | 达成 | `:39`、`:41`、`:33`；V-1 逐字段断言 |
| R2.3 块长度 `nH*(nW+1)+2` | 达成 | `:203-206`；V-2/V-4/V-7/V-8 断言 |
| R2.4 删除 COMPRESS_PAD_TO 及四项加项 | 达成 | 全仓 `COMPRESS_PAD_TO` 仅剩两处**说明性注释**（源码文档串与已构建 `lib`），无代码引用；`gridTokens` 已删除（`gitnexus detect_changes` 将其标为 `touched`，说明是删除而非保留） |
| R2.5/R2.6 `startTokenPos` 惰性、签名保留 | 达成 | `:204` `void startTokenPos`；V-3（15 个位置恒 317）、V-4、V-13、sweep 的 `stays position-independent on every swept size`（9 个位置 × 162 例） |
| R2.7/R2.9 `plan_image_grid` / `solveResizeRatio` 官方形式 | 达成 | `:161-188`、`:230-257` 与官方 `image_processor.py:101-112`、`:46-57` 逐行对应；**E2/E3 从零复算 31+162 例全一致**，这是最强证据 |
| R2.8 `safeResize` 单次求解 | **部分达成** | 单次求解已实现（`:275-280`），但 spec R2.8 伪码第 3 步的 `断言 nLlmH*(nLlmW+1)+2 <= 1024` **未移植**（官方 `image_processor.py:66` 有 `assert num_image_tokens(...) <= max_n_token`）。**E8 的 423,200 组模糊测试未发现可达违例**，故属防御性保真缺口而非行为缺陷 → **F4（low）** |
| R2.10 删除 `gridTokens()`、占用检查改公式 | 达成 | `gridTokens` 无定义；占用检查 `:275` 直接用 `deepSeekVisionImageBlockTokens` |
| R2.11 估算器返回形状与 equal padding bounds | 达成 | `:123-152`；V-5 断言 `{184,1024,'intrinsic-grid',184,184}`；V-9 断言 `source:'default'` 时 `tokens===256`、`upperBoundTokens===1024`、**无** padding 键；`DEEPSEEK_VISION_DEFAULT_IMAGE_TOKENS = 256` 保留（`:63`，Q3 冻结） |
| R2.12 估算器身份字符串 | 达成 | `:66-69` 模板拼接；V-12 断言 `'deepseek-ai/DeepSeek-V4.1-Flash/image-token-estimate'` + `'dba1be0a…:v1'` |
| R2.13 像素预算语义不变 | 达成 | `:101-103`；V-11 断言 640000 边界（含恰等与超 1 像素） |
| R2.14 `VISION_MODEL_ID` → `VISION_MODEL_IDS` 集合 | 达成 | `measurement.ts:108`；旧单值常量全仓无残留 |
| R2.15/R2.16 两处门改 `has()` | 达成 | `:311`（`countCanonicalImage`）、`:337`（`intrinsicImageDiagnostic`）；provider 门保持 `deepseek`/`deepseek-official`（`:336`） |
| R2.17 `bindCounter` 逻辑不变、不新增白名单 | 达成 | `:270-297` 无 model id 白名单，经 `deepSeekV4TokenizerForModel` 继承 ① 的修复 |

### ③ `deepseek-flash` 定价 —— ✅ **达成**（含两条 low 级测试缺口）

| 规则 | 判定 | 证据 |
| --- | --- | --- |
| R3.1 12 个价格字符串 | 达成 | `deepseek-official-pricing.ts:63-67`；`it.each` 16 行逐字符断言（`deepseek-official-pricing.spec.ts:10-53`）；**E5 用官方定价页 EN/ZH 复核一致** |
| R3.2 两个退役别名 = Flash 价 | 达成 | `:75-79`、`:86-90`；P-9（`:223-272`）逐字段 `toEqual` 与 `deepseek-flash` 相同；依据脚注 (1)「billed at the Flash price / 按 Flash 价格计费」**E5 逐字复核一致** |
| R3.2b / R3.2b′ / R3.2b″ 旧价按行作用域消失、V4-Pro 免于泛化 | 达成 | 两别名行已无 `'0.007'`/`'0.22'`/`'0.014'`/`'0.44'`/`'0.05'`/`'1.5'`/`'0.10'`/`'3.0'`；`version` 为 `'DeepSeek-V4.1-Flash'`；V4-Pro 行 `'0.66'`/`'1.32'`/`'4.5'`/`'9.0'` **合法保留**（`:81-85`） |
| R3.2c 会翻转 adaptive 判定 | 达成（**行为已交付，命名测试缺失**） | 审查者手算复核：Flash 价 `hit/(miss-hit)=0.003/0.147`，`(reclaimed=1000, affected=25)` → `3e9 > 3.675e9` 为假 → deny；旧价 `7e9 > 5.325e9` 为真 → allow。**翻转真实存在**。但 spec 的 P-9f 命名测试**不存在**（见 F2） |
| R3.2d tokenizer 与定价两契约独立 | 达成 | 定价只改 `PRICES` 的价格与 `version`；① 的映射与 ⑤.1/⑤.4 断言彼此独立 |
| R3.3 `PRICES` 键集合 = 联合类型成员（4 个） | 达成 | `:14-18`、`:60-91`；`isOfficialModel` 用 `hasOwnProperty`（`:309`） |
| 3.2 目录元数据 | 达成 | `catalogVersion = 'deepseek-official-2026-09-23'`（`:3`，已从 `…2026-08-25` 升级）；`checkedAt = '2026-09-23T00:40:00+08:00'`（`:5`，已非旧值）；`unitTokens`/`peakRule`/`sourceUrl`/`sourceLocale`/`provider`/`baseUrlClass` 均未变 |
| **catalog version / checked-at 是否已升级** | **达成** | 见上；P-6（`:69-84`）断言 `catalogVersion === 'deepseek-official-2026-09-23'` 且 `checkedAt !== '2026-08-25T00:10:20+08:00'` |

### ④ fail-closed 不变量 —— ⚠️ **大部分达成，一条安全不变量无测试证据**

| 规则 | 判定 | 证据 |
| --- | --- | --- |
| R4.1/R4.2 未知 id → `undefined`；无参默认 V4-Pro | 达成 | `:128-131`、`:149-153`；`deepSeekV4TokenizerFailureReason()` 无参取 `ARTIFACTS[0]` 并有测试（`:115`） |
| R4.3 14 个负例 | 达成 | `deepseek-v4-tokenizer.spec.ts:91-109` 的 `it.each` 列表与 spec ④.3 **逐项相同**（含 6 条本次新增的近邻 id） |
| R4.4 字节/SHA/JSON 三条件抛错 | 达成 | R-11/R-12/R-13/R-14 覆盖（`:118-139`、`:154-176`）；抛错消息含 `bytes`/`SHA-256`/`JSON` |
| R4.5 跨族隔离（双向） | 达成 | R-15（`:118-139` 尾段，V4.1 损坏后 V4-Pro 仍 exact）＋ R-16（`:141-152`，V4-Pro 损坏后 V4.1 仍 exact） |
| R4.6 缓存键为 origin 对象引用 | 达成 | `:115` `Map<DeepSeekTokenizerArtifactOrigin, …>`；两族 origin 为不同 `Object.freeze` 对象 |
| R4.7 非 DeepSeek provider 不计数 | 部分达成 | 行为已交付（`measurement.ts:278` 两处 reason 模板正确）。测试 `public-runtime.spec.ts:2605-2624` **只断言 `kind === 'unavailable'`**，未断言 `canonical image: provider "openai" is not the supported DeepSeek route` 亦未断言 `countText` 的 reason → **F5（low）** |
| R4.8 provider/model 为 `undefined` 的 reason | 部分达成 | 行为已交付（`:273-275`）；全仓无任何测试断言该两条 reason → **F5（low）** |
| R4.9 `intrinsicImageDiagnostic` 对非 DeepSeek provider 返回 `undefined` | 部分达成 | 行为已交付（`:335-337`）；M-8 场景（`:2605-2624`）**未断言** `view.intrinsicImageBlockEstimateTokens` 为空/0 → **F5（low）** |
| R4.10 含图片候选永不具备 exact 资格 | 达成 | M-5（`:2404-2433`）+ `:2278-2330`；断言 `count.kind === 'tokenizer-estimate'` 且 `currentSurface.kind === 'tokenizer-estimate'`，即使文本 tokenizer 现已可解析 |
| R4.11 `absorb()` 传播 estimate、`upperBound >= tokens` | 达成 | `measurement.ts:190-208`；测试 `:2322-2325`、`:2430-2432` |
| R4.12 含图片 tool-result 不被有损改写（fresh + pressure） | 达成 | M-6（`:2435-2488`）断言两次 `pruned.length === 0` 且原事件仍是 `tool/result` |
| R4.13 `currentSurface.kind` 与 TailTrim 走 unavailable 分支 | 达成 | `:2327`、`:2511`；`never TailTrims a tool group whose results carry images`（`:2626+`） |
| **R4.14 同一测量内估算器身份变更 → unavailable** | **未达成（无测试证据）** | 守卫代码存在（`measurement.ts:199-201`、`:382-384`，reason `image estimator identity changed within one measurement`）。但全仓搜索该字符串在 `tests/` 下**零命中**。spec 把这条与 R2.12 的 revision 升级绑定（"旧缓存审计行与新行不得被当作同一估算器"），属**必须机检**的 fail-closed 安全不变量 → **F1（medium）** |

### ⑤ TDD 测试清单（56 条）—— ⚠️ **53 条达成 / 3 条部分或缺失**

| 组 | 应测 | 达成 | 说明 |
| --- | --- | --- | --- |
| 5.1 Registry（R-1~R-17） | 17 | 17 | R-11/R-12/R-13/R-15 被**合并**为一个测试（`:118`），R-14 独立（`:154`）；行为全覆盖，但合并后的测试名既不等于也不严格是四条名字的"超集"（R5.0 措辞）→ 计入 **F6（low）** |
| 5.2 Measurement 视觉门（M-1~M-10） | 10 | 8 | M-1/M-2/M-3/M-5/M-6/M-7/M-9/M-10 达成；**M-4 缺 reason 断言**、**M-8 缺诊断断言** → **F5（low）** |
| 5.3 Vision 算术（V-1~V-13） | 13 | 13 | 全部达成，含 V-2 的 `it.each(fixture.singleImages)`（31 例）与 V-13 三组序列；另新增 167 例 sweep 回归（超出清单） |
| 5.4 Pricing（P-1~P-13） | 13 | 11 | P-1~P-7、P-9~P-13 达成；**P-8/P-9e 的 `modelVersion === 'DeepSeek-V4-Pro-0813'` 无断言** → **F3（low）**；**P-9f 完全缺失** → **F2（low）** |
| 5.5 Tokenizer golden（G-1~G-3） | 3 | 3 | G-1/G-2/G-3 达成；E4 独立复算 12/12 |

**R5.0（先红后绿）**：审查者无法从最终工作区回溯证明每条测试都曾先失败；但 R5.0 的可机检部分（测试名与输入/期望值）已逐条核对，且 E2/E3/E4 的独立复算证明期望值**不是**由实现反推（审查者用与实现无关的 Python 移植得到同一批值）。**不判未达成**，但记录为不可回溯项。

### ⑥ V4-Pro 不变性 —— ✅ **达成**

| 规则 | 判定 | 证据 |
| --- | --- | --- |
| R6.1 唯一允许改动 = manifest `modelIds` | 达成 | `git diff` 该文件**恰好删除一行** `"deepseek-v4-flash"`，无其他 hunk |
| R6.2 manifest 其余字段逐字符不变 | 达成 | 同上 diff 仅一个 hunk |
| R6.3/R6.4/R6.5 三个冻结文件字节与哈希 | 达成 | E7：`git diff` 对三文件**输出为空**；E6 实测 6367146/`8f9f37ca…`、801/`6ac8c8dc…`、1064/`1c8f573e…` |
| R6.6 artifact 常量除 `modelIds` 外不变 | 达成 | `deepseek-v4-tokenizer.ts:8-11`、`:32-39`、`:92-99` 值全部与 spec 1.3 一致 |
| R6.7/R6.8 V4-Pro `modelVersion` 与 4 组价格不变 | 达成（值正确，断言缺失） | `deepseek-official-pricing.ts:81-85` 值正确；`it.each` 覆盖 4 组三元组，但 `modelVersion` 无断言 → **F3（low）** |
| R6.9/R6.9b 不处置 Q2、别名重计费不波及 V4-Pro | 达成 | V4-Pro 行未被 Flash 价覆盖；两种偏离 (a)(b) 均未发生 |
| R6.10 V4-Pro 文本身份不变 | 达成 | R-3（`:42-48`）断言 `tokenizerId`/`tokenizerRevision` |
| R6.11 七条机检断言 | 6/7 达成 | 1~4、6、7 有测试（R-3/R-4/R-7/M-3 + verify:release 资产门）；**第 5 条**（`modelVersion` + 四组价格）值正确但 `modelVersion` 无断言 → 并入 **F3** |

---

## 3. 计划 §13 Definition of Done 逐条可达性

| DoD 条目 | 判定 | 证据 |
| --- | --- | --- |
| `pnpm typecheck && test && build && test:built && verify:release && test:e2e:packed` 全通过 | ✅ 达成 | E9 六门全绿（packed E2E 需 `npm_config_cache` 规避本机 npm cache 属主问题） |
| `deepseek-flash` 路由解析 `exact-tokenizer` | ✅ 达成 | R-1/R-2 + M-2 |
| 产出 priced adaptive decision | ✅ 达成 | 定价解析成功（P-1~P-7）；`index.ts:806-833` 把 `inputCacheHit`/`inputCacheMiss` 直接喂给 `decideConservativeAdaptive`；审查者手算复核翻转成立。**唯一缺口是 P-9f 命名测试**（F2） |
| 视觉 surface 报告重生成的 V4.1 golden 值 | ✅ 达成 | V-2/V-7/V-8 + M-7（206）+ M-9（1024）+ packed smoke 硬断言 317/1024 |
| `gitnexus detect_changes --scope all` clean（非 partial/truncated） | ✅ 达成 | E10：无 `partial`/`truncated`；`risk_level: high` 与计划 Finding 6 的预期一致 |
| README/README.zh/CHANGELOG/THIRD_PARTY_NOTICES 列出 `deepseek-flash` 及 pinned revision | ⚠️ **部分达成** | README.md ✅（含"由谁服务"表）；CHANGELOG.md ✅（Unreleased 条目）；THIRD_PARTY_NOTICES.md + runtime TPN ✅。**README.zh.md 支持模型表未更新** → **F7（medium）**；**runtime README EN/ZH 归属写反** → **F8（medium）** |

### 计划 §12 Assumption A2（兼容旧名是否仍路由 V4.1）

**判定：❌ 未在交付文档中保留为可复核的假设。**

- A2 全文（计划 `:902`）：别名"route to V4.1-Flash (docs say *temporarily*)，故今日迁到 V4.1 artifact 正确，但**别名被撤回时必须重新评估**"。计划 `:877` 另有一条提醒："re-read pricing 页 before relying on it"。
- 全仓搜索：A2 的**唯一**出现处是只读的计划文件（`:877`、`:902`）。冻结 spec **未**收录 A2（spec 的附录 C 只冻结了 Q1/Q2/Q3 与 t7，无 A2），README/CHANGELOG 也未保留"撤回时重评"的触发条件。
- 更关键的是：E5 显示官方脚注 (1) 现已明示两个旧名"**对应模型已下线**"（retired），这比计划 A2 的措辞"docs say *temporarily*"**更强**——A2 的前提描述已过时，而它没有被任何交付文档承接或更新。spec §3.3 引用了脚注原文，因此**事实**被捕获，但**假设与重评触发条件**被静默丢弃 → **F9（medium）**。

### 计划要求但被静默省略的内容

| 计划要求的文档 | 状态 |
| --- | --- |
| `README.md` | ✅ 已更新（支持表 + 视觉散文 + IMPORTANT 提示 + pinned revision） |
| `README.zh.md` | ⚠️ 散文与 IMPORTANT 提示已更新，**支持模型表未更新** → F7 |
| `CHANGELOG.md` | ✅ 新增 `## Unreleased`；旧条目（含 `6821d6ad…`、384 算术）**未被改写**，符合 R5.10 |
| `THIRD_PARTY_NOTICES.md` | ✅ vision-exp 归属替换为 V4.1-Flash |
| `packages/runtime/THIRD_PARTY_NOTICES.md` | ✅ 同上，且"serves"列表已改 |
| `packages/runtime/README.md` / `README.zh.md` | ⚠️ 已更新但**归属写反** → F8 |
| `packages/runtime/package.json` `files` | ✅ 已更新 |

**R5.9（免责声明不得删除）**：README.md / README.zh.md 均保留了"adapter 最终图片投影不可公开观测 → 估算不精确"的免责声明，且未据此宣称图片计数为 exact ✅。附带发现：README.md 从免责声明中删去了"absolute prompt position"字样（因块长现已位置无关，此举合理），但 `measurement.ts:299` 的源注释**仍**声称估算不精确是因为"the absolute prompt position … 未公开"，与实现自相矛盾 → 并入 **F10（low）**。

---

## 4. 结构化 Findings

> 字段：id / severity / file:line / problem / requiredFix。所有 finding 均为**文档、测试证据或注释**层面，**无一条涉及算术、映射或定价的行为错误**。

### F1 — R4.14 fail-closed 安全不变量无任何测试证据

- **id**: F1
- **severity**: `medium`
- **file:line**: `packages/runtime/src/measurement.ts:199-201`、`packages/runtime/src/measurement.ts:382-384`（守卫）；缺失断言应落在 `packages/runtime/tests/public/public-runtime.spec.ts`
- **problem**: spec R4.14 要求"同一测量内若出现两个不同的 `estimatorId`/`estimatorRevision`，必须 fail-closed 为 `unavailable`（reason 含 `image estimator identity changed within one measurement`）"，并明确该条与 R2.12 的 `estimatorRevision` 升级绑定（"旧缓存审计行与新行不得被当作同一估算器"）。守卫代码两处均存在且措辞正确，但**全仓 `tests/` 下搜索该 reason 零命中**——没有任何测试构造出两个不同估算器身份的节点，也没有测试证明该分支会 fail-closed。这是本次变更中**唯一一条 spec 明确列为必须机检、却完全无测试证据的安全不变量**。在 fail-closed 体系里，"守卫存在"与"守卫生效"必须由测试区分；若将来有人把 `firstRefusal ??=` 改成 `??` 或调整比较顺序，测试套件不会变红。
- **requiredFix**: 在 `packages/runtime/tests/public/public-runtime.spec.ts` 新增一条测试（建议命名 `fails closed when two image estimator identities appear in one measurement`）：构造同一测量内两个含图片节点、令其 `estimatorId`/`estimatorRevision` 不同（可通过 monkey-patch 估算器身份常量或注入混合估算器的最窄可行 seam），断言聚合结果 `kind === 'unavailable'` 且 `reason` 含 `image estimator identity changed within one measurement`。若现有 seam 无法从测试侧注入第二身份，须在 findings 中说明并改为断言 `measurement.ts` 的两处守卫可通过单元级导出被覆盖，不得以"代码看起来对"结案。

### F2 — P-9f 命名测试缺失（R3.2c 的动因未被机检固定）

- **id**: F2
- **severity**: `low`
- **file:line**: `packages/runtime/tests/deepseek-official-pricing.spec.ts`（应新增）；对照 `docs/specs/2026-09-23-deepseek-v4.1-flash-support-spec.md:571`
- **problem**: spec P-9f 要求：把 `resolveOfficialDeepSeekPrice('deepseek-v4-flash')` 取出的 `inputCacheHit`/`inputCacheMiss` 喂给 `decideConservativeAdaptive`（`reclaimedLowerBoundTokens=1000`、`affectedRetainedSuffixUpperBoundTokens=25`），断言取自**旧价**时 `allowHistory === true`、取自 **Flash 价**时 `allowHistory === false` 且 `reason === 'cache-risk-not-clearly-paid-back'`。该测试**不存在**：没有任何测试文件同时 import `deepseek-official-pricing` 与 `adaptive-cost`（审查者已逐文件核对）。行为本身**已交付**（审查者手算：Flash 价 `3e9 > 3.675e9` 为假→deny；旧价 `7e9 > 5.325e9` 为真→allow），但 R3.2c 之所以把这条修正定义为"不是账面问题"，正是靠这个翻转来证明；缺了它，未来若有人把两个别名行改回旧价，`P-9*` 系列与 `adaptive-cost.spec.ts` 的硬编码费率**都不会变红**。
- **requiredFix**: 在 `packages/runtime/tests/deepseek-official-pricing.spec.ts` 新增 P-9f 命名测试，从 `resolveOfficialDeepSeekPrice` 实际取值（不得硬编码 `'0.003'`/`'0.15'`）后调用 `decideConservativeAdaptive`，断言上述两个 `allowHistory` 值与 `reason`。

### F3 — V4-Pro `modelVersion` 无断言（P-8 / P-9e / R6.11-5 的机检缺口）

- **id**: F3
- **severity**: `low`
- **file:line**: `packages/runtime/tests/deepseek-official-pricing.spec.ts:21-24`（覆盖 V4-Pro 四组三元组但无 `modelVersion`）
- **problem**: spec P-8 要求 `keeps the deepseek-v4-pro tuple unchanged` 并断言 `modelVersion === 'DeepSeek-V4-Pro-0813'`；P-9e 与 R6.11 第 5 条同样要求。现有 `it.each` 只断言四组价格字符串，**全仓无任何测试断言 V4-Pro 的 `modelVersion`**（审查者已确认 `DeepSeek-V4-Pro-0813` 在 `tests/` 下仅作为 `adaptive-cost.spec.ts` 的无关 `tokenizerRevision` 夹具出现）。源码值**正确**（`deepseek-official-pricing.ts:82`），故属断言缺口而非行为缺口；但它恰好是 ⑥ 的核心保护对象之一。
- **requiredFix**: 在 `deepseek-official-pricing.spec.ts` 的 V4-Pro 用例中补 `expect(record.modelVersion).toBe('DeepSeek-V4-Pro-0813')`，并在 P-9e 语义下断言该行未被 Flash 价覆盖。

### F4 — R2.8 的 `assert num_image_tokens <= max_n_token` 未移植

- **id**: F4
- **severity**: `low`
- **file:line**: `packages/runtime/src/deepseek-v4-vision-tokens.ts:275-281`（对照官方 `inference/image_processor.py:63-66`）
- **problem**: spec R2.8 的冻结伪码在第 3 步明确包含 `断言 nLlmH*(nLlmW+1)+2 <= 1024`，官方实现亦以 `assert` 落地。移植版在单次 `solveResizeRatio` 后直接返回网格，**未保留该断言**。审查者以 423,200 组尺寸（含 1×1、13×14、543/544/545、10000×10、10×10000、60,000² 内随机）模糊测试移植实现，**0 例超限**，最大块长恰为 1024，故当前**无可达行为缺陷**；但按 spec 的字面要求，该防御性断言属于 R2.8 的一部分，缺失后任何未来对 `solveResizeRatio` 的改动都不会被断言拦下。
- **requiredFix**: 在 `safeResize` 单次求解后补回上界检查，并以与 `R4.4` 一致的 fail-closed 风格抛出（或返回可审计的失败而非静默返回可能超限的网格）。若决定不补，须由 captain 明确记录为对 R2.8 的有意偏离并同步 spec 文本，不得静默省略。

### F5 — R4.7 / R4.8 / R4.9 与 M-4 / M-8 的 reason 断言缺失

- **id**: F5
- **severity**: `low`
- **file:line**: `packages/runtime/tests/public/public-runtime.spec.ts:2605-2624`（M-4/M-8 场景只断言 `kind`）
- **problem**: M-4 要求断言 `reason` 含 `is not the supported DeepSeek route`，M-8 要求断言 `view.intrinsicImageBlockEstimateTokens` 与图片节点诊断为空/`undefined`；R4.8 还要求断言 provider/model 为 `undefined` 时的两条 reason。实际测试只断言 `kind === 'unavailable'`，且全仓 `tests/` 下搜索 `is not the supported DeepSeek route`、`no durable provider/model request header`、`canonical text: provider` **均零命中**。行为已交付（`measurement.ts:273-278`、`:335-337` 模板正确），但 reason 是这些不变量的可审计契约，只断 `kind` 无法区分"因 provider 被拒"与"因其他原因不可用"。
- **requiredFix**: 在 `:2605` 用例补 `expect(count.reason).toContain('canonical image: provider "openai" is not the supported DeepSeek route')` 与 `expect(view.intrinsicImageBlockEstimateTokens).toBe(0)`；另增一条无 request header（provider/model 为 `undefined`）的用例，断言 R4.8 的两条 reason 模板。

### F6 — Registry 合并测试名不符合 R5.0 的命名要求

- **id**: F6
- **severity**: `low`
- **file:line**: `packages/runtime/tests/deepseek-v4-tokenizer.spec.ts:118`
- **problem**: R5.0 要求"新增测试名须与下表一致或为下表测试名的超集"。R-11/R-12/R-13/R-15 四条被合并为单个测试 `fails closed on byte-length, SHA-256, and JSON corruption for the V4.1-Flash artifact without touching the text artifact`，该名称既不等于表中任何一条，也不是四条名字的超集（它未包含 "keeps the V4-Pro artifact serving after a V4.1-Flash corruption" 的语义表述）。行为覆盖完整（三条抛错分支 + 跨族隔离均被断言），仅命名契约不符。
- **requiredFix**: 拆分或重命名为能覆盖 R-11/R-12/R-13/R-15 语义的名称（例如分别保留四条 `it(...)`），或由 captain 明确接受"合并即视为超集"的解释并同步 spec R5.0 措辞。

### F7 — `README.zh.md` 支持模型表未更新（R5.8 明文要求）

- **id**: F7
- **severity**: `medium`
- **file:line**: `README.zh.md:50-56`
- **problem**: R5.8 的"支持模型表"行明确要求 `README.md` / `README.zh.md` 的**表格**中补上 `deepseek-flash`，并注明服务归属。实际 `README.zh.md:50-56` 的表**仍只有** `deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp` 三行，**既没有 `deepseek-flash` 行，也没有"由谁服务"列**；同文件的 IMPORTANT 提示（`:15`）与散文（`:58`）虽已更新，但用户最先看到的模型支持表仍是旧集合。对照 `README.md:50-56` 已正确改为 6 行含 `deepseek-flash` 与 `Served by` 列——中英两版对同一事实给出**不同**的模型支持集合。R5.8 自身规定"文案与实现不符属 spec 违背"，且该规则末尾明确此类偏离判 `needs_revision`。这正是本次 review 要抓的"测试全绿但用户可见行为未交付"缺口：没有任何测试会检查文档表格。
- **requiredFix**: 把 `README.zh.md:50-56` 的表改为与 `README.md:50-56` 结构一致：新增 `deepseek-flash` 行，增加"服务方"列，标注 `deepseek-flash`/`deepseek-v4-flash`/`deepseek-v4-flash-vision-exp` 由 `DeepSeek-V4.1-Flash` 服务、`deepseek-v4-pro` 由 `DeepSeek-V4-Pro` 服务。

### F8 — runtime README（EN/ZH）的"由谁服务"归属写反，与 ①.1 / R6.10 矛盾

- **id**: F8
- **severity**: `medium`
- **file:line**: `packages/runtime/README.md:7`、`packages/runtime/README.zh.md:7`
- **problem**: 两处散文按顺序列出四个 id（`deepseek-flash`、`deepseek-v4-flash`、`deepseek-v4-pro`、`deepseek-v4-flash-vision-exp`）后写道"**the first three** are served by DeepSeek-V4.1-Flash and **the last** by DeepSeek-V4-Pro"（中文同义："前三个由 DeepSeek-V4.1-Flash 服务，最后一个由 DeepSeek-V4-Pro 服务"）。按该顺序，"前三个"包含 `deepseek-v4-pro`，"最后一个"是 `deepseek-v4-flash-vision-exp`——**两个归属都写反了**：①.1 映射表与 R6.10 明确 `deepseek-v4-pro` 由 V4-Pro artifact 服务，`deepseek-v4-flash-vision-exp` 由 V4.1-Flash artifact 服务。这与 `README.md:50-56` 的正确表格**直接矛盾**，是发布包内用户可见的事实错误（`packages/runtime/README.md` 随 npm 包分发）。注意：实现本身正确，错误纯在文档措辞。
- **requiredFix**: 把两句改为按 id 点名归属（避免"前三个/最后一个"这类位置表述），例如："`deepseek-flash`, `deepseek-v4-flash`, and `deepseek-v4-flash-vision-exp` are served by DeepSeek-V4.1-Flash; `deepseek-v4-pro` keeps its own DeepSeek-V4-Pro artifact." 中文版同步。

### F9 — 计划 §12 Assumption A2 未被交付文档承接，且其前提措辞已过时

- **id**: F9
- **severity**: `medium`
- **file:line**: `docs/plans/2026-09-23-gitnexus-plan-v41-flash-support.md:902`（唯一出处）；`docs/specs/2026-09-23-deepseek-v4.1-flash-support-spec.md` 附录 C（应承接而未承接）
- **problem**: A2 冻结了一条可复核假设——两个旧名"temporarily"路由 V4.1，**别名被撤回时必须重新评估**。全仓搜索确认 A2 只存在于只读计划文件；冻结 spec 的附录 C 只冻结了 Q1/Q2/Q3 与 t7，**未收录 A2**；README/CHANGELOG 也未保留"撤回时重评"的触发条件。同时，官方定价页（审查者 E5 复核）现已明示两个旧名"**对应模型已下线**"（retired），比 A2 的"docs say *temporarily*"更强——即 A2 的**前提描述已过时**，却没有任何交付文档承接或更新它。结果：后续维护者若只看 spec 与 README，会以为别名路由是永久冻结的契约，而计划里那条"须重评"的提醒已随计划文件一起沉底。
- **requiredFix**: 在冻结 spec 的附录 C（或 ① 的映射表下）新增一条 A2 处置行，记录：(a) 两个旧名当前仍路由 V4.1-Flash 并按其计费；(b) 官方脚注 (1) 已把它们标为 retired，故该路由是**兼容期行为**而非永久契约；(c) 一旦官方撤回旧名，须重新评估 ①.1 映射与 ③ 的别名计费行。同步在 `CHANGELOG.md` 的 Unreleased 条目补一句"revisit when the aliases are withdrawn"。**注意**：本条要求的是"记录假设"，**不是**要求现在改变任何映射或价格——现状（别名仍路由 V4.1、按 Flash 价计费）是正确且已被 E5 验证的。

### F10 — `measurement.ts` 源注释仍描述已废弃的 V4-Flash 算术

- **id**: F10
- **severity**: `low`
- **file:line**: `packages/runtime/src/measurement.ts:65`、`:299`、`:303`、`:326`
- **problem**: 四处注释仍是旧算术措辞，与已交付的 V4.1 行为矛盾：`:65` 与 `:326` 称诊断评估在"two alignment-padding extremes (**compress-pad 0 and 3**)"，但 V4.1 已无 compress pad（R2.4 明确删除）；`:299` 称图片计数不精确的原因是"**the absolute prompt position** … not exposed"，而 R2.5/R2.3 已使块长与位置无关，README 也已相应删去该理由；`:303` 仍写"use the **midpoint of the four alignment residues** as a bounded estimate"，正是 R5.8/R5.9 点名要删除的旧表述。这些注释会进入 `lib/index.d.ts` 的公开文档面（`IntrinsicImageBlockDiagnostic` / `intrinsicImageBlockEstimateTokens` 的 doc 注释随包分发）。R5.8 的字面作用域是 README/CHANGELOG/TPN，不含源码注释，故不构成 spec 条文的直接违背；但 spec 的判据精神是"文案与实现不符属 spec 违背"，且这是审计行语义的说明文字。
- **requiredFix**: 更新这四处注释：删除 compress-pad 0/3 的表述，改为"intrinsic block length, position-independent under V4.1"；删除"absolute prompt position 不可观测"作为估算不精确的理由（保留 adapter 最终图片投影与像素预算覆盖不可观测这一仍成立的理由）；把"midpoint of the four alignment residues"改为"the position-independent block length（min/max 相等）"。

### F11 — `PROVENANCE.md` 的 sweep 计数笔误（160 vs 162）

- **id**: F11
- **severity**: `low`
- **file:line**: `packages/runtime/tests/fixtures/PROVENANCE.md:83`、`:86`
- **problem**: 该文档自称"a **160-case** sweep … Result: **160/160** identical"，但提交的 `vision-official-sweep.json` 实际有 **162** 例（`SWEEP_SIZES` 42 项 + `SWEEP_RANDOM_CASES` 120 = 162，审查者已数过并独立复算 162/162 一致），t2 的自述也写"162 例"。一份以"可复核性锚点"为目的的 provenance 文档把自己的证据基数写错，会直接误导复核者（按 160 去核对会得到对不上的结论）。
- **requiredFix**: 把 `:83`、`:86` 的 160 改为 162，并复核 `:82-87` 全段是否还有其他与 fixture 不符的数字（`maximum 1017`、`no cap violation` 经审查者 E3 复核为**正确**）。

---

## 5. 未构成 finding 但值得记录的三点

1. **规格自身的内部矛盾（R5.8）**：`docs/specs/…spec.md:643` 要求 README 注明"前三者由 `DeepSeek-V4.1-Flash` 服务、`deepseek-v4-pro` 由 `DeepSeek-V4-Pro` 服务"——但同句列出的"前三者"（`deepseek-flash`、`deepseek-v4-flash`、`deepseek-v4-pro`）**包含** `deepseek-v4-pro`，与后半句自相矛盾，也与 ①.1 / R6.10 矛盾。t2 在 `README.md:50-56` 按 ①.1 的正确语义落地（`deepseek-v4-pro` → `DeepSeek-V4-Pro`），这是**正确选择**。建议 captain 修 spec 措辞，并**明确禁止**后续任何人为了让文档"符合 R5.8 字面"而把 V4-Pro 标成 V4.1 服务。此条是 spec 缺陷，不是 t2 的 finding。
2. **`PROVENANCE.md` 与 fixture 的位置**：该文档位于 `packages/runtime/tests/fixtures/`（不在 spec 附录 A 的"必须修改"清单内，也不在"明确禁止修改"清单内）。它记录官方 revision、参数、sweep 覆盖与一个已知分歧（官方 `load_image` 对 100000×1 在 PIL 层抛错、移植无此失败模式）。审查者复核该分歧：`deepseek-v4-vision-sweep.spec.ts:88-98` 已用测试固定移植的有界返回行为，且 fixture 的最大宽高比止于 10000×10——处理得当，**不构成 finding**。
3. **`measurement.ts` 的 `intrinsicImageBlockEstimateTokens` 语义未变**：`measurement.ts:90` 仍标注它是"a diagnostic, not a token bound"，V4.1 下 min/max 相等使其成为官方块长本身。语义未变、无回归，仅 F10 的措辞需同步。

---

## 6. Verdict 自洽性说明

| 判据 | 结果 |
| --- | --- |
| 存在 blocker 或 high finding？ | **否**（最高为 medium） |
| 核心行为（① ② ③ ④ ⑥）是否交付？ | **是**，且经独立复现（E1~E10） |
| 是否存在 spec 明文判 `needs_revision` 的偏离？ | **是** —— R5.8 被违背（F7：README.zh 支持表未更新；R5.8 末尾明文"此类偏离判 `needs_revision`"） |
| 是否存在 spec 明确要求机检、却无测试证据的安全不变量？ | **是** —— R4.14（F1） |
| 是否存在交付文档与实现事实矛盾？ | **是** —— F8（runtime README 归属写反）、F10（源注释） |
| 是否存在计划要求的可复核假设被静默省略？ | **是** —— 计划 §12 A2（F9） |
| 因此 verdict | **`needs_revision`** |

**给 t6（集成）的建议路径**：F1~F11 **全部是文档/测试/注释层面的定点修复，不需要触碰 `deepseek-v4-vision-tokens.ts` 的算术、`deepseek-v4-tokenizer.ts` 的映射或 `deepseek-official-pricing.ts` 的价格值**（这些已被独立验证为正确）。修复后重跑 `pnpm test` 与 `pnpm verify:release` 即可；`README.zh.md` 与两个 runtime README 的改动需人工复核（无自动化门）。修完后建议以 `needs_revision` 的 findings 清单为输入做一次定点复审，而非全量重审。

---

**审查者声明**：本审查仅读取仓库与官方来源，**未修改** `packages/` 或 `scripts/` 下任何文件（本文件是唯一产出，位于 `docs/reviews/`）。E1 的官方文件下载仅写入 `/tmp`。审查期间创建的临时探针脚本均已删除（`packages/runtime/tests/t4-tok-probe.mjs`、`t4-fuzz.mjs`），`npm_config_cache` 指向 `/tmp/t4-npmcache`，未污染仓库或用户 npm cache。
