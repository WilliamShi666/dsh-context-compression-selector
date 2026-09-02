# dsh-context-compression-selector

这是可直接安装的非官方社区 DeepSeek Harness 上下文压缩选择器 Product Bundle。

**0.1.0 更新：**已加入 DeepSeek V4 Flash 视觉模型的官方 tokenizer；用户可选择模型驱动 Auto Compact 的触发阈值；标准 Profile 的水位与压缩参数会随该选择联动。

```sh
dsh plugin --profile web add dsh-context-compression-selector@latest
dsh --profile web --dump-config
```

这一条命令会自动安装精确版本的 `dsh-context-compression-selector-runtime` 依赖。Bundle 提供 Host 设置、Web UI 和可逆 preset overlay。除 id 精确等于内置 `minimal` 的 preset 外，其他 preset 都会获得压缩能力；非 Minimal preset 之间切换时已保存设置保持不变。Minimal 只暂停插件压缩，不删除设置。

已验证兼容 DeepSeek Harness `dsh-v0.1.1-rc.2` 与 `dsh-v0.1.2-alpha.5`，Node `^22.19.0 || >=24`。不需要修改 Harness 核心。

Profile、默认值、审计证据、Adaptive/cache 限制、升级/卸载与安全说明见[完整 README](https://github.com/WilliamShi666/dsh-context-compression-selector#readme)。本包与 DeepSeek 无隶属或背书关系。
