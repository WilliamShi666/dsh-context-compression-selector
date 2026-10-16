# dsh-context-compression-selector

The installable Product Bundle for the unofficial community DeepSeek Harness context-compression selector.

**0.2.1 highlights:** The same artifact now runs on DeepSeek Harness 0.2.x as well as 0.1.x — every `@deepseek-ai/dsh-*` peer widens to `^0.1.1-rc.2 || ^0.2.0-rc.1`, and the selector acquires its settings surface by capability rather than by version, so there is no 0.1.x or 0.2.x package to choose between. Web boot no longer aborts on 0.2.0, live settings editing works through the entry's volatile config fields, and the selected profile now reaches the generated composition. On 0.2.0 the Custom policy is selectable but not editable, because that generation's settings form serves only the entry's volatile fields; the UI withholds the editor rather than dropping edits silently. 0.2.1 fixes a blank settings panel on 0.2.0 (React error #185), so upgrade if you installed 0.2.0. No Harness core code is modified.

```sh
dsh plugin --profile web add dsh-context-compression-selector@latest
dsh --profile web --dump-config
```

This one command automatically installs the exact `dsh-context-compression-selector-runtime` dependency. The Bundle contributes Host settings, the Web UI, and a reversible preset overlay. All presets except the exact built-in `minimal` id receive the compression stack; switching non-Minimal presets preserves the saved selector settings. Minimal pauses plugin compression without deleting the setting.

Verified compatibility: DeepSeek Harness `dsh-v0.1.1-rc.2`, `dsh-v0.1.2-alpha.5`, and `dsh-v0.2.0-rc.2`, Node `^22.19.0 || >=24`. No Harness core patch is required.

See the [full README](https://github.com/WilliamShi666/dsh-context-compression-selector#readme) for profiles, defaults, audit evidence, Adaptive/cache limitations, upgrade/removal, and security guidance. This package is not affiliated with or endorsed by DeepSeek.
