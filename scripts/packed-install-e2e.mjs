import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
// Release mode (default) is fail-closed: the upgrade leg and the official
// clean-harness lifecycle must both run to green or the gate exits non-zero.
// Set DSH_E2E_MODE=dev for an offline smoke with explicit skip markers.
const e2eMode = process.env.DSH_E2E_MODE === 'dev' ? 'dev' : 'release'
const packages = [
  { directory: join(root, 'packages/runtime') },
  { directory: join(root, 'packages/selector') },
]
const officialHostPackages = [
  '@deepseek-ai/cordis@4.0.1',
  '@deepseek-ai/cordis-plugin-group@1.0.1',
  '@deepseek-ai/cordis-plugin-include@1.0.6',
  '@deepseek-ai/cordis-plugin-loader@1.0.2',
  '@deepseek-ai/dsh-agent@0.1.1-rc.2',
  '@deepseek-ai/dsh-agent-loop@0.1.1-rc.2',
  '@deepseek-ai/dsh-agent-loop-testkit@0.1.1-rc.2',
  '@deepseek-ai/dsh-agent-presets@0.1.1-rc.2',
  '@deepseek-ai/dsh-commands@0.1.1-rc.2',
  '@deepseek-ai/dsh-command-compact@0.1.1-rc.2',
  '@deepseek-ai/dsh-compaction-basic@0.1.1-rc.2',
  '@deepseek-ai/dsh-llm@0.1.1-rc.2',
  '@deepseek-ai/dsh-session@0.1.1-rc.2',
  '@deepseek-ai/dsh-scope@0.1.1-rc.2',
  '@deepseek-ai/dsh-settings@0.1.1-rc.2',
  '@deepseek-ai/dsh-system-prompt@0.1.1-rc.2',
  '@deepseek-ai/dsh-token-meter@0.1.1-rc.2',
  '@deepseek-ai/dsh-tools@0.1.1-rc.2',
]

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit', ...options })
  child.once('error', reject)
  child.once('exit', (code, signal) => {
    if (code === 0) resolve()
    else reject(new Error(`${command} exited ${code ?? `from signal ${signal}`}`))
  })
})

const capture = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.once('error', reject)
  child.once('exit', (code, signal) => {
    if (code === 0) resolve({ stdout, stderr })
    else reject(new Error([
      `${command} exited ${code ?? `from signal ${signal}`}`,
      stdout.trim(),
      stderr.trim(),
    ].filter(Boolean).join('\n')))
  })
})

const captureOutcome = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.once('error', reject)
  child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }))
})

const assert = (condition, message) => {
  if (!condition) throw new Error(`packed Host smoke: ${message}`)
}

async function scanPublishedTree(packageRoot) {
  const pending = [packageRoot]
  const violations = []
  const forbidden = [
    { label: 'developer absolute path', pattern: /(?:\/home\/|[A-Za-z]:\\Users\\)/u },
    { label: 'OpenAI-style secret', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/u },
    { label: 'NPM token', pattern: /\bnpm_[A-Za-z0-9]{20,}\b/u },
    { label: 'GitHub token', pattern: /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}\b/u },
    { label: 'assigned DeepSeek API key', pattern: /DEEPSEEK_API_KEY\s*=\s*[^\s"']+/u },
  ]
  while (pending.length > 0) {
    const directory = pending.pop()
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(path)
        continue
      }
      if (!/\.(?:js|d\.ts|json|md|ya?ml|txt)$/u.test(entry.name)
        || entry.name === 'tokenizer.json') continue
      const text = await readFile(path, 'utf8')
      for (const rule of forbidden) {
        if (rule.pattern.test(text)) violations.push(`${path}: ${rule.label}`)
      }
    }
  }
  if (violations.length > 0) throw new Error(`packed content scan failed:\n${violations.join('\n')}`)
}

