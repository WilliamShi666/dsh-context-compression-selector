// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMPRESSION_PROFILES,
  ContextCompressionSettingsSection,
  CompressionProfileSelector,
  type CompressionProfile,
  type CompressionProfileSelectorProps,
  type ContextCompressionSettings,
} from '../src/client/CompressionProfileSelector.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

interface SettingsScopeSnapshot<T> {
  status: 'loading' | 'ready' | 'unavailable'
  value: T | undefined
  base: T | undefined
  user: T | undefined
  revision: number | undefined
  writable: boolean
  mode: 'host' | 'memory'
}

interface SnapshotStore<T> {
  readonly getSnapshot: () => T
  readonly subscribe: (listener: () => void) => () => void
  readonly update: (recipe: (draft: T) => void) => void
}

function createSnapshotStore<T>(initial: T): SnapshotStore<T> {
  let snapshot = structuredClone(initial)
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update(recipe) {
      const draft = structuredClone(snapshot)
      recipe(draft)
      snapshot = draft
      for (const listener of listeners) listener()
    },
  }
}

function bindSnapshotSelector<T>(store: SnapshotStore<T>) {
  return function useSnapshotSelector<U>(selector: (snapshot: T) => U): U {
    return useSyncExternalStore(
      store.subscribe,
      () => selector(store.getSnapshot()),
      () => selector(store.getSnapshot()),
    )
  }
}

const COPY: Record<string, string> = {
  nav: 'Context compression selector',
  'settings.title': 'Context compression selector',
  'settings.description': 'Choose the profile and configure its available parameters for the current session.',
  label: 'Context compression',
  'profile.off': 'Plugin off',
  'profile.native': 'Native baseline',
  'profile.balanced': 'Balanced',
  'profile.cache-strict': 'Cache Strict (prefix protection)',
  'profile.savings': 'Savings',
  'profile.adaptive': 'Adaptive (conservative cost)',
  'profile.custom': 'Custom / Experimental',
  'profile.current': 'Current profile',
  'detail.off': 'Disable deterministic compression',
  'detail.native': 'Use native pruning',
  'detail.balanced': 'Reduce tool results deterministically',
  'detail.cache-strict': 'Preserve sent history until confirmed capacity pressure',
  'detail.savings': 'Use smaller targets without promising lower cost per request',
  'detail.adaptive': 'Age history only when official usage and prices prove a clear saving',
  'detail.custom': 'Choose implemented stages and measured thresholds for new sessions',
  'custom.title': 'Custom policy',
  'custom.settingsHint': 'Edit detailed parameters in Settings > Context compression selector.',
  'custom.sessionScope': 'Saved changes apply when the current compression runtime next observes a Session for the first time. A Session already observed by that runtime keeps its frozen policy.',
  'custom.measurement': 'Exact DeepSeek tokenizer first; tokenizer estimate with calibration fallback. Never chars/4. Cache attribution remains unknown.',
  'custom.unit': 'Canonical unit',
  'custom.unit.tokens': 'Tokens',
  'custom.unit.contextPercent': 'Context percent',
  'custom.fresh.enabled': 'Enable Fresh',
  'custom.fresh.trigger': 'Fresh trigger',
  'custom.fresh.target': 'Fresh target',
  'custom.aggregate.enabled': 'Enable Aggregate',
  'custom.aggregate.trigger': 'Aggregate trigger',
  'custom.aggregate.target': 'Aggregate target',
  'custom.history.enabled': 'Enable History',
  'custom.history.trigger': 'History trigger',
  'custom.history.keepRecentToolCalls': 'Protected recent tool calls',
  'custom.history.keepRecentTokens': 'Protected recent tool-result tail',
  'custom.history.minReclaim': 'Minimum reclaim',
  'custom.prefixPolicy': 'Sent-prefix policy',
  'custom.prefixPolicy.preserve': 'Preserve until capacity pressure',
  'custom.prefixPolicy.pressureBreak': 'Allow routine history aging',
  'custom.experimental': 'Experimental: Custom-only controls',
  'custom.tailTrim.enabled': 'Enable TailTrim (experimental)',
  'custom.tailTrim.trigger': 'TailTrim trigger',
  'status.minimalUnavailable': 'Minimal mode does not load context compression for this session. The selector is effectively off and Harness native behavior remains. Switch to Standard, PTC / Coding, Creative, or a capable custom preset to configure it.',
  'custom.tailTrim.warning': 'TailTrim requires exact tokens and may reduce cache hits.',
  'custom.save': 'Save Custom policy',
  'custom.reset': 'Reset Custom policy',
  'custom.invalid': 'Custom policy values are invalid.',
  'status.presetUnavailable': 'This session’s preset does not provide context compression, or availability is not yet confirmed.',
  'pricing.disclosure': 'DeepSeek official prices checked 2026-08-25. Peak Mon–Fri 09:00–12:00 and 14:00–18:00 Asia/Shanghai; otherwise off-peak. Cross-boundary requests use a cost range.',
}

