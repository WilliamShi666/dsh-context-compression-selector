/** Host owner of the context-compression preference consumed by the browser selector. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  type SettingsScope,
  type default as SettingsService,
} from '@deepseek-ai/dsh-settings'
import {
  CONTEXT_COMPRESSION_SETTINGS_NAMESPACE,
  ContextCompressionSettingsSchema,
  isCompressionProfile,
  readLiveConfigField,
} from 'dsh-context-compression-selector-runtime'
import {
  decorateAgentPresets,
  resolveCompressionModulePaths,
} from './preset-overlay.ts'

// Harness 0.1.1 exposed a namespace-branding helper; 0.1.2 validates the
// same public literal at SettingsProvider.register/get instead.
const CONTEXT_COMPRESSION_NAMESPACE = CONTEXT_COMPRESSION_SETTINGS_NAMESPACE as never

/** Fallback Auto Compact threshold when no readable settings document exists. */
const DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT = 80

/**
 * This plugin's own Cordis profile entry id, which IS its settings namespace on
 * Harness 0.2.0. Must match the `id` in this package's `cordis.patch.yml`.
 */
const HOST_ENTRY_ID = 'context-compression-selector-bundle'

/** Shared state forwarded through every Cordis proxy of one settings service. */
interface SharedSettingsRegistration {
  /** Plugin fibers currently leasing the namespace. */
  readonly owners: Set<SettingsOwner>
  /** Owner whose fiber currently carries settings.register's native effect. */
  registrationOwner: SettingsOwner
  /** Current owner scope; replaced without changing the stored document. */
  scope: SettingsScope<unknown>
}

/** One selector Host row able to own the registration effect. */
interface SettingsOwner {
  /** Traceable service proxy binding register() to this row's fiber. */
  readonly settings: SettingsService
}

/** Symbol properties reach the shared service target through Cordis proxies. */
const SHARED_SETTINGS = Symbol.for(
  'dsh-context-compression-selector/settings-registration',
)

type SettingsCarrier = SettingsService & {
  [SHARED_SETTINGS]?: SharedSettingsRegistration
}

/** Standalone Bundle behavior; the settings/UI owner remains safe when false. */
export interface Config {
  /** Add the canonical compression stack to every non-Minimal preset. */
  presetOverlay?: boolean
  /**
   * Selected compression profile, editable live from the settings page on
   * Harness 0.2.0. Declared volatile so the Host exposes it in this entry's
   * configuration form without remounting the plugin. Absent inherits the
   * runtime schema's own default, so 0.1.x behavior is unchanged.
   */
  profile?: string
  /**
   * Auto Compact threshold percent, editable live from the settings page on
   * Harness 0.2.0. Volatile for the same reason as {@link profile}.
   */
  autoCompactThresholdPercent?: number
}

/**
 * Declare the `volatile` metadata key on this package's schemastery floor.
 *
 * The Harness reads `schema.meta.volatile` to decide which Config fields its
 * settings page exposes as live-editable. This package's schemastery floor is
 * 3.18.1, whose `Meta` predates that key, so `.extra('volatile', true)` is
 * rejected by the compiler even though the call already sets exactly the
 * metadata the Host reads. The Host's own 3.18.4 declares the same optional
 * key, and two optional declarations of one key merge to the same thing, so
 * this augmentation agrees with the Host rather than diverging from it. Being
 * a type-level statement only, it adds no runtime dependency on either copy.
 */
declare global {
  namespace Schemastery {
    interface Meta<T = any> {
      /** Expose this field as live-editable in the Harness settings page. */
      volatile?: boolean
    }
  }
}

/**
 * Loader validation for the Bundle options.
 *
 * The two preference fields are marked `volatile` through `.extra(...)` rather
 * than `.volatile()`: the Harness reads `schema.meta.volatile`, and this
 * package's schemastery floor is 3.18.1, whose `Schema` has no `.volatile()`
 * method. `meta.volatile` round-trips through `toJSON()` on both 3.18.1 and the
 * Host's 3.18.4, so the form the Host derives is identical either way.
 */
export const Config: z<Config> = z.object({
  presetOverlay: z.boolean().default(false),
  profile: z.string().extra('volatile', true).required(false),
  autoCompactThresholdPercent: z.number().extra('volatile', true).required(false),
})

/** Register the persisted default read by the currently mounted root pruner. */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.inject(['settings'], (settingsCtx) => {
    acquireSettingsRegistration(settingsCtx)
  })

  if (config.presetOverlay !== true) return

  ctx.inject(['agentPresets'], (presetsCtx) => {
    const installation = decorateAgentPresets(
      presetsCtx.agentPresets,
      {
        modules: resolveCompressionModulePaths(),
        excludedPresetIds: ['minimal'],
        autoCompactThresholdPercent: () => resolveAutoCompactThresholdPercent(presetsCtx, config),
        profile: () => resolveSelectedProfile(presetsCtx, config),
      },
    )
    presetsCtx.effect(() => () => installation.dispose(), 'contextCompressionSelector.agentPresets()')
  })
}

