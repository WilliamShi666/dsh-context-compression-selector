/** Plugin-owned, reversible compression overlays for native agent presets. */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyEntryPatches, entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-presets'
import { dump, load } from 'js-yaml'

/** Absolute runtime entry points used by the generated compression stack. */
export interface CompressionModulePaths {
  /** Exact aggregate/history compaction implementation shipped with the Bundle. */
  readonly compactionBasic: string
  /** Exact manual compact command shipped with the Bundle. */
  readonly commandCompact: string
  /** Exact enhanced tool-result pruner shipped with the Bundle. */
  readonly toolResultPruner: string
}

/** The public native methods the decorator uses without reaching into core internals. */
export interface OverlayableAgentPresets {
  /** Resolve a source preset for discovery and authoring. */
  resolve(id?: string): Promise<AgentPreset>
  /** Compose an agent from a preset. */
  mount(agentCtx: unknown, id?: string): Promise<AgentPreset>
  /** Move a blank agent to a different preset. */
  recompose(agentCtx: unknown, id: string): Promise<AgentPreset>
  /** Ensure a standing preset composition for cold readers. */
  standingKeyFor(id?: string): Promise<unknown>
}

/** Configuration for one reversible decoration. */
export interface PresetOverlayOptions {
  /** Absolute module entry points written into the generated composition. */
  readonly modules: CompressionModulePaths
  /** Preset ids that deliberately retain their native composition. */
  readonly excludedPresetIds?: readonly string[]
  /** Test seam for locating the owner-only generated directory. */
  readonly tempParent?: string
}

/** Handle returned by {@link decorateAgentPresets}. */
export interface PresetOverlayInstallation {
  /** Restore native methods and remove every generated composition. */
  dispose(): Promise<void>
}

const COMPRESSION_IDS = new Set([
  'compaction',
  'compaction-basic',
  'command-compact',
  'tool-result-pruner',
])

const COMPRESSION_PACKAGES = new Set([
  '@deepseek-ai/dsh-compaction-basic',
  '@deepseek-ai/dsh-command-compact',
  '@deepseek-ai/dsh-compaction-tool-result-pruner',
  'dsh-context-compression-selector-runtime',
])

/**
 * Resolve the three compression package entries once from this package.
 * @returns Absolute entry paths for the canonical compression layer.
 */
export function resolveCompressionModulePaths(): CompressionModulePaths {
  return {
    compactionBasic: modulePath(
      '@deepseek-ai/dsh-compaction-basic', import.meta.resolve('@deepseek-ai/dsh-compaction-basic')),
    commandCompact: modulePath(
      '@deepseek-ai/dsh-command-compact', import.meta.resolve('@deepseek-ai/dsh-command-compact')),
    toolResultPruner: modulePath(
      'dsh-context-compression-selector-runtime', import.meta.resolve('dsh-context-compression-selector-runtime')),
  }
}

/** Convert one package resolution into the absolute path preset mounting accepts. */
function modulePath(specifier: string, resolved: string): string {
  if (!resolved.startsWith('file:')) {
    throw new Error(`context-compression selector: ${specifier} resolved outside the filesystem (${resolved})`)
  }
  return fileURLToPath(resolved)
}

/** One operation's permission to see generated presets through resolve(). */
interface CompositionOperation {
  readonly composing: true
}

/** Generated composition storage owned by one decorator installation. */
class PresetOverlayStore {
  private rootTask: Promise<string> | undefined
  private disposed = false

  constructor(private readonly options: PresetOverlayOptions) {
    const paths = Object.entries(options.modules) as [keyof CompressionModulePaths, string][]
    for (const [name, path] of paths) {
      if (!isAbsolute(path)) {
        throw new TypeError(`context-compression selector: module path ${name} is not absolute: ${path}`)
      }
    }
  }

