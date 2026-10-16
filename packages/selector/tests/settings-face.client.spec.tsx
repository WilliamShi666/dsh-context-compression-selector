// @vitest-environment jsdom

/**
 * Regression coverage for the settings-face snapshot contract.
 *
 * `useSyncExternalStore` compares consecutive `getSnapshot()` results by
 * reference and re-renders until they stop differing. An adapter that composes
 * a fresh object on every read therefore never settles: React aborts with
 * "Maximum update depth exceeded" and the Harness reports
 * `slot entry crashed in 'settings.section'`.
 *
 * That is exactly how 0.2.0 behaved on the live profile — the navigation entry
 * appeared, because the slot registered, but the panel body was blank. Both
 * halves are pinned below: the adapter's reference stability, and the section
 * component mounting through the same `useSyncExternalStore` path the slot
 * framework uses.
 */

import { render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ContextCompressionSettingsSection,
  type CompressionProfileSelectorProps,
  type ContextCompressionSettings,
} from '../src/client/CompressionProfileSelector.tsx'
import {
  settingsFaceFromConfigForm,
  type ConfigFormFace,
  type SettingsSnapshot,
  type VolatileProjection,
} from '../src/client/settings-face.ts'
import { en } from '../src/client/locales.ts'

afterEach(() => { vi.restoreAllMocks() })

/** Bind one store to the `useSyncExternalStore` selector-hook shape. */
function bindSnapshotSelector<T>(store: {
  getSnapshot: () => T
  subscribe: (listener: () => void) => () => void
}) {
  return function useSnapshotSelector<U>(selector: (snapshot: T) => U): U {
    return useSyncExternalStore(
      store.subscribe,
      () => selector(store.getSnapshot()),
      () => selector(store.getSnapshot()),
    )
  }
}

/**
 * A stand-in 0.2.0 configuration form. Its snapshot reference is stable between
 * changes, which is the contract the Harness store satisfies
 * (`getSnapshot() { return this.store.getSnapshot() }`).
 */
function createConfigForm(initial: VolatileProjection) {
  let snapshot: SettingsSnapshot<VolatileProjection> = {
    status: 'ready',
    value: structuredClone(initial),
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host',
  }
  const listeners = new Set<() => void>()
  return {
    form: {
      getSnapshot: () => snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set: async () => true,
    } satisfies ConfigFormFace<VolatileProjection>,
    update(next: VolatileProjection) {
      snapshot = { ...snapshot, value: structuredClone(next), revision: (snapshot.revision ?? 0) + 1 }
      for (const listener of listeners) listener()
    },
  }
}

describe('settings-face snapshot stability', () => {
  it('returns an identical reference while the underlying form is unchanged', () => {
    const { form } = createConfigForm({ profile: 'balanced', autoCompactThresholdPercent: 80 })
    const face = settingsFaceFromConfigForm(form)

    const first = face.getSnapshot()
    // React reads the snapshot more than once per commit; each read before a
    // change must be the same object or the store never settles.
    expect(face.getSnapshot()).toBe(first)
    expect(face.getSnapshot()).toBe(first)
  })

  it('recomposes only after the form publishes a new snapshot', () => {
    const { form, update } = createConfigForm({ profile: 'balanced' })
    const face = settingsFaceFromConfigForm(form)

    const before = face.getSnapshot()
    expect(before.value?.profile).toBe('balanced')

    update({ profile: 'savings' })

    const after = face.getSnapshot()
    expect(after).not.toBe(before)
    expect(after.value?.profile).toBe('savings')
    // ...and is stable again on the new value.
    expect(face.getSnapshot()).toBe(after)
  })
})

describe('0.2.0 settings section mounts through useSyncExternalStore', () => {
  it('renders instead of looping', () => {
    const { form } = createConfigForm({ profile: 'balanced', autoCompactThresholdPercent: 80 })
    const face = settingsFaceFromConfigForm(form)
    const sessions = {
      getSnapshot: () => ({ current: undefined, byId: {} }),
      subscribe: () => () => {},
    }

    // A non-memoized adapter loops here and React throws rather than drawing.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => render(
      <ContextCompressionSettingsSection {...({
        useCompression: bindSnapshotSelector(face),
        useSessions: bindSnapshotSelector(sessions),
        customEditable: false,
        select: vi.fn(() => Promise.resolve()),
        saveCustom: vi.fn(() => Promise.resolve()),
        resetCustom: vi.fn(() => Promise.resolve()),
        saveAutoCompact: vi.fn(() => Promise.resolve()),
        t: (key: string) => en[key as keyof typeof en] ?? key,
      } as unknown as CompressionProfileSelectorProps)} />,
    )).not.toThrow()

    expect(screen.getByText(en['settings.title'])).toBeDefined()
    expect(error).not.toHaveBeenCalled()
  })
})