/**
 * Read the selected compression profile at composition time.
 *
 * Harness 0.1.x keeps the selection in the shared `context-compression` settings
 * document, which the generated composition's own runtime entry reads live, so
 * returning `undefined` there leaves that path exactly as it was. Harness 0.2.0
 * has no shared document — the write lands on the selector entry alone — so the
 * selection only reaches the runtime if the generator states it in the pruner's
 * config, which is why this value is read here rather than left to the runtime.
 * @returns the selected profile, or undefined when none is readable.
 */
function resolveSelectedProfile(presetsCtx: Context, config: Config): string | undefined {
  const stored = readStoredSettings(presetsCtx)
  if (stored !== undefined) return undefined
  const selected = readLiveConfigField(config.profile)
  // The generated composition's pruner validates `profile` against the runtime
  // schema's strict union, so an unusable live value must not be written there:
  // leaving it undefined keeps the schema default rather than failing the mount.
  return isCompressionProfile(selected) ? selected : undefined
}

/**
 * Read the current Auto Compact threshold at composition time.
 *
 * Harness 0.1.x stores the whole document in the plugin's own `settings`
 * namespace. Harness 0.2.0 has no such namespace: the settings surface is the
 * profile entry's own Config, and only the fields the Host declared volatile
 * are exposed, so the threshold is read from {@link Config} instead. Values are
 * revalidated here, and any unreadable value falls back to the 80% default
 * rather than blocking preset composition.
 */
function resolveAutoCompactThresholdPercent(presetsCtx: Context, config: Config): number {
  const stored = readStoredSettings(presetsCtx)
  // Live-Config fields arrive as volatile references on 0.2.0, so the raw
  // `config.autoCompactThresholdPercent` can be a holder rather than a number.
  const configured = readLiveConfigField(config.autoCompactThresholdPercent)
  const raw = stored?.autoCompact ?? (
    configured === undefined ? undefined : { thresholdPercent: configured }
  )
  try {
    const parsed = ContextCompressionSettingsSchema({
      profile: stored?.profile ?? readLiveConfigField(config.profile) ?? 'balanced',
      ...stored?.custom === undefined ? {} : { custom: stored.custom },
      ...raw === undefined ? {} : { autoCompact: raw },
    } as never)
    return parsed.autoCompact.thresholdPercent
  } catch {
    return DEFAULT_AUTO_COMPACT_THRESHOLD_PERCENT
  }
}

/**
 * Read the persisted document from the 0.1.x settings namespace.
 *
 * Returns undefined on Harness 0.2.0, where `settings` exposes no `get` at all
 * — calling it there would throw rather than merely fail to find a document.
 */
function readStoredSettings(ctx: Context): {
  profile?: unknown
  custom?: unknown
  autoCompact?: unknown
} | undefined {
  const settings = ctx.get('settings') as { get?: (ns: never) => unknown } | undefined
  if (typeof settings?.get !== 'function') return undefined
  const stored = settings.get(CONTEXT_COMPRESSION_NAMESPACE)
  return stored === null || typeof stored !== 'object' ? undefined : stored
}

/**
 * Lease one native settings registration across duplicate Host rows.
 *
 * The lease effect is intentionally registered before settings.register().
 * Cordis disposes effects in reverse order, so the native registration first
 * releases the namespace; this disposer can then transfer it to another live
 * owner without a duplicate-registration window.
 */
function acquireSettingsRegistration(ctx: Context): void {
  const settings = ctx.settings as SettingsCarrier
  // Harness 0.2.0 replaced this namespace surface with per-entry
  // configuration forms, so there is no native registration to lease.
  if (typeof (settings as { register?: unknown }).register !== 'function') return
  const owner: SettingsOwner = { settings }
  let shared = settings[SHARED_SETTINGS]
  if (shared === undefined) {
    shared = {
      owners: new Set(),
      registrationOwner: owner,
      scope: undefined as unknown as SettingsScope<unknown>,
    }
    Object.defineProperty(settings, SHARED_SETTINGS, {
      configurable: true,
      enumerable: false,
      writable: false,
      value: shared,
    })
  }
  shared.owners.add(owner)
  const state = shared

  ctx.effect(() => () => {
    state.owners.delete(owner)
    if (state.registrationOwner === owner && state.owners.size > 0) {
      const next = state.owners.values().next().value as SettingsOwner
      state.registrationOwner = next
      state.scope = next.settings.register(
        CONTEXT_COMPRESSION_NAMESPACE,
        ContextCompressionSettingsSchema,
      )
    }
    if (state.owners.size === 0 && settings[SHARED_SETTINGS] === state) {
      Reflect.deleteProperty(settings, SHARED_SETTINGS)
    }
  }, 'contextCompressionSelector.settingsLease()')

  if (state.owners.size === 1) {
    state.scope = settings.register(
      CONTEXT_COMPRESSION_NAMESPACE,
      ContextCompressionSettingsSchema,
    )
  }
}

export { HOST_ENTRY_ID }
