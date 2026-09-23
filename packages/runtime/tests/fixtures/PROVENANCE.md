# V4.1-Flash vision arithmetic — official-implementation evidence

This note records how the V4.1-Flash vision numbers in
`packages/runtime/tests/fixtures/vision-golden.json` were produced and how the
Node port was cross-checked against the official Python implementation. It
exists so a reviewer can re-verify the arithmetic without re-deriving it.

## Source actually executed

| Fact | Value |
| --- | --- |
| Repository | `deepseek-ai/DeepSeek-V4.1-Flash` |
| Revision | `dba1be0a40aa45a94ad051997016db3960a90277` |
| Files | `inference/image_processor.py`, `config.json` |
| `image_processor.py` SHA-256 | `482759e3bcc4e9bb5ee582b244cc563f5d0e163d8b48dda91ebb7106e62f9272` |
| Interpreter | `torch 2.8.0` + `pillow 11.3.0` |

Reproduce the fixture:

```bash
# Reuses an existing image_processor.py / config.json in the workdir, so no
# network access is needed when they are already present.
python3 scripts/generate-vision-fixtures.py --workdir <dir-with-pinned-files>
```

The generator never re-implements the arithmetic: every fixture number is
`official.num_image_tokens(n_llm_h, n_llm_w)` (cross-asserted against
`official.image_token_types(...).numel()`) after `official.load_image(...)`.

## Config shape

V4.1 publishes the visual parameters nested under `config["vision_config"]`
(`patch_size`, `downsample_ratio`, `max_image_tokens`, `min_pixels`,
`max_wh_ratio`), not as the flat top-level `vision_*` keys the retired revision
used. `scripts/generate-vision-fixtures.py` reads the nested shape first and
falls back to the flat keys, so it stays reproducible against either pinned
revision.

`vision_max_wh_ratio` is JSON `null`, so both clamp sites in the official code
are inert. The TS port models this as `undefined` behind an explicit
`!== undefined && !== null` guard; it must never degrade into a tautology such
as `width >= 0`.

## Cross-checks against the official implementation

Every value below was produced by executing the official code, then compared
with the frozen table in
`docs/specs/2026-09-23-deepseek-v4.1-flash-support-spec.md` §5.3.1: **31/31
rows matched**, and the maximum block length over the fixture is 1001 (≤ 1024).

The 28 original sizes plus 3 cross-file reference sizes:

| width | height | nLlmH | nLlmW | tokens |
| --- | --- | --- | --- | --- |
| 14 | 14 | 13 | 13 | 184 |
| 28 | 14 | 10 | 19 | 202 |
| 800 | 600 | 15 | 20 | 317 |
| 1024 | 768 | 19 | 25 | 496 |
| 1024 | 1024 | 25 | 25 | 652 |
| 2000 | 2000 | 31 | 31 | 994 |
| 4000 | 3000 | 27 | 36 | 1001 |
| 4096 | 4096 | 31 | 31 | 994 |
| 4 | 400 | 130 | 2 | 392 |
| 400 | 4 | 2 | 130 | 264 |
| 4200 | 100 | 3 | 100 | 305 |
| 100 | 4200 | 100 | 3 | 402 |

## Position independence

The retired revision's `build_image_block(n_llm_h, n_llm_w, start)` no longer
exists. Rather than delete the position sweep, the generator retains it as
evidence that the V4.1 block length does not depend on the serialized position:
the fixture's `startPositions` section records the same count at every swept
offset (640×480 → 206 for all of `0,1,2,3,4,5,7,8,17,64,101,383,384,766,767`),
and `deepSeekVisionImageBlockTokens` ignores its `startTokenPos` argument.

The multi-image `sequences` section is likewise re-derived from
`num_image_tokens`, preserving the accumulated-start-position property.

## Node port fidelity

A candidate TS port was compared case-by-case against the official Python over a
162-case sweep (42 boundary sizes + 120 seeded random sizes, `SWEEP_SEED = 7`)
covering degenerate sizes (1×1, 2×3, 13×14, 15×15), the
minimum-pixel floor (543/544/545×544), cap saturation (4096×4096), extreme
aspect ratios (10000×10, 10×10000), and 120 seeded random sizes in
`[1, 5000]²`. Result: 162/162 identical, maximum 1017 (≤ 1024), no cap
violation. The committed test suite re-asserts the fixture-backed subset.

### One port detail

The official `solve_resize_ratio` "very tall" branch is
`(max_n_token - 2) // 2 * cell` — Python floor division. Under the pinned V4.1
parameters `max_n_token` is always 1024, so `max_n_token - 2` is always even and
floor division and truncation agree; the port's `Math.floor` is defensive
fidelity, not a reachable behavioural difference.

### Deliberate deviation from the official `safe_resize` upper-bound assert

The official `safe_resize` ends with `assert num_image_tokens(n_llm_h, n_llm_w)
<= max_n_token` (`inference/image_processor.py`). **This port deliberately does
not carry that assert.** Recorded here because the frozen spec cites this file
as part of the deviation's evidence chain (spec R2.8, "captain 裁定").

Rationale:

1. Under the pinned V4.1 parameters `max_n_token` is always 1024 and
   `safe_resize` is a single closed-form solve (no budget-decrement loop), so the
   assert is unreachable in the parameter domain.
2. A sweep of **646,000** sizes (degenerate dimensions, the
   `min_pixels = 295936` threshold neighbourhood, extreme aspect ratios, and
   seeded random sizes) produced **0 violations**, worst case exactly 1024.
3. Carrying an unreachable assert adds a branch no test can cover.

This deviation does **not** relax the rest of R2.8: `safe_resize` still performs
a single solve with no loop. The port-side note lives in
`packages/runtime/src/deepseek-v4-vision-tokens.ts` (`solveResizeRatio`), which
also records the forward-looking trigger: if `vision_max_n_token` ever changes
from 1024, this deviation must be re-evaluated.

## Known divergence: official PIL failure on extreme aspect ratios

For pathological inputs the official implementation raises before returning a
grid: `load_image` on a `100000×1` image fails inside PIL
(`ValueError: height and width must be > 0`, after the resize step), while
`50000×1` and `8192×1` return normally. The Node port has no such failure mode
and returns a bounded grid for those dimensions.

This is not a port defect — it is an official crash on an input the adapter
rejects earlier anyway via its image byte cap and per-request image limit. It
does mean such sizes cannot appear in the fixture (the official implementation
cannot produce a value for them), which is why the fixture's largest aspect
ratio is 10000×10 rather than something more extreme.
