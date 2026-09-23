# Code review r2 — DeepSeek-V4.1-Flash support (t3 findings closure)

- **Reviewer**: `code-reviewer` (team `v41-flash-support`), task **t9**, round 2
- **Reviewed task**: **t8** — repair round 2 (closing the t3 findings)
- **Supersedes nothing**: r1 remains at `docs/reviews/2026-09-23-v41-flash-code-review.md` and is the finding list this round judges. r1's verdict stays on the record as `needs_revision`.
- **Verdict**: **`pass`** — all 9 r1 findings closed; no open high/blocker.
- **Date**: 2026-09-23

---

## 1. Anchors

| Anchor | Value |
| --- | --- |
| Repository root | `/Users/williamshi666/Developers/dsh-context-compression-selector` |
| `HEAD` | `08e3db27fa232393ed2fcc756c0cfc0b591654ca` |
| Delivery state | **uncommitted working tree** (28 tracked modified/renamed + untracked test artifacts). Same situation as r1: no commit exists, so this is again a worktree review. |
| `packages/runtime/src/measurement.ts` | `15a9d468631b15d5ca5addb75243e6378c260d146242638620a13a197e883264` |
| `packages/runtime/src/deepseek-official-pricing.ts` | `99702e077d2db2dcbff0855feee014060251321062590af1a6856a26b4950398` |
| `packages/runtime/tests/deepseek-official-pricing.spec.ts` | `aebe913156cd3501aa0a6ffb3b81a95685f1833ca423b3c813f4ebd67df753be` |
| `packages/runtime/tests/measurement-identity.spec.ts` | `b9ae70b7d34b317ad7b92945c6b41189bea58f3fe8742472760000a3a13bf9ad` |
| `packages/runtime/tests/fixtures/vision-golden.json` | `c417418bf35ef7ac81dc7e07b14706bbd8fb8e53f891a0d44df3ef3c8d790600` |
| `packages/runtime/tests/fixtures/vision-official-sweep.json` | `fb61741a409e276035957931b903faa007bb9d7565a5b345f7471d52be00399a` |

**Re-anchoring note.** The worktree has moved since r1: t8 and t10 landed further changes (notably `countCanonicalContent` was refactored to an `absorb()` helper and the test count rose 507 → 515). Every judgement below was re-derived against the **current** worktree, not the r1 snapshot. Where r1's own verification still holds unchanged I say so explicitly rather than re-running it (the two vision fixtures are **byte-identical** to the r1 hashes, and in r1 I confirmed those bytes are reproducible byte-for-byte from the pinned official revision — that conclusion therefore carries forward without re-derivation).

Gates re-run on the current worktree, all green: `pnpm typecheck` exit 0 · `npx vitest run` **515 passed | 1 skipped (516)** · `pnpm build` exit 0 · `pnpm test:built` 1 passed · `pnpm verify:release` `release verification: OK`. `pnpm test:e2e:packed` was **not** run (t5 owns it).

---

## 2. Finding-by-finding closure

### F1 (r1: high) — runtime READMEs stated the model→artifact mapping inverted → **CLOSED**

Both files now carry an explicit per-id mapping and the positional phrasing is gone.

- `grep -rn "前三个|the first three|first three are served|最后一个"` over all four READMEs → **0 hits** (exit 1).
- `packages/runtime/README.md:7` now reads: "…`deepseek-flash`, `deepseek-v4-flash`, and `deepseek-v4-flash-vision-exp` are served by DeepSeek-V4.1-Flash; `deepseek-v4-pro` keeps its own DeepSeek-V4-Pro tokenizer."
- `packages/runtime/README.zh.md:7` carries the same mapping in Chinese.
- The mapping now agrees with the code (`deepseek-v4-tokenizer.ts:32-39` V4-Pro, `:53-60` V4.1-Flash) and no longer contradicts its own adjacent sentence.

### F2 (r1: high) — `README.zh.md` support table omitted `deepseek-flash` → **CLOSED**

`README.zh.md:50-57` is now a three-column table mirroring the English one:

| 模型路由 | 服务模型 | 选择器压缩 |
| --- | --- | --- |
| `deepseek-flash` | `DeepSeek-V4.1-Flash` | … |
| `deepseek-v4-flash` | `DeepSeek-V4.1-Flash` | 支持 |
| `deepseek-v4-flash-vision-exp` | `DeepSeek-V4.1-Flash` | … |
| `deepseek-v4-pro` | `DeepSeek-V4-Pro` | 支持 |

The `deepseek-flash` row exists, the `服务模型` column exists, and the two language variants now make the same factual claim. Diff confirms 21 changed lines in `README.zh.md`, matching the English table's shape.

