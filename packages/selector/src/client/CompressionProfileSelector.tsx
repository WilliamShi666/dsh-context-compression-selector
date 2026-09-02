import { useEffect, useId, useState } from 'react'
import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ContextCompressionLocaleKey } from './locales.ts'
import css from './CompressionProfileSelector.module.css'
import {
  AUTO_COMPACT_THRESHOLD_LIMITS,
  COMPRESSION_PROFILES,
  isCustomCompressionPolicy,
  isValidAutoCompactThresholdPercent,
  type CompressionProfile,
  type CustomCompressionBudget,
  type CustomCompressionPolicy,
  type CustomCompressionPolicyV3,
  type CustomHistoryPolicy,
  type ContextCompressionSettings,
} from '../profiles.ts'

export { COMPRESSION_PROFILES, isCustomCompressionPolicy }
export type { CompressionProfile, CustomCompressionPolicy, ContextCompressionSettings }

export interface CompressionSelectorInjected {
  hooks: { compression: SettingsScope<ContextCompressionSettings> }
  select: (profile: CompressionProfile) => Promise<void>
  saveCustom: (custom: CustomCompressionPolicy) => Promise<void>
  resetCustom: () => Promise<void>
  saveAutoCompact: (thresholdPercent: number) => Promise<void>
}

export type CompressionProfileSelectorProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'context-compression'>
  & InjectFace<CompressionSelectorInjected>

/** Full-page Settings surface backed by the same durable selector state. */
export function ContextCompressionSettingsSection(props: CompressionProfileSelectorProps) {
  return <SettingsCompressionProfileControls {...props} />
}

function SettingsCompressionProfileControls({
  useCompression, useSessions, select, saveCustom, resetCustom, saveAutoCompact, t,
}: CompressionProfileSelectorProps) {
  const state = useCompression(snapshot => snapshot)
  const currentPreset = useSessions((sessions) => {
    const current = sessions.current
    return current === undefined ? undefined : sessions.byId[current]?.agentPreset
  })
  const selectorAvailable = currentPreset !== 'minimal'
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [draft, setDraft] = useState<CustomCompressionPolicyV3 | null>(null)
  const current = state.value?.profile ?? 'balanced'
  useEffect(() => {
    const custom = state.value?.custom
    setDraft(current === 'custom' && custom !== undefined ? editableCustom(custom) : null)
  }, [current, state.value?.custom])
  if (state.status === 'unavailable') return null

  const busy = state.status === 'loading' || saving
  const selectProfile = (profile: CompressionProfile): void => {
    if (!selectorAvailable || !state.writable || profile === current) return
    setSaveError(null)
    setSaving(true)
    void select(profile).then(
      () => { setSaving(false) },
      (error: unknown) => {
        setSaving(false)
        setSaveError(error instanceof Error && error.message !== '' ? error.message : t('status.saveFailed'))
      },
    )
  }
  const settle = (operation: () => Promise<void>): void => {
    setSaveError(null)
    setSaving(true)
    void operation().then(
      () => { setSaving(false) },
      (error: unknown) => {
        setSaving(false)
        setSaveError(error instanceof Error && error.message !== '' ? error.message : t('status.saveFailed'))
      },
    )
  }

  return (
    <section className={css.settingsSection}>
      <h2 className={css.settingsTitle}>{t('settings.title')}</h2>
      <p className={css.settingsDescription}>{t('settings.description')}</p>
      {selectorAvailable ? (
        <div className={css.profileGrid} aria-label={t('label')}>
          {COMPRESSION_PROFILES.map((profile) => {
            const selected = profile === current
            return (
              <button key={profile} type="button" className={css.profileCard} aria-pressed={selected}
                disabled={busy || !state.writable} onClick={() => { selectProfile(profile) }}>
                <span className={css.profileCardTop}>
                  <span className={css.profileCardTitle}>{t(`profile.${profile}`)}</span>
                  {selected ? <span className={css.profileCurrent}>{t('profile.current')}</span> : null}
                </span>
                <span className={css.profileCardDetail}>{t(`detail.${profile}`)}</span>
              </button>
            )
          })}
        </div>
      ) : <div className={css.unavailable} role="status">{t('status.minimalUnavailable')}</div>}
      <AutoCompactThresholdControls
        value={state.value?.autoCompact?.thresholdPercent ?? AUTO_COMPACT_THRESHOLD_LIMITS.default}
        disabled={busy || !state.writable || !selectorAvailable}
        save={saveAutoCompact}
        settle={settle}
        t={t}
      />
      <div className={css.pricing}>{t('pricing.disclosure')}</div>
      {current !== 'custom' || draft === null || !selectorAvailable ? null : (
        <CustomPolicyEditor value={draft} disabled={busy || !state.writable} setValue={setDraft}
          save={() => saveCustom(structuredClone(draft))} reset={resetCustom} settle={settle} t={t} />
      )}
      {saveError === null ? null : <div className={css.error} role="alert">{saveError}</div>}
    </section>
  )
}

