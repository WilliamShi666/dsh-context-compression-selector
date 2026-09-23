# Code review — DeepSeek-V4.1-Flash support (t2, Standards axis)

- **Reviewer**: `code-reviewer` (team `v41-flash-support`), task **t3**, round 1
- **Reviewed task**: **t2** — "以 TDD 实现 DeepSeek-V4.1-Flash 支持"
- **Verdict**: **`needs_revision`** (2 × high, 4 × medium, 3 × low; no blocker)
- **Date**: 2026-09-23

---

## 1. Review scope and anchors

### 1.1 Revision anchors

| Anchor | Value |
| --- | --- |
| Repository root | `/Users/williamshi666/Developers/dsh-context-compression-selector` |
| `HEAD` (fixed point for all `git diff`/`git show` reads) | `08e3db27fa232393ed2fcc756c0cfc0b591654ca` (`chore(release): prepare stable 0.1.0`) |
| t2 delivery state | **uncommitted working tree** — 27 tracked files modified/renamed + 3 new untracked test artifacts. t2 produced **no commit**, so every finding below is anchored to worktree state, not to a revision. |
| Branch | `codex/beta-0.1.0-beta.3` (detached at `08e3db2`) |

Because t2 never committed, this review is a **worktree review**. A later round must re-verify after the first commit, since the anchors above are mutable.

### 1.2 Artifacts inspected (content hashes at review time)

| Artifact | SHA-256 |
| --- | --- |
| `packages/runtime/src/deepseek-v4-vision-tokens.ts` | `52ed3e50c40929d5f749f5fe8524db66c54596f72c13a83d1c72099b7e372260` |
| `packages/runtime/src/deepseek-v4-tokenizer.ts` | `029ca9ed46571291d8a7fde877187bb5948df906050c1f63a79e89848e12e0b9` |
| `packages/runtime/src/measurement.ts` | `0268ea9c1f1d32c1dcbcfe4d162ef2f801a54b5515e7a47d34a56f511609edc3` |
| `packages/runtime/src/deepseek-official-pricing.ts` | `85c6c1ea0cfd1eafbfa1b7f3be2cf42ae023ef3c3c42aa063f1201e4f25f388a` |
| `packages/runtime/assets/deepseek-v4.1-flash/manifest.json` | `cd46fe4be554d86f6acf117ac2bb818b1c041790979b7ed6db2698496647e9eb` |
| `packages/runtime/tests/fixtures/vision-golden.json` | `c417418bf35ef7ac81dc7e07b14706bbd8fb8e53f891a0d44df3ef3c8d790600` |
| `packages/runtime/tests/fixtures/vision-official-sweep.json` | `fb61741a409e276035957931b903faa007bb9d7565a5b345f7471d52be00399a` |
| `packages/runtime/tests/fixtures/PROVENANCE.md` | `cf3553c5e4f63a6f447d649fc2fe7bf8cc9237428f9118aab06160fbd61eee54` |

### 1.3 Method

1. `git diff` / `git diff --stat` / `git show HEAD:<path>` for every t2-touched file, then per-file close reading of the four changed sources, all five changed spec files, the three release-gate scripts, and the two new fixtures.
2. **Independent re-execution of the official implementation.** I ran the pinned official `inference/image_processor.py` (`sha256 482759e3bcc4e9bb5ee582b244cc563f5d0e163d8b48dda91ebb7106e62f9272`, `torch 2.8.0` + `pillow 11.3.0`, config `vision_config = {patch_size:14, downsample_ratio:3, max_image_tokens:1024, min_pixels:295936, max_wh_ratio:null}`) and compared case-by-case against the committed Node port:
   - **556 distinct sizes** (boundary/degenerate sizes such as `1×1`, `2×3`, `13×14`, `543/544/545×544`, `4096×4096`, `10000×10`, the very-wide branch set, plus 520 seeded random sizes in `[1,8000]²`) → **0 mismatches**;
   - **162 sweep cases + 56 fixture entries** (`31` single images, `15` start positions, `10` multi-image sequence entries) re-derived from the official code → **0 mismatches**;
   - **30 000 additional extreme sizes** (`[1,200000]²` and extreme aspect ratios) run through the port alone → **0 cap violations** (`1 ≤ tokens ≤ 1024`), observed max **1017**;
   - the official implementation raises `ValueError` on 6 pathological inputs (`295936×1`, `1×295936`, `1×50000`, `100000×1`, `1×70000`, `1×45000`); the port returns bounded values for all of them — matching the divergence documented in `PROVENANCE.md:97-109`.
