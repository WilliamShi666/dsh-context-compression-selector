import { describe, expect, it, vi } from 'vitest'
import type { ClientContext, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import {
  DEFAULT_CUSTOM_COMPRESSION_POLICY,
  isCustomCompressionPolicy,
} from '../src/profiles.ts'
import { apply } from '../src/client/index.ts'
import type {
  CompressionSelectorInjected,
  ContextCompressionSettings,
} from '../src/client/CompressionProfileSelector.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutline14: () => null,
  Menu: () => null,
}))

const CUSTOM = {
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

describe('context compression browser contract', () => {
  it('accepts legacy v1 and defaults new edits to v2 with TailTrim disabled', () => {
    expect(isCustomCompressionPolicy(CUSTOM)).toBe(true)
    expect(DEFAULT_CUSTOM_COMPRESSION_POLICY).toMatchObject({
      version: 2,
      tailTrim: { enabled: false, trigger: 700_000 },
    })
    expect(isCustomCompressionPolicy(DEFAULT_CUSTOM_COMPRESSION_POLICY)).toBe(true)
  })

  it('fails the browser narrowing for unknown or invalid Custom fields', () => {
    expect(isCustomCompressionPolicy({
      ...structuredClone(CUSTOM),
      tailTrim: { enabled: true },
    })).toBe(false)
    expect(isCustomCompressionPolicy({
      ...structuredClone(CUSTOM),
      fresh: { enabled: true, trigger: 100, target: 100 },
    })).toBe(false)
    for (const trigger of [0, -1]) {
      expect(isCustomCompressionPolicy({
        ...structuredClone(DEFAULT_CUSTOM_COMPRESSION_POLICY),
        tailTrim: { enabled: true, trigger },
      })).toBe(false)
    }
    expect(isCustomCompressionPolicy({
      ...structuredClone(DEFAULT_CUSTOM_COMPRESSION_POLICY),
      unit: 'context-percent',
      tailTrim: { enabled: true, trigger: 101 },
    })).toBe(false)
  })

  it('reports a recovered no-op write only on the selector boundary', async () => {
    let revision = 7
    let commit = false
    let rewriteCustom = false
    let rewriteReset = false
    let dropTailTrim = false
    let downgradeVersion = false
    let value: ContextCompressionSettings = {
      profile: 'balanced',
      custom: structuredClone(CUSTOM),
    }
    const snapshot = (): SettingsScopeSnapshot<ContextCompressionSettings> => ({
      status: 'ready',
      value,
      base: undefined,
      user: undefined,
      revision,
      writable: true,
      mode: 'host',
    })
    const scope = {
      getSnapshot: snapshot,
      subscribe: vi.fn(() => () => {}),
      set: vi.fn(async (field: string, next: unknown) => {
        if (!commit) return
        revision += 1
        if (field === 'custom' && rewriteCustom) {
          const accepted = structuredClone(next as ContextCompressionSettings['custom'])
          accepted.fresh.trigger += 1
          value = { ...value, custom: accepted }
          return
        }
        if (field === 'custom' && dropTailTrim) {
          const accepted = structuredClone(next as ContextCompressionSettings['custom'])
          if (accepted.version === 2) {
            accepted.tailTrim = { enabled: false, trigger: 700_000 }
          }
          value = { ...value, custom: accepted }
          return
        }
        if (field === 'custom' && downgradeVersion) {
          value = { ...value, custom: structuredClone(CUSTOM) }
          return
        }
        value = { ...value, [field]: next }
      }),
      unset: vi.fn(async () => {
        if (!commit) return
        revision += 1
        const custom: ContextCompressionSettings['custom'] = structuredClone(CUSTOM)
        if (rewriteReset) {
          custom.fresh.trigger = 8_192
          custom.fresh.target = 4_096
        }
        value = { ...value, custom }
      }),
    }
    let injected: (() => CompressionSelectorInjected) | undefined
    const ctx = {
      effect: (install: () => unknown) => { install() },
      locale: { register: vi.fn(() => () => {}) },
      settingsScope: { bind: vi.fn(() => scope) },
      slots: {
        inject: (_slot: string, install: () => unknown) => { install() },
        register: (registration: { inject: () => CompressionSelectorInjected }) => {
          injected = registration.inject
          return () => {}
        },
      },
    } as unknown as ClientContext

    apply(ctx)
    const actions = injected?.()
    expect(actions).toBeDefined()
    if (actions === undefined) throw new Error('selector injection was not registered')
    await expect(actions.select('native')).rejects.toThrow('were not saved')

    commit = true
    await expect(actions.select('native')).resolves.toBeUndefined()
    expect(value.profile).toBe('native')

    const requested: ContextCompressionSettings['custom'] = structuredClone(CUSTOM)
    requested.fresh.trigger = 8_192
    requested.fresh.target = 4_096
    rewriteCustom = true
    await expect(actions.saveCustom(requested)).rejects.toThrow('were not saved')

    rewriteCustom = false
    const requestedV2 = structuredClone(DEFAULT_CUSTOM_COMPRESSION_POLICY)
    if (requestedV2.version !== 2) throw new Error('Custom TailTrim persistence fixture requires policy v2')
    requestedV2.tailTrim = { enabled: true, trigger: 49_152 }
    dropTailTrim = true
    await expect(actions.saveCustom(requestedV2)).rejects.toThrow('were not saved')

    dropTailTrim = false
    downgradeVersion = true
    await expect(actions.saveCustom(requestedV2)).rejects.toThrow('were not saved')

    downgradeVersion = false
    rewriteReset = true
    await expect(actions.resetCustom()).rejects.toThrow('were not saved')
  })
})