export function CompressionProfileSelector({
  ...props
}: CompressionProfileSelectorProps) {
  return <CompressionProfileControls {...props} showCustomEditor={false} />
}

function CompressionProfileControls({
  useCompression, useSessions, select, saveCustom, resetCustom, t, showCustomEditor,
}: CompressionProfileSelectorProps & { showCustomEditor: boolean }) {
  const state = useCompression(snapshot => snapshot)
  const currentPreset = useSessions((sessions) => {
    const current = sessions.current
    return current === undefined ? undefined : sessions.byId[current]?.agentPreset
  })
  // A profile is Host-global. A cold Session may not have reported a live
  // capability yet, so only Minimal blocks initial configuration.
  const contextCompressionAvailable = currentPreset !== 'minimal'
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [draft, setDraft] = useState<CustomCompressionPolicyV3 | null>(null)
  const unavailableId = useId()
  const current = state.value?.profile ?? 'balanced'
  useEffect(() => {
    if (state.status === 'ready' && state.writable && contextCompressionAvailable) return
    setOpen(false)
  }, [contextCompressionAvailable, state.status, state.writable])
  useEffect(() => {
    const custom = state.value?.custom
    setDraft(current === 'custom' && custom !== undefined ? editableCustom(custom) : null)
  }, [current, state.value?.custom])
  if (state.status === 'unavailable') return null
  const busy = state.status === 'loading' || saving
  const label = busy ? t('status.loading') : t(`profile.${current}`)
  return (
    <div className={css.root}>
      <Menu
        open={open && contextCompressionAvailable}
        onClose={() => { setOpen(false) }}
        selectedId={current}
        items={COMPRESSION_PROFILES.map(profile => ({
          id: profile,
          label: (
            <span className={css.menuCopy}>
              <span className={css.menuTitle}>{t(`profile.${profile}`)}</span>
              <span className={css.menuDetail}>{t(`detail.${profile}`)}</span>
            </span>
          ),
        }))}
        onSelect={(id) => {
          setOpen(false)
          if (id === current || !COMPRESSION_PROFILES.includes(id as CompressionProfile)) return
          setSaveError(null)
          setSaving(true)
          void select(id as CompressionProfile).then(
            () => { setSaving(false) },
            (error: unknown) => {
              setSaving(false)
              setSaveError(error instanceof Error && error.message !== '' ? error.message : t('status.saveFailed'))
            },
          )
        }}
        align="start"
        portal
        anchor={(
          <button
            type="button"
            className={css.button}
            aria-haspopup="menu"
            aria-expanded={open && contextCompressionAvailable}
            aria-describedby={contextCompressionAvailable ? undefined : unavailableId}
            disabled={busy || !state.writable || !contextCompressionAvailable}
            onClick={() => { setOpen(value => !value) }}
          >
            <span className={css.copy}>
              <span className={css.label}>{t('label')}</span>
              <span className={css.value}>{label}</span>
            </span>
            <IconChevronDownOutline14 className={css.chevron} />
          </button>
        )}
      />
      {contextCompressionAvailable ? null : (
        <div id={unavailableId} className={css.unavailable} role="status">
          {t('status.minimalUnavailable')}
        </div>
      )}
      <div className={css.pricing}>{t('pricing.disclosure')}</div>
      <div className={css.settingsHint}>
        {t('autoCompact.summaryHint').replace('{percent}', String(state.value?.autoCompact?.thresholdPercent ?? AUTO_COMPACT_THRESHOLD_LIMITS.default))}
      </div>
      {current !== 'custom' || showCustomEditor ? null : (
        <div className={css.settingsHint}>{t('custom.settingsHint')}</div>
      )}
      {current !== 'custom' || draft === null || !showCustomEditor ? null : (
        <CustomPolicyEditor
          value={draft}
          disabled={busy || !state.writable || !contextCompressionAvailable}
          setValue={setDraft}
          save={() => saveCustom(structuredClone(draft))}
          reset={resetCustom}
          settle={(operation) => {
            setSaveError(null)
            setSaving(true)
            void operation().then(
              () => { setSaving(false) },
              (error: unknown) => {
                setSaving(false)
                setSaveError(error instanceof Error && error.message !== '' ? error.message : t('status.saveFailed'))
              },
            )
          }}
          t={t}
        />
      )}
      {saveError === null ? null : <div className={css.error} role="alert">{saveError}</div>}
    </div>
  )
}