async function runPackedHostSmoke(consumerRoot) {
  const consumerRequire = createRequire(join(consumerRoot, 'package.json'))
  const load = async specifier => import(pathToFileURL(consumerRequire.resolve(specifier)).href)
  const [
    cordis,
    groupModule,
    includeModule,
    loaderModule,
    agentModule,
    agentLoopModule,
    presetsModule,
    commandsModule,
    llmModule,
    sessionModule,
    scopeModule,
    settingsModule,
    systemPromptModule,
    tokenMeterModule,
    toolsModule,
    selectorModule,
  ] = await Promise.all([
    load('@deepseek-ai/cordis'),
    load('@deepseek-ai/cordis-plugin-group'),
    load('@deepseek-ai/cordis-plugin-include'),
    load('@deepseek-ai/cordis-plugin-loader'),
    load('@deepseek-ai/dsh-agent'),
    load('@deepseek-ai/dsh-agent-loop'),
    load('@deepseek-ai/dsh-agent-presets'),
    load('@deepseek-ai/dsh-commands'),
    load('@deepseek-ai/dsh-llm'),
    load('@deepseek-ai/dsh-session'),
    load('@deepseek-ai/dsh-scope'),
    load('@deepseek-ai/dsh-settings'),
    load('@deepseek-ai/dsh-system-prompt'),
    load('@deepseek-ai/dsh-token-meter'),
    load('@deepseek-ai/dsh-tools'),
    load('dsh-context-compression-selector'),
  ])

  class MemorySettings extends settingsModule.SettingsProvider {
    writable = true

    load() {
      return Promise.resolve({})
    }

    persist() {
      return Promise.resolve()
    }
  }

  const presetRoot = join(consumerRoot, 'preset-fixtures')
  await mkdir(presetRoot)
  const marker = join(presetRoot, 'marker.mjs')
  await writeFile(marker, 'export function apply() {}\n')
  const source = `- id: source-marker\n  name: ${JSON.stringify(marker)}\n`
  for (const id of ['standard', 'custom', 'minimal']) {
    const directory = join(presetRoot, id)
    await mkdir(directory)
    await writeFile(join(directory, presetsModule.COMPOSITION_FILE), source)
  }

  const runtime = new cordis.Context()
  try {
    runtime.baseUrl = `${pathToFileURL(presetRoot).href}/`
    await runtime.plugin(loaderModule.default)
    runtime.loader.builtins.include = includeModule.default
    runtime.loader.builtins.group = groupModule.default
    await runtime.plugin(llmModule.default)
    await runtime.plugin(sessionModule.default)
    await runtime.plugin(systemPromptModule.default, { persona: '' })
    await runtime.plugin(toolsModule.default)
    await runtime.plugin(agentModule.default)
    await runtime.plugin(agentLoopModule.default, { agents: [] })
    await runtime.plugin(commandsModule.default)
    await runtime.plugin(tokenMeterModule.default)
    await runtime.plugin(MemorySettings)
    await runtime.plugin(presetsModule.default, {
      default: 'standard',
      roots: [{ path: presetRoot, trust: 'system' }],
      includeUserRoot: false,
    })
    await runtime.plugin({
      apply: selectorCtx => selectorModule.apply(selectorCtx, { presetOverlay: true }),
    }).await()

    const createAgent = async (sessionId, preset) => {
      const handle = await runtime.agents.create({
        sessionId: sessionModule.SessionId(sessionId),
        setup: async agentCtx => void await runtime.agentPresets.mount(agentCtx, preset),
      })
      return handle.agent
    }
    const hasRetrieve = agent => runtime.tools.get(
      'context_compression_retrieve',
      scopeModule.scopeOf(agent.ctx),
    ) !== undefined
    const hasCompact = agent => runtime.commands.list(agent)
      .some(command => command.name === 'compact')
    const hasCompleteStack = agent =>
      runtime.agentPresets.serviceFor(agent, 'toolResultPruner') !== undefined
      && runtime.agentPresets.serviceFor(agent, 'compaction') !== undefined
      && hasRetrieve(agent)
      && hasCompact(agent)
    const hasNoStack = agent =>
      runtime.agentPresets.serviceFor(agent, 'toolResultPruner') === undefined
      && runtime.agentPresets.serviceFor(agent, 'compaction') === undefined
      && !hasRetrieve(agent)
      && !hasCompact(agent)

    const sourcePreset = await runtime.agentPresets.resolve('standard')
    const sourceText = await runtime.agentPresets.read('standard')
    const agent = await createAgent('packed-host-standard', 'standard')
    assert(hasCompleteStack(agent), 'standard preset did not mount the complete compression stack')
    assert((await runtime.agentPresets.resolve('standard')).path === sourcePreset.path,
      'overlay changed the source preset path')
    assert(await runtime.agentPresets.read('standard') === sourceText,
      'overlay changed the source preset contents')
    assert(!sourceText.includes('tool-result-pruner'), 'source preset was mutated')

    await runtime.agentPresets.recompose(agent.ctx, 'minimal')
    assert(hasNoStack(agent), 'exact Minimal preset retained compression')
    await runtime.agentPresets.recompose(agent.ctx, 'custom')
    assert(hasCompleteStack(agent), 'compression did not return after leaving Minimal')

    const parent = await createAgent('packed-host-parent', 'standard')
    const childHandle = await runtime.agents.create({
      sessionId: sessionModule.SessionId('packed-host-child'),
      setup: childCtx => void runtime.agentPresets.composeFrom(childCtx, parent.ctx),
    })
    const child = childHandle.agent
    const original = Symbol.for('cordis.original')
    const parentPruner = runtime.agentPresets.serviceFor(parent, 'toolResultPruner')
    const childPruner = runtime.agentPresets.serviceFor(child, 'toolResultPruner')
    const parentCompaction = runtime.agentPresets.serviceFor(parent, 'compaction')
    const childCompaction = runtime.agentPresets.serviceFor(child, 'compaction')
    assert(parentPruner !== undefined && childPruner !== undefined,
      'parent or child pruner is missing')
    assert(parentCompaction !== undefined && childCompaction !== undefined,
      'parent or child compaction engine is missing')
    assert(Object.is(childPruner[original], parentPruner[original]),
      'child did not inherit the parent pruner instance')
    assert(Object.is(childCompaction[original], parentCompaction[original]),
      'child did not inherit the parent compaction instance')
    assert(hasRetrieve(child) && hasCompact(child),
      'child lacks the inherited retrieve tool or compact command')

    const namespace = settingsModule.settingsNamespace('context-compression')
    const settings = runtime.settings.get(namespace)
    assert(settings.custom.history.trigger === 500_000,
      'packed Host did not expose the 500000 History default')
    assert(settings.custom.tailTrim.enabled === false && settings.custom.tailTrim.trigger === 700_000,
      'packed Host did not expose disabled TailTrim at 700000')

    return {
      officialHostPackages: officialHostPackages.length,
      standardPreset: 'complete-stack',
      minimalPreset: 'no-stack',
      postMinimalPreset: 'complete-stack',
      childServices: 'same-parent-instances',
      sourcePreset: 'unchanged',
      defaults: { history: 500_000, tailTrim: { enabled: false, trigger: 700_000 } },
    }
  } finally {
    await runtime.fiber.dispose()
  }
}

