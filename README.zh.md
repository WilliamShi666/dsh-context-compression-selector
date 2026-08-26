# dsh-context-compression-selector

[English](README.md) | 中文

这是面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的非官方社区 Product Bundle。它在不修改 Harness 核心的前提下，提供 Web 压缩 Profile 选择器和可审计、无模型调用的工具上下文压缩运行时。

## 一个插件、两个包

用户只安装入口包 `dsh-context-compression-selector`。它会精确依赖并自动安装 `dsh-context-compression-selector-runtime`；后者包含 reducer、恢复工具、审计、TailTrim 与经校验的离线 DeepSeek tokenizer。两个包只是保持 Host/UI 与运行时职责分离，不意味着用户要执行两次安装。

| 包 | 职责 | 用户是否直接安装 |
|---|---|---:|
| `dsh-context-compression-selector` | DSH Bundle、设置 UI、preset overlay | 是 |
| `dsh-context-compression-selector-runtime` | 压缩运行时库/插件 | 否；自动安装 |

## 兼容性

| 插件版本 | 已验证 Harness | Node.js |
|---|---|---|
| `0.1.0-beta.1` | `dsh-v0.1.1-rc.2` / 公开包 `0.1.1-rc.2` | `^22.19.0` 或 `>=24` |

暂不声称兼容其他 Harness 版本。有损改写目前只对 bundled tokenizer 明确验证过的模型 id 开放：`deepseek-v4-flash`、`deepseek-v4-pro`。未知模型 fail-open，保留原上下文。

## 安装

把 NPM Bundle 安装到某个 Harness profile（例如 `web`）：

```sh
dsh plugin --profile web add dsh-context-compression-selector@beta
dsh --profile web --dump-config
```

配置 dump 应出现 `# == dsh-context-compression-selector` 层。之后用您原有的 WSL Harness 管理方式启动或重启该 profile；不要为了安装插件再启动一个重复 Harness。

升级与卸载：

```sh
dsh plugin --profile web up dsh-context-compression-selector
dsh plugin --profile web remove dsh-context-compression-selector
```

Bundle 会增强除 id 精确等于内置 `minimal` 之外的 preset。非 Minimal preset 之间切换时，已保存的压缩设置保持不变；Minimal 只暂停插件压缩，不删除设置，离开 Minimal 后设置重新可用。

## Profile 与默认值

UI 提供 `off`、`native`、`balanced`、`cache-strict`、`savings`、`adaptive`、`custom`。Custom 的日常 token 默认值为：

- Fresh `8192 -> 3072`
- Aggregate `32768 -> 12288`
- History 触发 `500000`，保留 4 轮 / `128000` tokens，最少回收 `96000`
- `prefixPolicy=pressure-break`
- TailTrim 默认关闭，触发 `700000`

某个 Session 第一次被当前挂载的 runtime 观察时，会冻结完整设置文档。之后更改设置只影响随后首次观察到的 Session，不会改写该旧 Session 的冻结策略。runtime remount 或 Host 重启会开启新的进程内冻结生命周期。

## 运行证据

Harness 日志中的结构化行以 `context-compression audit ` 开头，其后的 JSON 会严格区分：

- `policy-frozen`、`policy-resolved`；
- `component-evaluation`：组件关闭/跳过及原因和阈值；
- `rewrite`：仅在标准 `compaction/prune` 与 replacement 都提交后记录，包含 component、stage、reducer、exact token 前后值、tokenizer 身份和 Session event seq；
- `failure`：fail-open 的运行时错误；
- `native-auto-compact`：只在核心真正提交 `compaction/summary` 后记录。

因此 Fresh、Aggregate、History、TailTrim、插件 Native 工具结果压缩与核心 Native auto-compact 不会混为一谈。日志不记录 prompt、工具参数、工具结果正文或凭证。

`policy-frozen` 会记录该 Session 首次到达 runtime 时观察到的完整选择器设置与已解析 deployment 配置。它属于 Harness logger 记录，不是自定义 Session event，因此保留期限取决于部署者的 Harness 日志 sink；需要长期审计时必须保留这些日志。已提交的上下文改写仍会以官方 `compaction/prune` 加 replacement 的形式独立持久化在 Session log 中。Harness `0.1.1-rc.2` 没有公开稳定的插件专属数据目录 API，所以本版不会自行猜测或硬编码 `~/.dsh` 下的路径。

TailTrim 只属于 Custom 且默认关闭。它只使用官方 `compaction/prune` 加 `user/message` replacement，每个边界最多替换一个完整结束、无错误的纯工具组，并通过插件自有的 `context_compression_retrieve` 恢复；原事件仍保留在 append-only Session log 中。

## Usage、Adaptive 与缓存限制

runtime 只使用公开 Session request header/context 和官方 `TokenMeter.measure()`。只有 official baseline 明确给出 usage 时才把它当作请求级真值。`0.1.1-rc.2` 的公开接口没有提供足够的 route-keyed cache split 信息来证明普通 Adaptive History 的成本收益，所以成本 gate 会 fail-closed；确认的容量压力是独立的安全 override。内置价格表需要人工维护，它只是估算，不能归因到某条工具结果。

fork 子智能体通过 Harness 原生行为继承父 Session 前缀，spawn 不继承。本项目会验证 fork 的序列化前缀一致，但没有实现 provider 专用 prefix id、breakpoint、TTL 或跨 Session cache API。若请求序列化前缀恰好相同，DeepSeek 服务端可能自然复用。只有官方 response usage 给出一致的请求级 cache hit/miss 字段时才能声称命中；无法据此判断具体哪条工具结果命中。

## 开发与验证

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm typecheck
pnpm build
pnpm verify:release
pnpm pack:dry-run
```

发布门禁还会把两个真实 tarball 安装到未修改的官方 Harness `dsh-v0.1.1-rc.2` checkout。workspace 源码测试不能代替 packed-install 证据。

## 安全与许可

安全问题请按 [SECURITY.md](SECURITY.md) 报告。本项目使用 MIT 许可，与 DeepSeek 无隶属或背书关系。DeepSeek Harness 衍生代码与 bundled 官方 tokenizer 的来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
