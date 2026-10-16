import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context } from '@deepseek-ai/cordis'
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
import {
  settingsFaceFromConfigForm,
  settingsFaceFromScope,
  type ConfigFormsService,
  type LegacySettingsScope,
  type SettingsFace,
  type VolatileProjection,
} from './settings-face.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'context-compression'

/**
 * Host profile entry id owning this plugin's settings namespace on Harness
 * 0.2.0, where the settings namespace IS the Host entry id rather than a
 * plugin-chosen name. Spelled here rather than imported because a browser
 * package must not depend on a Host package; the value must match the `id` in
 * this package's `cordis.patch.yml` (`context-compression-selector-bundle`).
 */
const HOST_ENTRY_ID = 'context-compression-selector-bundle'

/**
 * Read the 0.2.0 configuration-form service off a context.
 *
 * The service NAME is a compile-time window between generations: the 0.1.x
 * types declare `settingsScope` on `Context` and never `configForms`, the 0.2.0
 * types declare the reverse, and this package's own `Context` is whichever
 * generation it was built against (here 0.1.x). Declaring `configForms` here
 * would not be additive: a merged property must have the same type in every
 * declaration of it, and 0.2.0 declares its concrete `ConfigForms` class, so
 * the augmentation would fail to compile for anyone building against 0.2.0
 * types — the exact dual-target case this migration exists to support. The
 * property is therefore read structurally through the cast below, which is
 * legal against either generation's types and keeps one artifact compiling for
 * both. Only the access is asserted; everything downstream programs against
 * {@link ConfigFormsService}, which is checked.
 * @param ctx - a context inside `ctx.inject(['configForms'], ...)`.
 * @returns the 0.2.0 configuration-form service.
 */
function configFormsOf(ctx: Context): ConfigFormsService {
  return (ctx as unknown as { configForms: ConfigFormsService }).configForms
}

/**
 * Static service dependencies. Deliberately excludes the settings surface:
 * 0.1.x provides `settingsScope` and no `configForms`, while 0.2.0 provides
 * `configForms` and no `settingsScope`. A static dependency on a service the
 * running Harness never provides leaves this entry's fiber `pending` forever,
 * and the web boot gate reads that entry fiber and aborts the whole page — so
 * each settings surface is acquired through its own `ctx.inject` sub-fiber
 * below, where a missing service leaves only that sub-fiber pending while this
 * entry still reaches `active`.
 */
export const inject = ['slots', 'locale']

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

/**
 * Narrow one 0.1.x settings section through {@link decodeSettings}, accepting
 * only a complete document. 0.2.0 never reaches here: its per-entry form is
 * narrowed by `decodeVolatileProjection` instead, because that form serves the
 * entry's projected volatile fields rather than the whole document.
 */
function decodeSection(section: unknown): ContextCompressionSettings | undefined {
  return decodeSettings(section)
}

/**
 * Build the injected business face over one settings adapter, including the
 * write-confirm contract that makes a silently-dropped write fail loudly.
 */
function createInjected(face: SettingsFace<ContextCompressionSettings>): CompressionSelectorInjected {
  const writeAndConfirm = async (
    write: () => Promise<void>,
    accepts: (settings: ContextCompressionSettings) => boolean,
  ): Promise<void> => {
    const beforeRevision = face.getSnapshot().revision
    await write()
    const after = face.getSnapshot()
    if (
      after.status !== 'ready'
      || after.value === undefined
      || after.revision === beforeRevision
      || !accepts(after.value)
    ) {
      throw new Error('Context compression settings were not saved.')
    }
  }
  return {
    hooks: { compression: face },
    customEditable: face.customEditable,
    select: profile => writeAndConfirm(
      () => face.set('profile', profile),
      settings => settings.profile === profile,
    ),
    saveCustom: custom => writeAndConfirm(
      () => face.set('custom', custom),
      settings => isCustomCompressionPolicy(settings.custom)
        && sameCustomPolicy(settings.custom, custom),
    ),
    resetCustom: () => writeAndConfirm(
      () => face.set('custom', structuredClone(DEFAULT_CUSTOM_COMPRESSION_POLICY)),
      settings => isCustomCompressionPolicy(settings.custom)
        && sameCustomPolicy(settings.custom, DEFAULT_CUSTOM_COMPRESSION_POLICY),
    ),
    saveAutoCompact: thresholdPercent => writeAndConfirm(
      () => face.set('autoCompact', { thresholdPercent }),
      settings => settings.autoCompact.thresholdPercent === thresholdPercent,
    ),
  }
}

/**
 * Mount the settings section once a settings surface is available.
 * @returns the disposer removing the contribution.
 */
function mountSection(
  ctx: Context,
  injected: () => CompressionSelectorInjected,
): () => void {
  return ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'context-compression',
    order: 17,
    label: () => ctx.locale.bind(NS)('nav'),
    locale: NS,
    inject: injected,
  }, ContextCompressionSettingsSection))
}

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-context-compression: dictionaries')

  // Harness 0.1.x: a plugin-chosen namespace bound through `settingsScope`,
  // which carries the complete settings document.
  ctx.inject(['settingsScope'], (scopeCtx) => {
    const scope = (scopeCtx.settingsScope as LegacySettingsScope)
      .bind<ContextCompressionSettings>({ namespace: NS, decode: decodeSection })
    mountSection(scopeCtx, () => createInjected(settingsFaceFromScope(scope)))
  })

  // Harness 0.2.0: no plugin-chosen namespace exists. The entry's own Config
  // declares the editable fields as volatile, and the settings namespace is
  // this plugin's Host entry id. `whileServed` keeps the page unregistered
  // until the Host actually serves that namespace, so a deployment that
  // composed no such entry shows no trace of the section.
  ctx.inject(['configForms'], (formsCtx) => {
    const forms = configFormsOf(formsCtx)
    formsCtx.effect(
      () => forms.whileServed([HOST_ENTRY_ID], () => {
        const form = forms.get<VolatileProjection>(HOST_ENTRY_ID)
        return mountSection(formsCtx, () => createInjected(settingsFaceFromConfigForm(form)))
      }),
      'ui-context-compression: 0.2.0 settings section',
    )
  })
}

export { COMPRESSION_PROFILES }
export type {
  CompressionProfile, CompressionProfileSelectorProps, CompressionSelectorInjected,
  ContextCompressionSettings,
} from './CompressionProfileSelector.tsx'