  /** Return a detached preset record whose path names the canonical overlay. */
  async overlay(preset: AgentPreset): Promise<AgentPreset> {
    if (this.disposed) throw new Error('context-compression selector: preset overlay is disposed')
    if (preset.broken !== undefined) return preset
    const source = await readFile(preset.path, 'utf8')
    const rows = parseRows(source, preset.path)
    const patched = applyEntryPatches(
      stripCompressionRows(rows),
      [{ insert: canonicalCompressionRows(this.options.modules) }],
      (message: string, ...args: unknown[]) => {
        throw new Error(renderPatchWarning(message, args))
      },
    )
    const rendered = dump(patched, {
      schema: entryListSchema,
      noRefs: true,
      lineWidth: -1,
      sortKeys: false,
    })
    const identity = createHash('sha256')
      .update(preset.id).update('\0')
      .update(source).update('\0')
      .update(JSON.stringify(this.options.modules))
      .digest('hex')
      .slice(0, 24)
    const root = await this.root()
    const path = join(root, `${preset.id}-${identity}.agent.cordis.yml`)
    try {
      await writeFile(path, rendered, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    await chmod(path, 0o600)
    return { ...preset, path }
  }

  /** Remove all generated files without touching any source preset. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.rootTask === undefined) return
    const root = await this.rootTask
    await rm(root, { recursive: true, force: true })
  }

  /** Lazily create the one owner-only directory for this installation. */
  private async root(): Promise<string> {
    if (this.rootTask === undefined) {
      const parent = this.options.tempParent ?? tmpdir()
      this.rootTask = mkdtemp(join(parent, 'dsh-context-compression-presets-'))
        .then(async (root) => {
          await chmod(root, 0o700)
          return root
        })
    }
    return await this.rootTask
  }
}

/** Parse one native preset with exactly the Loader's YAML dialect. */
function parseRows(source: string, path: string): EntryOptions[] {
  const parsed = load(source, { schema: entryListSchema })
  if (!Array.isArray(parsed)) {
    throw new TypeError(`context-compression selector: preset ${path} is not a top-level entry list`)
  }
  return parsed as EntryOptions[]
}

/** Remove any prior compression implementation before adding the canonical one. */
function stripCompressionRows(rows: EntryOptions[]): EntryOptions[] {
  const kept: EntryOptions[] = []
  for (const row of rows) {
    if (COMPRESSION_IDS.has(row.id) || COMPRESSION_PACKAGES.has(row.name)) continue
    if (row.group === true && Array.isArray(row.config)) {
      const nested = row.config as unknown as EntryOptions[]
      kept.push({ ...row, config: stripCompressionRows(nested) })
    } else {
      kept.push(row)
    }
  }
  return kept
}

/** Complete, same-realm compression stack added to every applicable preset. */
function canonicalCompressionRows(modules: CompressionModulePaths): EntryOptions[] {
  return [
    {
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      isolate: {
        compaction: true,
        toolResultPruner: true,
      },
      config: [
        {
          id: 'compaction-basic',
          name: modules.compactionBasic,
        },
        {
          id: 'command-compact',
          name: modules.commandCompact,
        },
        {
          id: 'tool-result-pruner',
          name: modules.toolResultPruner,
          config: {
            headChars: 4096,
            tailChars: 1024,
          },
        },
      ],
    },
  ]
}

/** Render include's printf-style warning without silently losing its target. */
function renderPatchWarning(message: string, args: readonly unknown[]): string {
  let index = 0
  return `context-compression selector: ${message.replace(/%C/g, () => JSON.stringify(args[index++]))}`
}

/** Method names whose native execution is allowed to resolve an overlay. */
type CompositionMethod = 'mount' | 'recompose' | 'standingKeyFor'

/** Restore one method to exactly the own/prototype state it had before decoration. */
interface MethodSnapshot {
  readonly name: 'resolve' | CompositionMethod
  readonly own: PropertyDescriptor | undefined
  readonly original: (...args: never[]) => unknown
  wrapped?: (...args: never[]) => unknown
}

/** One physical decoration shared by every duplicate Host row. */
interface SharedDecoration {
  /** Canonical options prevent two rows from silently requesting different stacks. */
  readonly optionsKey: string
  /** Number of live plugin fibers leasing this decoration. */
  references: number
  /** Physical method wrappers and generated-directory owner. */
  readonly installation: PresetOverlayInstallation
}

/**
 * Cordis can hand two callers different traceable proxies for one service.
 * Symbol properties forward to the shared target, unlike proxy identity.
 */
const SHARED_DECORATION = Symbol.for(
  'dsh-context-compression-selector/preset-overlay',
)

/**
 * Reversibly decorate native AgentPresets composition calls.
 *
 * Duplicate Host rows share one physical decoration. This matters while an
 * installation migrates from a Harness-bundled selector row to the standalone
 * Bundle: either row can unload first without double-compressing or disposing
 * the generated files still used by the other.
 * @param presets Native AgentPresets service to decorate during composition.
 * @param options Canonical module paths, exclusions, and optional test directory.
 * @returns A reference-counted handle that restores the native service on final disposal.
 */
export function decorateAgentPresets(
  presets: OverlayableAgentPresets,
  options: PresetOverlayOptions,
): PresetOverlayInstallation {
  const optionsKey = overlayOptionsKey(options)
  const carrier = presets as OverlayableAgentPresets & { [SHARED_DECORATION]?: SharedDecoration }
  let shared = carrier[SHARED_DECORATION]
  if (shared === undefined) {
    shared = {
      optionsKey,
      references: 0,
      installation: installAgentPresetsDecoration(presets, options),
    }
    Object.defineProperty(carrier, SHARED_DECORATION, {
      configurable: true,
      enumerable: false,
      writable: false,
      value: shared,
    })
  } else if (shared.optionsKey !== optionsKey) {
    throw new Error('context-compression selector: AgentPresets already has a different compression overlay')
  }
  const lease = shared
  lease.references += 1

  let disposed = false
  return {
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      lease.references -= 1
      if (lease.references !== 0) return
      if (carrier[SHARED_DECORATION] === lease) {
        Reflect.deleteProperty(carrier, SHARED_DECORATION)
      }
      await lease.installation.dispose()
    },
  }
}

/** Stable equality for two rows asking to share one physical overlay. */
function overlayOptionsKey(options: PresetOverlayOptions): string {
  return JSON.stringify({
    modules: options.modules,
    excludedPresetIds: [...(options.excludedPresetIds ?? ['minimal'])].sort(),
    tempParent: options.tempParent,
  })
}

/**
 * Install the one physical method decoration leased by public callers.
 *
 * Direct resolution and authoring stay source-preserving. AsyncLocalStorage
 * scopes the overlay to the async call tree of mount/recompose/standingKeyFor,
 * so an unrelated resolve racing the mount cannot inherit its generated path.
 */
function installAgentPresetsDecoration(
  presets: OverlayableAgentPresets,
  options: PresetOverlayOptions,
): PresetOverlayInstallation {
  const excluded = new Set(options.excludedPresetIds ?? ['minimal'])
  const operations = new AsyncLocalStorage<CompositionOperation>()
  const store = new PresetOverlayStore(options)
  const snapshots = snapshotMethods(presets)
  const resolveSnapshot = snapshotFor(snapshots, 'resolve')

  const resolveWrapped = async (id?: string): Promise<AgentPreset> => {
    const preset = await Reflect.apply(resolveSnapshot.original, presets, [id]) as AgentPreset
    if (operations.getStore()?.composing !== true || excluded.has(preset.id)) return preset
    return await store.overlay(preset)
  }
  installMethod(presets, resolveSnapshot, resolveWrapped)

  for (const method of ['mount', 'recompose', 'standingKeyFor'] as const) {
    const snapshot = snapshotFor(snapshots, method)
    const wrapped = (...args: unknown[]): unknown => operations.run(
      { composing: true },
      (): unknown => Reflect.apply(snapshot.original, presets, args) as unknown,
    )
    installMethod(presets, snapshot, wrapped)
  }

  let disposed = false
  return {
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      for (const snapshot of [...snapshots].reverse()) restoreMethod(presets, snapshot)
      await store.dispose()
    },
  }
}

