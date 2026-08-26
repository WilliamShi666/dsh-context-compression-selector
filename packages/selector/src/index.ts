/** Host owner of the context-compression preference consumed by the browser selector. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  settingsNamespace,
  type SettingsScope,
  type default as SettingsService,
} from '@deepseek-ai/dsh-settings'
import {
  CONTEXT_COMPRESSION_SETTINGS_NAMESPACE,
  ContextCompressionSettingsSchema,
} from 'dsh-context-compression-selector-runtime'
import {
  decorateAgentPresets,
  resolveCompressionModulePaths,
} from './preset-overlay.ts'

const CONTEXT_COMPRESSION_NAMESPACE = settingsNamespace(CONTEXT_COMPRESSION_SETTINGS_NAMESPACE)

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
}

/** Loader validation for the standalone Bundle opt-in. */
export const Config: z<Config> = z.object({
  presetOverlay: z.boolean().default(false),
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
      },
    )
    presetsCtx.effect(() => () => installation.dispose(), 'contextCompressionSelector.agentPresets()')
  })
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
