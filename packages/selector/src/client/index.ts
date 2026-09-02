import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import {
  COMPRESSION_PROFILES,
  isCustomCompressionPolicy,
  ContextCompressionSettingsSection,
  type CompressionProfile, type CompressionSelectorInjected, type ContextCompressionSettings,
} from './CompressionProfileSelector.tsx'
import { DEFAULT_CUSTOM_COMPRESSION_POLICY } from '../profiles.ts'
import { decodeSettings } from './decode.ts'
import { en, zh } from './locales.ts'

export const inject = ['slots', 'locale', 'settingsScope']
const NS = 'context-compression'


function sameCustomPolicy(
  left: ContextCompressionSettings['custom'],
  right: ContextCompressionSettings['custom'],
): boolean {
  if (left.version !== 3 || right.version !== 3) return false
  return left.version === right.version
    && left.unit === right.unit
    && left.prefixPolicy === right.prefixPolicy
    && left.fresh.enabled === right.fresh.enabled
    && left.fresh.trigger === right.fresh.trigger
    && left.fresh.target === right.fresh.target
    && left.aggregate.enabled === right.aggregate.enabled
    && left.aggregate.trigger === right.aggregate.trigger
    && left.aggregate.target === right.aggregate.target
    && left.history.enabled === right.history.enabled
    && left.history.trigger === right.history.trigger
    && left.history.keepRecentToolCalls === right.history.keepRecentToolCalls
    && left.history.keepRecentTokens === right.history.keepRecentTokens
    && left.history.minReclaim === right.history.minReclaim
    && left.tailTrim.enabled === right.tailTrim.enabled
    && left.tailTrim.trigger === right.tailTrim.trigger
}

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-context-compression: dictionaries')
  const scope = ctx.settingsScope.bind<ContextCompressionSettings>({ namespace: NS, decode: decodeSettings })
  const writeAndConfirm = async (
    write: () => Promise<void>,
    accepts: (settings: ContextCompressionSettings) => boolean,
  ): Promise<void> => {
    const beforeRevision = scope.getSnapshot().revision
    await write()
    const after = scope.getSnapshot()
    if (
      after.status !== 'ready'
      || after.value === undefined
      || after.revision === beforeRevision
      || !accepts(after.value)
    ) {
      throw new Error('Context compression settings were not saved.')
    }
  }
  const injected = (): CompressionSelectorInjected => ({
    hooks: { compression: scope },
    select: profile => writeAndConfirm(
      () => scope.set('profile', profile),
      settings => settings.profile === profile,
    ),
    saveCustom: custom => writeAndConfirm(
      () => scope.set('custom', custom),
      settings => isCustomCompressionPolicy(settings.custom)
        && sameCustomPolicy(settings.custom, custom),
    ),
    resetCustom: () => writeAndConfirm(
      () => scope.set('custom', structuredClone(DEFAULT_CUSTOM_COMPRESSION_POLICY)),
      settings => isCustomCompressionPolicy(settings.custom)
        && sameCustomPolicy(settings.custom, DEFAULT_CUSTOM_COMPRESSION_POLICY),
    ),
    saveAutoCompact: thresholdPercent => writeAndConfirm(
      () => scope.set('autoCompact', { thresholdPercent }),
      settings => settings.autoCompact.thresholdPercent === thresholdPercent,
    ),
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'context-compression',
    order: 17,
    label: () => ctx.locale.bind(NS)('nav'),
    locale: NS,
    inject: injected,
  }, ContextCompressionSettingsSection))
}

export type {
  CompressionProfile, CompressionProfileSelectorProps, CompressionSelectorInjected,
  ContextCompressionSettings,
} from './CompressionProfileSelector.tsx'
