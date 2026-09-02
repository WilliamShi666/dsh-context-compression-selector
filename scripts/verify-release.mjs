import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

const fail = (message) => {
  throw new Error(`release verification: ${message}`)
}

const json = async (path) => JSON.parse(await readFile(path, 'utf8'))
const rootPackage = await json(join(root, 'package.json'))
const runtimePackage = await json(join(root, 'packages/runtime/package.json'))
const selectorPackage = await json(join(root, 'packages/selector/package.json'))

if (!rootPackage.scripts?.typecheck?.includes('pnpm run typecheck:tests')
  || rootPackage.scripts?.['typecheck:tests'] !== 'tsc --noEmit -p tsconfig.tests.json') {
  fail('root typecheck must include the strict active-test TypeScript gate')
}
if (runtimePackage.scripts?.test
  !== 'vitest run --root ../.. --config vitest.config.ts --project runtime') {
  fail('Runtime package-local test script is not the verified root project command')
}
if (selectorPackage.scripts?.test
  !== 'vitest run --root ../.. --config vitest.config.ts --project selector-host --project selector-client') {
  fail('Selector package-local test script is not the verified root project command')
}
const ci = await readFile(join(root, '.github/workflows/ci.yml'), 'utf8')
for (const required of [
  'pnpm --filter dsh-context-compression-selector-runtime test',
  'pnpm --filter dsh-context-compression-selector test',
]) {
  if (!ci.includes(required)) fail(`CI lacks package-local gate: ${required}`)
}
// The packed release E2E is the release gate that actually installs the
// tarballs: verify it cannot be silently dropped or defanged. It must exist
// as a root script, CI must run exactly that script, the script must default
// to fail-closed release mode, and that mode must refuse every skip/null
// lifecycle outcome.
if (rootPackage.scripts?.['test:e2e:packed'] !== 'node scripts/packed-install-e2e.mjs') {
  fail('root test:e2e:packed script is missing or does not run the packed E2E directly')
}
if (!ci.includes('pnpm run test:e2e:packed') && !ci.includes('pnpm test:e2e:packed')) {
  fail('CI does not run the packed release E2E gate')
}
const packedE2e = await readFile(join(root, 'scripts/packed-install-e2e.mjs'), 'utf8')
if (!/const e2eMode = process\.env\.DSH_E2E_MODE === 'dev' \? 'dev' : 'release'/u.test(packedE2e)) {
  fail('packed E2E must default to release mode (dev only via an explicit DSH_E2E_MODE)')
}
for (const failClosed of [
  'release gate requires the upgrade leg to run',
  'release gate requires the official clean-harness lifecycle to run',
]) {
  if (!packedE2e.includes(failClosed)) {
    fail(`packed E2E release mode lost its fail-closed guard: ${failClosed}`)
  }
}
const packedComponents = await readFile(join(root, 'scripts/packed-components-smoke.mjs'), 'utf8')
for (const required of [
  'Runtime.measureForCompaction(visionCtx, visionImage)',
  "estimatedImageCount?.kind === 'tokenizer-estimate'",
  'estimatedImageCount.tokens === 340',
  'estimatedImageCount.upperBoundTokens === 384',
  'imageMeasurement.currentSurface.kind',
]) {
  if (!packedComponents.includes(required)) {
    fail(`packed component smoke lost its installed vision estimate guard: ${required}`)
  }
}
for (const required of [
  "packedVisionSmoke.imageSession?.measurement?.kind === 'tokenizer-estimate'",
  'packedVisionSmoke.imageSession.measurement.tokens === 340',
  'packedVisionSmoke.imageSession.measurement.upperBoundTokens === 384',
  'packedVisionSmoke.imageSession.measurement.estimatorId',
  'packedVisionSmoke.imageSession.measurement.estimatorRevision',
]) {
  if (!packedE2e.includes(required)) {
    fail(`packed E2E lost its parsed vision estimate guard: ${required}`)
  }
}
await stat(join(root, 'tsconfig.tests.json'))

