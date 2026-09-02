// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CompressionProfileSelector,
  ContextCompressionSettingsSection,
  type CompressionProfile,
  type CompressionProfileSelectorProps,
  type ContextCompressionSettings,
} from '../src/client/CompressionProfileSelector.tsx'
import { en } from '../src/client/locales.ts'

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

const t = (key: string) => en[key as keyof typeof en] ?? key

interface MountOptions {
  readonly value?: ContextCompressionSettings
  readonly saveAutoCompact?: (thresholdPercent: number) => Promise<void>
  readonly settingsSection?: boolean
  readonly writable?: boolean
  readonly status?: 'loading' | 'ready'
}

function mountAutoCompact(options: MountOptions = {}) {
  const state = createSnapshotStore<SettingsScopeSnapshot<ContextCompressionSettings>>({
    status: options.status ?? 'ready',
    value: options.value ?? {
      profile: 'balanced',
      custom: structuredClone(DEFAULT_CUSTOM),
      autoCompact: { thresholdPercent: 80 },
    },
    base: undefined,
    user: undefined,
    revision: 0,
    writable: options.writable ?? true,
    mode: 'host',
  })
  const sessions = createSnapshotStore({
    ids: ['s1'],
    byId: { s1: { id: 's1', displayTitle: 's1', running: false, blank: true, updatedAt: 0, agentPreset: 'standard' } },
    current: 's1',
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  })
  const saveAutoCompact = options.saveAutoCompact ?? vi.fn(() => Promise.resolve())
  const Component = options.settingsSection === false ? CompressionProfileSelector : ContextCompressionSettingsSection
  render(<Component {...({
    useCompression: bindSnapshotSelector(state),
    useSessions: bindSnapshotSelector(sessions),
    select: vi.fn(() => Promise.resolve()),
    saveCustom: vi.fn(() => Promise.resolve()),
    resetCustom: vi.fn(() => Promise.resolve()),
    saveAutoCompact,
    t,
  } as unknown as CompressionProfileSelectorProps)} />)
  return { state, saveAutoCompact }
}

const INPUT_LABEL = 'Auto Compact threshold (%)'

describe('Auto Compact threshold controls', () => {
  it('renders the editor only inside the context-compression settings section', () => {
    mountAutoCompact({ settingsSection: true })
    expect(screen.getByLabelText(INPUT_LABEL)).not.toBeNull()
    expect(screen.queryByRole('slider')).toBeNull()
    for (const quick of ['70%', '80%', '85%']) expect(screen.queryByRole('button', { name: quick })).toBeNull()

    // The compact workspace selector shows a summary, never a second editor.
    cleanup()
    mountAutoCompact({ settingsSection: false })
    expect(screen.queryByLabelText(INPUT_LABEL)).toBeNull()
    expect(screen.queryByRole('slider')).toBeNull()
    expect(screen.getByText(/Auto Compact threshold: 80%/)).not.toBeNull()
  })

  it('saves a non-quick value like 73 and reads the same value back after remount', async () => {
    let store: ReturnType<typeof mountAutoCompact>['state'] | undefined
    const saving = vi.fn((thresholdPercent: number): Promise<void> => {
      store?.update(draft => {
        if (draft.value !== undefined) draft.value.autoCompact = { thresholdPercent }
      })
      return Promise.resolve()
    })
    const mounted = mountAutoCompact({ settingsSection: true, saveAutoCompact: saving })
    store = mounted.state
    fireEvent.change(screen.getByLabelText(INPUT_LABEL), { target: { value: '73' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Auto Compact threshold' }))
    await waitFor(() => { expect(mounted.state.getSnapshot().value?.autoCompact).toEqual({ thresholdPercent: 73 }) })

    // A fresh mount reads the same persisted settings.
    cleanup()
    mountAutoCompact({
      settingsSection: true,
      value: { profile: 'balanced', custom: structuredClone(DEFAULT_CUSTOM), autoCompact: { thresholdPercent: 73 } },
    })
    expect(screen.getByLabelText<HTMLInputElement>(INPUT_LABEL).value).toBe('73')
  })

  it.each(['49', '91', '72.5', 'abc', ''])('blocks saving the invalid draft %s', (draft) => {
    const { saveAutoCompact } = mountAutoCompact({ settingsSection: true })
    fireEvent.change(screen.getByLabelText(INPUT_LABEL), { target: { value: draft } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save Auto Compact threshold' }).disabled).toBe(true)
    expect(screen.getByText(/must be an integer between 50 and 90/)).not.toBeNull()
    expect(saveAutoCompact).not.toHaveBeenCalled()
  })

  it('uses the typed number input as the only threshold editor', () => {
    mountAutoCompact({ settingsSection: true })
    const input = screen.getByLabelText<HTMLInputElement>(INPUT_LABEL)
    fireEvent.change(input, { target: { value: '73' } })
    expect(input.value).toBe('73')
    expect(screen.queryByRole('slider')).toBeNull()
    for (const quick of ['70%', '80%', '85%']) expect(screen.queryByRole('button', { name: quick })).toBeNull()
  })

  it('explains the risk outside the recommended 70–85 band but keeps saving available', () => {
    mountAutoCompact({ settingsSection: true })
    fireEvent.change(screen.getByLabelText(INPUT_LABEL), { target: { value: '65' } })
    expect(screen.getByText(/summarization calls and prefix rebuilds/)).not.toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save Auto Compact threshold' }).disabled).toBe(false)

    fireEvent.change(screen.getByLabelText(INPUT_LABEL), { target: { value: '90' } })
    expect(screen.getByText(/shared by requests and output/)).not.toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save Auto Compact threshold' }).disabled).toBe(false)

    fireEvent.change(screen.getByLabelText(INPUT_LABEL), { target: { value: '80' } })
    expect(screen.queryByText(/summarization calls and prefix rebuilds/)).toBeNull()
    expect(screen.queryByText(/shared by requests and output/)).toBeNull()
  })

  it('disables every control while saving or when the scope is not writable', () => {
    const { saveAutoCompact } = mountAutoCompact({ settingsSection: true, status: 'loading' })
    expect(screen.getByLabelText<HTMLInputElement>(INPUT_LABEL).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save Auto Compact threshold' }).disabled).toBe(true)
    expect(saveAutoCompact).not.toHaveBeenCalled()

    cleanup()
    mountAutoCompact({ settingsSection: true, writable: false })
    expect(screen.getByLabelText<HTMLInputElement>(INPUT_LABEL).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save Auto Compact threshold' }).disabled).toBe(true)
  })

  it('shows a failed threshold save inline', async () => {
    const rejected = Promise.reject(new Error('threshold write failed'))
    void rejected.catch(() => {})
    mountAutoCompact({ settingsSection: true, saveAutoCompact: () => rejected })
    fireEvent.change(screen.getByLabelText(INPUT_LABEL), { target: { value: '73' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save Auto Compact threshold' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toContain('threshold write failed') })
  })
})
