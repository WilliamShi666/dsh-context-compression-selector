# GitNexus Engineering Plan

> Task: Add DeepSeek-V4.1-Flash (`deepseek-flash`) support to the context-compression selector — model-id mapping, pricing catalog, and the re-ported V4.1 vision arithmetic.
> Evidence verified at commit `08e3db27fa232393ed2fcc756c0cfc0b591654ca`; GitNexus index 1 commit behind (indexed 2026-09-02, HEAD 2026-09-03) — freshness `accept`, source-weighted, refresh skipped.
> Evidence provenance schema 2; global dirty digest `019c864e3143e534389bda1921786fa2f2457ddde304238ff6ca4079800a644e`; cited-path manifest 27 sorted entries; exact generated plan path excluded.

## Objective (§1)

The retired models `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` and the new default `deepseek-flash` are all served today by **DeepSeek-V4.1-Flash**. The plugin must (a) resolve an exact tokenizer for `deepseek-flash`, (b) price it, and (c) replace the vision-token arithmetic, which was ported from the retired vision-exp `image_processor.py` and is now numerically wrong.

## Current Behaviour (§2–3)

`deepSeekV4TokenizerForModel` (`packages/runtime/src/deepseek-v4-tokenizer.ts:122`) is the single registry: it maps a model id through two frozen `ARTIFACTS` (`:85-102`) to a SHA-256-verified local `tokenizer.json`. `bindCounter` (`packages/runtime/src/measurement.ts:266`) is the only consumer that gates compression; it accepts only providers `deepseek`/`deepseek-official` and then requires a tokenizer. `VISION_MODEL_ID` (`measurement.ts:103`) is a single id taken from the vision artifact's `modelIds[0]`, so image counting is hard-gated to one model name. Pricing is a second, independent gate: `resolveOfficialDeepSeekPrice` (`packages/runtime/src/deepseek-official-pricing.ts:86`) fails closed on any id absent from `PRICES` (`:59`).

## Findings (§4–5)

1. **The plugin is currently a no-op on the default route.** `[verified]` direct probe of `packages/runtime/src/deepseek-v4-tokenizer.ts`:
   `deepseek-flash → UNDEFINED (fail-closed)`; `deepseek-v4-flash`/`deepseek-v4-pro` → V4-Pro artifact; `deepseek-v4-flash-vision-exp` → vision artifact. The installed DSH 0.1.5-rc.2 `dsh-llm-deepseek` lists `deepseek-flash` as the **first** `DEFAULT_MODELS` entry with `inputModalities: ["text","image"]`, so the GUI default hits the unmapped id: `bindCounter` returns `unavailableTokenCount('canonical text: no verified bundled tokenizer for model "deepseek-flash"')`, every exact gate fails, `warnExactUnavailable` fires and the original tool results are kept.
2. **The required tokenizer bytes are already shipped.** `[verified]` `https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash` @ `dba1be0a40aa45a94ad051997016db3960a90277`: its `tokenizer.json` is SHA-256 `c90dfa01249db1be4245780a052ede752e1361c612ac6d08e2bdada7d599476b` and `cmp` proves it **byte-identical** to the bundled `packages/runtime/assets/deepseek-v4-vision-exp/tokenizer.json`; its `tokenizer_config.json` hashes to `6ac8c8dc065ed118161d02dd532749ae3f52c243deac27872134fae2f50d8547`, identical to both bundled configs. No new 6.3 MB asset is needed — only provenance and the model-id mapping.
3. **Text counts agree; only the image placeholder differs.** `[verified]` diff of the two bundled tokenizers: `vocab`, `merges`, `pre_tokenizer`, `normalizer`, `post_processor`, `decoder` are all equal; the added-token sets differ only in `<｜deepseek_image｜>`/`<｜System｜>`/`<|place_holder_mm_span_0436..0442|>` (V4.1) vs `<｜image｜>`/`<｜image2｜>`/table tokens (V4-Pro). Measured with `@huggingface/tokenizers`: 8/9 representative payloads count identically; only `before<｜deepseek_image｜>after` differs (9 vs 3).
4. **The pricing gate also fails closed.** `[verified]` `deepseek-flash` is absent from `OfficialDeepSeekModelId` (`deepseek-official-pricing.ts:14-17`) → `unpriced('unknown model id')`, which disables adaptive cost authority (`index.ts:806-812` → `adaptiveHistoryAllowed`). Official prices (docs, 2026-09-10): `deepseek-flash` USD off-peak/peak cache-hit `0.003`/`0.006`, cache-miss `0.15`/`0.3`, output `0.6`/`1.2`; CNY `0.02`/`0.04`, `1`/`2`, `4`/`8`.
5. **The vision arithmetic is stale and numerically wrong.** `[verified]` the retired `deepseek-ai/DeepSeek-V4-Flash-Vision-Exp` config pins `vision_max_n_token: 384`, `vision_min_pixels: 147456`, `vision_max_wh_ratio: 8`; the V4.1 config pins `1024`, `295936`, `null` and adds `image_token_id: 129264`. The official vision guide matches (≤1024 tokens/image; upscale below ~544×544 ≈ 295 936 px; downscale to ~1300×1300). The new `inference/image_processor.py` was rewritten: `COMPRESS_PAD_TO`, `IMAGE_PAD`, the `perm`/N-layout and the `safe_resize` budget loop are gone, `num_image_tokens = nH*(nW+1)+2` is the whole block length, and `solve_resize_ratio` is a single pass. Measured divergence against the current port: 800×600 → 338 (bundled) vs 317 (V4.1); 1024×1024 → 346 vs 652. The estimator's `paddingMinimum/MaximumTokens` concept no longer exists in V4.1 because the block is position-independent.
6. **Graph findings.** `[graph]` `impact(deepSeekV4TokenizerForModel, upstream, depth 2)` → **HIGH** risk, 2 direct dependents (`bindCounter`; `tokenizerAuditFact` in `index.ts:576`), 4 processes (`activePolicy`, `measureForCompaction`, `constructor`, `pruneSession`). `impact(resolveOfficialDeepSeekPrice)` → **HIGH**, 3 direct, 2 processes. `impact(estimateDeepSeekVisionImageTokens)` → **HIGH**, 2 direct (`countCanonicalImage`, `intrinsicImageDiagnostic`). `impact(countCanonicalImage)` → LOW, 2 direct. **These HIGH verdicts are expected and accepted**: both functions are single-entry-point registries whose callers are enumerated and all in-scope. No PDG layer is indexed (`pdg_query` → "no PDG layer"); no statement-level slice was taken.