async function runOfficialCloneCliSmoke(referenceRoot, registry, upgradeFrom, candidateVersion) {
  const clone = await realpath(referenceRoot)
  const git = async (...args) => (await capture('git', args, { cwd: clone })).stdout.trim()
  const before = {
    tag: await git('describe', '--tags', '--exact-match'),
    commit: await git('rev-parse', 'HEAD'),
    tree: await git('rev-parse', 'HEAD^{tree}'),
    status: await git('status', '--porcelain'),
  }
  assert(before.tag === 'dsh-v0.1.1-rc.2', `official clone tag is ${before.tag}`)
  assert(before.commit === 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e',
    `official clone commit is ${before.commit}`)
  assert(before.tree === '53915efe4e2126cc7779b73dfc8a3bcec5318c44',
    `official clone tree is ${before.tree}`)
  assert(before.status === '', 'official clone is dirty before CLI smoke')

  const temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-selector-official-clone-'))
  const worktree = join(temporaryRoot, 'official')
  const dshHome = join(temporaryRoot, 'dsh-home')
  let added = false
  const environment = { ...process.env, DSH_HOME: dshHome }
  const dsh = (...args) => run('pnpm', ['dsh', ...args], { cwd: worktree, env: environment })
  const dumpConfig = () => capture('pnpm', ['dsh', '--profile', 'web', '--dump-config'], {
    cwd: worktree,
    env: environment,
  }).then(captured => captured.stdout)

  /** Installed manifests of the profile-resolved selector and runtime. */
  const profilePackages = () => {
    const profileRoot = join(dshHome, 'profiles/web')
    const profileRequire = createRequire(join(profileRoot, 'package.json'))
    const selectorPath = profileRequire.resolve('dsh-context-compression-selector/package.json')
    const runtimePath = profileRequire.resolve('dsh-context-compression-selector-runtime/package.json')
    return {
      profileRoot,
      selectorPath,
      runtimePath,
      selector: JSON.parse(readFileSync(selectorPath, 'utf8')),
      runtime: JSON.parse(readFileSync(runtimePath, 'utf8')),
    }
  }

  /**
   * Peers a headless official profile can never provide: pure web-host UI
   * packages supplied by the web app, not the CLI installation. The list is
   * REVIEWED and exact — any OTHER unresolved selector peer fails the gate,
   * and every web/client peer is still import-verified from the built
   * client libraries below.
   */
  const WEB_ONLY_HEADLESS_UNRESOLVED_PEERS = [
    '@deepseek-ai/dsh-client-ui-primitives',
    '@deepseek-ai/dsh-client-ui-slots',
  ]

  /**
   * Verify every web/client peer exists as a BUILT artifact resolvable from
   * the packages that depend on it. Executable loading of the client stack
   * happens under the web bundler, not bare Node (the UI packages ship CSS
   * modules only a bundler can import): that load leg is the `build:web`
   * step of the worktree's `pnpm run build` above, which fails closed when
   * the client graph is broken.
   */
  const proveBuiltClientPeersLoad = async () => {
    const clientPeers = [
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-ui-primitives',
      '@deepseek-ai/dsh-client-ui-settings',
      '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-workspace',
      'react',
    ]
    // pnpm's isolated layout keeps each package's dependents in ITS own
    // node_modules, so anchor resolution at the packages that actually
    // depend on the client stack: the web-app bundle (locale, runtime,
    // ui-settings, ui-workspace), the client-locale package (react,
    // ui-primitives, ui-slots), and the web app.
    const anchors = JSON.stringify([
      join(worktree, 'packages/bundle/web-app/package.json'),
      join(worktree, 'packages/client/locale/package.json'),
      join(worktree, 'apps/web/package.json'),
    ])
    const outcome = await captureOutcome(process.execPath, ['--input-type=commonjs', '-e', [
      "const { createRequire } = require('node:module')",
      `const anchors = ${anchors}.map(path => createRequire(path))`,
      `for (const peer of ${JSON.stringify(clientPeers)}) {`,
      '  const resolved = anchors.some(requireFrom => {',
      '    try { requireFrom.resolve(peer); return true } catch { return false }',
      '  })',
      "  if (!resolved) throw new Error('built client peer resolved from no dependent package: ' + peer)",
      '}',
      "console.log('CLIENT_PEERS_OK')",
    ].join('\n')], { cwd: worktree, env: environment })
    if (outcome.code !== 0 || !outcome.stdout.includes('CLIENT_PEERS_OK')) {
      throw new Error(`built client peers failed to resolve in the official worktree:\n${outcome.stdout}\n${outcome.stderr}`)
    }
    return clientPeers.length
  }

  /**
   * Prove the plugin actually loads in the official profile: pnpm's peers
   * check cannot see the healed profiles/node_modules fallback by design, so
   * the release gate resolves and imports instead. Fail-closed parts: every
   * RUNTIME peer (the engine surface the headless host must provide) and the
   * selector's node entry with a callable apply(). The selector's remaining
   * unresolved peers must equal the REVIEWED web-only whitelist above —
   * anything else (a newly missing host dependency) fails immediately.
   */
  const provePluginLoads = async () => {
    const { profileRoot, selector, runtime } = profilePackages()
    const enginePeers = Object.keys(runtime.peerDependencies ?? {})
    const selectorPeers = Object.keys(selector.peerDependencies ?? {})
    for (const allowed of WEB_ONLY_HEADLESS_UNRESOLVED_PEERS) {
      if (!selectorPeers.includes(allowed)) {
        throw new Error(`web-only whitelist names a peer the selector no longer declares: ${allowed}`)
      }
    }
    const script = [
      "const { createRequire } = require('node:module')",
      `const requireFromProfile = createRequire(String.raw\`${join(profileRoot, 'package.json')}\`)`,
      `for (const peer of ${JSON.stringify(enginePeers)}) {`,
      '  requireFromProfile.resolve(peer)',
      '}',
      "const selectorEntry = requireFromProfile.resolve('dsh-context-compression-selector')",
      'const plugin = require(selectorEntry)',
      "if (typeof plugin.apply !== 'function') throw new Error('selector entry exports no apply()')",
      `const unresolved = []`,
      `for (const peer of ${JSON.stringify(selectorPeers)}) {`,
      '  try { requireFromProfile.resolve(peer) } catch { unresolved.push(peer) }',
      '}',
      "console.log('LOAD_OK ' + JSON.stringify(unresolved))",
    ].join('\n')
    const outcome = await captureOutcome(process.execPath, ['--input-type=commonjs', '-e', script], {
      cwd: worktree,
      env: environment,
    })
    const marker = outcome.stdout.split('\n').find(line => line.startsWith('LOAD_OK'))
    if (outcome.code !== 0 || marker === undefined) {
      throw new Error(`official profile failed to load the plugin and its engine peers:\n${outcome.stdout}\n${outcome.stderr}`)
    }
    const unresolved = JSON.parse(marker.slice('LOAD_OK '.length))
    const unexpected = unresolved.filter(peer => !WEB_ONLY_HEADLESS_UNRESOLVED_PEERS.includes(peer))
    if (unexpected.length > 0) {
      throw new Error(`selector peers failed to resolve headless outside the reviewed web-only whitelist: ${unexpected.join(', ')}`)
    }
    return {
      enginePeers: enginePeers.length,
      headlessUnresolvedSelectorPeers: unresolved,
      whitelist: WEB_ONLY_HEADLESS_UNRESOLVED_PEERS,
      builtClientPeersVerified: await proveBuiltClientPeersLoad(),
    }
  }

  /**
   * Boot the official profile FOR REAL through the CLI's own profile-boot
   * path — not --dump-config, which composes YAML without booting or
   * executing plugins. The probe mounts the full bundle tree (selector
   * included), then proves: the settings service resolves the registered
   * document (before the upgrade: the previous release's schema defaults;
   * after: the seeded savings/73 document parsed with the INSTALLED runtime),
   * the AgentPresets service composed the selector's standing overlay, and
   * the overlay's generated composition exists with the deterministic
   * identity filename. Any failure exits non-zero.
   */
  const runProfileBootProbe = async (phase, expectSeeded) => {
    const { profileRoot } = profilePackages()
    const settingsProof = expectSeeded
      ? [
        '  const requireFromProfile = createRequire(profileRoot)',
        "  const runtimeEntry = requireFromProfile.resolve('dsh-context-compression-selector-runtime/package.json').replace(/package\\.json$/u, 'lib/index.js')",
        '  const runtime = requireFromProfile(runtimeEntry)',
        '  const parsed = runtime.parseContextCompressionSettings(structuredClone(raw))',
        "  if (parsed.profile !== 'savings' || parsed.autoCompact.thresholdPercent !== 73) {",
        "    throw new Error('boot probe: booted settings did not expose the seeded document: ' + JSON.stringify(parsed))",
        '  }',
      ]
      : [
        // The previous release predates the autoCompact section and the
        // public parser; prove its OWN schema resolved the registered
        // namespace into a complete supported document instead.
        "  if (raw?.profile !== 'balanced' || raw?.custom?.version !== 3) {",
        "    throw new Error('boot probe: previous-release settings defaults did not resolve: ' + JSON.stringify(raw))",
        '  }',
      ]
    const probe = [
      "import { readdir } from 'node:fs/promises'",
      "import { tmpdir } from 'node:os'",
      "import { join } from 'node:path'",
      "import { createRequire } from 'node:module'",
      "import { pathToFileURL } from 'node:url'",
      `const worktree = String.raw\`${worktree}\``,
      `const profileRoot = String.raw\`${join(profileRoot, 'package.json')}\``,
      'const bootModule = await import(pathToFileURL(join(worktree, \'apps/cli/src/profile-boot.ts\')).href)',
      // Import the workspace packages from their source trees (pinned, like
      // the profile-boot path above): the probe runs under tsx, and their
      // lib/ artifacts are only produced by the full release build, not the
      // library faces.
      "const appBoot = await import(pathToFileURL(join(worktree, 'packages/boot/app-boot/src/index.ts')).href)",
      "const settingsModule = await import(pathToFileURL(join(worktree, 'packages/settings/settings/src/index.ts')).href)",
      'const preBootStores = new Set(await readdir(tmpdir()))',
      'const { ctx } = await bootModule.runProfile({',
      "  environment: appBoot.loadLayeredEnv('dsh'),",
      "  profile: 'web',",
      '  patchFiles: [],',
      '  args: [],',
      '})',
      'try {',
      "  const settings = ctx.get('settings')",
      "  if (settings === undefined) throw new Error('boot probe: settings service missing')",
      "  const raw = settings.get(settingsModule.settingsNamespace('context-compression'))",
      ...settingsProof,
      "  const presets = ctx.get('agentPresets')",
      "  if (presets === undefined) throw new Error('boot probe: agentPresets service missing')",
      '  const key = await presets.standingKeyFor()',
      '  if (key?.agentPreset !== \'standard\') {',
      "    throw new Error('boot probe: standing key did not compose the default preset: ' + JSON.stringify(key))",
      '  }',
      // Only stores CREATED BY THIS BOOT count: stale leftovers from earlier
      // runs or concurrent harnesses must never satisfy the overlay proof.
      '  const generated = []',
      "  for (const entry of await readdir(tmpdir(), { withFileTypes: true })) {",
      '    if (!entry.isDirectory() || preBootStores.has(entry.name)) continue',
      "    if (!entry.name.startsWith('dsh-context-compression-presets-')) continue",
      '    let children',
      '    try {',
      '      children = await readdir(join(tmpdir(), entry.name))',
      '    } catch {',
      '      continue // a concurrent process disposed its store mid-scan',
      '    }',
      "    for (const child of children) {",
      "      if (/^standard-[0-9a-f]{24}\\.agent\\.cordis\\.yml$/u.test(child)) generated.push(child)",
      '    }',
      '  }',
      '  if (generated.length === 0) {',
      "    throw new Error('boot probe: the selector preset overlay generated no standing composition in this boot')",
      '  }',
      "  console.log('BOOT_PROBE_OK ' + JSON.stringify({ phase: " + JSON.stringify(phase) + ", settings: " + JSON.stringify(expectSeeded ? 'seeded-savings-73' : 'previous-release-defaults') + ", generated: generated.length }))",
      '} finally {',
      '  await ctx.fiber.dispose()',
      '}',
      'process.exit(0)',
    ].join('\n')
    const probePath = join(temporaryRoot, `boot-probe-${phase}.mjs`)
    await writeFile(probePath, probe, 'utf8')
    const outcome = await captureOutcome(process.execPath, ['--import', 'tsx/esm', probePath], {
      cwd: worktree,
      env: environment,
    })
    const marker = outcome.stdout.split('\n').find(line => line.startsWith('BOOT_PROBE_OK'))
    if (outcome.code !== 0 || marker === undefined) {
      throw new Error(`official profile boot probe (${phase}) failed:\n${outcome.stdout}\n${outcome.stderr}`)
    }
    return JSON.parse(marker.slice('BOOT_PROBE_OK '.length))
  }

  /** Seed real user settings through the plugin's own public surface. */
  const seedSettings = async () => {
    const { profileRoot } = profilePackages()
    const settingsPath = join(dshHome, 'settings.yaml')
    const script = [
      "const { writeFileSync, readFileSync, existsSync } = require('node:fs')",
      "const { createRequire } = require('node:module')",
      "const yaml = require('js-yaml')",
      `const requireFromProfile = createRequire(String.raw\`${join(profileRoot, 'package.json')}\`)`,
      "const runtimeEntry = requireFromProfile.resolve('dsh-context-compression-selector-runtime/package.json').replace(/package\\.json$/u, 'lib/index.js')",
      'const runtime = require(runtimeEntry)',
      "const document = {",
      "  'context-compression': {",
      "    profile: 'savings',",
      '    custom: runtime.DEFAULT_CUSTOM_COMPRESSION_POLICY,',
      '    autoCompact: { thresholdPercent: 73 },',
      '  },',
      '}',
      `const path = String.raw\`${settingsPath}\``,
      'const merged = existsSync(path) ? { ...yaml.load(readFileSync(path, \'utf8\')), ...document } : document',
      "writeFileSync(path, yaml.dump(merged), 'utf8')",
      "console.log('SEED_OK')",
    ].join('\n')
    const outcome = await captureOutcome(process.execPath, ['--input-type=commonjs', '-e', script], {
      cwd: worktree,
      env: environment,
    })
    if (outcome.code !== 0 || !outcome.stdout.includes('SEED_OK')) {
      throw new Error(`seeding official-profile settings failed:\n${outcome.stdout}\n${outcome.stderr}`)
    }
    return settingsPath
  }

  /** Read the seeded settings back through the upgraded plugin's parser. */
  const proveSettingsPreserved = async (settingsPath) => {
    const { profileRoot } = profilePackages()
    const script = [
      "const { readFileSync } = require('node:fs')",
      "const { createRequire } = require('node:module')",
      'const yaml = require(\'js-yaml\')',
      `const requireFromProfile = createRequire(String.raw\`${join(profileRoot, 'package.json')}\`)`,
      "const runtimeEntry = requireFromProfile.resolve('dsh-context-compression-selector-runtime/package.json').replace(/package\\.json$/u, 'lib/index.js')",
      'const runtime = require(runtimeEntry)',
      `const document = yaml.load(readFileSync(String.raw\`${settingsPath}\`, 'utf8'))`,
      "const parsed = runtime.parseContextCompressionSettings(document['context-compression'])",
      "if (parsed.profile !== 'savings' || parsed.autoCompact.thresholdPercent !== 73) {",
      "  throw new Error('upgraded profile lost the saved user settings: ' + JSON.stringify(parsed))",
      '}',
      "console.log('SETTINGS_OK')",
    ].join('\n')
    const outcome = await captureOutcome(process.execPath, ['--input-type=commonjs', '-e', script], {
      cwd: worktree,
      env: environment,
    })
    if (outcome.code !== 0 || !outcome.stdout.includes('SETTINGS_OK')) {
      throw new Error(`settings preservation proof failed:\n${outcome.stdout}\n${outcome.stderr}`)
    }
  }

  try {
    await run('git', ['worktree', 'add', '--detach', worktree, before.commit], { cwd: clone })
    added = true
    await run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: worktree })
    // A source checkout ships no built artifacts (install above skips
    // prepare scripts). The boot probes run the REAL web profile —
    // dsh-base + dsh-web-app, the only bundle that mounts agent-presets and
    // therefore the selector's preset overlay — so build both library faces
    // AND the web frontend; the healed profiles/node_modules fallback also
    // symlinks the CLI's own workspace packages.
    await run('pnpm', ['run', 'build'], { cwd: worktree })

    // Real lifecycle: start on the published previous release.
    if (upgradeFrom === undefined) throw new Error('release gate requires the previous published release for the official lifecycle')
    await dsh('plugin', '--profile', 'web', 'add',
      `dsh-context-compression-selector@${upgradeFrom}`, '--registry', registry)
    const beforeUp = profilePackages()
    if (beforeUp.runtime.version !== upgradeFrom || beforeUp.selector.version !== upgradeFrom) {
      throw new Error(`official lifecycle started on selector ${String(beforeUp.selector.version)} / runtime ${String(beforeUp.runtime.version)}, expected ${upgradeFrom}`)
    }

    // Boot the profile once on the previous release. This asserts the added
    // bundle layer is live before any update and heals
    // $DSH_HOME/profiles/node_modules — the shared-module fallback the
    // plugin's harness peers resolve through in every later raw-node proof.
    const addedDump = await dumpConfig()
    assert(addedDump.includes('context-compression-selector-bundle'),
      'official post-add dump lacks the selector Bundle layer')

    // Real profile start on the previous release, BEFORE seeding: the
    // previous-release schema predates the autoCompact section, so this probe
    // proves its own defaults resolve; the seeded document is asserted by the
    // post-up probe through the upgraded runtime.
    const postAddBoot = await runProfileBootProbe('post-add', false)

    const settingsPath = await seedSettings()

    // Standard update command moves BOTH packages; assert before any add.
    await dsh('plugin', '--profile', 'web', 'up',
      'dsh-context-compression-selector@beta', '--registry', registry)
    const afterUp = profilePackages()
    if (afterUp.selector.version !== candidateVersion || afterUp.runtime.version !== candidateVersion) {
      throw new Error(`official up landed selector ${String(afterUp.selector.version)} / runtime ${String(afterUp.runtime.version)}, expected both at ${String(candidateVersion)}`)
    }
    if (afterUp.selector.dependencies?.[afterUp.runtime.name] !== afterUp.runtime.version) {
      throw new Error('official up broke the exact selector->runtime dependency')
    }
    await proveSettingsPreserved(settingsPath)
    const loadProof = await provePluginLoads()
    const postUpBoot = await runProfileBootProbe('post-up', true)
    const upDump = await dumpConfig()
    for (const marker of ['context-compression-selector-bundle', 'presetOverlay: true']) {
      assert(upDump.includes(marker), `official post-up dump lacks ${marker}`)
    }
    assert(upDump.match(/context-compression-selector-bundle/gu)?.length === 1,
      'official post-up dump contains more than one selector Bundle layer')

    // pnpm's peers check is informational: plugin peers resolve through the
    // healed profiles/node_modules fallback, which pnpm cannot see by design.
    const peers = await captureOutcome('pnpm', ['peers', 'check'], {
      cwd: join(dshHome, 'profiles/web'),
      env: environment,
    })

    await dsh('plugin', '--profile', 'web', 'remove', 'dsh-context-compression-selector')
    const removedDump = await dumpConfig()
    assert(!removedDump.includes('context-compression-selector-bundle'),
      'official CLI remove left the selector Bundle layer active')

    await dsh('plugin', '--profile', 'web', 'add',
      'dsh-context-compression-selector@beta', '--registry', registry)
    const secondDump = await dumpConfig()
    assert(secondDump.includes('context-compression-selector-bundle'),
      'official CLI reinstall did not restore the selector Bundle layer')

    return {
      tag: before.tag,
      commit: before.commit,
      tree: before.tree,
      status: 'clean',
      install: 'entry-package-only',
      upgrade: {
        from: upgradeFrom,
        to: candidateVersion,
        selector: afterUp.selector.version,
        runtime: afterUp.runtime.version,
        exactDependency: true,
        settingsPreserved: true,
        pluginAndEnginePeersLoad: loadProof,
        realProfileBoot: { postAdd: postAddBoot, postUp: postUpBoot },
        dump: 'single-bundle-layer',
      },
      remove: 'bundle-removed',
      reinstall: 'bundle-restored',
      peersCheck: {
        exitCode: peers.code,
        note: 'informational: plugin peers resolve via the healed profiles/node_modules fallback, proven by load',
      },
    }
  } finally {
    if (added) await run('git', ['worktree', 'remove', '--force', worktree], { cwd: clone })
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

const fixedArtifactRoot = process.env.DSH_SELECTOR_ARTIFACT_DIR
const artifactRoot = fixedArtifactRoot === undefined
  ? await mkdtemp(join(tmpdir(), 'dsh-selector-pack-'))
  : await realpath(fixedArtifactRoot)
const ownsArtifactRoot = fixedArtifactRoot === undefined
const comparisonRoot = fixedArtifactRoot === undefined
  ? undefined
  : await mkdtemp(join(tmpdir(), 'dsh-selector-rebuild-'))
const consumerRoot = await mkdtemp(join(tmpdir(), 'dsh-selector-consumer-'))
let server

try {
  const registryPackages = new Map()
  // Published previous-release metadata served alongside the packed candidate
  // so the upgrade leg can install the real shipped beta.2 first.
  const previousVersions = new Map()
  const previousRelease = '0.1.0-beta.2'
  let upgradeLeg = 'skipped-no-network'
  for (const name of ['dsh-context-compression-selector', 'dsh-context-compression-selector-runtime']) {
    try {
      const response = await fetch(`https://registry.npmjs.org/${name}/${previousRelease}`)
      if (!response.ok) throw new Error(`packument responded ${response.status}`)
      const manifest = await response.json()
      const tarballResponse = await fetch(manifest.dist.tarball)
      if (!tarballResponse.ok) throw new Error(`tarball responded ${tarballResponse.status}`)
      const bytes = Buffer.from(await tarballResponse.arrayBuffer())
      const filename = `${name}-${previousRelease}.tgz`
      const tarball = join(artifactRoot, `previous-${filename}`)
      await writeFile(tarball, bytes)
      previousVersions.set(name, {
        filename,
        manifest,
        tarball,
        sha1: createHash('sha1').update(bytes).digest('hex'),
        integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
      })
      } catch (error) {
      if (e2eMode === 'release') {
        throw new Error(`release gate requires the published previous release for the upgrade leg: ${error instanceof Error ? error.message : String(error)}`)
      }
      upgradeLeg = `skipped-previous-release-unavailable:${error instanceof Error ? error.message : String(error)}`
      previousVersions.clear()
      break
    }
  }
  if (previousVersions.size === 2) upgradeLeg = 'installed'
  for (const descriptor of packages) {
    const manifest = JSON.parse(await readFile(join(descriptor.directory, 'package.json'), 'utf8'))
    if (fixedArtifactRoot === undefined) {
      await run('npm', ['pack', '--pack-destination', artifactRoot, descriptor.directory], { cwd: root })
    }
    const filename = `${manifest.name}-${manifest.version}.tgz`
    const tarball = join(artifactRoot, filename)
    await stat(tarball)
    const bytes = await readFile(tarball)
    if (comparisonRoot !== undefined) {
      await run('npm', ['pack', '--pack-destination', comparisonRoot, descriptor.directory], { cwd: root })
      const rebuilt = await readFile(join(comparisonRoot, filename))
      const reviewedHash = createHash('sha256').update(bytes).digest('hex')
      const rebuiltHash = createHash('sha256').update(rebuilt).digest('hex')
      if (reviewedHash !== rebuiltHash) {
        throw new Error(`${manifest.name} fixed tarball differs from the current workspace rebuild`)
      }
    }
    registryPackages.set(manifest.name, {
      filename,
      manifest,
      tarball,
      sha1: createHash('sha1').update(bytes).digest('hex'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    })
  }

  server = createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1')
      const decodedPath = decodeURIComponent(requestUrl.pathname)
      for (const [name, descriptor] of registryPackages) {
        if (decodedPath === `/${name}`) {
          const address = server.address()
          if (address === null || typeof address === 'string') throw new Error('registry has no TCP address')
          const tarballUrl = `http://127.0.0.1:${address.port}/${name}/-/${descriptor.filename}`
          const version = {
            ...descriptor.manifest,
            dist: {
              tarball: tarballUrl,
              shasum: descriptor.sha1,
              integrity: descriptor.integrity,
            },
          }
          const previous = previousVersions.get(name)
          const previousVersion = previous === undefined ? {} : {
            [previous.manifest.version]: {
              ...previous.manifest,
              dist: {
                tarball: `http://127.0.0.1:${address.port}/${name}/-/${previous.filename}`,
                shasum: previous.sha1,
                integrity: previous.integrity,
              },
            },
          }
          const body = JSON.stringify({
            name,
            'dist-tags': { beta: descriptor.manifest.version },
            versions: { ...previousVersion, [descriptor.manifest.version]: version },
          })
          response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
          response.end(request.method === 'HEAD' ? undefined : body)
          return
        }
        if (decodedPath === `/${name}/-/${descriptor.filename}`) {
          const details = await stat(descriptor.tarball)
          response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': details.size })
          if (request.method === 'HEAD') response.end()
          else createReadStream(descriptor.tarball).pipe(response)
          return
        }
      }
      for (const [name, previous] of previousVersions) {
        if (decodedPath === `/${name}/-/${previous.filename}`) {
          const details = await stat(previous.tarball)
          response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': details.size })
          if (request.method === 'HEAD') response.end()
          else createReadStream(previous.tarball).pipe(response)
          return
        }
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(404).end()
        return
      }
      const upstream = await fetch(`https://registry.npmjs.org${requestUrl.pathname}${requestUrl.search}`, {
        method: request.method,
        headers: { accept: request.headers.accept ?? '*/*' },
      })
      const headers = {}
      for (const name of ['content-type', 'content-length', 'cache-control', 'etag', 'last-modified']) {
        const value = upstream.headers.get(name)
        if (value !== null) headers[name] = value
      }
      response.writeHead(upstream.status, headers)
      if (request.method === 'HEAD' || upstream.body === null) response.end()
      else Readable.fromWeb(upstream.body).pipe(response)
    } catch (error) {
      response.writeHead(502, { 'content-type': 'text/plain' })
      response.end(error instanceof Error ? error.message : String(error))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('registry has no TCP address')
  const registry = `http://127.0.0.1:${address.port}`

  await writeFile(join(consumerRoot, 'package.json'), JSON.stringify({
    name: 'dsh-context-compression-selector-packed-e2e',
    version: '0.0.0',
    private: true,
  }, null, 2))
  if (upgradeLeg === 'installed') {
    // Real upgrade path: install the published previous release, then move to
    // the packed candidate through the standard update command.
    await run('pnpm', [
      'add',
      `dsh-context-compression-selector@${previousRelease}`,
      ...officialHostPackages,
      '--registry', registry,
    ], { cwd: consumerRoot })
    const previousSelectorDir = await realpath(join(consumerRoot, 'node_modules/dsh-context-compression-selector'))
    const previousRuntime = JSON.parse(await readFile(
      join(dirname(previousSelectorDir), 'dsh-context-compression-selector-runtime/package.json'),
      'utf8',
    ))
    if (previousRuntime.version !== previousRelease) {
      throw new Error(`upgrade leg installed runtime ${String(previousRuntime.version)}, expected ${previousRelease}`)
    }
    await run('pnpm', [
      'up',
      'dsh-context-compression-selector@beta',
      '--registry', registry,
    ], { cwd: consumerRoot })
    // The up command must land BOTH packages on the packed candidate.
    const upgradedSelectorDir = await realpath(join(consumerRoot, 'node_modules/dsh-context-compression-selector'))
    const upgradedSelector = JSON.parse(await readFile(join(upgradedSelectorDir, 'package.json'), 'utf8'))
    const upgradedRuntime = JSON.parse(await readFile(
      join(dirname(upgradedSelectorDir), 'dsh-context-compression-selector-runtime/package.json'),
      'utf8',
    ))
    const candidateVersion = registryPackages.get('dsh-context-compression-selector-runtime')?.manifest.version
    if (candidateVersion === undefined) throw new Error('packed candidate version is unknown')
    if (upgradedSelector.version !== candidateVersion || upgradedRuntime.version !== candidateVersion) {
      throw new Error(`upgrade leg landed selector ${String(upgradedSelector.version)} / runtime ${String(upgradedRuntime.version)}, expected both at ${String(candidateVersion)}`)
    }
    if (upgradedSelector.dependencies?.[upgradedRuntime.name] !== upgradedRuntime.version) {
      throw new Error('upgrade leg broke the exact selector->runtime dependency')
    }
  } else {
    console.info(`UPGRADE_LEG_SKIPPED ${upgradeLeg}`)
    await run('pnpm', [
      'add',
      'dsh-context-compression-selector@beta',
      ...officialHostPackages,
      '--registry', registry,
    ], { cwd: consumerRoot })
  }

  const selectorDir = await realpath(join(consumerRoot, 'node_modules/dsh-context-compression-selector'))
  const runtimeDir = await realpath(join(dirname(selectorDir), 'dsh-context-compression-selector-runtime'))
  const selector = JSON.parse(await readFile(join(selectorDir, 'package.json'), 'utf8'))
  const runtime = JSON.parse(await readFile(join(runtimeDir, 'package.json'), 'utf8'))
  if (selector.version !== runtime.version) throw new Error('selector/runtime versions differ')
  if (selector.dependencies?.[runtime.name] !== runtime.version) throw new Error('selector/runtime dependency is not exact')
  if (selector.publishConfig?.tag !== 'beta' || runtime.publishConfig?.tag !== 'beta') {
    throw new Error('packed package is not guarded by publishConfig.tag=beta')
  }
  for (const peer of ['@deepseek-ai/dsh-command-compact', '@deepseek-ai/dsh-compaction-basic']) {
    if (selector.peerDependencies?.[peer] !== '>=0.1.1-rc.2 <0.2.0') {
      throw new Error(`packed selector has an invalid ${peer} peer range`)
    }
  }
  for (const directory of [selectorDir, runtimeDir]) {
    const notice = await readFile(join(directory, 'THIRD_PARTY_NOTICES.md'), 'utf8')
    if (!notice.includes('Copyright (c) 2026 DeepSeek')) {
      throw new Error(`${basename(directory)} lacks the full DeepSeek Harness MIT notice`)
    }
    await scanPublishedTree(directory)
  }

  const productionLicenses = Object.fromEntries(await Promise.all([
    ['dsh-context-compression-selector', selectorDir, 'MIT'],
    ['dsh-context-compression-selector-runtime', runtimeDir, 'MIT'],
    ['@huggingface/tokenizers', join(dirname(runtimeDir), '@huggingface/tokenizers'), 'Apache-2.0'],
    ['js-yaml', join(dirname(selectorDir), 'js-yaml'), 'MIT'],
  ].map(async ([name, directory, expected]) => {
    const resolved = await realpath(directory)
    const manifest = JSON.parse(await readFile(join(resolved, 'package.json'), 'utf8'))
    if (manifest.name !== name) throw new Error(`expected ${name}, found ${String(manifest.name)}`)
    if (manifest.license !== expected) {
      throw new Error(`${name} license is ${String(manifest.license)}, expected ${expected}`)
    }
    return [name, manifest.license]
  })))
  const yamlDir = await realpath(join(dirname(selectorDir), 'js-yaml'))
  const argparseDir = await realpath(join(dirname(yamlDir), 'argparse'))
  const argparse = JSON.parse(await readFile(join(argparseDir, 'package.json'), 'utf8'))
  if (argparse.name !== 'argparse' || argparse.license !== 'Python-2.0') {
    throw new Error(`argparse license is ${String(argparse.license)}, expected Python-2.0`)
  }
  productionLicenses.argparse = argparse.license

  const packedTokenizerArtifacts = {}
  for (const artifactDir of ['deepseek-v4', 'deepseek-v4-vision-exp']) {
    const manifest = JSON.parse(await readFile(join(runtimeDir, 'assets', artifactDir, 'manifest.json'), 'utf8'))
    const tokenizerBytes = await readFile(join(runtimeDir, 'assets', artifactDir, 'tokenizer.json'))
    const tokenizerHash = createHash('sha256').update(tokenizerBytes).digest('hex')
    if (tokenizerBytes.length !== manifest.files['tokenizer.json'].bytes) throw new Error(`packed ${artifactDir} tokenizer size differs`)
    if (tokenizerHash !== manifest.files['tokenizer.json'].sha256) throw new Error(`packed ${artifactDir} tokenizer hash differs`)
    packedTokenizerArtifacts[artifactDir] = { bytes: tokenizerBytes.length, sha256: tokenizerHash }
  }
  const tokenizer = await readFile(join(runtimeDir, 'assets/deepseek-v4/tokenizer.json'))
  const tokenizerHash = packedTokenizerArtifacts['deepseek-v4'].sha256

  const client = await readFile(join(selectorDir, 'lib/client.js'), 'utf8')
  if (!client.startsWith('window.__ModuleLoader__.load({')) throw new Error('packed client is not lazy-CJS')
  if (/(?:\/home\/|[A-Za-z]:\\Users\\)/u.test(client)) throw new Error('packed client leaks a developer path')
  const hostSmoke = await runPackedHostSmoke(consumerRoot)
  const installedComponentsScript = join(consumerRoot, 'packed-components-smoke.mjs')
  await copyFile(join(root, 'scripts/packed-components-smoke.mjs'), installedComponentsScript)
  const installedComponentsOutput = await capture(process.execPath, [installedComponentsScript], {
    cwd: consumerRoot,
  })
  const installedComponentsLine = installedComponentsOutput.stdout
    .split(/\r?\n/u)
    .find(line => line.startsWith('PACKED_COMPONENTS_E2E '))
  if (installedComponentsLine === undefined) {
    throw new Error(`installed component smoke lacks its result marker:\n${installedComponentsOutput.stdout}`)
  }
  const installedComponentsSmoke = JSON.parse(
    installedComponentsLine.slice('PACKED_COMPONENTS_E2E '.length),
  )
  const visionLine = installedComponentsOutput.stdout
    .split(/\r?\n/u)
    .find(line => line.startsWith('PACKED_VISION_E2E '))
  if (visionLine === undefined) {
    throw new Error('installed component smoke lacks its vision-session result marker')
  }
  const packedVisionSmoke = JSON.parse(visionLine.slice('PACKED_VISION_E2E '.length))
  assert(packedVisionSmoke.model === 'deepseek-v4-flash-vision-exp',
    'installed vision smoke reported the wrong model')
  assert(packedVisionSmoke.imageSession?.measurement?.kind === 'tokenizer-estimate',
    'installed vision smoke did not prove a tokenizer-estimate image surface')
  assert(packedVisionSmoke.imageSession.measurement.tokens === 340
    && packedVisionSmoke.imageSession.measurement.upperBoundTokens === 384,
  'installed vision smoke reported the wrong 800x600 image estimate')
  assert(packedVisionSmoke.imageSession.measurement.estimatorId
    === 'deepseek-ai/DeepSeek-V4-Flash-Vision-Exp/image-token-estimate'
    && packedVisionSmoke.imageSession.measurement.estimatorRevision
      === '6821d6ad3681a4b137b066b76094fa82ebd0a380:v1',
  'installed vision smoke reported the wrong image estimator identity')
  assert(packedVisionSmoke.imageSession.currentSurfaceKind === 'tokenizer-estimate'
    && packedVisionSmoke.imageSession.exactRewriteIneligible === true
    && packedVisionSmoke.imageSession.originalIntact === true,
  'installed vision smoke did not prove estimate propagation and exact-only safety')
  let officialCloneSmoke = null
  const candidateVersion = registryPackages.get('dsh-context-compression-selector-runtime')?.manifest.version
  if (candidateVersion === undefined) throw new Error('packed candidate version is unknown')
  const previousForLifecycle = upgradeLeg === 'installed' ? previousRelease : undefined
  if (process.env.DSH_OFFICIAL_CLONE !== undefined) {
    officialCloneSmoke = await runOfficialCloneCliSmoke(
      process.env.DSH_OFFICIAL_CLONE,
      registry,
      previousForLifecycle,
      candidateVersion,
    )
  } else {
    // Auto-provision a clean official checkout so the standard add → up →
    // remove lifecycle runs without manual setup. Release mode fails closed;
    // only dev mode may skip with an explicit marker.
    const cloneRoot = join(artifactRoot, 'official-clone')
    try {
      await run('git', [
        'clone', '--depth', '1', '--branch', 'dsh-v0.1.1-rc.2',
        'https://github.com/deepseek-ai/deepseek-harness.git', cloneRoot,
      ])
      officialCloneSmoke = await runOfficialCloneCliSmoke(
        cloneRoot,
        registry,
        previousForLifecycle,
        candidateVersion,
      )
    } catch (error) {
      if (e2eMode === 'release') throw error
      console.info(`OFFICIAL_CLONE_SMOKE_SKIPPED ${error instanceof Error ? error.message : String(error)}`)
      await rm(cloneRoot, { recursive: true, force: true })
    }
  }

  if (e2eMode === 'release' && upgradeLeg !== 'installed') {
    throw new Error(`release gate requires the upgrade leg to run; it reported: ${upgradeLeg}`)
  }
  if (e2eMode === 'release' && officialCloneSmoke === null) {
    throw new Error('release gate requires the official clean-harness lifecycle to run')
  }
  console.info(JSON.stringify({
    installCommand: 'pnpm add dsh-context-compression-selector@beta',
    e2eMode,
    upgradeLeg,
    artifactSource: fixedArtifactRoot === undefined ? 'fresh-pack' : artifactRoot,
    workspaceRebuildMatched: fixedArtifactRoot === undefined ? null : true,
    selector: selector.version,
    runtime: runtime.version,
    runtimeInstalledTransitively: true,
    productionLicenses,
    tokenizerArtifacts: packedTokenizerArtifacts,
    tokenizerBytes: tokenizer.length,
    tokenizerSha256: tokenizerHash,
    hostSmoke,
    installedComponentsSmoke,
    packedVisionSmoke,
    officialCloneSmoke,
    tarballs: Object.fromEntries([...registryPackages].map(([name, value]) => [name, {
      file: basename(value.tarball),
      sha256: value.sha256,
    }])),
  }, null, 2))
} finally {
  if (server !== undefined) await new Promise(resolve => server.close(resolve))
  if (comparisonRoot !== undefined) await rm(comparisonRoot, { recursive: true, force: true })
  if (ownsArtifactRoot) await rm(artifactRoot, { recursive: true, force: true })
  await rm(consumerRoot, { recursive: true, force: true })
}
