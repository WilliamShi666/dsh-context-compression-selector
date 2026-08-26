# Test inventory

Every checked-in spec belongs to an active test project. There is no silent
legacy-test allowlist.

## Root suite

- Runtime: `packages/runtime/tests/**/*.spec.ts` under the `runtime` project.
- Selector Host: `cache-prefix-audit.spec.ts` plus every `*.host.spec.ts` under
  the `selector-host` project.
- Selector client: every `*.client.spec.ts` or `*.client.spec.tsx` under the
  `selector-client` project.
- Built browser artifact: `packages/selector/tests/built/client-artifact.spec.ts`
  under the separate `vitest.built.config.ts` gate, after `pnpm build`.

The root `pnpm test`, both package-local `pnpm test` commands, and
`pnpm test:built` are release gates. `scripts/verify-release.mjs` compares the
checked-in spec inventory with these project rules so a new test cannot be
silently excluded.

## Removed transition tests

The standalone extraction initially carried twelve specs copied from the
integrated Harness worktree. They depended on removed private packages,
monorepo-relative fixtures, or the retired `compaction/group-trim` event and
were not executable in a public checkout. They were removed instead of
reintroducing Harness core dependencies.

Their supported behavior is covered by active public tests:

- policy resolution, reducers, exact measurement, Fresh, Aggregate, routine
  and capacity-pressure History, Native pruning, TailTrim publication,
  recovery, replay and orphan fail-open behavior:
  `packages/runtime/tests/public/public-runtime.spec.ts`;
- Loader composition, preset overlay, Minimal pause/restore and parent/child
  service identity: `packages/selector/tests/preset-overlay-loader.e2e.host.spec.ts`;
- package/export/tarball contract:
  `packages/selector/tests/public/package-contract.client.spec.ts` and
  `scripts/packed-install-e2e.mjs`;
- profile and Custom editor behavior:
  `packages/selector/tests/profiles.client.spec.tsx`.
