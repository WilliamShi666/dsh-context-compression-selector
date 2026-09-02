# dsh-context-compression-selector

The installable Product Bundle for the unofficial community DeepSeek Harness context-compression selector.

**0.1.0 highlights:** DeepSeek V4 Flash Vision's official tokenizer is included; users can choose the model-driven Auto Compact threshold; standard profile watermarks and compression parameters follow that choice.

```sh
dsh plugin --profile web add dsh-context-compression-selector@latest
dsh --profile web --dump-config
```

This one command automatically installs the exact `dsh-context-compression-selector-runtime` dependency. The Bundle contributes Host settings, the Web UI, and a reversible preset overlay. All presets except the exact built-in `minimal` id receive the compression stack; switching non-Minimal presets preserves the saved selector settings. Minimal pauses plugin compression without deleting the setting.

Verified compatibility: DeepSeek Harness `dsh-v0.1.1-rc.2` and `dsh-v0.1.2-alpha.5`, Node `^22.19.0 || >=24`. No Harness core patch is required.

See the [full README](https://github.com/WilliamShi666/dsh-context-compression-selector#readme) for profiles, defaults, audit evidence, Adaptive/cache limitations, upgrade/removal, and security guidance. This package is not affiliated with or endorsed by DeepSeek.