### F3 (r1: medium) — stale alignment-padding prose, leaking into the shipped `.d.ts` → **CLOSED**

- `grep -rn "alignment-padding extremes|midpoint of the four alignment|both alignment extremes|compress-pad|four alignment residues|absolute prompt position"` over `packages/runtime/src/` → **0 hits**.
- `packages/runtime/src/measurement.ts:61-71` now states the block length is "a single position-independent value, so `paddingMinimumTokens === paddingMaximumTokens`".
- `:165-173` drops the obsolete absolute-position clause; `:299-307` and `:325-330` describe the single position-independent value.
- **The build output was regenerated**: `packages/runtime/lib/index.d.ts` no longer contains the stale wording (0 hits) and does contain the new text at `:411-412`. This was the part of F3 that mattered — the prose had been shipping in the published type declarations.

### F4 (r1: medium) — frozen TDD item P-9f absent → **CLOSED**

`packages/runtime/tests/deepseek-official-pricing.spec.ts:335-376` now implements P-9f:

- `:336-350` derives `inputCacheHitRate` / `inputCacheMissRate` from `resolveOfficialDeepSeekPrice` (not hard-coded) for the alias id.
- `:363-367` asserts `allowHistory: false`, `reason: 'cache-risk-not-clearly-paid-back'` under the Flash price, with `reclaimedLowerBoundTokens: 1000` / `affectedRetainedSuffixUpperBoundTokens: 25` exactly as spec §⑤.4 P-9f requires.
- `:371-376` keeps the old-price contrast (`0.007`/`0.22` → `allowHistory: true`), which is what makes the assertion meaningful rather than trivially satisfiable.

### F5 (r1: medium) — `CHECKED_AT` predated the alias verification → **CLOSED**

- `packages/runtime/src/deepseek-official-pricing.ts:9` is now `'2026-09-23T01:48:36+08:00'` — the instant the spec records as authoritative for the alias re-pricing (`spec:29`, `:297`, `:829`), i.e. the catalog timestamp now covers every row it describes.
- Two tests pin the exact string rather than merely asserting non-emptiness: `deepseek-official-pricing.spec.ts:317` (the exported constant) and `:331` (the value surfaced on a resolved record). r1's criticism was that the old test only checked "truthy and not the old value"; that gap is closed.
- I independently confirmed every emitted row reports this timestamp, including the untouched V4-Pro rows.

### F6 (r1: medium) — CHANGELOG omitted the alias re-pricing → **CLOSED**

`CHANGELOG.md:16` is a new entry giving **both** tuples (new `0.003/0.15/0.6` etc. and previous `0.007/0.22/0.66` etc.), both `modelVersion` values, and the operational consequence in the captain's own terms: the cache-hit/cache-miss spread narrows `0.213` → `0.147`, which "can turn a previously authorized Adaptive History decision on these routes into `cache-risk-not-clearly-paid-back`". `:17` adds the compatibility-period boundary. `:15` now scopes its "untouched" clause explicitly: "the 'untouched' part of this entry applies to `deepseek-v4-pro` only". All three parts of F6's requiredFix are present.

### F7 (r1: low) — PROVENANCE said 160 where the fixture has 162 → **CLOSED**

`PROVENANCE.md:83` now reads "162-case sweep (42 boundary sizes + 120 seeded random sizes, `SWEEP_SEED = 7`)" and `:87` reads "162/162 identical". Both occurrences corrected and the composition stated.

### F8 (r1: low) — generator docstring missed `--skip-sweep` and the second output → **CLOSED**

`scripts/generate-vision-fixtures.py:30` usage line now ends `[--workdir DIR] [--mirror] [--skip-sweep]`, and `:33-34` lists both outputs (`vision-golden.json`, `vision-official-sweep.json`).

### F9 (r1: low) — Flash price tuple duplicated three times → **CLOSED**

`deepseek-official-pricing.ts:64-75` defines a single `const V41_FLASH_PRICES`, referenced by all three rows at `:79`, `:87`, `:94`. The three rows can no longer drift by construction — the structural fix r1 asked for, rather than a tripwire test.

**Emitted strings unchanged, independently confirmed.** I resolved all 4 ids × 2 currencies × 2 bands through the real module and compared against r1's recorded values: all 16 tuples and all 4 `modelVersion` values are byte-identical to what r1 saw. The refactor is behaviour-preserving.

---

## 3. Requested boundary check — `countSurfaceCounts` is NOT in the public API

