/** Auto Compact threshold settings schema and History linkage formula. */

import { describe, expect, it } from 'vitest'
import {
  AUTO_COMPACT_THRESHOLD_LIMITS,
  ContextCompressionSettingsSchema,
  DEFAULT_CUSTOM_COMPRESSION_POLICY,
  isValidAutoCompactThresholdPercent,
  parseContextCompressionSettings,
  resolveConfig,
  resolvePolicy,
} from '../src/index.ts'
import {
  AUTO_COMPACT_THRESHOLD_LIMITS as BROWSER_LIMITS,
  decodeAutoCompactSettings as browserDecodeAutoCompact,
  isValidAutoCompactThresholdPercent as browserIsValid,
} from '../../selector/src/profiles.ts'
import { decodeSettings as browserDecodeSettings } from '../../selector/src/client/decode.ts'

const BASE_SETTINGS = {
  profile: 'balanced' as const,
  custom: structuredClone(DEFAULT_CUSTOM_COMPRESSION_POLICY),
}

describe('autoCompact settings validation', () => {
  it('defaults legacy settings without an autoCompact section to 80%', () => {
    const settings = parseContextCompressionSettings(structuredClone(BASE_SETTINGS))
    expect(settings.autoCompact).toEqual({ thresholdPercent: 80 })
  })

  it('accepts any integer threshold from 50 through 90, including non-quick values', () => {
    for (const thresholdPercent of [50, 69, 70, 73, 80, 82, 85, 90]) {
      const settings = parseContextCompressionSettings({
        ...structuredClone(BASE_SETTINGS),
        autoCompact: { thresholdPercent },
      } as never)
      expect(settings.autoCompact.thresholdPercent).toBe(thresholdPercent)
    }
  })

  it.each([
    49, 91, 0, -1, 100, 72.5, 80.5, Number.NaN, Number.POSITIVE_INFINITY,
  ])('rejects the out-of-range or fractional value %s', (thresholdPercent) => {
    expect(() => parseContextCompressionSettings({
      ...structuredClone(BASE_SETTINGS),
      autoCompact: { thresholdPercent },
    })).toThrow()
    expect(isValidAutoCompactThresholdPercent(thresholdPercent)).toBe(false)
  })

  it('rejects malformed autoCompact sections and unknown keys', () => {
    for (const autoCompact of [
      { thresholdPercent: '80' },
      { thresholdPercent: null },
      {},
      { thresholdPercent: 80, extra: true },
      null,
    ]) {
      expect(() => parseContextCompressionSettings({
        ...structuredClone(BASE_SETTINGS),
        autoCompact,
      })).toThrow()
    }
    expect(() => parseContextCompressionSettings({
      ...structuredClone(BASE_SETTINGS),
      autoCompact: { thresholdPercent: 80 },
      unrelated: true,
    } as never)).toThrow(/unknown key/u)
  })

  it('publishes one shared validation contract for UI, persistence, and runtime', () => {
    expect(AUTO_COMPACT_THRESHOLD_LIMITS).toEqual({
      min: 50,
      max: 90,
      step: 1,
      default: 80,
    })
    expect(isValidAutoCompactThresholdPercent(73)).toBe(true)
    expect(isValidAutoCompactThresholdPercent(80)).toBe(true)
    expect(isValidAutoCompactThresholdPercent('73')).toBe(false)
    expect(isValidAutoCompactThresholdPercent(undefined)).toBe(false)
  })

  it('keeps the browser-safe mirror of the contract identical to the runtime contract', () => {
    expect(BROWSER_LIMITS).toEqual(AUTO_COMPACT_THRESHOLD_LIMITS)
    for (const value of [50, 73, 80, 90, 49, 91, 72.5, '73', null]) {
      expect(browserIsValid(value)).toBe(isValidAutoCompactThresholdPercent(value))
    }
  })

  it('keeps the full settings document browser/runtime parity', () => {
    const documents = [
      ['legacy without autoCompact', { profile: 'off', custom: structuredClone(BASE_SETTINGS.custom) }],
      ['complete document', {
        profile: 'off',
        custom: structuredClone(BASE_SETTINGS.custom),
        autoCompact: { thresholdPercent: 73 },
      }],
      ['top-level unknown key', {
        profile: 'off',
        custom: structuredClone(BASE_SETTINGS.custom),
        autoCompact: { thresholdPercent: 80 },
        unrelated: true,
      }],
      ['null document', null],
      ['array document', [{ profile: 'off' }]],
      ['primitive document', 42],
      ['empty object', {}],
      ['missing profile', { custom: structuredClone(BASE_SETTINGS.custom) }],
      ['invalid profile', { profile: 'turbo', custom: structuredClone(BASE_SETTINGS.custom) }],
      ['missing custom', { profile: 'off' }],
      ['malformed autoCompact', {
        profile: 'off',
        custom: structuredClone(BASE_SETTINGS.custom),
        autoCompact: { thresholdPercent: '80' },
      }],
      ['null profile', { profile: null, custom: structuredClone(BASE_SETTINGS.custom) }],
      ['null custom', { profile: 'off', custom: null }],
      ['both sections null', { profile: null, custom: null }],
      ['own-property undefined profile', { profile: undefined, custom: structuredClone(BASE_SETTINGS.custom) }],
      ['own-property undefined custom', { profile: 'off', custom: undefined }],
      ['profile off plus malformed autoCompact', {
        profile: 'off',
        custom: structuredClone(BASE_SETTINGS.custom),
        autoCompact: { thresholdPercent: 400 },
      }],
      ['custom with wrong version', { profile: 'off', custom: { ...structuredClone(BASE_SETTINGS.custom), version: 99 } }],
    ] as const
    for (const [label, document] of documents) {
      const runtimeAccepts = (() => {
        try {
          parseContextCompressionSettings(structuredClone(document))
          return true
        } catch {
          return false
        }
      })()
      const browserDecoded = browserDecodeSettings(structuredClone(document))
      expect(browserDecoded !== undefined, label).toBe(runtimeAccepts)
      // When both accept, the decoded values must agree on the COMPLETE
      // canonical document — profile, custom, and autoCompact alike.
      if (runtimeAccepts && browserDecoded !== undefined) {
        const runtimeDecoded = parseContextCompressionSettings(structuredClone(document))
        expect(browserDecoded, label).toEqual(runtimeDecoded)
      }
    }
  })

  it('enforces the same plain-record boundary without erasing prototypes', () => {
    class SettingsDocument {
      profile = 'off' as const
      custom = structuredClone(BASE_SETTINGS.custom)
      autoCompact = { thresholdPercent: 73 }
    }

    class AutoCompactDocument {
      thresholdPercent = 73
    }

    const customPrototypeDocument = (): Record<string, unknown> => {
      const custom = structuredClone(BASE_SETTINGS.custom) as unknown as Record<string, unknown>
      Object.setPrototypeOf(custom, { inheritedMarker: true })
      return {
        profile: 'off',
        custom,
        autoCompact: { thresholdPercent: 73 },
      }
    }

    const invalidFactories: ReadonlyArray<readonly [string, () => unknown]> = [
      ['Date top-level document', () => new Date(0)],
      ['class top-level document', () => new SettingsDocument()],
      ['class autoCompact section', () => ({
        ...structuredClone(BASE_SETTINGS),
        autoCompact: new AutoCompactDocument(),
      })],
      ['custom-prototype Custom section', customPrototypeDocument],
    ]

    for (const [label, createDocument] of invalidFactories) {
      expect(() => ContextCompressionSettingsSchema(createDocument() as never), `host: ${label}`).toThrow()
      expect(() => parseContextCompressionSettings(createDocument()), `runtime: ${label}`).toThrow()
      expect(browserDecodeSettings(createDocument()), `browser: ${label}`).toBeUndefined()
    }

    const nullPrototypeDocument = Object.assign(Object.create(null) as Record<string, unknown>, {
      profile: 'off',
      custom: structuredClone(BASE_SETTINGS.custom),
      autoCompact: { thresholdPercent: 73 },
    })
    const hostDecoded = ContextCompressionSettingsSchema(nullPrototypeDocument as never)
    const runtimeDecoded = parseContextCompressionSettings(nullPrototypeDocument)
    const browserDecoded = browserDecodeSettings(nullPrototypeDocument)
    expect(hostDecoded).toEqual(runtimeDecoded)
    expect(browserDecoded).toEqual(runtimeDecoded)
  })

  it('canonicalizes legacy Custom v1 documents identically on both ends', () => {
    const legacyV1 = {
      version: 1,
      unit: 'tokens',
      fresh: { enabled: true, trigger: 8_192, target: 3_072 },
      aggregate: { enabled: true, trigger: 32_768, target: 12_288 },
      history: {
        enabled: true,
        trigger: 500_000,
        keepRecentTurns: 4,
        keepRecent: 64_000,
        minReclaim: 96_000,
      },
      prefixPolicy: 'pressure-break',
    }
    const runtimeDecoded = parseContextCompressionSettings({
      profile: 'custom',
      custom: structuredClone(legacyV1),
    })
    const browserDecoded = browserDecodeSettings({
      profile: 'custom',
      custom: structuredClone(legacyV1),
    })
    expect(browserDecoded).toEqual(runtimeDecoded)
    // Canonicalization is part of the shared contract: both ends upgrade the
    // legacy document to the same complete v3 policy.
    const custom = runtimeDecoded.custom
    if (custom.version !== 3) throw new Error('runtime did not canonicalize the legacy document to v3')
    expect(custom.version).toBe(3)
    expect(custom.history.keepRecentToolCalls).toBe(10)
    expect(custom.history.keepRecentTokens).toBe(64_000)
    expect(custom.tailTrim).toEqual({ enabled: false, trigger: 700_000 })
  })

  it('decodes the browser autoCompact section with exactly the runtime strictness', () => {
    for (const [section, expected] of [
      [undefined, { thresholdPercent: 80 }],
      [{ thresholdPercent: 73 }, { thresholdPercent: 73 }],
      [{ thresholdPercent: 50 }, { thresholdPercent: 50 }],
      [{ thresholdPercent: 90 }, { thresholdPercent: 90 }],
      [null, undefined],
      [[80], undefined],
      [80, undefined],
      ['80', undefined],
      [{}, undefined],
      [{ thresholdPercent: 80, extra: true }, undefined],
      [{ thresholdPercent: null }, undefined],
      [{ thresholdPercent: '73' }, undefined],
      [{ thresholdPercent: 91 }, undefined],
      [{ thresholdPercent: 72.5 }, undefined],
      [{ percent: 80 }, undefined],
    ] as const) {
      expect(browserDecodeAutoCompact(section), JSON.stringify(section)).toEqual(expected)
      // The runtime schema agrees on accept/reject for the whole section.
      const accepted = (() => {
        try {
          parseContextCompressionSettings({ ...structuredClone(BASE_SETTINGS), ...(section === undefined ? {} : { autoCompact: section }) })
          return true
        } catch {
          return false
        }
      })()
      expect(accepted, JSON.stringify(section)).toBe(expected !== undefined)
    }
  })
})