interface AutoCompactThresholdControlsProps {
  value: number
  disabled: boolean
  save: (thresholdPercent: number) => Promise<void>
  settle: (operation: () => Promise<void>) => void
  t: (key: ContextCompressionLocaleKey) => string
}

const AUTO_COMPACT_QUICK_VALUES = [70, 80, 85] as const

/**
 * The authoritative Auto Compact threshold editor for the context-compression
 * section. The number input, slider, and quick values share one draft and one
 * save path; values outside the recommended 70–85 band warn without blocking.
 */
function AutoCompactThresholdControls({ value, disabled, save, settle, t }: AutoCompactThresholdControlsProps) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  const parsed = Number(draft)
  // Number inputs legally produce value-equivalent drafts such as '8e1';
  // only the parsed value needs to be a valid threshold.
  const valid = isValidAutoCompactThresholdPercent(parsed)
  const risk = !valid
    ? 'autoCompact.invalid'
    : parsed < 70 ? 'autoCompact.riskLow'
      : parsed > 85 ? 'autoCompact.riskHigh'
        : undefined
  return (
    <section className={css.autoCompact} aria-labelledby="context-compression-autocompact-title">
      <h3 id="context-compression-autocompact-title" className={css.autoCompactTitle}>{t('autoCompact.title')}</h3>
      <p className={css.customNote}>{t('autoCompact.description')}</p>
      <div className={css.autoCompactControls}>
        <label className={css.field}>
          <span>{t('autoCompact.inputLabel')}</span>
          <input
            type="number"
            value={draft}
            min={AUTO_COMPACT_THRESHOLD_LIMITS.min}
            max={AUTO_COMPACT_THRESHOLD_LIMITS.max}
            step={AUTO_COMPACT_THRESHOLD_LIMITS.step}
            disabled={disabled}
            aria-invalid={!valid}
            onChange={(event) => { setDraft(event.currentTarget.value) }}
          />
        </label>
        <label className={css.autoCompactSlider}>
          <span className={css.autoCompactSliderLabel}>{t('autoCompact.sliderLabel')}</span>
          <input
            type="range"
            value={valid ? draft : String(value)}
            min={AUTO_COMPACT_THRESHOLD_LIMITS.min}
            max={AUTO_COMPACT_THRESHOLD_LIMITS.max}
            step={AUTO_COMPACT_THRESHOLD_LIMITS.step}
            disabled={disabled}
            onChange={(event) => { setDraft(event.currentTarget.value) }}
          />
        </label>
      </div>
      <div className={css.autoCompactQuick} role="group" aria-label={t('autoCompact.quick')}>
        {AUTO_COMPACT_QUICK_VALUES.map(quick => (
          <button
            key={quick}
            type="button"
            className={css.autoCompactQuickButton}
            aria-pressed={valid && parsed === quick}
            disabled={disabled}
            onClick={() => { setDraft(String(quick)) }}
          >
            {`${String(quick)}%`}
          </button>
        ))}
      </div>
      {risk === undefined ? null : (
        <div className={risk === 'autoCompact.invalid' ? css.error : css.autoCompactRisk} role={risk === 'autoCompact.invalid' ? 'alert' : 'note'}>
          {t(risk)}
        </div>
      )}
      <div className={css.actions}>
        <button
          type="button"
          disabled={disabled || !valid || parsed === value}
          onClick={() => { settle(() => save(parsed)) }}
        >
          {t('autoCompact.save')}
        </button>
      </div>
    </section>
  )
}