t8 exported `countSurfaceCounts` from `measurement.ts` with an `@internal` marker so the mixed-identity guards could be driven directly (they are unreachable through `measureForCompaction`, because `countCanonicalImage` hard-codes the estimator identity to the module constant). The question is whether that leaked into the published surface. **It did not.** Measured on the current worktree:

| Check | Result |
| --- | --- |
| `grep -c countSurfaceCounts packages/runtime/src/index.ts` | **0** |
| `grep -c countSurfaceCounts packages/runtime/lib/index.d.ts` | **0** |
| Runtime public export count (`Object.keys(await import('lib/index.js'))`) | **22** |
| `countSurfaceCounts` among those exports | **false** |
| Occurrences in `lib/index.js` | 2 — both internal (`:408` the call site, `:587` the definition); **not** in the `export {...}` statement |

The `export {...}` statement at `lib/index.js:3755` lists exactly 22 names and does not include it. `packages/runtime/package.json` exposes only `.`, `./invariant`, and `./package.json`, with `types` → `lib/index.d.ts` — and `lib/index.d.ts` does not mention it, so a consumer cannot even reach it by type. The `@internal` pattern matches existing precedent in this repo (`deepseek-v4-vision-tokens.ts:201`, `deepseek-v4-tokenizer.ts:168`).

**Conclusion: no public-API widening. No finding raised.**

---

## 4. Mutation testing — are the new guards real tripwires?

A passing test proves nothing unless it fails when the behaviour breaks. I ran three mutations in a **scratch copy** (`/tmp/t9mut`, with `node_modules` symlinked), never touching the real repository, and restored after each.

| # | Mutation applied | Expected | Observed |
| --- | --- | --- | --- |
| 1 | `countSurfaceCounts` image-estimator identity guard replaced by `if (false)` | test at `measurement-identity.spec.ts:39` turns red | **1 failed / 3 passed** — `expect(result.kind).toBe('unavailable')` received `"tokenizer-estimate"` ✅ |
| 2 | `countSurfaceCounts` tokenizer identity guard replaced by `if (false)` | test at `:46` turns red | **1 failed / 3 passed** — same assertion, received `"exact-tokenizer"` ✅ |
| 3 | `PRICES['deepseek-v4-flash']` reverted to the withdrawn V4-Flash tuple (`0.007/0.22/0.66`, `DeepSeek-V4-Flash-0731`) — the exact regression F4 exists to catch | the new P-9f test turns red | **7 failed / 46 passed** on `deepseek-official-pricing.spec.ts`, including the P-9f assertion at `:363-367` ✅ |

**Restoration verified.** After each mutation the file was copied back from a pristine snapshot and `diff -q` against the real repository reported identical; the affected specs then returned green (`measurement-identity` 4/4, `official-pricing` 53/53). The real repository was never mutated: `grep -c MUTATED packages/runtime/src/measurement.ts` → **0**, and its hash is unchanged from the value recorded in §1.

Mutation 3 is the most informative of the three: it shows the suite would have caught the alias-pricing regression that r1's F4 was about, not merely that a test with the right name exists.

---

## 5. Six-axis re-confirmation (current worktree)

Judged against the current worktree, not the r1 snapshot. Where r1's evidence is unaffected by t8/t10 I cite it rather than re-deriving it.

| # | Axis | Result | Basis |
| --- | --- | --- | --- |
| 1 | **fail-closed discipline** | **PASS** | `grep` for character-count fallbacks (`text.length`, `length / 4`, `charCount`, `estimateTokens`) over `packages/runtime/src/` → **0 hits**. The 14 negative model ids are still enumerated and asserted `undefined` at `deepseek-v4-tokenizer.spec.ts:91-109`. `countSurfaceCounts` guards return `unavailable` on identity change (`measurement.ts:381`, `:390`) — and §4 mutations 1–2 prove those guards are load-bearing. |
| 2 | **asset integrity + per-artifact isolation** | **PASS** | Recomputed all 6 descriptors across both manifests: every byte length and SHA-256 matches (`deepseek-v4`: 6367146/`8f9f37ca…`, 801/`6ac8c8dc…`, 1064/`1c8f573e…`; `deepseek-v4.1-flash`: 6367257/`c90dfa01…`, 801/`6ac8c8dc…`, 1084/`f2c6c602…`). r1 verified bidirectional isolation tests; those tests are unchanged. |
| 3 | **four-way provenance consistency** | **PASS** | The revision `dba1be0a…` resolves consistently across TS constants, both fixtures, `manifest.json`, test assertions, and all three release-gate scripts. r1's single exception (`CHECKED_AT`) is now closed — see F5. |
| 4 | **vision-arithmetic fidelity** | **PASS** | Fixtures are **byte-identical** to r1 (`c417418b…`, `fb61741a…`), and r1 established those bytes reproduce byte-for-byte from the pinned official revision. Additionally verified the R2.8 deviation is sound: spec §R2.8 now records the captain's deliberate ruling not to port the official `assert`, and I fuzzed **601,190** sizes (dense sweep near `min_pixels` + 600k random incl. extreme aspect ratios) → **0 violations, max exactly 1024**, 0 non-safe-integers. The assert is genuinely unreachable, so omitting it removes no protection. |
| 5 | **V4-Pro unaffected** | **PASS** | All three frozen V4-Pro files are byte-identical to their `HEAD` blobs (`8f9f37ca…`, `6ac8c8dc…`, `1c8f573e…`). `manifest.json` diff is exactly the one deleted `"deepseek-v4-flash"` line. `PRICES['deepseek-v4-pro']` still emits `DeepSeek-V4-Pro-0813` with the original four tuples (independently re-resolved). `git status packages/selector/` → **0 entries**. |
| 6 | **TDD evidence** | **PASS** | Test count rose 507 → 515, i.e. the repairs added tests rather than only editing source. Coverage of the new behaviour is discriminating, demonstrated directly by §4's three mutations. |