describe('Auto Compact History linkage formula', () => {
  it('restores the exact current preset numbers at the 80% default on a 1M window', () => {
    for (const [profile, expected] of [
      ['balanced', { h: 500_000, m: 96_000 }],
      ['adaptive', { h: 500_000, m: 96_000 }],
      ['savings', { h: 400_000, m: 128_000 }],
      ['cache-strict', { h: 600_000, m: 128_000 }],
    ] as const) {
      const policy = resolvePolicy(resolveConfig(), profile, undefined, {
        contextWindowTokens: 1_000_000,
        autoCompactThresholdPercent: 80,
      })
      expect(policy.historyTriggerTokens, `${profile} trigger`).toBe(expected.h)
      expect(policy.historyMinReclaimTokens, `${profile} min reclaim`).toBe(expected.m)
      expect(policy.historyKeepRecentTokens, `${profile} tail`).toBe(64_000)
      expect(policy.autoCompactTokens).toBe(800_000)
      expect(policy.microDeadlineTokens).toBe(700_000)
    }
  })

  it('scales H/M/K and the micro deadline for arbitrary thresholds', () => {
    const balanced73 = resolvePolicy(resolveConfig(), 'balanced', undefined, {
      contextWindowTokens: 1_000_000,
      autoCompactThresholdPercent: 73,
    })
    expect(balanced73.autoCompactTokens).toBe(730_000)
    expect(balanced73.microDeadlineTokens).toBe(638_750)
    expect(balanced73.historyTriggerTokens).toBe(456_250)
    expect(balanced73.historyMinReclaimTokens).toBe(87_600)
    expect(balanced73.historyKeepRecentTokens).toBe(58_400)

    const savings70 = resolvePolicy(resolveConfig(), 'savings', undefined, {
      contextWindowTokens: 1_000_000,
      autoCompactThresholdPercent: 70,
    })
    expect(savings70.autoCompactTokens).toBe(700_000)
    expect(savings70.microDeadlineTokens).toBe(612_500)
    expect(savings70.historyTriggerTokens).toBe(350_000)
    expect(savings70.historyMinReclaimTokens).toBe(112_000)
    expect(savings70.historyKeepRecentTokens).toBe(56_000)

    const cacheStrict85 = resolvePolicy(resolveConfig(), 'cache-strict', undefined, {
      contextWindowTokens: 1_000_000,
      autoCompactThresholdPercent: 85,
    })
    expect(cacheStrict85.autoCompactTokens).toBe(850_000)
    expect(cacheStrict85.microDeadlineTokens).toBe(743_750)
    expect(cacheStrict85.historyTriggerTokens).toBe(637_500)
    expect(cacheStrict85.historyMinReclaimTokens).toBe(136_000)
    expect(cacheStrict85.historyKeepRecentTokens).toBe(68_000)
  })

  it('matches the native engine float evaluation order on rounding-edge pairs', () => {
    // compaction-basic computes floor(window * (p / 100)); integer-first
    // division differs by one token on exactly these pairs.
    for (const [thresholdPercent, contextWindowTokens, expected] of [
      [57, 200_000, 113_999],
      [58, 200_000, 115_999],
      [57, 1_000_000, 570_000],
    ] as const) {
      const policy = resolvePolicy(resolveConfig(), 'balanced', undefined, {
        contextWindowTokens,
        autoCompactThresholdPercent: thresholdPercent,
      })
      expect(policy.autoCompactTokens, `${String(thresholdPercent)}@${String(contextWindowTokens)}`)
        .toBe(expected)
      expect(policy.autoCompactTokens)
        .toBe(Math.floor(contextWindowTokens * (thresholdPercent / 100)))
    }
  })

  it('keeps every watermark floor-based and exact on odd context windows', () => {
    const contextWindow = 999_983
    const policy = resolvePolicy(resolveConfig(), 'balanced', undefined, {
      contextWindowTokens: contextWindow,
      autoCompactThresholdPercent: 73,
    })
    const autoTokens = Math.floor(contextWindow * (73 / 100))
    expect(policy.autoCompactTokens).toBe(autoTokens)
    expect(policy.microDeadlineTokens).toBe(Math.floor(autoTokens * 0.875))
    expect(policy.historyTriggerTokens).toBe(Math.floor(0.625 * autoTokens))
    expect(policy.historyMinReclaimTokens).toBe(Math.floor(0.12 * autoTokens))
    expect(policy.historyKeepRecentTokens).toBe(Math.floor(0.08 * autoTokens))
  })

  it('covers the 50% and 90% hard boundaries', () => {
    const low = resolvePolicy(resolveConfig(), 'balanced', undefined, {
      contextWindowTokens: 1_000_000,
      autoCompactThresholdPercent: 50,
    })
    expect(low.autoCompactTokens).toBe(500_000)
    expect(low.microDeadlineTokens).toBe(437_500)
    const high = resolvePolicy(resolveConfig(), 'balanced', undefined, {
      contextWindowTokens: 1_000_000,
      autoCompactThresholdPercent: 90,
    })
    expect(high.autoCompactTokens).toBe(900_000)
    expect(high.microDeadlineTokens).toBe(787_500)
  })

  it('never links Custom, Off, or Native profiles', () => {
    const custom = resolvePolicy(resolveConfig(), 'custom', structuredClone(DEFAULT_CUSTOM_COMPRESSION_POLICY), {
      contextWindowTokens: 1_000_000,
      autoCompactThresholdPercent: 73,
    })
    expect(custom.historyTriggerTokens).toBe(500_000)
    expect(custom.autoCompactTokens).toBeUndefined()
    expect(custom.microDeadlineTokens).toBeUndefined()
    for (const profile of ['off', 'native'] as const) {
      const policy = resolvePolicy(resolveConfig(), profile, undefined, {
        contextWindowTokens: 1_000_000,
        autoCompactThresholdPercent: 73,
      })
      expect(policy.autoCompactTokens).toBeUndefined()
      expect(policy.microDeadlineTokens).toBeUndefined()
      expect(policy.historyMode).toBe('disabled')
    }
  })

  it('falls back to the fixed preset numbers without a resolved context window', () => {
    const policy = resolvePolicy(resolveConfig(), 'balanced', undefined, { autoCompactThresholdPercent: 73 })
    expect(policy.historyTriggerTokens).toBe(500_000)
    expect(policy.historyMinReclaimTokens).toBe(96_000)
    expect(policy.historyKeepRecentTokens).toBe(64_000)
    expect(policy.autoCompactTokens).toBeUndefined()
    expect(policy.microDeadlineTokens).toBeUndefined()
  })

  it('rejects an out-of-range deployment-config threshold percent', () => {
    for (const autoCompactThresholdPercent of [49, 91, 72.5]) {
      expect(() => resolveConfig({ autoCompactThresholdPercent }), String(autoCompactThresholdPercent))
        .toThrow(/autoCompactThresholdPercent/u)
    }
    expect(resolveConfig({ autoCompactThresholdPercent: 73 }).autoCompactThresholdPercent).toBe(73)
  })

  it('ignores linkage when the context window is zero, fractional, or negative', () => {
    for (const contextWindowTokens of [0, -1_000_000, 999_999.5]) {
      const policy = resolvePolicy(resolveConfig(), 'balanced', undefined, {
        contextWindowTokens,
        autoCompactThresholdPercent: 73,
      })
      expect(policy.historyTriggerTokens).toBe(500_000)
      expect(policy.autoCompactTokens).toBeUndefined()
      expect(policy.microDeadlineTokens).toBeUndefined()
    }
  })

  it('ignores linkage when the threshold is missing or invalid', () => {
    for (const autoCompactThresholdPercent of [undefined, 49, 91, 72.5]) {
      const policy = resolvePolicy(resolveConfig(), 'balanced', undefined, {
        contextWindowTokens: 1_000_000,
        ...(autoCompactThresholdPercent === undefined ? {} : { autoCompactThresholdPercent }),
      })
      expect(policy.historyTriggerTokens).toBe(500_000)
      expect(policy.microDeadlineTokens).toBeUndefined()
    }
  })

  it('keeps explicit deployment overrides ahead of linkage values', () => {
    const config = resolveConfig({ historyTriggerTokens: 123_456, historyMinReclaimTokens: 12_345 })
    const policy = resolvePolicy(config, 'balanced', undefined, {
      contextWindowTokens: 1_000_000,
      autoCompactThresholdPercent: 73,
    })
    expect(policy.historyTriggerTokens).toBe(123_456)
    expect(policy.historyMinReclaimTokens).toBe(12_345)
    expect(policy.historyKeepRecentTokens).toBe(58_400)
  })

  it('keeps the 10-call working set and Fresh/Aggregate budgets independent of the threshold', () => {
    for (const autoCompactThresholdPercent of [50, 73, 90]) {
      const policy = resolvePolicy(resolveConfig(), 'balanced', undefined, {
        contextWindowTokens: 1_000_000,
        autoCompactThresholdPercent,
      })
      expect(policy.historyKeepRecentToolCalls).toBe(10)
      expect(policy.freshTriggerTokens).toBe(8_192)
      expect(policy.freshTargetTokens).toBe(3_072)
      expect(policy.aggregateTriggerTokens).toBe(32_768)
      expect(policy.aggregateTargetTokens).toBe(12_288)
    }
  })
})