interface CustomPolicyEditorProps {
  value: CustomCompressionPolicyV3
  disabled: boolean
  setValue: (value: CustomCompressionPolicyV3) => void
  save: () => Promise<void>
  reset: () => Promise<void>
  settle: (operation: () => Promise<void>) => void
  t: (key: ContextCompressionLocaleKey) => string
}

function CustomPolicyEditor({ value, disabled, setValue, save, reset, settle, t }: CustomPolicyEditorProps) {
  const valid = isCustomCompressionPolicy(value)
  const unitStep = value.unit === 'tokens' ? 1 : 0.01
  const unitMax = value.unit === 'tokens' ? undefined : 100
  const unitBounds = unitMax === undefined ? {} : { max: unitMax }
  const setBudget = (
    stage: 'fresh' | 'aggregate',
    patch: Partial<CustomCompressionBudget>,
  ): void => {
    setValue({ ...value, [stage]: { ...value[stage], ...patch } })
  }
  const setHistory = (patch: Partial<CustomHistoryPolicy>): void => {
    setValue({ ...value, history: { ...value.history, ...patch } })
  }
  return (
    <section className={css.custom} aria-labelledby="context-compression-custom-title">
      <h3 id="context-compression-custom-title" className={css.customTitle}>{t('custom.title')}</h3>
      <p className={css.customNote}>{t('custom.sessionScope')}</p>
      <p className={css.customNote}>{t('custom.measurement')}</p>
      <label className={css.field}>
        <span>{t('custom.unit')}</span>
        <select
          value={value.unit}
          disabled={disabled}
          onChange={(event) => {
            setValue({
              ...value,
              unit: event.currentTarget.value as CustomCompressionPolicy['unit'],
            })
          }}
        >
          <option value="tokens">{t('custom.unit.tokens')}</option>
          <option value="context-percent">{t('custom.unit.contextPercent')}</option>
        </select>
      </label>
      <StageFields
        t={t}
        title={t('custom.fresh.enabled')}
        enabled={value.fresh.enabled}
        disabled={disabled}
        onEnabled={(enabled) => { setBudget('fresh', { enabled }) }}
        fields={[
          { label: t('custom.fresh.trigger'), value: value.fresh.trigger, set: (trigger) => { setBudget('fresh', { trigger }) }, ...unitBounds },
          { label: t('custom.fresh.target'), value: value.fresh.target, set: (target) => { setBudget('fresh', { target }) }, ...unitBounds },
        ]}
        step={unitStep}
      />
      <StageFields
        t={t}
        title={t('custom.aggregate.enabled')}
        enabled={value.aggregate.enabled}
        disabled={disabled}
        onEnabled={(enabled) => { setBudget('aggregate', { enabled }) }}
        fields={[
          { label: t('custom.aggregate.trigger'), value: value.aggregate.trigger, set: (trigger) => { setBudget('aggregate', { trigger }) }, ...unitBounds },
          { label: t('custom.aggregate.target'), value: value.aggregate.target, set: (target) => { setBudget('aggregate', { target }) }, ...unitBounds },
        ]}
        step={unitStep}
      />
      <StageFields
        t={t}
        title={t('custom.history.enabled')}
        enabled={value.history.enabled}
        disabled={disabled}
        onEnabled={(enabled) => { setHistory({ enabled }) }}
        fields={[
          { label: t('custom.history.trigger'), value: value.history.trigger, set: (trigger) => { setHistory({ trigger }) }, ...unitBounds },
          { label: t('custom.history.keepRecentToolCalls'), value: value.history.keepRecentToolCalls, set: (keepRecentToolCalls) => { setHistory({ keepRecentToolCalls }) }, integer: true, allowZero: true },
          { label: t('custom.history.keepRecentTokens'), value: value.history.keepRecentTokens, set: (keepRecentTokens) => { setHistory({ keepRecentTokens }) }, allowZero: true, ...unitBounds },
          { label: t('custom.history.minReclaim'), value: value.history.minReclaim, set: (minReclaim) => { setHistory({ minReclaim }) }, ...unitBounds },
        ]}
        step={unitStep}
        fieldsEnabled={value.history.enabled || value.tailTrim.enabled}
      />
      <label className={css.field}>
        <span>{t('custom.prefixPolicy')}</span>
        <select
          value={value.prefixPolicy}
          disabled={disabled || !value.history.enabled}
          onChange={(event) => {
            setValue({
              ...value,
              prefixPolicy: event.currentTarget.value as CustomCompressionPolicy['prefixPolicy'],
            })
          }}
        >
          <option value="preserve">{t('custom.prefixPolicy.preserve')}</option>
          <option value="pressure-break">{t('custom.prefixPolicy.pressureBreak')}</option>
        </select>
      </label>
      <div className={css.customNote}>{t('custom.experimental')}</div>
      <StageFields
        t={t}
        title={t('custom.tailTrim.enabled')}
        enabled={value.tailTrim.enabled}
        disabled={disabled}
        onEnabled={(enabled) => {
          setValue({ ...value, tailTrim: { ...value.tailTrim, enabled } })
        }}
        fields={[{
          label: t('custom.tailTrim.trigger'),
          value: value.tailTrim.trigger,
          set: (trigger) => {
            setValue({ ...value, tailTrim: { ...value.tailTrim, trigger } })
          },
          ...unitBounds,
        }]}
        step={unitStep}
      />
      <p className={css.customNote}>{t('custom.tailTrim.warning')}</p>
      {valid ? null : <div className={css.error} role="alert">{t('custom.invalid')}</div>}
      <div className={css.actions}>
        <button type="button" disabled={disabled || !valid} onClick={() => { settle(save) }}>{t('custom.save')}</button>
        <button type="button" disabled={disabled} onClick={() => { settle(reset) }}>{t('custom.reset')}</button>
      </div>
    </section>
  )
}