## Proposed Changes (§6)

**A. Re-anchor the vision asset directory to V4.1-Flash** — `packages/runtime/assets/deepseek-v4-vision-exp/` → `packages/runtime/assets/deepseek-v4.1-flash/` (`git mv`, tokenizer bytes untouched). Update `manifest.json`: `repository: deepseek-ai/DeepSeek-V4.1-Flash`, `revision: dba1be0a40aa45a94ad051997016db3960a90277`, `license: MIT`, `modelIds: ["deepseek-flash","deepseek-v4-flash","deepseek-v4-flash-vision-exp"]`, and replace the license file with the V4.1 `LICENSE` (1084 bytes, SHA-256 `f2c6c602815669d292889e5be8c802f2ed950653b77999b1584e8e6aed25d040`). `tokenizer.json` SHA-256 stays `c90dfa01…`; `tokenizer_config.json` stays `6ac8c8dc…`.

**B. Registry** — `deepseek-v4-tokenizer.ts`: rename `DEEPSEEK_VISION_TOKENIZER_ARTIFACT` → `DEEPSEEK_V41_FLASH_TOKENIZER_ARTIFACT` with the new repository/revision/modelIds above; point its `assetRoot` at the renamed directory; move `deepseek-v4-flash` off the V4-Pro artifact onto it. Keep the V4-Pro artifact for `deepseek-v4-pro` only. `deepSeekV4TokenizerForModel` and `deepSeekTokenizerArtifacts()` signatures are unchanged.

**C. Measurement gating** — `measurement.ts`: replace the single `VISION_MODEL_ID` constant (`:103`) with a predicate over the V4.1 artifact's `modelIds` (a `Set`), used at `:306` (`countCanonicalImage`) and `:332` (`intrinsicImageDiagnostic`). `bindCounter` needs no logic change — it inherits the fix from B.