const DEFAULT_CUSTOM = {
  version: 1,
  unit: 'tokens',
  fresh: { enabled: true, trigger: 4_096, target: 2_048 },
  aggregate: { enabled: true, trigger: 16_384, target: 8_192 },
  history: {
    enabled: true,
    trigger: 32_768,
    keepRecentTurns: 2,
    keepRecent: 16_384,
    minReclaim: 8_192,
  },
  prefixPolicy: 'pressure-break',
} as const satisfies ContextCompressionSettings['custom']

function renderReady(
  select: (profile: CompressionProfile) => Promise<void>,
  contextCompressionAvailable: boolean | undefined,
  t: (key: string) => string,
  options: {
    value?: ContextCompressionSettings
    saveCustom?: (value: ContextCompressionSettings['custom']) => Promise<void>
    resetCustom?: () => Promise<void>
    agentPreset?: string
    settingsSection?: boolean
  } = {},
) {
  const state = createSnapshotStore<SettingsScopeSnapshot<ContextCompressionSettings>>({
    status: 'ready',
    value: options.value ?? {
      profile: 'native',
      custom: structuredClone(DEFAULT_CUSTOM),
      autoCompact: { thresholdPercent: 80 },
    },
    base: undefined,
    user: undefined,
    revision: 0,
    writable: true,
    mode: 'host',
  })
  const sessions = createSnapshotStore({
    ids: ['s1'],
    byId: {
      s1: {
        id: 's1', displayTitle: 's1', running: false, blank: true, updatedAt: 0,
        agentPreset: options.agentPreset ?? 'standard',
        ...(contextCompressionAvailable === undefined ? {} : { contextCompressionAvailable }),
      },
    },
    current: 's1',
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  })
  const Component = options.settingsSection === true ? ContextCompressionSettingsSection : CompressionProfileSelector
  render(<Component {...({
    useCompression: bindSnapshotSelector(state),
    useSessions: bindSnapshotSelector(sessions),
    select,
    saveCustom: options.saveCustom ?? (() => Promise.resolve()),
    resetCustom: options.resetCustom ?? (() => Promise.resolve()),
    t,
  } as unknown as CompressionProfileSelectorProps)} />)
  return { state, sessions }
}

function mount(
  select: (profile: CompressionProfile) => Promise<void>,
  ...availability: [] | [boolean | undefined]
) {
  const contextCompressionAvailable = availability.length === 0 ? true : availability[0]
  return renderReady(select, contextCompressionAvailable, key => COPY[key] ?? key)
}

function chooseOff(): void {
  fireEvent.click(screen.getByRole('button', { name: /Native baseline/ }))
  fireEvent.click(screen.getByRole('menuitem', { name: /Plugin off/ }))
}