/** Capture callable methods and whether each was inherited or owned. */
function snapshotMethods(presets: OverlayableAgentPresets): MethodSnapshot[] {
  return (['resolve', 'mount', 'recompose', 'standingKeyFor'] as const).map((name) => {
    const original = presets[name]
    if (typeof original !== 'function') {
      throw new TypeError(`context-compression selector: AgentPresets.${name} is unavailable`)
    }
    return {
      name,
      own: Object.getOwnPropertyDescriptor(presets, name),
      original,
    }
  })
}

/** Return the captured method or fail loudly if the snapshot set is corrupt. */
function snapshotFor(
  snapshots: readonly MethodSnapshot[],
  name: MethodSnapshot['name'],
): MethodSnapshot {
  const snapshot = snapshots.find(candidate => candidate.name === name)
  if (snapshot === undefined) {
    throw new Error(`context-compression selector: missing method snapshot for ${name}`)
  }
  return snapshot
}

/** Install one own method while retaining its identity for safe disposal. */
function installMethod(
  presets: OverlayableAgentPresets,
  snapshot: MethodSnapshot,
  wrapped: (...args: never[]) => unknown,
): void {
  snapshot.wrapped = wrapped
  Object.defineProperty(presets, snapshot.name, {
    configurable: true,
    writable: true,
    value: wrapped,
  })
}

/** Restore the captured own/prototype state after the final shared lease. */
function restoreMethod(presets: OverlayableAgentPresets, snapshot: MethodSnapshot): void {
  // Cordis' traceable service proxy rebinds a method on every read, so function
  // identity cannot prove ownership here. The shared reference count is the
  // ownership guard: this path runs only after the final decorator lease ends.
  if (snapshot.own === undefined) {
    Reflect.deleteProperty(presets, snapshot.name)
  } else {
    Object.defineProperty(presets, snapshot.name, snapshot.own)
  }
}