**D. Vision arithmetic** — `deepseek-v4-vision-tokens.ts`: re-port to the V4.1 `image_processor.py`. `DEEPSEEK_VISION_PROJECTION` gains `sourceRepository: 'deepseek-ai/DeepSeek-V4.1-Flash'`, `sourceRevision: 'dba1be0a…'`, `visionMaxNTokens: 1024`, `visionMinPixels: 295_936`, `visionMaxWhRatio: undefined`; keep `requestImagePixelBudget: 640_000` (still the adapter's `DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET` in DSH 0.1.5-rc.2) and note it is not the server-side 1300×1300 resize. `deepSeekVisionImageBlockTokens` becomes `nH*(nW+1)+2` (no compress pad, no odd-row pad, no alignment pad); keep the 3-arg signature so the call graph is untouched, and document that `startTokenPos` is inert under V4.1. `solveResizeRatio`/`safeResize` are rewritten to the single-pass official form. `estimateDeepSeekVisionImageTokens` keeps its return shape but now reports equal padding bounds, and `DEEPSEEK_VISION_IMAGE_ESTIMATOR.revision` moves to `dba1be0a…:v1` so cached audit rows cannot be confused across the two arithmetics.

**E. Pricing catalog** — `deepseek-official-pricing.ts`: add `'deepseek-flash'` to `OfficialDeepSeekModelId` and `PRICES` with `modelVersion: 'DeepSeek-V4.1-Flash'` and the four tuples from Finding 4; bump `DEEPSEEK_OFFICIAL_PRICE_CATALOG_VERSION` to `deepseek-official-2026-09-23` and `DEEPSEEK_OFFICIAL_PRICE_CHECKED_AT` to the re-verification timestamp. Leave `deepseek-v4-pro` on its published tuple — see §12 Q2.

**F. Fixtures and docs** — regenerate `tests/fixtures/vision-golden.json` via `scripts/generate-vision-fixtures.py` (update `REVISION`/`BASE`/parameter set there first); extend `tests/fixtures/tokenizer-golden.json` with the V4.1 repository key. Update `README.md`, `README.zh.md`, `CHANGELOG.md`, `THIRD_PARTY_NOTICES.md`, and the `packages/runtime/package.json` `files` array (the `assets/deepseek-v4-vision-exp/*` entry becomes `assets/deepseek-v4.1-flash/*`).

## Implementation Sequence (§7)

1. `git mv packages/runtime/assets/deepseek-v4-vision-exp packages/runtime/assets/deepseek-v4.1-flash`; rewrite `manifest.json` and swap the license file. *(risk: a stale path in `package.json#files` silently drops the asset from the tarball — the packed E2E in step 8 catches it.)*
2. Update `deepseek-v4-tokenizer.ts` registry + artifact identity (Change B). Re-run the direct probe: `deepseek-flash` must return `exact-tokenizer`.
3. Update `measurement.ts` vision gating to a model-id set (Change C).
4. Re-port `deepseek-v4-vision-tokens.ts` (Change D) — the largest single edit; keep the exported signatures stable.
5. Update `scripts/generate-vision-fixtures.py` to the V4.1 repo/revision/parameters, then regenerate `vision-golden.json` **once** (`pip install torch pillow` is a prerequisite; not installed on this machine). *(risk: without torch the fixture cannot be regenerated locally — the executor must provision it or hand-verify against the official Python.)*
6. Extend `tokenizer-golden.json` and `scripts/generate-tokenizer-fixtures.py` with the V4.1 key; regenerate once.
7. Update `deepseek-official-pricing.ts` (Change E).
8. Update tests and the three release-gate scripts, then run the full gate (§8). *(risk: `packed-components-smoke.mjs:539-542` and `packed-install-e2e.mjs:1008-1012` hard-assert the old 340/384 pair for 800×600 — they must move to the regenerated fixture values in this same step.)*
9. Update README/README.zh/CHANGELOG/THIRD_PARTY_NOTICES to the new supported set. Regenerate any recorded baselines **once**, here, as the final step.

## Test Strategy (§8)

Update `packages/runtime/tests/deepseek-v4-tokenizer.spec.ts` (registry expectations + the manifest-loop directory key), `packages/runtime/tests/deepseek-v4-vision-tokens.spec.ts` (parameter pins + golden cases), `packages/runtime/tests/tokenizer-golden.spec.ts` (`MODEL_BY_TOKENIZER`), `packages/runtime/tests/deepseek-official-pricing.spec.ts` (new price rows), `packages/runtime/tests/public/public-runtime.spec.ts` (`VISION_MODEL` constant and the image-estimate expectations).

New scenarios: `deepSeekV4TokenizerForModel('deepseek-flash')` → `exact-tokenizer` with `tokenizerId 'deepseek-ai/DeepSeek-V4.1-Flash'` and revision `dba1be0a…` → and `countText('<｜deepseek_image｜>').tokens === 1` while `deepseek-v4-pro` stays `> 1` (proves the alias did not collapse onto the V4-Pro vocabulary). `resolveOfficialDeepSeekPrice({modelId:'deepseek-flash', currency:'USD', at: off-peak})` → `0.003`/`0.15`/`0.6`; the same at peak → `0.006`/`0.3`/`1.2`. `deepSeekVisionImageGrid(800,600)` → `{nLlmH:15,nLlmW:20}` and block tokens `317`; `(14,14)` → `184`; a 4000×3000 image must shrink to ≤1024 under `safeResize`. Regression: the fail-closed path must still hold — `deepseek-v4-flash-vision` (no such id), `gpt-4o`, `''` stay `undefined`, and a corrupted vision asset must not disable the text artifact.

Commands (all exist and are runnable from the repo root): `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:built`, `pnpm verify:release`, `pnpm test:e2e:packed`.

## Implementation Context (§11)

```json
{
  "implementation_context": {
    "task_summary": "Add DeepSeek-V4.1-Flash (deepseek-flash) support: map the id to the already-bundled V4.1 tokenizer, add its official prices, and re-port the vision-token arithmetic from the V4.1 image_processor.py (1024-token cap, 295936 min pixels, no aspect clamp, no alignment padding).",
    "acceptance_criteria": [
      "deepSeekV4TokenizerForModel('deepseek-flash') returns an exact-tokenizer count identified as deepseek-ai/DeepSeek-V4.1-Flash @ dba1be0a40aa45a94ad051997016db3960a90277",
      "resolveOfficialDeepSeekPrice prices deepseek-flash in USD and CNY, peak and off-peak",
      "Vision arithmetic matches the regenerated V4.1 golden fixture (num_image_tokens = nH*(nW+1)+2; max 1024 tokens/image)",
      "deepseek-v4-flash and deepseek-v4-flash-vision-exp route to the V4.1 artifact; deepseek-v4-pro keeps its own",
      "Unknown ids and corrupted assets still fail closed",
      "pnpm typecheck, pnpm test, pnpm build, pnpm test:built, pnpm verify:release, pnpm test:e2e:packed all pass"
    ],
    "evidence_provenance": {
      "schema_version": 2,
      "head_commit": "08e3db27fa232393ed2fcc756c0cfc0b591654ca",
      "generated_plan_path": "docs/plans/2026-09-23-gitnexus-plan-v41-flash-support.md",
      "global_dirty_digest": {
        "algorithm": "sha256",
        "canonicalization": "gitnexus-evidence-provenance-v2 NUL-framed UTF-8 records",
        "value": "019c864e3143e534389bda1921786fa2f2457ddde304238ff6ca4079800a644e"
      },
      "cited_path_manifest": [
        {
          "path": ".github/workflows/ci.yml",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:2dd4c79313183fa2a509015280895d45b10e9104cc55cab5eb2601f58de197d0",
          "index_digest": "sha256:2dd4c79313183fa2a509015280895d45b10e9104cc55cab5eb2601f58de197d0",
          "worktree_digest": "sha256:2dd4c79313183fa2a509015280895d45b10e9104cc55cab5eb2601f58de197d0",
          "untracked_digest": "absent"
        },
        {
          "path": "CHANGELOG.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:d43e998be8821b7f55b82c3d1f9a605ad00d0985e3f17fee64835983f2cfb217",
          "index_digest": "sha256:d43e998be8821b7f55b82c3d1f9a605ad00d0985e3f17fee64835983f2cfb217",
          "worktree_digest": "sha256:d43e998be8821b7f55b82c3d1f9a605ad00d0985e3f17fee64835983f2cfb217",
          "untracked_digest": "absent"
        },
        {
          "path": "README.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:c47160226fae0e722a229b078c1a8163df6759b2048133f772765bd5274e0fe9",
          "index_digest": "sha256:c47160226fae0e722a229b078c1a8163df6759b2048133f772765bd5274e0fe9",
          "worktree_digest": "sha256:c47160226fae0e722a229b078c1a8163df6759b2048133f772765bd5274e0fe9",
          "untracked_digest": "absent"
        },
        {
          "path": "README.zh.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:393498dd03fbf9edb1ed0fbf0ae008ef1ef0146f9f97abe23c0c0d73fdf00d29",
          "index_digest": "sha256:393498dd03fbf9edb1ed0fbf0ae008ef1ef0146f9f97abe23c0c0d73fdf00d29",
          "worktree_digest": "sha256:393498dd03fbf9edb1ed0fbf0ae008ef1ef0146f9f97abe23c0c0d73fdf00d29",
          "untracked_digest": "absent"
        },
        {
          "path": "THIRD_PARTY_NOTICES.md",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:a1d59cba867d4959f605353a41d8f089e24d294517fae8da5f634129ddf4259c",
          "index_digest": "sha256:a1d59cba867d4959f605353a41d8f089e24d294517fae8da5f634129ddf4259c",
          "worktree_digest": "sha256:a1d59cba867d4959f605353a41d8f089e24d294517fae8da5f634129ddf4259c",
          "untracked_digest": "absent"
        },
        {
          "path": "packages/runtime/assets/deepseek-v4-vision-exp/manifest.json",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:96e2eec6bb5c66af38e1ddfad4ffa9ef0ecb1e56102e7b2801d77151fe90dceb",
          "index_digest": "sha256:96e2eec6bb5c66af38e1ddfad4ffa9ef0ecb1e56102e7b2801d77151fe90dceb",
          "worktree_digest": "sha256:96e2eec6bb5c66af38e1ddfad4ffa9ef0ecb1e56102e7b2801d77151fe90dceb",
          "untracked_digest": "absent"
        },
        {
          "path": "packages/runtime/assets/deepseek-v4/manifest.json",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:3c849d9ee6bd7063da9bae09e46a1374c55207cbce793b130349cf09396b03d4",
          "index_digest": "sha256:3c849d9ee6bd7063da9bae09e46a1374c55207cbce793b130349cf09396b03d4",
          "worktree_digest": "sha256:3c849d9ee6bd7063da9bae09e46a1374c55207cbce793b130349cf09396b03d4",
          "untracked_digest": "absent"
        },
        {
          "path": "packages/runtime/package.json",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:b7053eaecd3b02444fc08e6b730e3b77b76bcb8f4346214395e873f3dd70d454",
          "index_digest": "sha256:b7053eaecd3b02444fc08e6b730e3b77b76bcb8f4346214395e873f3dd70d454",
          "worktree_digest": "sha256:b7053eaecd3b02444fc08e6b730e3b77b76bcb8f4346214395e873f3dd70d454",
          "untracked_digest": "absent"
        },
        {
          "path": "packages/runtime/src/audit.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:478f5a4e2eccaf5e03fd0533468e2dedf17f6e3f1d34ee287eb5a01081d0614b",
          "index_digest": "sha256:478f5a4e2eccaf5e03fd0533468e2dedf17f6e3f1d34ee287eb5a01081d0614b",
          "worktree_digest": "sha256:478f5a4e2eccaf5e03fd0533468e2dedf17f6e3f1d34ee287eb5a01081d0614b",
          "untracked_digest": "absent"
        },
        {
          "path": "packages/runtime/src/deepseek-official-pricing.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:b81ccbf2d10c65d9a8ab4937e9f069eb9034e552b848de25f48367ff2f925f36",
          "index_digest": "sha256:b81ccbf2d10c65d9a8ab4937e9f069eb9034e552b848de25f48367ff2f925f36",
          "worktree_digest": "sha256:b81ccbf2d10c65d9a8ab4937e9f069eb9034e552b848de25f48367ff2f925f36",
          "untracked_digest": "absent"
        },
        {
          "path": "packages/runtime/src/deepseek-v4-tokenizer.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:d8be9aff2404b7acae0a85c7e262982894bfaa896ae1fdb7a7f5bec2aa8df858",
          "index_digest": "sha256:d8be9aff2404b7acae0a85c7e262982894bfaa896ae1fdb7a7f5bec2aa8df858",
          "worktree_digest": "sha256:d8be9aff2404b7acae0a85c7e262982894bfaa896ae1fdb7a7f5bec2aa8df858",
          "untracked_digest": "absent"
        },
        {
          "path": "packages/runtime/src/deepseek-v4-vision-tokens.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:61dd41fb734f814419da1b3c1c81f124deee27398607718b726b2a1070980c41",
          "index_digest": "sha256:61dd41fb734f814419da1b3c1c81f124deee27398607718b726b2a1070980c41",
          "worktree_digest": "sha256:61dd41fb734f814419da1b3c1c81f124deee27398607718b726b2a1070980c41",
          "untracked_digest": "absent"
        },
        {
          "path": "packages/runtime/src/index.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:88304544dba43f713477f5eab1db983ebcb9c9bc640d60a9e627f16b0744c4af",
          "index_digest": "sha256:88304544dba43f713477f5eab1db983ebcb9c9bc640d60a9e627f16b0744c4af",
          "worktree_digest": "sha256:88304544dba43f713477f5eab1db983ebcb9c9bc640d60a9e627f16b0744c4af",
          "untracked_digest": "absent"
        },
        {
          "path": "packages/runtime/src/measurement.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:09c2b615cb2d44b08c9aa6c3d5ec418559917d5023448d3783e4d0838f8f243d",
          "index_digest": "sha256:09c2b615cb2d44b08c9aa6c3d5ec418559917d5023448d3783e4d0838f8f243d",
          "worktree_digest": "sha256:09c2b615cb2d44b08c9aa6c3d5ec418559917d5023448d3783e4d0838f8f243d",
          "untracked_digest": "absent"
        },
        {
          "path": "packages/runtime/src/token-count.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:d049cbda54248f931fc01bda9af0ffee306c478e35c636fccd4f52072fa4bc04",
          "index_digest": "sha256:d049cbda54248f931fc01bda9af0ffee306c478e35c636fccd4f52072fa4bc04",
          "worktree_digest": "sha256:d049cbda54248f931fc01bda9af0ffee306c478e35c636fccd4f52072fa4bc04",
          "untracked_digest": "absent"
        },
        {
          "path": "packages/runtime/tests/deepseek-official-pricing.spec.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:f594caa4e0523e72cc4e0f772f4418fd861126d4a56bf75453b2ac13b19b4428",
          "index_digest": "sha256:f594caa4e0523e72cc4e0f772f4418fd861126d4a56bf75453b2ac13b19b4428",
          "worktree_digest": "sha256:f594caa4e0523e72cc4e0f772f4418fd861126d4a56bf75453b2ac13b19b4428",
          "untracked_digest": "absent"
        },
        {
          "path": "packages/runtime/tests/deepseek-v4-tokenizer.spec.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:cb5486120a57e308a4c7b2b38d00b0fe1ab324d5efe50dbdc9e0cce29925da36",
          "index_digest": "sha256:cb5486120a57e308a4c7b2b38d00b0fe1ab324d5efe50dbdc9e0cce29925da36",
          "worktree_digest": "sha256:cb5486120a57e308a4c7b2b38d00b0fe1ab324d5efe50dbdc9e0cce29925da36",
          "untracked_digest": "absent"
        },
        {
          "path": "packages/runtime/tests/deepseek-v4-vision-tokens.spec.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:dd2d64d52fcf6712fd3f26bd8500098e44f91c00f765149cb7720bc5a929cc4f",
          "index_digest": "sha256:dd2d64d52fcf6712fd3f26bd8500098e44f91c00f765149cb7720bc5a929cc4f",
          "worktree_digest": "sha256:dd2d64d52fcf6712fd3f26bd8500098e44f91c00f765149cb7720bc5a929cc4f",
          "untracked_digest": "absent"
        },
        {
          "path": "packages/runtime/tests/fixtures/tokenizer-golden.json",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:229e6e00f9b72856dba20c8608c1b8893de3f9b05e032ef193992d0dc26cc83e",
          "index_digest": "sha256:229e6e00f9b72856dba20c8608c1b8893de3f9b05e032ef193992d0dc26cc83e",
          "worktree_digest": "sha256:229e6e00f9b72856dba20c8608c1b8893de3f9b05e032ef193992d0dc26cc83e",
          "untracked_digest": "absent"
        },
        {
          "path": "packages/runtime/tests/fixtures/vision-golden.json",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:e52f2142b91c80a6165b7e4c797c3e65ab98c717a17e0ac951a0bb508b28619c",
          "index_digest": "sha256:e52f2142b91c80a6165b7e4c797c3e65ab98c717a17e0ac951a0bb508b28619c",
          "worktree_digest": "sha256:e52f2142b91c80a6165b7e4c797c3e65ab98c717a17e0ac951a0bb508b28619c",
          "untracked_digest": "absent"
        },
        {
          "path": "packages/runtime/tests/public/public-runtime.spec.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:13d6d8d4c48815e4c81f97b8de69dab6e2ec74f4780ee374a81b9759d97f8b82",
          "index_digest": "sha256:13d6d8d4c48815e4c81f97b8de69dab6e2ec74f4780ee374a81b9759d97f8b82",
          "worktree_digest": "sha256:13d6d8d4c48815e4c81f97b8de69dab6e2ec74f4780ee374a81b9759d97f8b82",
          "untracked_digest": "absent"
        },
        {
          "path": "packages/runtime/tests/tokenizer-golden.spec.ts",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:912b0cdbb81764daa8004e4e1b34b43ae5bf0825759ef640b422aa217a35c328",
          "index_digest": "sha256:912b0cdbb81764daa8004e4e1b34b43ae5bf0825759ef640b422aa217a35c328",
          "worktree_digest": "sha256:912b0cdbb81764daa8004e4e1b34b43ae5bf0825759ef640b422aa217a35c328",
          "untracked_digest": "absent"
        },
        {
          "path": "scripts/generate-tokenizer-fixtures.py",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:154f9bd7ece883fe7e116cfe17b78b5c643bff55e0ce908210e923fdb00bdfb4",
          "index_digest": "sha256:154f9bd7ece883fe7e116cfe17b78b5c643bff55e0ce908210e923fdb00bdfb4",
          "worktree_digest": "sha256:154f9bd7ece883fe7e116cfe17b78b5c643bff55e0ce908210e923fdb00bdfb4",
          "untracked_digest": "absent"
        },
        {
          "path": "scripts/generate-vision-fixtures.py",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:e564428db5fa513d9f132964bdb1054b23ae357cf8dc634b5c6c5e1cdb49f778",
          "index_digest": "sha256:e564428db5fa513d9f132964bdb1054b23ae357cf8dc634b5c6c5e1cdb49f778",
          "worktree_digest": "sha256:e564428db5fa513d9f132964bdb1054b23ae357cf8dc634b5c6c5e1cdb49f778",
          "untracked_digest": "absent"
        },
        {
          "path": "scripts/packed-components-smoke.mjs",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:5aa747e6a89ed833c7067c75a17f006dabd11794848ed2e96024435b1807f80a",
          "index_digest": "sha256:5aa747e6a89ed833c7067c75a17f006dabd11794848ed2e96024435b1807f80a",
          "worktree_digest": "sha256:5aa747e6a89ed833c7067c75a17f006dabd11794848ed2e96024435b1807f80a",
          "untracked_digest": "absent"
        },
        {
          "path": "scripts/packed-install-e2e.mjs",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:9784eea12542e841f32aad1826016d0532e294b3e13b7c4165403714bcbff53e",
          "index_digest": "sha256:9784eea12542e841f32aad1826016d0532e294b3e13b7c4165403714bcbff53e",
          "worktree_digest": "sha256:9784eea12542e841f32aad1826016d0532e294b3e13b7c4165403714bcbff53e",
          "untracked_digest": "absent"
        },
        {
          "path": "scripts/verify-release.mjs",
          "object_kind": {
            "head": "regular",
            "index": "regular",
            "worktree": "regular",
            "untracked": "absent"
          },
          "state": "clean",
          "rename_from": null,
          "rename_to": null,
          "head_digest": "sha256:e1061b83cdf50b36141eed918a3e4fc2fb246bcc6b8b0fde19781ef86b03f980",
          "index_digest": "sha256:e1061b83cdf50b36141eed918a3e4fc2fb246bcc6b8b0fde19781ef86b03f980",
          "worktree_digest": "sha256:e1061b83cdf50b36141eed918a3e4fc2fb246bcc6b8b0fde19781ef86b03f980",
          "untracked_digest": "absent"
        }
      ]
    },
    "primary_symbols": [
      {
        "symbol": "deepSeekV4TokenizerForModel",
        "file": "packages/runtime/src/deepseek-v4-tokenizer.ts",
        "lines": "122-136",
        "role": "single model-id -> artifact registry; returns undefined (fail-closed) for unmapped ids"
      },
      {
        "symbol": "DEEPSEEK_VISION_TOKENIZER_ARTIFACT",
        "file": "packages/runtime/src/deepseek-v4-tokenizer.ts",
        "lines": "47-54",
        "role": "artifact identity + modelIds to re-anchor onto V4.1-Flash"
      },
      {
        "symbol": "ARTIFACTS",
        "file": "packages/runtime/src/deepseek-v4-tokenizer.ts",
        "lines": "85-102",
        "role": "asset root + byte/SHA-256 integrity per artifact"
      },
      {
        "symbol": "bindCounter",
        "file": "packages/runtime/src/measurement.ts",
        "lines": "266-290",
        "role": "the only compression gate; provider + tokenizer availability"
      },
      {
        "symbol": "countCanonicalImage",
        "file": "packages/runtime/src/measurement.ts",
        "lines": "302-317",
        "role": "image estimate entry; hard-gated to VISION_MODEL_ID"
      },
      {
        "symbol": "DEEPSEEK_VISION_PROJECTION",
        "file": "packages/runtime/src/deepseek-v4-vision-tokens.ts",
        "lines": "25-45",
        "role": "the pinned official vision parameters to re-port"
      },
      {
        "symbol": "deepSeekVisionImageBlockTokens",
        "file": "packages/runtime/src/deepseek-v4-vision-tokens.ts",
        "lines": "176-183",
        "role": "block length arithmetic that becomes nH*(nW+1)+2"
      },
      {
        "symbol": "resolveOfficialDeepSeekPrice",
        "file": "packages/runtime/src/deepseek-official-pricing.ts",
        "lines": "86-119",
        "role": "pricing gate; unpriced disables adaptive authority"
      }
    ],
    "related_symbols": [
      {
        "symbol": "deepSeekV4TokenizerFailureReason",
        "relationship": "CALLS",
        "relevance": "shares the registry; must report the renamed artifact"
      },
      {
        "symbol": "deepSeekTokenizerArtifacts",
        "relationship": "CALLS",
        "relevance": "public inventory; order is asserted by tests"
      },
      {
        "symbol": "tokenizerAuditFact",
        "relationship": "CALLS",
        "relevance": "index.ts:576; emits tokenizer identity into audit rows"
      },
      {
        "symbol": "VISION_MODEL_ID",
        "relationship": "referenced-by",
        "relevance": "measurement.ts:103 single-id gate to replace with a set"
      },
      {
        "symbol": "intrinsicImageDiagnostic",
        "relationship": "CALLS",
        "relevance": "measurement.ts:324; second VISION_MODEL_ID gate"
      },
      {
        "symbol": "estimateDeepSeekVisionImageTokens",
        "relationship": "CALLS",
        "relevance": "padding min/max concept disappears under V4.1"
      },
      {
        "symbol": "priceOfficialDeepSeekUsage",
        "relationship": "CALLS",
        "relevance": "index.ts:727 postflight cost"
      },
      {
        "symbol": "adaptiveHistoryAllowed",
        "relationship": "CALLS",
        "relevance": "index.ts:806; unpriced model silently disables adaptive"
      },
      {
        "symbol": "DEEPSEEK_VISION_DEFAULT_IMAGE_TOKENS",
        "relationship": "referenced-by",
        "relevance": "256-token malformed-image fallback; see Q3"
      },
      {
        "symbol": "deepSeekVisionImageGrid",
        "relationship": "CALLS",
        "relevance": "min-pixel upscale + aspect clamp to re-parameterize"
      }
    ],
    "execution_path": [
      "Agent loop issues a request on provider deepseek-official with model deepseek-flash",
      "measureForCompaction -> bindCounter(provider, model) -> deepSeekV4TokenizerForModel(model)",
      "Today: undefined -> unavailableTokenCount('canonical text: no verified bundled tokenizer for model \"deepseek-flash\"')",
      "Every candidate count is not exact-tokenizer -> exactUnavailable -> warnExactUnavailable -> no lossy rewrite lands",
      "After the change: the V4.1 artifact resolves -> exact counts -> gates evaluate normally",
      "Adaptive path additionally calls resolveOfficialDeepSeekPrice; today 'unknown model id' -> adaptive-unknown-price -> adaptive disabled"
    ],
    "pdg_constraints": [],
    "architectural_patterns": [
      {
        "pattern": "Fail-closed registry: an unmapped model id returns undefined and callers must report unavailable rather than estimate",
        "example_location": "packages/runtime/src/deepseek-v4-tokenizer.ts deepSeekV4TokenizerForModel",
        "usage_guidance": "Keep the undefined return; add ids, never a fallback alias."
      },
      {
        "pattern": "Byte + SHA-256 verified offline assets, one independent cache entry per artifact",
        "example_location": "packages/runtime/src/deepseek-v4-tokenizer.ts ARTIFACTS + readVerifiedJson",
        "usage_guidance": "A corrupted artifact must never disable the other family."
      },
      {
        "pattern": "Independent, separately pinned artifacts per model family, never treated as aliases",
        "example_location": "packages/runtime/assets/*/manifest.json",
        "usage_guidance": "Record repository+revision+hashes; keep manifest.json in lockstep with the TS constants."
      },
      {
        "pattern": "Golden fixtures generated by executing the official Python implementation",
        "example_location": "scripts/generate-vision-fixtures.py, scripts/generate-tokenizer-fixtures.py",
        "usage_guidance": "Never hand-edit fixture numbers; regenerate from the pinned revision."
      },
      {
        "pattern": "Release gates re-assert asset hashes and model ids from the packed tarball",
        "example_location": "scripts/verify-release.mjs, scripts/packed-components-smoke.mjs, scripts/packed-install-e2e.mjs",
        "usage_guidance": "Update these in the same step as the source change or CI fails."
      }
    ],
    "files_to_modify": [
      {
        "file": "packages/runtime/assets/deepseek-v4.1-flash/",
        "symbols": [
          "manifest.json",
          "tokenizer.json",
          "tokenizer_config.json",
          "LICENSE.DeepSeek-V4.1-Flash.txt"
        ],
        "intended_change": "git mv from assets/deepseek-v4-vision-exp; rewrite provenance to deepseek-ai/DeepSeek-V4.1-Flash @ dba1be0a…; swap the license file"
      },
      {
        "file": "packages/runtime/src/deepseek-v4-tokenizer.ts",
        "symbols": [
          "DEEPSEEK_VISION_TOKENIZER_ARTIFACT",
          "ARTIFACTS",
          "TOKENIZER_* consts"
        ],
        "intended_change": "rename to DEEPSEEK_V41_FLASH_TOKENIZER_ARTIFACT, new repository/revision/modelIds, point assetRoot at the renamed dir, move deepseek-v4-flash onto it"
      },
      {
        "file": "packages/runtime/src/measurement.ts",
        "symbols": [
          "VISION_MODEL_ID",
          "countCanonicalImage",
          "intrinsicImageDiagnostic"
        ],
        "intended_change": "replace the single id with a Set membership test over the V4.1 artifact modelIds"
      },
      {
        "file": "packages/runtime/src/deepseek-v4-vision-tokens.ts",
        "symbols": [
          "DEEPSEEK_VISION_PROJECTION",
          "deepSeekVisionImageBlockTokens",
          "solveResizeRatio",
          "safeResize",
          "estimateDeepSeekVisionImageTokens",
          "DEEPSEEK_VISION_IMAGE_ESTIMATOR"
        ],
        "intended_change": "re-port to V4.1 image_processor.py; 1024 cap, 295936 min pixels, no wh clamp, no compress/odd-row/alignment padding, single-pass resize, estimator revision bump"
      },
      {
        "file": "packages/runtime/src/deepseek-official-pricing.ts",
        "symbols": [
          "OfficialDeepSeekModelId",
          "PRICES",
          "DEEPSEEK_OFFICIAL_PRICE_CATALOG_VERSION",
          "DEEPSEEK_OFFICIAL_PRICE_CHECKED_AT"
        ],
        "intended_change": "add deepseek-flash rows (USD/CNY x peak/off-peak) and bump the catalog version/checked-at"
      },
      {
        "file": "packages/runtime/package.json",
        "symbols": [
          "files"
        ],
        "intended_change": "assets/deepseek-v4-vision-exp/* -> assets/deepseek-v4.1-flash/*"
      },
      {
        "file": "packages/runtime/tests/deepseek-v4-tokenizer.spec.ts",
        "symbols": [
          "registry expectations",
          "manifest loop"
        ],
        "intended_change": "new repository/revision/modelIds; add deepseek-flash"
      },
      {
        "file": "packages/runtime/tests/deepseek-v4-vision-tokens.spec.ts",
        "symbols": [
          "parameter pins"
        ],
        "intended_change": "new parameter values from the regenerated fixture"
      },
      {
        "file": "packages/runtime/tests/tokenizer-golden.spec.ts",
        "symbols": [
          "MODEL_BY_TOKENIZER"
        ],
        "intended_change": "V4.1 repository key"
      },
      {
        "file": "packages/runtime/tests/deepseek-official-pricing.spec.ts",
        "symbols": [
          "price table cases"
        ],
        "intended_change": "deepseek-flash rows"
      },
      {
        "file": "packages/runtime/tests/public/public-runtime.spec.ts",
        "symbols": [
          "MODEL",
          "VISION_MODEL",
          "image expectations"
        ],
        "intended_change": "route the vision cases through the V4.1 ids and new estimates"
      },
      {
        "file": "packages/runtime/tests/fixtures/vision-golden.json",
        "symbols": [],
        "intended_change": "regenerated from the V4.1 official implementation"
      },
      {
        "file": "packages/runtime/tests/fixtures/tokenizer-golden.json",
        "symbols": [],
        "intended_change": "add the V4.1 repository key"
      },
      {
        "file": "scripts/generate-vision-fixtures.py",
        "symbols": [
          "REVISION",
          "BASE",
          "SINGLE_SIZES"
        ],
        "intended_change": "point at DeepSeek-V4.1-Flash and its parameter set"
      },
      {
        "file": "scripts/generate-tokenizer-fixtures.py",
        "symbols": [
          "ASSETS"
        ],
        "intended_change": "add the V4.1 asset directory key"
      },
      {
        "file": "scripts/verify-release.mjs",
        "symbols": [
          "assetManifests"
        ],
        "intended_change": "directory/repository/modelIds for the renamed artifact"
      },
      {
        "file": "scripts/packed-components-smoke.mjs",
        "symbols": [
          "MODEL",
          "VISION_MODEL",
          "image assertions"
        ],
        "intended_change": "new ids and regenerated estimate values"
      },
      {
        "file": "scripts/packed-install-e2e.mjs",
        "symbols": [
          "artifact dirs",
          "vision assertions"
        ],
        "intended_change": "new dir name and estimate values"
      },
      {
        "file": "README.md",
        "symbols": [],
        "intended_change": "supported-model table + pinned revision"
      },
      {
        "file": "README.zh.md",
        "symbols": [],
        "intended_change": "same, in Chinese"
      },
      {
        "file": "CHANGELOG.md",
        "symbols": [],
        "intended_change": "record the V4.1-Flash migration"
      },
      {
        "file": "THIRD_PARTY_NOTICES.md",
        "symbols": [],
        "intended_change": "replace the vision-exp attribution with V4.1-Flash"
      }
    ],
    "tests": [
      {
        "file": "packages/runtime/tests/deepseek-v4-tokenizer.spec.ts",
        "scenarios": [
          "deepSeekV4TokenizerForModel('deepseek-flash') -> exact-tokenizer, tokenizerId 'deepseek-ai/DeepSeek-V4.1-Flash', revision 'dba1be0a…'",
          "countText('<｜deepseek_image｜>').tokens === 1 on deepseek-flash and > 1 on deepseek-v4-pro (no alias collapse)",
          "manifest loop covers the renamed directory and matches repository/revision/modelIds",
          "fail-closed set still returns undefined: 'deepseek-v4-flash-vision', 'gpt-4o', ''"
        ]
      },
      {
        "file": "packages/runtime/tests/deepseek-v4-vision-tokens.spec.ts",
        "scenarios": [
          "DEEPSEEK_VISION_PROJECTION pins 1024 / 295936 / undefined against the regenerated fixture",
          "deepSeekVisionImageGrid(800,600) -> nLlmH 15, nLlmW 20; block tokens 317",
          "deepSeekVisionImageGrid(14,14) -> 184 (min-pixel upscale under the new threshold)",
          "a 4000x3000 image shrinks to <= 1024 tokens",
          "invalid dimensions still fall back to DEEPSEEK_VISION_DEFAULT_IMAGE_TOKENS"
        ]
      },
      {
        "file": "packages/runtime/tests/deepseek-official-pricing.spec.ts",
        "scenarios": [
          "deepseek-flash USD off-peak -> 0.003 / 0.15 / 0.6; peak -> 0.006 / 0.3 / 1.2",
          "deepseek-flash CNY off-peak -> 0.02 / 1 / 4; peak -> 0.04 / 2 / 8",
          "an unknown model id still returns unpriced('unknown model id')"
        ]
      },
      {
        "file": "packages/runtime/tests/public/public-runtime.spec.ts",
        "scenarios": [
          "a deepseek-flash route yields exact-tokenizer node counts and lands a rewrite",
          "the vision route reports the regenerated estimate and upper bound",
          "image-bearing candidates remain exact-ineligible"
        ]
      }
    ],
    "verification_commands": [
      "pnpm typecheck",
      "pnpm test",
      "pnpm build",
      "pnpm test:built",
      "pnpm verify:release",
      "pnpm test:e2e:packed"
    ],
    "risks": [
      "HIGH-impact registries (deepSeekV4TokenizerForModel, resolveOfficialDeepSeekPrice, estimateDeepSeekVisionImageTokens) — all callers enumerated and in-scope; verify with impact before each edit",
      "Release gates hard-assert the old 340/384 vision numbers and the old asset directory name; they fail CI until updated in the same change",
      "vision-golden.json cannot be regenerated without torch+pillow (absent on this machine)",
      "A stale assets/ path in package.json#files silently drops the 6.3 MB asset from the published tarball",
      "Moving deepseek-v4-flash to the V4.1 artifact is correct only while the compatibility alias routes there",
      "The V4-Pro pricing contradiction (Q2) could make adaptive cost decisions wrong for deepseek-v4-pro"
    ],
    "assumptions": [
      "A1: deepseek-flash uses exactly the V4.1-Flash vocabulary — re-hash https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/resolve/main/tokenizer.json and compare to c90dfa01249db1be4245780a052ede752e1361c612ac6d08e2bdada7d599476b",
      "A2: deepseek-v4-flash / deepseek-v4-flash-vision-exp still route to V4.1-Flash — re-read https://api-docs.deepseek.com/quick_start/pricing before relying on it",
      "A3: the adapter still uses a 640000-pixel request budget — grep DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET in the installed dsh-llm-deepseek",
      "A4: deepseek-v4-pro keeps its own tokenizer artifact and its published prices"
    ],
    "open_questions": [
      "Q1: should deepseek-v4-pro also move to the V4.1 artifact, given its served model is now V4.1-Flash?",
      "Q2: the news post says v4-pro routes to V4.1-Flash at V4.1-Flash rates from 2026-09-14, but the pricing page still publishes v4-pro's own tuple — which governs?",
      "Q3: is 256 still the intended malformed-image fallback under a 1024-token cap?"
    ],
    "avoid": [
      "Do not repeat full repository discovery",
      "Do not re-download or replace the 6.3 MB tokenizer.json — the bundled bytes are already byte-identical to the V4.1 asset",
      "Do not hand-edit vision-golden.json or tokenizer-golden.json numbers; regenerate them from the pinned revision",
      "Do not add a fallback alias for unknown model ids; the registry must stay fail-closed",
      "Do not touch packages/selector/src — the selector UI carries no model-id coupling",
      "Do not change deepseek-v4-pro prices without resolving Q2",
      "Do not modify production code in the planning step"
    ]
  }
}
```

## Assumptions and Open Questions (§12)

- **Assumption A1** — `deepseek-flash` is served by exactly the V4.1-Flash vocabulary. Evidence: the official repo's `tokenizer.json` is byte-identical to a bundled asset. Re-verify by re-hashing `https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash/resolve/main/tokenizer.json` before relying on it.
- **Assumption A2** — `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` route to V4.1-Flash (docs say "temporarily"), so moving them to the V4.1 artifact is correct today but must be revisited when the aliases are withdrawn.
- **Q1 (decision needed)** — Should the bundled `deepseek-v4-pro` tokenizer stay on the V4-Pro artifact, or also move to V4.1? Its own vocabulary is the V4-Pro one, but its *served* model is V4.1-Flash. This plan keeps V4-Pro on its own artifact (safer for placeholder fidelity) and flags the choice.
- **Q2 (contradiction, unresolved)** — The 2026-09-10 news post says `deepseek-v4-pro` requests "will route to V4.1-Flash **at V4.1-Flash rates**" from 04:00 UTC 2026-09-14, while the current changelog entry and the live pricing page still publish `deepseek-v4-pro` at its own tuple and version. This plan leaves the V4-Pro prices unchanged; do not change them without re-reading the pricing page.
- **Q3** — `DEEPSEEK_VISION_DEFAULT_IMAGE_TOKENS` stays at 256. Under a 1024-token cap that is now *more* conservative than before; confirm the intended fallback.
- **Deferred (§12 follow-ups, not in scope)** — the docs describe a server-side `detail: low` 512×512 downscale and a ~1300×1300 resize budget that the adapter does not model; exposing projected dimensions upstream would let the estimator become exact. Also deferred: `imageMaxBytes`/`maxImagesPerRequest` limits in the DSH catalog.
- **Limitation** — the GitNexus index is one commit behind HEAD and has no PDG layer; all `[graph]` claims are source-weighted, and no statement-level slice was taken.

## Definition of Done (§13)

`pnpm typecheck && pnpm test && pnpm build && pnpm test:built && pnpm verify:release && pnpm test:e2e:packed` all pass. A `deepseek-flash` route resolves an `exact-tokenizer` count, produces a priced adaptive decision, and its vision surfaces report the regenerated V4.1 golden values. `gitnexus detect_changes --scope all` is clean (not `partial`/`truncated`) before commit. README/README.zh/CHANGELOG/THIRD_PARTY_NOTICES list `deepseek-flash` as supported with its pinned revision.