if (selectorPackage.dependencies?.['dsh-context-compression-selector-runtime'] !== selectorPackage.version) {
  fail('selector must depend on the exact same runtime version')
}
if (selectorPackage.dsh?.bundle?.patch !== './cordis.patch.yml') {
  fail('selector must declare the DSH Bundle patch')
}
if (selectorPackage.files?.some((entry) => entry.endsWith('.css'))) {
  fail('selector must not rely on separately served CSS assets')
}
if (runtimePackage.name !== 'dsh-context-compression-selector-runtime') fail('unexpected runtime package name')
if (selectorPackage.name !== 'dsh-context-compression-selector') fail('unexpected selector package name')
for (const [name, manifest] of [
  ['runtime', runtimePackage],
  ['selector', selectorPackage],
]) {
  if (manifest.publishConfig?.access !== 'public') fail(`${name} publish access is not public`)
  if (manifest.publishConfig?.tag !== 'beta') fail(`${name} publish tag is not beta`)
}
for (const peer of [
  '@deepseek-ai/dsh-command-compact',
  '@deepseek-ai/dsh-compaction-basic',
]) {
  if (selectorPackage.peerDependencies?.[peer] !== '>=0.1.1-rc.2 <0.2.0') {
    fail(`selector peer ${peer} is missing or outside the verified range`)
  }
}
for (const packageRoot of [join(root, 'packages/runtime'), join(root, 'packages/selector')]) {
  const notice = await readFile(join(packageRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  if (!notice.includes('Copyright (c) 2026 DeepSeek')) {
    fail(`${relative(root, packageRoot)} does not carry the full DeepSeek Harness MIT notice`)
  }
}

const assetManifests = [
  {
    directory: 'deepseek-v4',
    repository: 'deepseek-ai/DeepSeek-V4-Pro',
    modelIds: 'deepseek-v4-flash","deepseek-v4-pro',
  },
  {
    directory: 'deepseek-v4-vision-exp',
    repository: 'deepseek-ai/DeepSeek-V4-Flash-Vision-Exp',
    revision: '6821d6ad3681a4b137b066b76094fa82ebd0a380',
    modelIds: 'deepseek-v4-flash-vision-exp',
  },
]
for (const expected of assetManifests) {
  const assetRoot = join(root, 'packages/runtime/assets', expected.directory)
  const manifest = await json(join(assetRoot, 'manifest.json'))
  if (manifest.repository !== expected.repository) fail(`${expected.directory} manifest repository differs`)
  if (!JSON.stringify(manifest.modelIds).includes(expected.modelIds)) {
    fail(`${expected.directory} manifest model ids differ`)
  }
  if (expected.revision !== undefined && manifest.revision !== expected.revision) {
    fail(`${expected.directory} manifest revision is not the pinned vision revision`)
  }
  for (const [name, descriptor] of Object.entries(manifest.files)) {
    const bytes = await readFile(join(assetRoot, name))
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (bytes.byteLength !== descriptor.bytes) fail(`${expected.directory}/${name} byte length differs from manifest`)
    if (hash !== descriptor.sha256) fail(`${expected.directory}/${name} SHA-256 differs from manifest`)
  }
  const runtimeFiles = runtimePackage.files
  if (!runtimeFiles.includes(`assets/${expected.directory}/*`)) {
    fail(`runtime package files list omits assets/${expected.directory}/*`)
  }
}

const sourceRoots = [join(root, 'packages/runtime/src'), join(root, 'packages/selector/src')]
const forbidden = [
  { pattern: /compaction\/group-trim/u, label: 'custom compaction/group-trim event' },
  { pattern: /@deepseek-ai\/[^'"\s]+\/src(?:\/|['"])/u, label: 'Harness source subpath import' },
  { pattern: /(?:\/home\/|[A-Za-z]:\\Users\\)/u, label: 'developer absolute path' },
  { pattern: /\.\.\/\.\.\/\.\.\/(?:core|packages)\//u, label: 'monorepo-relative source import' },
]

const walk = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await walk(path))
    else files.push(path)
  }
  return files
}

for (const sourceRoot of sourceRoots) {
  for (const path of await walk(sourceRoot)) {
    const text = await readFile(path, 'utf8')
    for (const rule of forbidden) {
      if (rule.pattern.test(text)) fail(`${relative(root, path)} contains ${rule.label}`)
    }
  }
}

for (const packageRoot of [join(root, 'packages/runtime'), join(root, 'packages/selector')]) {
  const lib = join(packageRoot, 'lib')
  if (!(await stat(lib)).isDirectory()) fail(`${relative(root, lib)} is missing; run build first`)
  for (const path of await walk(lib)) {
    if (path.endsWith('.map')) fail(`${relative(root, path)} is a source map`)
  }
}

const clientArtifact = await readFile(join(root, 'packages/selector/lib/client.js'), 'utf8')
if (!clientArtifact.startsWith('window.__ModuleLoader__.load({')) {
  fail('client.js is not a Harness lazy-CJS artifact')
}
if (!clientArtifact.includes('data-plugin-css') || !clientArtifact.includes('document.head.appendChild(tag)')) {
  fail('client.js does not contain its tagged CSS injection')
}
if (/^\s*(?:import|export)\s/mu.test(clientArtifact)) fail('client.js contains ESM syntax')
if (/(?:\/home\/|[A-Za-z]:\\Users\\)/u.test(clientArtifact)) fail('client.js contains a developer absolute path')
if (clientArtifact.includes('sourceMappingURL')) fail('client.js contains a source map reference')
const clientRequires = [...clientArtifact.matchAll(/require\("([^"]+)"\)/gu)].map(match => match[1])
const allowedClientRequires = new Set([
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-primitives',
])
for (const dependency of clientRequires) {
  if (!allowedClientRequires.has(dependency)) fail(`client.js has unexpected external dependency ${dependency}`)
}

const collectSpecs = async (directory) => (await walk(directory))
  .filter(path => /\.spec\.tsx?$/u.test(path))
  .map(path => relative(root, path).replaceAll('\\', '/'))
  .sort()

const runtimeSpecs = await collectSpecs(join(root, 'packages/runtime/tests'))
const selectorSpecs = await collectSpecs(join(root, 'packages/selector/tests'))
if (runtimeSpecs.some(path => !path.endsWith('.spec.ts'))) {
  fail('Runtime test inventory contains a spec outside the active **/*.spec.ts project')
}
const selectorUnclassified = selectorSpecs.filter(path => path !== 'packages/selector/tests/cache-prefix-audit.spec.ts'
  && path !== 'packages/selector/tests/built/client-artifact.spec.ts'
  && !path.endsWith('.host.spec.ts')
  && !path.endsWith('.client.spec.ts')
  && !path.endsWith('.client.spec.tsx'))
if (selectorUnclassified.length > 0) {
  fail(`Selector test inventory contains unclassified specs: ${selectorUnclassified.join(', ')}`)
}
const rootTestConfig = await readFile(join(root, 'vitest.config.ts'), 'utf8')
for (const required of [
  'packages/runtime/tests/**/*.spec.ts',
  'packages/selector/tests/**/*.host.spec.ts',
  'packages/selector/tests/**/*.client.spec.{ts,tsx}',
  'packages/selector/tests/cache-prefix-audit.spec.ts',
]) {
  if (!rootTestConfig.includes(required)) fail(`vitest.config.ts lacks active inventory rule ${required}`)
}
const builtTestConfig = await readFile(join(root, 'vitest.built.config.ts'), 'utf8')
if (!builtTestConfig.includes('packages/selector/tests/built/**/*.spec.ts')) {
  fail('vitest.built.config.ts lacks the built client artifact inventory rule')
}
const forbiddenTestDependencies = [
  /(?:from\s+|import\s*\(|require\s*\()\s*['"]@deepseek-ai\/dsh-compaction-tool-result-pruner/u,
  /(?:from\s+|import\s*\(|require\s*\()\s*['"]@deepseek-ai\/dsh-tool-context-retrieve/u,
  /\.\.\/\.\.\/\.\.\/(?:core|client)\//u,
]
for (const path of [...runtimeSpecs, ...selectorSpecs]) {
  const text = await readFile(join(root, path), 'utf8')
  if (forbiddenTestDependencies.some(pattern => pattern.test(text))) {
    fail(`${path} depends on a removed core-extension or monorepo test contract`)
  }
}

const runtime = await import(new URL('../packages/runtime/lib/index.js', import.meta.url))
const defaults = runtime.DEFAULT_CUSTOM_COMPRESSION_POLICY
if (defaults?.history?.trigger !== 500_000) fail('Custom History default is not 500000')
if (defaults?.tailTrim?.trigger !== 700_000 || defaults?.tailTrim?.enabled !== false) {
  fail('Custom TailTrim default is not disabled at 700000')
}

console.info('release verification: OK')