---

## 6. Verdict

**`pass`.**

All nine r1 findings are closed, each verified against the current worktree by reading the artefact rather than trusting the repair report:

- the two **high** findings (F1, F2) — the shipped documentation now states the model→artifact mapping correctly in both languages, with the inverted positional phrasing gone and the Chinese table brought into line;
- the four **medium** findings (F3–F6) — including the two that had real substance beyond wording: the stale prose no longer ships in `lib/index.d.ts`, and the alias re-pricing is now both test-pinned (P-9f) and honestly recorded in the changelog with its adaptive consequence;
- the three **low** findings (F7–F9) — with F9 fixed structurally (single shared constant) rather than by adding a guard test.

Two claims the repair report made on its own authority I verified independently rather than accepting:

1. **`countSurfaceCounts` did not widen the public API** — measured: 0 references in `index.ts`, 0 in `lib/index.d.ts`, public export count still **22**, absent from the `export {...}` statement (§3). No leak, so no high finding.
2. **The new guards are real tripwires** — established by three mutations in a scratch copy, each turning the expected test red and each cleanly reverted (§4). Mutation 3 additionally shows the suite catches the alias-pricing regression itself, not just the presence of a test.

Residual caveats, none of which block `pass`:

- **The work has still never been committed.** This is the second consecutive review conducted against a mutable worktree, and `HEAD` remains `08e3db2`. Every anchor in §1 can change under the next writer. The gate results above are therefore valid for this snapshot only; the first commit must be followed by a confirmation run before release. This is a process observation, not a code finding, and it is the same caveat r1 recorded.
- **`pnpm test:e2e:packed` remains unrun** by design (t5's remit). t9's `pass` is a Standards-axis verdict on the source and its unit/integration evidence; it is not a substitute for t5's end-to-end verification.

---

## 7. Addendum — post-review documentation edits (verdict unaffected)

After this review was written, the captain made three **documentation-only** edits arising from t11's spec review. None touches code, and I re-checked the one that lands in a file this review judged:

| Edit | File | Effect on this review |
| --- | --- | --- |
| Added a "Deliberate deviation from the official `safe_resize` upper-bound assert" section | `packages/runtime/tests/fixtures/PROVENANCE.md` | **None.** This is the file F7 concerned, so I re-verified: `:83` still reads "162-case sweep (42 boundary sizes + 120 seeded random sizes, `SWEEP_SEED = 7`)" and `:87` still reads "162/162 identical". **F7 remains closed.** |
| spec R5.8a "判定式（机检）" → "（人工核对）" | `docs/specs/…-spec.md` | None — the spec is outside this review's judgement; the change corrects a spec claim (no README-table machine check exists repo-wide), which I confirm: `verify-release.mjs` contains no README-table assertion. |
| Added an "证据边界" section to spec R4.14 | `docs/specs/…-spec.md` | None, and it is consistent with §4 of this review: the two `absorb()`-side guards in `countCanonicalContent` (`measurement.ts:193`, `:203`) are same-source siblings of the `countSurfaceCounts` guards I mutated, and are indeed not directly test-drivable. Mutations 1–2 exercised the `countSurfaceCounts` copies, which are reachable via the `@internal` export; the `absorb()` copies remain unexercised by construction. Recorded here so the distinction is not lost. |

Re-run after these edits: `npx vitest run` → **515 passed | 1 skipped (516)**, i.e. unchanged, confirming the edits are documentation-only. **The `pass` verdict stands.**