describe('context compression profiles', () => {
  it('exposes Custom after the six established profiles', () => {
    expect(COMPRESSION_PROFILES).toEqual([
      'off', 'native', 'balanced', 'cache-strict', 'savings', 'adaptive', 'custom',
    ])
  })

  it('renders no selector when Host settings are unavailable', () => {
    const state = createSnapshotStore<SettingsScopeSnapshot<ContextCompressionSettings>>({
      status: 'unavailable',
      value: undefined,
      base: undefined,
      user: undefined,
      revision: undefined,
      writable: false,
      mode: 'memory',
    })
    const sessions = createSnapshotStore({
      ids: [], byId: {}, current: undefined, phase: 'ready',
      subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
    })
    render(<CompressionProfileSelector {...({
      useCompression: bindSnapshotSelector(state),
      useSessions: bindSnapshotSelector(sessions),
      select: vi.fn(() => Promise.resolve()),
      t: (key: string) => COPY[key] ?? key,
    } as unknown as CompressionProfileSelectorProps)} />)

    expect(screen.queryByRole('button', { name: /Context compression/ })).toBeNull()
  })

  it('keeps all seven profiles selectable for a capable official or custom preset', () => {
    mount(vi.fn(() => Promise.resolve()), true)

    const button = screen.getByRole('button', { name: /Context compression/ })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button)
    expect(screen.getAllByRole('menuitem')).toHaveLength(7)
  })

  it.each([false, undefined])(
    'remains selectable before capability refresh %s when the initial preset is not Minimal',
    (available) => {
      const { state } = mount(vi.fn(() => Promise.resolve()), available)

      expect(screen.getByRole<HTMLButtonElement>('button', { name: /Context compression/ }).disabled).toBe(false)
      expect(screen.queryByRole('status')).toBeNull()
      expect(state.getSnapshot().value?.profile).toBe('native')
    },
  )

  it('explains that Minimal keeps the selector effectively off without overwriting the saved profile', () => {
    const { state } = renderReady(
      vi.fn(() => Promise.resolve()), false, key => COPY[key] ?? key,
      { agentPreset: 'minimal' },
    )

    expect(screen.getByText(/Minimal mode does not load context compression.*effectively off.*native behavior remains/)).not.toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Context compression/ }).disabled).toBe(true)
    expect(state.getSnapshot().value?.profile).toBe('native')
  })

  it('renders the full selector as its own Settings section', () => {
    renderReady(
      vi.fn(() => Promise.resolve()), true, key => COPY[key] ?? key,
      { settingsSection: true },
    )

    expect(screen.getByRole('heading', { name: 'Context compression selector' })).not.toBeNull()
    expect(screen.getByText(/Choose the profile and configure its available parameters/)).not.toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Native baseline.*Current profile/ }).disabled).toBe(false)
    expect(screen.getByRole('button', { name: /Balanced.*Reduce tool results deterministically/ })).not.toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('does not require a preset switch when capability refresh is delayed', async () => {
    const { sessions } = mount(vi.fn(() => Promise.resolve()), true)
    fireEvent.click(screen.getByRole('button', { name: /Context compression/ }))
    expect(screen.getAllByRole('menuitem')).toHaveLength(7)

    sessions.update((draft) => {
      const current = draft.byId.s1
      if (current !== undefined) current.contextCompressionAvailable = false
    })

    await waitFor(() => { expect(screen.getAllByRole('menuitem')).toHaveLength(7) })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Context compression/ }).disabled).toBe(false)
  })

  it('persists a selected profile', async () => {
    const select = vi.fn(() => Promise.resolve())
    mount(select)

    chooseOff()

    await waitFor(() => { expect(select).toHaveBeenCalledWith('off') })
  })

  it('persists Cache Strict and exposes its prefix-protection wording', async () => {
    const select = vi.fn(() => Promise.resolve())
    mount(select)

    fireEvent.click(screen.getByRole('button', { name: /Native baseline/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Cache Strict/ }))

    await waitFor(() => { expect(select).toHaveBeenCalledWith('cache-strict') })
  })

  it('persists Adaptive and exposes its conservative official-cost wording', async () => {
    const select = vi.fn(() => Promise.resolve())
    mount(select)

    fireEvent.click(screen.getByRole('button', { name: /Native baseline/ }))
    expect(screen.getByRole('menuitem', {
      name: /Adaptive \(conservative cost\).*official usage and prices prove a clear saving/,
    })).not.toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: /Adaptive \(conservative cost\)/ }))

    await waitFor(() => { expect(select).toHaveBeenCalledWith('adaptive') })
  })

  it('edits only the implemented Custom stages and saves one canonical document', async () => {
    const custom = {
      version: 1 as const,
      unit: 'tokens' as const,
      fresh: { enabled: true, trigger: 4_096, target: 2_048 },
      aggregate: { enabled: true, trigger: 16_384, target: 8_192 },
      history: {
        enabled: true, trigger: 32_768, keepRecentTurns: 2,
        keepRecent: 16_384, minReclaim: 8_192,
      },
      prefixPolicy: 'pressure-break' as const,
    }
    const saveCustom = vi.fn(() => Promise.resolve())
    const resetCustom = vi.fn(() => Promise.resolve())
    renderReady(vi.fn(() => Promise.resolve()), true, key => COPY[key] ?? key, {
      value: { profile: 'custom', custom, autoCompact: { thresholdPercent: 80 } },
      saveCustom,
      resetCustom,
      settingsSection: true,
    })

    expect(screen.getByText('Saved changes apply when the current compression runtime next observes a Session for the first time. A Session already observed by that runtime keeps its frozen policy.')).not.toBeNull()
    expect(screen.getByText(/Exact DeepSeek tokenizer first.*Never chars\/4.*Cache attribution remains unknown/)).not.toBeNull()
    expect(screen.getByLabelText<HTMLSelectElement>('Enable TailTrim (experimental)').value).toBe('off')
    expect(screen.getByLabelText<HTMLInputElement>('TailTrim trigger').value).toBe('700000')
    expect(screen.getByText(/TailTrim requires exact tokens.*cache hits/)).not.toBeNull()
    fireEvent.change(screen.getByLabelText('Fresh trigger'), { target: { value: '8192' } })
    fireEvent.change(screen.getByLabelText('Fresh target'), { target: { value: '4096' } })
    fireEvent.change(screen.getByLabelText('Enable TailTrim (experimental)'), { target: { value: 'on' } })
    fireEvent.change(screen.getByLabelText('TailTrim trigger'), { target: { value: '49152' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Custom policy' }))
    await waitFor(() => {
      expect(saveCustom).toHaveBeenCalledWith(expect.objectContaining({
        version: 3,
        unit: 'tokens',
        fresh: { enabled: true, trigger: 8_192, target: 4_096 },
        tailTrim: { enabled: true, trigger: 49_152 },
      }))
    })

    fireEvent.click(screen.getByRole('button', { name: 'Reset Custom policy' }))
    await waitFor(() => { expect(resetCustom).toHaveBeenCalledOnce() })
  })

  it('applies percent bounds only to measured windows and keeps tool-call counts unbounded', () => {
    renderReady(vi.fn(() => Promise.resolve()), true, key => COPY[key] ?? key, {
      value: {
        profile: 'custom',
        autoCompact: { thresholdPercent: 80 },
        custom: {
          version: 1,
          unit: 'context-percent',
          fresh: { enabled: true, trigger: 8, target: 4 },
          aggregate: { enabled: true, trigger: 24, target: 12 },
          history: {
            enabled: true,
            trigger: 60,
            keepRecentTurns: 256,
            keepRecent: 30,
            minReclaim: 10,
          },
          prefixPolicy: 'pressure-break',
        },
      },
      settingsSection: true,
    })

    expect(screen.getByLabelText<HTMLInputElement>('Fresh trigger').min).toBe('0.01')
    expect(screen.getByLabelText<HTMLInputElement>('Fresh trigger').max).toBe('100')
    expect(screen.getByLabelText<HTMLInputElement>('Protected recent tool calls').min).toBe('0')
    expect(screen.getByLabelText<HTMLInputElement>('Protected recent tool calls').max).toBe('')
    expect(screen.getByLabelText<HTMLInputElement>('Protected recent tool calls').step).toBe('1')
  })

  it.each([
    ['English', en, /checked 2026-08-25.*Mon–Fri 09:00–12:00.*14:00–18:00.*Asia\/Shanghai.*cost range/],
    ['Simplified Chinese', zh, /2026-08-25.*Asia\/Shanghai.*周一至周五 09:00–12:00.*14:00–18:00.*成本区间/],
  ] as const)('renders the Adaptive price date and schedule in %s', (_label, locale, expected) => {
    const copy = locale as Readonly<Record<string, string>>
    renderReady(vi.fn(() => Promise.resolve()), true, key => copy[key] ?? key)

    expect(screen.getByText(expected)).not.toBeNull()
  })

  it('states the mounted-runtime first-observation scope in both locales', () => {
    expect(en['custom.sessionScope']).toBe(
      'Saved changes apply when the current compression runtime next observes a Session for the first time. A Session already observed by that runtime keeps its frozen policy.',
    )
    expect(zh['custom.sessionScope']).toBe(
      '保存后的修改会在当前压缩运行时随后首次观察某个 Session 时生效；已被该运行时观察的 Session 继续使用其冻结策略。',
    )
  })

  it('keeps Custom parameters out of the compact sidebar surface', () => {
    renderReady(vi.fn(() => Promise.resolve()), true, key => COPY[key] ?? key, {
      value: { profile: 'custom', custom: structuredClone(DEFAULT_CUSTOM), autoCompact: { thresholdPercent: 80 } },
    })

    expect(screen.queryByRole('heading', { name: 'Custom policy' })).toBeNull()
    expect(screen.getByText('Edit detailed parameters in Settings > Context compression selector.')).not.toBeNull()
  })

  it('shows a rejected save to the user', async () => {
    const rejected = Promise.reject(new Error('settings write failed'))
    // Mark the fixture promise handled so only the component's visible-error
    // contract determines this assertion; an implementation that ignores the
    // returned promise still fails because it renders no alert.
    void rejected.catch(() => {})
    mount(vi.fn(() => rejected))

    chooseOff()

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).not.toBe('')
    })
  })
})
