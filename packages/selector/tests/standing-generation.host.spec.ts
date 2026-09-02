/** Real-AgentPresets standing-generation behavior for the overlay threshold. */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Group from '@deepseek-ai/cordis-plugin-group'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  SettingsProvider,
  settingsNamespace,
  type SettingsNamespace,
} from '@deepseek-ai/dsh-settings'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import {
  decorateAgentPresets,
  resolveCompressionModulePaths,
  standingStampMs,
  standingStampMsAtWindow,
} from '../src/preset-overlay.ts'
import type {
  CompressionModulePaths,
  OverlayableAgentPresets,
  PresetOverlayMetadataIo,
} from '../src/preset-overlay.ts'

let root: string | undefined
let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

class MemorySettings extends SettingsProvider {
  readonly writable = true
  private readonly stored: Record<string, unknown> = {}

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.stored))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.stored[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

async function presetsRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-selector-standing-'))
  const marker = join(root, 'marker-aaaaaaaaaa.mjs')
  await writeFile(marker, 'export function apply() {}\n')
  const path = join(root, 'standard', 'agent.cordis.yml')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `- id: source-marker\n  name: ${JSON.stringify(marker)}\n`)
  return root
}

/**
 * Read the overlay compositions generated from THIS test's source preset.
 * Concurrent spec files write their own stores; the embedded marker path
 * distinguishes ours without depending on directory discovery timing.
 */
async function overlayFiles(sourceMarker: string): Promise<{ path: string, rendered: string }[]> {
  const parent = await readdir(tmpdir(), { withFileTypes: true })
  const files: { path: string, rendered: string }[] = []
  for (const entry of parent) {
    if (!entry.isDirectory() || !entry.name.startsWith('dsh-context-compression-presets-')) continue
    const directory = join(tmpdir(), entry.name)
    let children
    try {
      children = await readdir(directory)
    } catch {
      continue // a concurrent spec disposed its store mid-scan
    }
    for (const child of children) {
      if (!child.startsWith('standard-') || !child.endsWith('.agent.cordis.yml')) continue
      const path = join(directory, child)
      const rendered = await readFile(path, 'utf8')
      if (rendered.includes(sourceMarker)) files.push({ path, rendered })
    }
  }
  return files
}

let sourceRoot: string | undefined

/** Rewrite the source preset to an equal-length marker module. */
async function rewriteSourceMarker(name: string): Promise<void> {
  if (sourceRoot === undefined) throw new Error('source root not prepared')
  const marker = join(sourceRoot, name)
  await writeFile(marker, 'export function apply() {}\n')
  await writeFile(join(sourceRoot, 'standard', 'agent.cordis.yml'), `- id: source-marker\n  name: ${JSON.stringify(marker)}\n`)
}

/** Create an importable marker module with an exact-length directory name. */
async function sameLengthModule(label: string): Promise<string> {
  if (sourceRoot === undefined) throw new Error('source root not prepared')
  const directory = join(sourceRoot, label)
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'index.mjs')
  await writeFile(file, 'export function apply() {}\n')
  return file
}

/** Reproduce the production content identity without replacing it in the store. */
function overlayIdentity(
  source: string,
  modules: CompressionModulePaths,
  thresholdPercent: number,
): string {
  return createHash('sha256')
    .update('standard').update('\0')
    .update(source).update('\0')
    .update(JSON.stringify({ modules, autoCompactThresholdPercent: thresholdPercent }))
    .digest('hex')
    .slice(0, 24)
}

/** Find equal-length valid presets whose production identities share window 0. */
function coarseCollisionFixture(
  marker: string,
  modules: CompressionModulePaths,
): Readonly<{ first: string, second: string, firstIdentity: string, secondIdentity: string }> {
  const seen = new Map<string, Readonly<{ source: string, identity: string }>>()
  for (let index = 0; index < 300_000; index += 1) {
    const label = index.toString(16).padStart(8, '0')
    const source = [
      '- id: source-marker',
      `  name: ${JSON.stringify(marker)}`,
      `- id: collision-${label}`,
      '  name: cordis:group',
      '  group: true',
      '  config: []',
      '',
    ].join('\n')
    const identity = overlayIdentity(source, modules, 80)
    const prefix = identity.slice(0, 8)
    const prior = seen.get(prefix)
    if (prior !== undefined && prior.identity !== identity) {
      return {
        first: prior.source,
        second: source,
        firstIdentity: prior.identity,
        secondIdentity: identity,
      }
    }
    seen.set(prefix, { source, identity })
  }
  throw new Error('failed to find a deterministic 32-bit standing-stamp collision')
}

