import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
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

async function runOfficialCloneCliSmoke(referenceRoot, registry) {
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
  let peerCheck
  try {
    await run('git', ['worktree', 'add', '--detach', worktree, before.commit], { cwd: clone })
    added = true
    await run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], { cwd: worktree })
    const environment = { ...process.env, DSH_HOME: dshHome }
    const addArgs = [
      'dsh', 'plugin', '--profile', 'audit', 'add',
      'dsh-context-compression-selector@beta',
      '--registry', registry,
    ]
    await run('pnpm', addArgs, { cwd: worktree, env: environment })
    const profileRoot = join(dshHome, 'profiles/audit')
    peerCheck = await captureOutcome('pnpm', ['peers', 'check'], {
      cwd: profileRoot,
      env: environment,
    })
    console.info('OFFICIAL_PROFILE_PEER_CHECK_BEGIN')
    if (peerCheck.stdout.trim() !== '') console.info(peerCheck.stdout.trim())
    if (peerCheck.stderr.trim() !== '') console.info(peerCheck.stderr.trim())
    console.info('OFFICIAL_PROFILE_PEER_CHECK_END')
    const firstDump = (await capture(
      'pnpm', ['dsh', '--profile', 'audit', '--dump-config'],
      { cwd: worktree, env: environment },
    )).stdout
    for (const marker of [
      'context-compression-selector-bundle',
      'dsh-context-compression-selector',
      'presetOverlay: true',
    ]) assert(firstDump.includes(marker), `official CLI dump lacks ${marker}`)
    assert(firstDump.match(/context-compression-selector-bundle/gu)?.length === 1,
      'official CLI dump contains more than one selector Bundle layer')

    await run('pnpm', [
      'dsh', 'plugin', '--profile', 'audit', 'remove',
      'dsh-context-compression-selector',
    ], { cwd: worktree, env: environment })
    const removedDump = (await capture(
      'pnpm', ['dsh', '--profile', 'audit', '--dump-config'],
      { cwd: worktree, env: environment },
    )).stdout
    assert(!removedDump.includes('context-compression-selector-bundle'),
      'official CLI remove left the selector Bundle layer active')

    await run('pnpm', addArgs, { cwd: worktree, env: environment })
    const secondDump = (await capture(
      'pnpm', ['dsh', '--profile', 'audit', '--dump-config'],
      { cwd: worktree, env: environment },
    )).stdout
    assert(secondDump.includes('context-compression-selector-bundle'),
      'official CLI reinstall did not restore the selector Bundle layer')
  } finally {
    if (added) await run('git', ['worktree', 'remove', '--force', worktree], { cwd: clone })
    await rm(temporaryRoot, { recursive: true, force: true })
  }

  const after = {
    tag: await git('describe', '--tags', '--exact-match'),
    commit: await git('rev-parse', 'HEAD'),
    tree: await git('rev-parse', 'HEAD^{tree}'),
    status: await git('status', '--porcelain'),
  }
  assert(JSON.stringify(after) === JSON.stringify(before),
    'official clone identity or clean state changed during CLI smoke')
  return {
    ...after,
    status: 'clean',
    install: 'entry-package-only',
    dump: 'single-bundle-layer',
    remove: 'bundle-removed',
    reinstall: 'bundle-restored',
    peerCheck: {
      exitCode: peerCheck?.code ?? null,
      signal: peerCheck?.signal ?? null,
      stdoutSha256: createHash('sha256').update(peerCheck?.stdout ?? '').digest('hex'),
      stderrSha256: createHash('sha256').update(peerCheck?.stderr ?? '').digest('hex'),
    },
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
          const body = JSON.stringify({
            name,
            'dist-tags': { beta: descriptor.manifest.version },
            versions: { [descriptor.manifest.version]: version },
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
  await run('pnpm', [
    'add',
    'dsh-context-compression-selector@beta',
    ...officialHostPackages,
    '--registry', registry,
  ], { cwd: consumerRoot })

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

  const tokenizerManifest = JSON.parse(await readFile(join(runtimeDir, 'assets/deepseek-v4/manifest.json'), 'utf8'))
  const tokenizer = await readFile(join(runtimeDir, 'assets/deepseek-v4/tokenizer.json'))
  const tokenizerHash = createHash('sha256').update(tokenizer).digest('hex')
  if (tokenizer.length !== tokenizerManifest.files['tokenizer.json'].bytes) throw new Error('packed tokenizer size differs')
  if (tokenizerHash !== tokenizerManifest.files['tokenizer.json'].sha256) throw new Error('packed tokenizer hash differs')

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
  const officialCloneSmoke = process.env.DSH_OFFICIAL_CLONE === undefined
    ? null
    : await runOfficialCloneCliSmoke(process.env.DSH_OFFICIAL_CLONE, registry)

  console.info(JSON.stringify({
    installCommand: 'pnpm add dsh-context-compression-selector@beta',
    artifactSource: fixedArtifactRoot === undefined ? 'fresh-pack' : artifactRoot,
    workspaceRebuildMatched: fixedArtifactRoot === undefined ? null : true,
    selector: selector.version,
    runtime: runtime.version,
    runtimeInstalledTransitively: true,
    productionLicenses,
    tokenizerBytes: tokenizer.length,
    tokenizerSha256: tokenizerHash,
    hostSmoke,
    installedComponentsSmoke,
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
