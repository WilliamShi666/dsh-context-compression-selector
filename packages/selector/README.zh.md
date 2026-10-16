# dsh-context-compression-selector

这是可直接安装的非官方社区 DeepSeek Harness 上下文压缩选择器 Product Bundle。

**0.2.1 更新：**同一份产物现在可同时运行在 DeepSeek Harness 0.2.x 与 0.1.x 上——所有 `@deepseek-ai/dsh-*` peer 范围放宽为 `^0.1.1-rc.2 || ^0.2.0-rc.1`，选择器按能力而非按版本获取设置界面，因此不存在需要二选一的 0.1.x 与 0.2.x 包。0.2.0 上 web 启动不再中断，实时设置编辑经由入口的 volatile 配置字段生效，所选档位也能传递到生成的 composition。在 0.2.0 上 Custom 策略可选但不可编辑，因为该代设置表单只服务于入口的 volatile 字段；界面不显示该编辑器，而不是静默丢弃编辑。0.2.1 修复了 0.2.0 上设置面板空白的问题（React error #185），若你安装的是 0.2.0 请升级。不修改 Harness 核心代码。

```sh
dsh plugin --profile web add dsh-context-compression-selector@latest
dsh --profile web --dump-config
```

这一条命令会自动安装精确版本的 `dsh-context-compression-selector-runtime` 依赖。Bundle 提供 Host 设置、Web UI 和可逆 preset overlay。除 id 精确等于内置 `minimal` 的 preset 外，其他 preset 都会获得压缩能力；非 Minimal preset 之间切换时已保存设置保持不变。Minimal 只暂停插件压缩，不删除设置。

已验证兼容 DeepSeek Harness `dsh-v0.1.1-rc.2`、`dsh-v0.1.2-alpha.5` 与 `dsh-v0.2.0-rc.2`，Node `^22.19.0 || >=24`。不需要修改 Harness 核心。

Profile、默认值、审计证据、Adaptive/cache 限制、升级/卸载与安全说明见[完整 README](https://github.com/WilliamShi666/dsh-context-compression-selector#readme)。本包与 DeepSeek 无隶属或背书关系。