/**
 * Mount the full real stack, run `arrange`, capture the standing key and
 * generated file, run `act`, and assert the generation moved.
 */
async function assertStandingSwitch(
  arrange: () => Promise<() => Promise<void>>,
): Promise<void> {
  const rootPath = await presetsRoot()
  sourceRoot = rootPath
  ctx = new Context()
  ctx.baseUrl = `${pathToFileURL(rootPath).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(MemorySettings).await()
  await ctx.plugin({ apply }).await()
  await ctx.plugin(AgentPresets, {
    default: 'standard',
    roots: [{ path: rootPath, trust: 'system' }],
    includeUserRoot: false,
  }).await()
  const act = await arrange()
  const bundle = ctx.plugin({ apply: (child) => {
    apply(child, { presetOverlay: true })
  } })
  await bundle.await()
  const presets = ctx.agentPresets as unknown as OverlayableAgentPresets
  const first = await presets.standingKeyFor()
  const firstFiles = await overlayFiles(rootPath)
  expect(firstFiles).toHaveLength(1)

  await act()
  const second = await presets.standingKeyFor()
  const secondFiles = await overlayFiles(rootPath)
  expect(secondFiles).toHaveLength(2)
  expect(second).not.toBe(first)
  const stamps = await Promise.all(secondFiles.map(async file => (await stat(file.path)).mtimeMs))
  expect(new Set(stamps).size).toBe(2)
}

describe('deterministic standing stamps', () => {
  // The reviewer's reproduced 1-second-granularity collision: under the old
  // millisecond-prefix mapping these two identities stamped 280ms apart, and
  // floor(stamp/1000) collapsed both onto second 586129064.
  const COLLISION_A = '887803c2b6c57357206d271e'
  const COLLISION_B = '887803c3ceb119ac3cfb7d32'

  it('never shares a one-second bucket between distinct identities', () => {
    const stampA = standingStampMs(COLLISION_A)
    const stampB = standingStampMs(COLLISION_B)
    expect(Math.floor(stampA / 1000)).not.toBe(Math.floor(stampB / 1000))
  })

  it('stays inside the nanosecond range every filesystem can store', () => {
    const maxIdentity = 'ffffffffffffffffffffffff'
    const stamp = standingStampMs(maxIdentity)
    expect(Number.isFinite(stamp)).toBe(true)
    expect(stamp).toBeLessThan(Date.UTC(2260, 0, 1))
    expect(stamp).toBeGreaterThan(Date.UTC(2026, 0, 1))
  })

  it('is deterministic per identity and separable across hash windows', () => {
    expect(standingStampMs(COLLISION_A)).toBe(standingStampMs(COLLISION_A))
    // Equal 8-hex prefixes share the second bucket at window 0 but the
    // escalated window reads later hash digits into distinct seconds.
    const sharedPrefix = '887803c2'
    const first = `${sharedPrefix}aaaaaaaaaaaaaaaa`
    const second = `${sharedPrefix}bbbbbbbbbbbbbbbb`
    expect(Math.floor(standingStampMsAtWindow(first, 0) / 1000))
      .toBe(Math.floor(standingStampMsAtWindow(second, 0) / 1000))
    expect(standingStampMsAtWindow(first, 0)).not.toBe(standingStampMsAtWindow(second, 0))
    expect(Math.floor(standingStampMsAtWindow(first, 1) / 1000))
      .not.toBe(Math.floor(standingStampMsAtWindow(second, 1) / 1000))
  })
})

describe('real AgentPresets standing generations with the overlay threshold', () => {
  it('separates colliding equal-size generations on a whole-second metadata surface before publish', async () => {
    const rootPath = await presetsRoot()
    sourceRoot = rootPath
    const sourcePath = join(rootPath, 'standard', 'agent.cordis.yml')
    const marker = join(rootPath, 'marker-aaaaaaaaaa.mjs')
    const modules = resolveCompressionModulePaths()
    const collision = coarseCollisionFixture(marker, modules)
    expect(collision.first).toHaveLength(collision.second.length)
    expect(collision.firstIdentity.slice(0, 8)).toBe(collision.secondIdentity.slice(0, 8))
    await writeFile(sourcePath, collision.first)

    ctx = new Context()
    ctx.baseUrl = `${pathToFileURL(rootPath).href}/`
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.group = Group
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(AgentPresets, {
      default: 'standard',
      roots: [{ path: rootPath, trust: 'system' }],
      includeUserRoot: false,
    }).await()

    const coarseMetadataIo: PresetOverlayMetadataIo = {
      async setTimes(path, stamp) {
        const wholeSecond = new Date(Math.floor(stamp.getTime() / 1000) * 1000)
        await utimes(path, wholeSecond, wholeSecond)
      },
      async read(path) {
        const observed = await stat(path)
        return { mtimeMs: observed.mtimeMs, size: observed.size }
      },
    }
    const presets = ctx.agentPresets as unknown as OverlayableAgentPresets
    const installation = decorateAgentPresets(presets, {
      modules,
      autoCompactThresholdPercent: () => 80,
      metadataIo: coarseMetadataIo,
    })

    const firstKey = await presets.standingKeyFor()
    await writeFile(sourcePath, collision.second)
    const changedSourceStamp = new Date(Date.now() + 2_000)
    await utimes(sourcePath, changedSourceStamp, changedSourceStamp)
    const secondKey = await presets.standingKeyFor()
    // Scope keys are structurally `{ agentPreset: id }`; a new object identity
    // proves real AgentPresets observed a different composition stamp and
    // created a new standing generation.
    expect(secondKey).not.toBe(firstKey)

    const files = await overlayFiles(rootPath)
    expect(files).toHaveLength(2)
    const byIdentity = new Map(files.map(file => [
      /standard-([0-9a-f]+)\.agent\.cordis\.yml$/u.exec(file.path)?.[1],
      file.path,
    ]))
    const firstFile = byIdentity.get(collision.firstIdentity)
    const secondFile = byIdentity.get(collision.secondIdentity)
    expect(firstFile).toBeDefined()
    expect(secondFile).toBeDefined()
    const firstStat = await stat(firstFile as string)
    const secondStat = await stat(secondFile as string)
    expect(firstStat.size).toBe(secondStat.size)
    expect(firstStat.mtimeMs % 1000).toBe(0)
    expect(secondStat.mtimeMs % 1000).toBe(0)
    expect(firstStat.mtimeMs).toBe(Math.floor(standingStampMsAtWindow(collision.firstIdentity, 0) / 1000) * 1000)
    expect(secondStat.mtimeMs).toBe(Math.floor(standingStampMsAtWindow(collision.secondIdentity, 1) / 1000) * 1000)

    await installation.dispose()
  })

  it('publishes distinct second buckets for equal-length colliding sources on the real filesystem', async () => {
    const rootPath = await presetsRoot()
    sourceRoot = rootPath
    ctx = new Context()
    ctx.baseUrl = `${pathToFileURL(rootPath).href}/`
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.group = Group
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(MemorySettings).await()
    await ctx.plugin({ apply }).await()
    await ctx.plugin(AgentPresets, {
      default: 'standard',
      roots: [{ path: rootPath, trust: 'system' }],
      includeUserRoot: false,
    }).await()
    const namespace = settingsNamespace('context-compression')
    await ctx.settings.update(namespace, { autoCompact: { thresholdPercent: 80 } })
    const bundle = ctx.plugin({ apply: (child) => {
      apply(child, { presetOverlay: true })
    } })
    await bundle.await()

    const presets = ctx.agentPresets as unknown as OverlayableAgentPresets
    await presets.standingKeyFor()
    // Two equal-length sources (55 bytes each, matching the collision
    // fixture's shape): distinct identities whose stamps must never collapse
    // onto the same whole second even if the filesystem truncates mtimes.
    await rewriteSourceMarker('marker-00000aa9.mjs')
    await presets.standingKeyFor()
    await rewriteSourceMarker('marker-00000wil.mjs')
    const third = await presets.standingKeyFor()
    expect(third).toBeDefined()

    const files = await overlayFiles(rootPath)
    expect(files.length).toBeGreaterThanOrEqual(3)
    const buckets = await Promise.all(files.map(async file => Math.floor((await stat(file.path)).mtimeMs / 1000)))
    expect(new Set(buckets).size).toBe(buckets.length)
    // No staging leftovers survive a publish.
    const storeDirs = await Promise.all(
      (await readdir(tmpdir(), { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && entry.name.startsWith('dsh-context-compression-presets-'))
        .map(async entry => readdir(join(tmpdir(), entry.name))),
    )
    expect(storeDirs.flat().some(name => name.endsWith('.tmp'))).toBe(false)

    await bundle.dispose()
  })

  it('keeps one fully-identical generation under concurrent composition of the same identity', async () => {
    const rootPath = await presetsRoot()
    ctx = new Context()
    ctx.baseUrl = `${pathToFileURL(rootPath).href}/`
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.group = Group
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(MemorySettings).await()
    await ctx.plugin({ apply }).await()
    await ctx.plugin(AgentPresets, {
      default: 'standard',
      roots: [{ path: rootPath, trust: 'system' }],
      includeUserRoot: false,
    }).await()
    const namespace = settingsNamespace('context-compression')
    await ctx.settings.update(namespace, { autoCompact: { thresholdPercent: 73 } })
    const bundle = ctx.plugin({ apply: (child) => {
      apply(child, { presetOverlay: true })
    } })
    await bundle.await()

    const presets = ctx.agentPresets as unknown as OverlayableAgentPresets
    // Every concurrent composer must hand out the SAME path, and the file's
    // persisted stamp must be the deterministic identity stamp — never a
    // wall-clock mtime from a metadata window.
    const concurrent = await Promise.all([
      presets.standingKeyFor(),
      presets.standingKeyFor(),
      presets.standingKeyFor(),
      presets.standingKeyFor(),
      presets.standingKeyFor(),
      presets.standingKeyFor(),
    ])
    expect(new Set(concurrent.map(key => JSON.stringify(key)))).toHaveLength(1)
    const files = await overlayFiles(rootPath)
    expect(files).toHaveLength(1)
    const details = await stat(files[0]!.path)
    const now = Date.now()
    expect(Math.abs(details.mtimeMs - now)).toBeGreaterThan(60 * 60 * 1000)
    // The persisted whole-second bucket matches the identity-derived stamp's
    // bucket regardless of filesystem mtime granularity, and the persisted
    // sub-second component is the identity-derived one (or its zero-truncated
    // form on a coarse filesystem).
    const rendered = files[0]!.rendered
    const identity = rendered.length > 0
      ? /standard-([0-9a-f]+)\.agent\.cordis\.yml$/u.exec(files[0]!.path)?.[1]
      : undefined
    expect(identity).toBeDefined()
    expect(Math.floor(details.mtimeMs / 1000))
      .toBe(Math.floor(standingStampMs(identity as string) / 1000))
    const observedSubSecond = details.mtimeMs % 1000
    const expectedSubSecond = standingStampMs(identity as string) % 1000
    expect(observedSubSecond === 0 || Math.abs(observedSubSecond - expectedSubSecond) < 1).toBe(true)

    await bundle.dispose()
  })

  it('switches the standing generation for an equal-length threshold change', async () => {
    await assertStandingSwitch(async () => {
      const namespace = settingsNamespace('context-compression')
      await ctx!.settings.update(namespace, { autoCompact: { thresholdPercent: 70 } })
      return async () => ctx!.settings.update(namespace, { autoCompact: { thresholdPercent: 80 } })
    })
  })

  it('switches the standing generation for an equal-length source change at a fixed threshold', async () => {
    await assertStandingSwitch(async () => {
      const namespace = settingsNamespace('context-compression')
      await ctx!.settings.update(namespace, { autoCompact: { thresholdPercent: 80 } })
      return async () => {
        await rewriteSourceMarker('marker-bbbbbbbbbb.mjs')
      }
    })
  })

  it('switches the standing generation for an equal-length module identity change', async () => {
    const rootPath = await presetsRoot()
    sourceRoot = rootPath
    ctx = new Context()
    ctx.baseUrl = `${pathToFileURL(rootPath).href}/`
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.group = Group
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(MemorySettings).await()
    await ctx.plugin({ apply }).await()
    await ctx.plugin(AgentPresets, {
      default: 'standard',
      roots: [{ path: rootPath, trust: 'system' }],
      includeUserRoot: false,
    }).await()
    const namespace = settingsNamespace('context-compression')
    await ctx.settings.update(namespace, { autoCompact: { thresholdPercent: 80 } })

    const presets = ctx.agentPresets as unknown as OverlayableAgentPresets
    // Two module sets whose entry paths differ in content but not length.
    const moduleA = await sameLengthModule('module-aaaaaaaaaa')
    const moduleB = await sameLengthModule('module-bbbbbbbbbb')
    const paths = (m: string) => ({
      compactionBasic: m,
      commandCompact: m,
      toolResultPruner: m,
    })
    let installation = decorateAgentPresets(presets, {
      modules: paths(moduleA),
      excludedPresetIds: ['minimal'],
      autoCompactThresholdPercent: () => 80,
    })
    const first = await presets.standingKeyFor()
    const firstFiles = await overlayFiles(rootPath)
    expect(firstFiles).toHaveLength(1)
    const firstPath = firstFiles[0]!.path
    const firstStamp = (await stat(firstPath)).mtimeMs
    expect(firstFiles[0]!.rendered).toContain(moduleA)

    // Disposing the old decoration also removes its generated store, so the
    // swap is proven by the new composition's path, content, and stamp.
    await installation.dispose()
    installation = decorateAgentPresets(presets, {
      modules: paths(moduleB),
      excludedPresetIds: ['minimal'],
      autoCompactThresholdPercent: () => 80,
    })
    const second = await presets.standingKeyFor()
    const secondFiles = await overlayFiles(rootPath)
    expect(secondFiles).toHaveLength(1)
    expect(second).not.toBe(first)
    expect(secondFiles[0]!.path).not.toBe(firstPath)
    expect(secondFiles[0]!.rendered).toContain(moduleB)
    expect((await stat(secondFiles[0]!.path)).mtimeMs).not.toBe(firstStamp)
    await installation.dispose()
  })

  it('keeps one generation under concurrent and repeated composition of the same identity', async () => {
    const rootPath = await presetsRoot()
    ctx = new Context()
    ctx.baseUrl = `${pathToFileURL(rootPath).href}/`
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.group = Group
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(MemorySettings).await()
    await ctx.plugin({ apply }).await()
    await ctx.plugin(AgentPresets, {
      default: 'standard',
      roots: [{ path: rootPath, trust: 'system' }],
      includeUserRoot: false,
    }).await()
    const namespace = settingsNamespace('context-compression')
    await ctx.settings.update(namespace, { autoCompact: { thresholdPercent: 73 } })
    const bundle = ctx.plugin({ apply: (child) => {
      apply(child, { presetOverlay: true })
    } })
    await bundle.await()

    const presets = ctx.agentPresets as unknown as OverlayableAgentPresets
    const concurrent = await Promise.all([
      presets.standingKeyFor(),
      presets.standingKeyFor(),
      presets.standingKeyFor(),
    ])
    expect(new Set(concurrent.map(key => JSON.stringify(key)))).toHaveLength(1)
    const files = await overlayFiles(rootPath)
    expect(files).toHaveLength(1)
    const stampFirst = (await stat(files[0]!.path)).mtimeMs
    const repeated = await presets.standingKeyFor()
    expect(JSON.stringify(repeated)).toBe(JSON.stringify(concurrent[0]))
    expect(await overlayFiles(rootPath)).toHaveLength(1)
    expect((await stat(files[0]!.path)).mtimeMs).toBe(stampFirst)
  })

  it('switches the standing generation for an equal-length threshold change (legacy body)', async () => {
    const rootPath = await presetsRoot()
    ctx = new Context()
    ctx.baseUrl = `${pathToFileURL(rootPath).href}/`
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins.group = Group
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(CommandRuntime)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(MemorySettings).await()
    await ctx.plugin({ apply }).await()
    await ctx.plugin(AgentPresets, {
      default: 'standard',
      roots: [{ path: rootPath, trust: 'system' }],
      includeUserRoot: false,
    }).await()
    const namespace = settingsNamespace('context-compression')
    await ctx.settings.update(namespace, { autoCompact: { thresholdPercent: 70 } })
    const bundle = ctx.plugin({ apply: (child) => {
      apply(child, { presetOverlay: true })
    } })
    await bundle.await()

    const presets = ctx.agentPresets as unknown as OverlayableAgentPresets
    const first = await presets.standingKeyFor()
    const firstFiles = await overlayFiles(rootPath)
    expect(firstFiles).toHaveLength(1)
    expect(firstFiles[0]?.rendered).toContain('thresholdRatio: 0.7')
    expect(firstFiles[0]?.rendered).toContain('autoCompactThresholdPercent: 70')

    // Equal-length change: identical rendered sizes, and without the
    // deterministic threshold mtime a same-millisecond switch could have
    // reused the superseded generation.
    await ctx.settings.update(namespace, { autoCompact: { thresholdPercent: 80 } })
    const second = await presets.standingKeyFor()
    const secondFiles = await overlayFiles(rootPath)
    expect(secondFiles).toHaveLength(2)
    expect(secondFiles.some(file => file.rendered.includes('thresholdRatio: 0.8')
      && file.rendered.includes('autoCompactThresholdPercent: 80'))).toBe(true)
    expect(second).not.toBe(first)
    const stamps = await Promise.all(secondFiles.map(async file => (await stat(file.path)).mtimeMs))
    expect(new Set(stamps).size).toBe(2)

    await bundle.dispose()
  })
})