interface StageNumberField {
  label: string
  value: number
  set: (value: number) => void
  integer?: boolean
  allowZero?: boolean
  max?: number
}

function StageFields({ title, enabled, disabled, onEnabled, fields, step, fieldsEnabled = enabled, t }: {
  title: string
  enabled: boolean
  disabled: boolean
  onEnabled: (enabled: boolean) => void
  fields: readonly StageNumberField[]
  step: number
  fieldsEnabled?: boolean
  t: (key: ContextCompressionLocaleKey) => string
}) {
  return (
    <fieldset className={css.stage} disabled={disabled}>
      <legend>{title}</legend>
      <label className={css.field}>
        <span>{t('custom.enabled')}</span>
        <select aria-label={title} value={enabled ? 'on' : 'off'}
          onChange={(event) => { onEnabled(event.currentTarget.value === 'on') }}>
          <option value="on">{t('custom.enabled.on')}</option>
          <option value="off">{t('custom.enabled.off')}</option>
        </select>
      </label>
      <div className={css.fieldGrid}>
        {fields.map(field => (
          <label className={css.field} key={field.label}>
            <span>{field.label}</span>
            <input
              type="number"
              value={field.value}
              min={field.allowZero === true ? 0 : field.integer === true ? 1 : step}
              max={field.max}
              step={field.integer === true ? 1 : step}
              disabled={!fieldsEnabled || disabled}
              onChange={(event) => { field.set(Number(event.currentTarget.value)) }}
            />
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function editableCustom(value: CustomCompressionPolicy): CustomCompressionPolicyV3 {
  if (value.version === 3) return structuredClone(value)
  return {
    version: 3,
    unit: value.unit,
    fresh: structuredClone(value.fresh),
    aggregate: structuredClone(value.aggregate),
    history: {
      enabled: value.history.enabled,
      trigger: value.history.trigger,
      keepRecentToolCalls: 10,
      keepRecentTokens: value.history.keepRecent,
      minReclaim: value.history.minReclaim,
    },
    prefixPolicy: value.prefixPolicy,
    tailTrim: value.version === 1 ? { enabled: false, trigger: 700_000 } : structuredClone(value.tailTrim),
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'context-compression': ContextCompressionLocaleKey
  }
}