3. **Independent fixture regeneration.** I re-ran the committed `scripts/generate-vision-fixtures.py` against the pinned official source into a scratch tree. Both `vision-golden.json` and `vision-official-sweep.json` came back **byte-identical** (`cmp`) to the committed files — this independently discharges spec R5.1 (no hand-written numbers).
4. Independent hash recomputation of all bundled assets and of the `HEAD` baselines of the frozen V4-Pro assets.
5. Gates re-run: `pnpm test` (504 passed / 1 skipped), `pnpm typecheck`, `pnpm build`, `pnpm test:built`, `pnpm verify:release` (`release verification: OK`). All exit 0. `pnpm test:e2e:packed` was **not** run — it belongs to t5 and running it would destroy t5's independence.

### 1.4 Out-of-scope handling

`docs/plans/**` and `docs/specs/**` were read as **read-only reference** and verified unmodified (`mtime` 2026-09-23 00:48 / 01:52, i.e. before t2's implementation window). `packages/selector/**` and `scripts/**` were **read only** — this review writes exactly one file, `docs/reviews/2026-09-23-v41-flash-code-review.md`, per the t3 contract.

---

## 2. Findings

### F1 — `high` — shipped READMEs state the model→artifact mapping **inverted**

- **file:line**: `packages/runtime/README.md:7`, `packages/runtime/README.zh.md:7`
- **problem**: Both files enumerate four ids in the order `deepseek-flash`, `deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-vision-exp` and then assert:

  > "…the first three are served by DeepSeek-V4.1-Flash and the last by DeepSeek-V4-Pro."
  > "…前三个由 DeepSeek-V4.1-Flash 服务，最后一个由 DeepSeek-V4-Pro 服务。"

  Both halves are **inverted**. The "first three" includes `deepseek-v4-pro`, which the implementation serves from the **V4-Pro** artifact (`packages/runtime/src/deepseek-v4-tokenizer.ts:32-39,91-99`); the "last" is `deepseek-v4-flash-vision-exp`, which is served by the **V4.1-Flash** artifact (`:53-60,100-107`). The sentence therefore contradicts the code *and* the immediately following sentence in the same paragraph ("the two vocabularies are deliberately never treated as aliases of each other").

  This is not a cosmetic nit: these two files are inside the published tarball (`packages/runtime/package.json` `files` includes `README.md`, `README.zh.md`), and the per-route tokenizer identity is precisely the safety-relevant contract this change exists to correct. An operator reading the installed package would be told the V4-Pro route uses the V4.1 vocabulary — the single confusion the change was made to prevent. Spec **R5.8** lists `packages/runtime/README.md` by name and states that prose contradicting the implementation is a spec violation.
- **requiredFix**: Replace the positional "first three / the last" phrasing with an explicit per-id mapping in both files, e.g. "`deepseek-flash`, `deepseek-v4-flash`, and `deepseek-v4-flash-vision-exp` are served by DeepSeek-V4.1-Flash; `deepseek-v4-pro` keeps its own DeepSeek-V4-Pro tokenizer." Do not rely on list order.

### F2 — `high` — `README.zh.md` model-support table was never updated (still omits `deepseek-flash`)

- **file:line**: `README.zh.md:50-55` (table), versus the updated `README.md:50-57`
- **problem**: The English table gained a `Served by` column, a `deepseek-flash` row, and the corrected V4-Pro row. The Chinese table is **byte-for-byte the old one**: it has no `Served by` column, **does not mention `deepseek-flash` at all** — the default DeepSeek API model and the entire subject of this change — and still presents `deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp` as the supported set. The two language variants of the same document now make different factual claims about which model ids are supported. Spec **R5.8** requires the `README.zh.md` prose (including its table) to move to the new values.
- **requiredFix**: Mirror the English table into `README.zh.md:50-57` — three columns (`模型路由 | 服务模型 | 选择器压缩`), a `deepseek-flash` row, `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` marked as served by `DeepSeek-V4.1-Flash`, and `deepseek-v4-pro` marked as served by `DeepSeek-V4-Pro`.

### F3 — `medium` — `measurement.ts` still documents the **deleted** alignment-padding arithmetic, and that stale text ships in the public `.d.ts`

- **file:line**: `packages/runtime/src/measurement.ts:61-70` (`IntrinsicImageBlockDiagnostic` doc), `:297-306` (`countCanonicalImage` doc), `:324-328` (`intrinsicImageDiagnostic` doc); built output `packages/runtime/lib/index.d.ts:411-417`
- **problem**: Three doc comments in a file t2 modified still describe the pre-V4.1 model:
  - `:65` — "at the two alignment-padding extremes (compress-pad 0 and 3)". There is no compress pad in V4.1; the two extremes are the same value by construction.
  - `:303` — "Valid dimensions therefore use the midpoint of the four alignment residues as a bounded estimate". The implementation now returns the single position-independent block length and sets `paddingMinimumTokens === paddingMaximumTokens` (`deepseek-v4-vision-tokens.ts:137-143`).
  - `:326` — "at both alignment extremes". Same reason (doc block `:324-328`).

  The behavior is correct; only the documentation is wrong. It matters more than a normal comment because `IntrinsicImageBlockDiagnostic` is reachable from the package's public surface — `index.ts:101-104` re-exports `MeasuredTokenSurfaceNode`, which carries the field — so the stale text is emitted verbatim into the shipped `lib/index.d.ts` (confirmed present at `lib/index.d.ts:411`). This is the same class of defect spec **R5.8** targets (prose contradicting the implementation), just in the source rather than in Markdown. The `:168` clause "the absolute prompt position and the adapter's final projection are not publicly observable" is likewise now half-obsolete: the absolute position is no longer a source of inexactness.
- **requiredFix**: Rewrite the three comments (and the `:168` clause) to describe the V4.1 semantics: a single position-independent block length, `paddingMinimumTokens === paddingMaximumTokens`, inexactness arising only from the adapter's unobservable final image projection. Re-run `pnpm build` so `lib/index.d.ts` picks the correction up.

### F4 — `medium` — the frozen TDD item **P-9f** (adaptive-decision flip) is absent from the suite

- **file:line**: missing from `packages/runtime/tests/deepseek-official-pricing.spec.ts` and `packages/runtime/tests/adaptive-cost.spec.ts`; required by `docs/specs/2026-09-23-deepseek-v4.1-flash-support-spec.md:571` (§⑤.4, row P-9f)
- **problem**: Spec R5.0 states that new test names must match the §⑤ table "or be a superset of it". P-9f — `flips the adaptive decision when the alias is billed at the Flash price` — has no counterpart anywhere: `resolveOfficialDeepSeekPrice` is imported only by `deepseek-official-pricing.spec.ts`, and `adaptive-cost.spec.ts` feeds `decideConservativeAdaptive` hard-coded rates, never resolved prices. So no test in the repo exercises the actual end-to-end reason the pricing amendment was made.

  I reproduced the underlying behavior independently, and the amendment is **correct** — the flip is real:

  ```
  alias @ old V4-Flash price (0.007 / 0.22) → allowHistory=true , reason=cost-interval-clearly-favourable
  alias @ new Flash price   (0.003 / 0.15) → allowHistory=false, reason=cache-risk-not-clearly-paid-back
  ```

  The gap is coverage, not behavior. It is rated medium rather than low because this flip is a *user-visible* change in compression authority on two routes, it is the sole justification recorded for amending the frozen spec, and the amendment's stated rationale (`deepseek-official-pricing.ts:71-74`) is currently asserted nowhere.
- **requiredFix**: Add the P-9f test as specified: derive `inputCacheHitRate` / `inputCacheMissRate` from `resolveOfficialDeepSeekPrice({ modelId: 'deepseek-v4-flash', ... })` with `reclaimedLowerBoundTokens: 1000` and `affectedRetainedSuffixUpperBoundTokens: 25`, and assert `allowHistory === false` with `reason === 'cache-risk-not-clearly-paid-back'` under the Flash price (optionally pinning the old-price `true` as the contrast).

### F5 — `medium` — `DEEPSEEK_OFFICIAL_PRICE_CHECKED_AT` predates the verification that justifies the shipped alias rows

- **file:line**: `packages/runtime/src/deepseek-official-pricing.ts:5` (`'2026-09-23T00:40:00+08:00'`), `:3` (catalog version), `:75-79` and `:86-90` (the alias rows it covers)
- **problem**: The field is documented at `:4` as "Wall-clock time at which the checked-in official price pages were verified". The two alias rows shipped in this catalog version were re-priced from a capture taken at **`2026-09-23T01:48:36+08:00`**, which is the instant the spec records as authoritative in three places (`docs/specs/…-spec.md:29`, `:297`, `:829`). The catalog therefore reports a verification time **~68 minutes earlier than the capture that produced part of its own contents** — i.e. an audit record whose timestamp does not cover every row it describes. This is exactly the failure mode the amendment was made to avoid (stale provenance on the alias rows).

  The existing test cannot catch it: `deepseek-official-pricing.spec.ts:82-83` only asserts `checkedAt` is truthy and `!== '2026-08-25T00:10:20+08:00'`, which is the letter of spec §3.2 but leaves the value unpinned and unverifiable.
- **requiredFix**: Set `DEEPSEEK_OFFICIAL_PRICE_CHECKED_AT` to the latest verification instant covering **every** shipped row (`2026-09-23T01:48:36+08:00`), or record per-row provenance if the two captures are meant to stay distinguishable. Add a test pinning the exact string so a future partial re-verification cannot silently under-report again.

### F6 — `medium` — `CHANGELOG.md` omits the alias re-pricing, the one behavior change with user-visible consequences

- **file:line**: `CHANGELOG.md:7-18` (the `Unreleased` section); the change lives at `packages/runtime/src/deepseek-official-pricing.ts:75-79,86-90`
- **problem**: The `Unreleased` block documents the tokenizer remap (`:15`), the vision re-port (`:16`), the estimator identity bump (`:17`), and the fixture regeneration (`:18`) — but never records that `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` were moved from the retired V4-Flash tuple (`0.007/0.22/0.66`) to the Flash tuple (`0.003/0.15/0.6`). Per the captain's own amendment rationale and finding F4, that change **flips `decideConservativeAdaptive` from `allowHistory: true` to `false`** on those routes. A release note that lists the tokenizer remap while silently omitting the pricing change gives an operator no way to anticipate the compression-authority change. `:15` actively works against this: it says of the V4-Pro artifact "its tokenizer bytes, `modelVersion`, and prices are untouched", which is true of V4-Pro but sits immediately after a sentence about the two aliases and reads as covering them too.
- **requiredFix**: Add an explicit `Changed` bullet recording that the two retired aliases are now billed at the Flash price (with both tuples, old and new) and that this can disable Adaptive History authority on those routes via the cache-hit/cache-miss spread; and clarify that `:15`'s "untouched" clause applies to `deepseek-v4-pro` only.

### F7 — `low` — `PROVENANCE.md` records a 160-case sweep while the committed fixture has 162 cases

- **file:line**: `packages/runtime/tests/fixtures/PROVENANCE.md:83`, `:86`
- **problem**: The note says "a 160-case sweep" and "160/160 identical", but the committed `vision-official-sweep.json` has **162** cases (42 `SWEEP_SIZES` entries + 120 seeded random) and the generator prints 162. The 160 figure describes the pre-commit exploratory sweep, not the artifact shipped beside the note. Since the note's whole purpose is to let a reviewer re-verify without re-deriving, a count that does not match the adjacent fixture is a defect in the provenance record — and it is the one number in that file a reader can check in seconds. (The rest of the note is accurate: I confirmed `imageProcessorSha256 = 482759e3…`, the `31/31` row match, `max 1017`, and the PIL-failure divergence on `100000×1` / `1×45000`-class inputs.)
- **requiredFix**: Change both occurrences to 162 and state the composition ("42 boundary sizes + 120 seeded random sizes, `SWEEP_SEED=7`"), or explicitly label the 160 figure as the pre-commit exploratory sweep.

### F8 — `low` — generator usage/docstring not updated for `--skip-sweep` and the second output file

- **file:line**: `scripts/generate-vision-fixtures.py:30` (usage), `:33` (Output), `:221` (the `--skip-sweep` flag)
- **problem**: The module docstring advertises `[--workdir DIR] [--mirror]` and a single output (`vision-golden.json`), but the script also defines `--skip-sweep` and, unless that flag is passed, writes a second file (`vision-official-sweep.json`). A user following the documented invocation gets an undeclared second artifact.
- **requiredFix**: Add `[--skip-sweep]` to the usage line and list both outputs in the `Output:` line.

### F9 — `low` — the Flash price tuple is duplicated three times with no shared source of truth

- **file:line**: `packages/runtime/src/deepseek-official-pricing.ts:63-67`, `:75-79`, `:86-90`
- **problem**: The identical `modelPrices('DeepSeek-V4.1-Flash', ['0.003','0.15','0.6'], …)` literal appears three times. The duplication is deliberate and currently guarded (`deepseek-official-pricing.spec.ts:223-272` compares each alias row field-by-field against `deepseek-flash`), so this is not a live defect — but it is a divergence hazard for the next price edit: a single-row update would break the guard rather than propagate.
- **requiredFix**: Extract the shared Flash tuple into one `const V41_FLASH_PRICES = …` and reference it from all three rows, so the three rows cannot drift by construction and the test becomes a structural check rather than a tripwire. (Optional this round; must not change the emitted strings.)

---

## 3. Verification matrix — the six required axes

| # | Axis | Result | Evidence |
| --- | --- | --- | --- |
| 1 | **fail-closed discipline** | **PASS — no violation found** | `artifactForModel` (`deepseek-v4-tokenizer.ts:117-119`) returns `undefined` for any id outside the two frozen `modelIds` lists; `deepSeekV4TokenizerForModel:128-142` propagates that; `bindCounter` (`measurement.ts:271-295`) returns `unavailableTokenCount` for a missing header, a non-DeepSeek provider, and an unresolved tokenizer. **No character-count fallback exists anywhere in `packages/runtime/src`** (searched for `text.length`, `length / 4`, `charCount`, `estimateTokens` → 0 hits). The image path is independently gated by a set test (`measurement.ts:105-108,311-313`), so an unknown id yields `unavailable`, never an estimate — there is no path from an unknown id to `estimateDeepSeekVisionImageTokens`. The one "fallback" (fixed 256, `deepseek-v4-vision-tokens.ts:63,127-134,145-151`) is reachable **only** for malformed dimensions on an already-authorized route, is labelled `source: 'default'`, and drops the `padding*` keys so it cannot masquerade as an intrinsic-grid estimate. 14 negative ids are covered (`deepseek-v4-tokenizer.spec.ts:91-109`), including lookalikes (`deepseek-flash-vision`, `deepseek-v4.1-flash`, `deepseek-v4-flash-exp`). |
| 2 | **asset integrity (byte + SHA-256 + JSON) and per-artifact isolation** | **PASS** | `readVerifiedJson` (`deepseek-v4-tokenizer.ts:191-210`) still performs all three checks in order and is applied to both artifacts through independent `integrity` descriptors (`:91-108`). I recomputed every hash and size independently: `deepseek-v4.1-flash/tokenizer.json` 6 367 257 / `c90dfa01…`, `tokenizer_config.json` 801 / `6ac8c8dc…`, `LICENSE…V4.1-Flash.txt` 1084 / `f2c6c602…` — all three match `manifest.json` exactly; the license hash also matches the independently downloaded upstream `LICENSE`. Isolation is proven **in both directions**: a V4.1 corruption leaves `deepseek-v4-pro` serving (`deepseek-v4-tokenizer.spec.ts:118-139`) and a V4-Pro corruption leaves `deepseek-flash` serving (`:141-152`). Caches are keyed per `origin` object (`:115,131-140`), so a failure on one artifact cannot poison the other. |
| 3 | **provenance consistency across the four sites** | **PASS with one exception (F5)** | I cross-checked repository / revision / modelIds / hashes across (a) TS constants (`deepseek-v4-tokenizer.ts:12-15,53-60,100-107`; `deepseek-v4-vision-tokens.ts:32-33`), (b) `manifest.json`, (c) test assertions, (d) release-gate scripts (`verify-release.mjs:117-140`, `packed-components-smoke.mjs:400-404,536-545`, `packed-install-e2e.mjs:971-1022`). All four agree on `deepseek-ai/DeepSeek-V4.1-Flash` / `dba1be0a40aa45a94ad051997016db3960a90277` / the three ids / `c90dfa01…` + `6ac8c8dc…`, and on `deepseek-ai/DeepSeek-V4-Pro` / `0e1a0e5e…` for the fourth id. The **only** provenance field that does not reconcile with its own authoritative source is `DEEPSEEK_OFFICIAL_PRICE_CHECKED_AT` — see **F5**. |
| 4 | **vision-arithmetic fidelity to the official implementation** | **PASS — verified to a high standard** | I re-ran the pinned official Python and compared case-by-case with the committed port: **556/556** distinct sizes agree, **162/162** sweep cases and all **56** fixture entries agree, **30 000** extreme sizes stay in `[1,1024]`, observed max **1017**. I re-ran the committed generator against the pinned source: both fixtures came back **byte-identical**. Formula-level checks against the official source: block length `nLlmH*(nLlmW+1)+2` (official `:35-36`); `llm_grid` = `ceil((best // p)/d)` matches `llmGrid` `Math.ceil(Math.floor(best/patch)/downsample)`; `plan_image_grid` order (inert clamp → min-pixel upscale with `int()` truncation → `ceil` to patch → `safe_resize`) matches `deepSeekVisionImageGrid:161-188`, including `Math.trunc` standing in for Python `int()` on positive values; `safe_resize` is the single-pass form with one occupancy check and at most one solve (official `:60-67`); `solve_resize_ratio` matches all three branches, including the very-tall `(max_n_token-2)//2*cell` (harmless because `1024-2` is even) and the very-wide `(max_n_token-3)*cell` — I exercised the very-wide branch against the official code specifically (11/11 agree). The **256 fallback** (spec Q3) is retained, documented, and now strictly more conservative under the 1024 cap. The one documented divergence — the official PIL path raising on `100000×1`-class inputs while the port returns a bounded value — is honestly recorded in `PROVENANCE.md:97-109` and pinned by `deepseek-v4-vision-sweep.spec.ts:88-99`. |
| 5 | **V4-Pro unaffected / no undeclared behavior change** | **PASS** | `assets/deepseek-v4/manifest.json` lost exactly one line (`"deepseek-v4-flash"`); I hashed the three other files against their `HEAD` blobs — `tokenizer.json` 6 367 146 / `8f9f37ca…`, `tokenizer_config.json` 801 / `6ac8c8dc…`, `LICENSE.DeepSeek-V4-Pro.txt` 1064 / `1c8f573e…` — all **byte-identical** to baseline, and `git diff` for them is empty. `PRICES['deepseek-v4-pro']` keeps `DeepSeek-V4-Pro-0813` with all four original tuples (`deepseek-official-pricing.ts:81-84`), pinned by `deepseek-official-pricing.spec.ts` (table rows `:21-24` + the alias-exemption test). The V4-Pro route is explicitly tested to still refuse image counting (`public-runtime.spec.ts:2382-2402`). `git diff packages/selector/` is **empty** — the plan/spec §6 outOfScope boundary (`packages/selector/**`, `assets/deepseek-v4/**` bytes, `docs/plans/**`, `.gitnexus/**`) is respected. The one intentional cross-cutting change — moving `deepseek-v4-flash` off the V4-Pro artifact — is declared in the spec (§①, R3.2d) and in `CHANGELOG.md:15`. |
| 6 | **TDD evidence** | **PASS on coverage; ordering asserted but not independently reproducible (see note)** | Coverage is strong and the tests are *discriminating*: I confirmed the old implementation cannot satisfy them (pre-change golden values were `14×14 → 117`, `800×600 → 341`, `640×480` varying `206/207/208/209`; the new assertions pin `184`, `317`, and a constant `206`). New behavior and failure paths are each covered: parameter pins (`deepseek-v4-vision-tokens.spec.ts:43-61`), position-independence (`:69-99`), cap saturation and the min-pixel floor (`:150-159`), the fixed fallback plus the *absence* of `padding*` keys (`:174-189`), estimator identity (`:168-172`), registry mapping and the non-alias proof (`deepseek-v4-tokenizer.spec.ts:24-89`), both corruption-isolation directions (`:118-152`), manifest-vs-shipped verification (`:178-192`), the 162-case official sweep as a new spec file, and the measurement gate across all three ids (`public-runtime.spec.ts:2333-2357`). **Note on ordering**: t2 reports red-first, but the red phase left no reproducible artifact — no commit, no stash, no reflog entry, and no captured red run (the worktree contains only the final green state). I therefore verified *discriminating power* (the tests fail against the old code) rather than *chronology*, which is the strongest claim the evidence supports. This is an evidence limitation, not a defect, and it does not affect the verdict. Missing item: **P-9f** — see **F4**. |

---

## 4. Verdict

**`needs_revision`.**

The core engineering is sound and I want that on the record, because the verdict below is about documentation and provenance rather than about the arithmetic or the safety posture:

- the re-ported vision arithmetic is **faithful** — 556/556 agreement with the official implementation under my own re-execution, 162/162 sweep cases and 56/56 fixture entries agreeing, both fixtures reproducible byte-for-byte from the pinned revision;
- **fail-closed discipline is intact** — no path turns an unknown id into an estimate, and no character-count fallback exists;
- **asset integrity and cross-artifact isolation are intact** in both directions;
- **V4-Pro is provably untouched** at the byte level, and `packages/selector/**` is provably untouched;
- the pricing amendment is **substantively correct** (I reproduced the adaptive flip) and the four-way provenance cross-check reconciles everywhere except the `checkedAt` timestamp.

The task contract states that `verdict=pass` requires **no open high-severity finding**. Two high findings are open, both in shipped, in-scope documentation that the frozen spec (R5.8) names explicitly:

- **F1** — the published package READMEs assert the model→artifact mapping **inverted** (both halves), contradicting the code and their own adjacent sentence, in the exact file the change set was supposed to bring into line;
- **F2** — `README.zh.md`'s support table was never updated and still does not mention `deepseek-flash` at all, so the two language variants of one document now make different factual claims about the supported model set.

Neither breaks runtime behavior, which is why I did not raise a blocker. But "the shipped docs describe the safety-relevant route mapping incorrectly" is precisely the category spec R5.8 designates as `needs_revision`, and passing it would leave a documented falsehood in the tarball.

**Required before re-review** (all inside t2's amended scope; no `packages/selector/**`, no `scripts/**` logic, no `docs/plans/**`, no `docs/specs/**`):

1. **F1** — rewrite the `first three / the last` sentence in `packages/runtime/README.md:7` and `packages/runtime/README.zh.md:7` as an explicit per-id mapping.
2. **F2** — mirror the English support table (with the `Served by` column and the `deepseek-flash` row) into `README.zh.md:50-57`.
3. **F3** — correct the three stale comments in `packages/runtime/src/measurement.ts` and re-run `pnpm build` so `lib/index.d.ts` is regenerated.
4. **F4** — add the missing P-9f adaptive-flip test.
5. **F5** — reconcile `DEEPSEEK_OFFICIAL_PRICE_CHECKED_AT` with the verification instant the shipped rows actually come from, and pin it in a test.
6. **F6** — record the alias re-pricing (and its adaptive consequence) in `CHANGELOG.md`.

F7–F9 are low severity and may be folded into the same pass or deferred; they must not block re-review.

Re-review must re-run the five gates and confirm the fixes against the **committed** revision, since t2 has not yet committed and every anchor in §1.1 is currently mutable.
