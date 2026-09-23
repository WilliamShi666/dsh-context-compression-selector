import { describe, expect, it } from 'vitest'
import {
  DEEPSEEK_OFFICIAL_PRICE_CATALOG_VERSION,
  DEEPSEEK_OFFICIAL_PRICE_CHECKED_AT,
  priceBandAt,
  priceOfficialDeepSeekUsage,
  resolveOfficialDeepSeekPrice,
} from '../src/deepseek-official-pricing.ts'
import { decideConservativeAdaptive } from '../src/adaptive-cost.ts'

describe('DeepSeek checked-in official price catalog', () => {
  it.each([
    ['deepseek-flash', 'USD', 'off-peak', '0.003', '0.15', '0.6'],
    ['deepseek-flash', 'USD', 'peak', '0.006', '0.3', '1.2'],
    ['deepseek-flash', 'CNY', 'off-peak', '0.02', '1', '4'],
    ['deepseek-flash', 'CNY', 'peak', '0.04', '2', '8'],
    // The legacy aliases are retired but still accepted; the official pricing
    // page bills them at the Flash price.
    ['deepseek-v4-flash', 'USD', 'off-peak', '0.003', '0.15', '0.6'],
    ['deepseek-v4-flash', 'USD', 'peak', '0.006', '0.3', '1.2'],
    ['deepseek-v4-flash', 'CNY', 'off-peak', '0.02', '1', '4'],
    ['deepseek-v4-flash', 'CNY', 'peak', '0.04', '2', '8'],
    ['deepseek-v4-pro', 'USD', 'off-peak', '0.022', '0.66', '1.98'],
    ['deepseek-v4-pro', 'USD', 'peak', '0.044', '1.32', '3.96'],
    ['deepseek-v4-pro', 'CNY', 'off-peak', '0.15', '4.5', '13.5'],
    ['deepseek-v4-pro', 'CNY', 'peak', '0.30', '9.0', '27.0'],
    ['deepseek-v4-flash-vision-exp', 'USD', 'off-peak', '0.003', '0.15', '0.6'],
    ['deepseek-v4-flash-vision-exp', 'USD', 'peak', '0.006', '0.3', '1.2'],
    ['deepseek-v4-flash-vision-exp', 'CNY', 'off-peak', '0.02', '1', '4'],
    ['deepseek-v4-flash-vision-exp', 'CNY', 'peak', '0.04', '2', '8'],
  ] as const)(
    'resolves %s %s %s from the versioned catalog',
    (modelId, currency, band, hit, miss, output) => {
      const resolved = resolveOfficialDeepSeekPrice({
        provider: 'deepseek-official',
        baseUrlClass: 'official-public',
        apiRoute: 'chat-completions',
        modelId,
        currency,
        at: band === 'peak'
          ? new Date('2026-08-25T01:00:00.000Z')
          : new Date('2026-08-23T01:00:00.000Z'),
      })
      expect(resolved).toMatchObject({
        kind: 'priced',
        record: {
          catalogVersion: DEEPSEEK_OFFICIAL_PRICE_CATALOG_VERSION,
          modelId, currency, band,
          inputCacheHit: hit,
          inputCacheMiss: miss,
          output,
        },
      })
    },
  )

  it('reports the V4.1-Flash model version for deepseek-flash', () => {
    expect(resolveOfficialDeepSeekPrice({
      provider: 'deepseek-official',
      baseUrlClass: 'official-public',
      apiRoute: 'chat-completions',
      modelId: 'deepseek-flash',
      currency: 'USD',
      at: new Date('2026-08-23T01:00:00.000Z'),
    })).toMatchObject({
      kind: 'priced',
      record: { modelVersion: 'DeepSeek-V4.1-Flash' },
    })
  })

  it('carries the bumped catalog version and re-verification time', () => {
    const resolved = resolveOfficialDeepSeekPrice({
      provider: 'deepseek-official',
      baseUrlClass: 'official-public',
      apiRoute: 'chat-completions',
      modelId: 'deepseek-flash',
      currency: 'USD',
      at: new Date('2026-08-23T01:00:00.000Z'),
    })
    expect(resolved.kind).toBe('priced')
    if (resolved.kind !== 'priced') throw new Error('expected a priced resolution')
    expect(DEEPSEEK_OFFICIAL_PRICE_CATALOG_VERSION).toBe('deepseek-official-2026-09-23')
    expect(resolved.record.catalogVersion).toBe('deepseek-official-2026-09-23')
    expect(resolved.record.checkedAt).toBeTruthy()
    expect(resolved.record.checkedAt).not.toBe('2026-08-25T00:10:20+08:00')
  })

  it('prices deepseek-flash in CNY with the Chinese source locale', () => {
    expect(resolveOfficialDeepSeekPrice({
      provider: 'deepseek-official',
      baseUrlClass: 'official-public',
      apiRoute: 'chat-completions',
      modelId: 'deepseek-flash',
      currency: 'CNY',
      at: new Date('2026-08-23T01:00:00.000Z'),
    })).toMatchObject({
      kind: 'priced',
      record: { sourceLocale: 'zh-CN', inputCacheHit: '0.02', inputCacheMiss: '1', output: '4' },
    })
  })

  it.each(['chat-completions', 'responses'] as const)(
    'prices both documented API routes for deepseek-flash (%s)',
    (apiRoute) => {
      expect(resolveOfficialDeepSeekPrice({
        provider: 'deepseek-official',
        baseUrlClass: 'official-public',
        apiRoute,
        modelId: 'deepseek-flash',
        currency: 'USD',
        at: new Date('2026-08-23T01:00:00.000Z'),
      })).toMatchObject({
        kind: 'priced',
        record: {
          apiRoute,
          catalogVersion: DEEPSEEK_OFFICIAL_PRICE_CATALOG_VERSION,
          inputCacheHit: '0.003',
          inputCacheMiss: '0.15',
          output: '0.6',
        },
      })
    },
  )

  it.each(['deepseek-flash-vision', 'deepseek-v4.1-flash', 'gpt-4o'])(
    'still fails closed on the unknown model id %s',
    (modelId) => {
      expect(resolveOfficialDeepSeekPrice({
        provider: 'deepseek-official',
        baseUrlClass: 'official-public',
        apiRoute: 'chat-completions',
        modelId,
        currency: 'USD',
        at: new Date('2026-08-23T01:00:00.000Z'),
      })).toEqual({ kind: 'unpriced', reason: 'unknown model id' })
    },
  )

  it('still fails closed on an unknown currency and an invalid timestamp', () => {
    const base = {
      provider: 'deepseek-official',
      baseUrlClass: 'official-public',
      apiRoute: 'chat-completions',
      modelId: 'deepseek-flash',
      at: new Date('2026-08-23T01:00:00.000Z'),
    }
    expect(resolveOfficialDeepSeekPrice({ ...base, currency: 'EUR' }))
      .toEqual({ kind: 'unpriced', reason: 'unknown currency' })
    expect(resolveOfficialDeepSeekPrice({ ...base, currency: 'USD', at: new Date(Number.NaN) }))
      .toEqual({ kind: 'unpriced', reason: 'invalid price timestamp' })
  })

  it.each(['chat-completions', 'responses'] as const)(
    'prices the documented %s route without changing the catalog tuple',
    (apiRoute) => {
      expect(resolveOfficialDeepSeekPrice({
        provider: 'deepseek-official',
        baseUrlClass: 'official-public',
        apiRoute,
        modelId: 'deepseek-v4-pro',
        currency: 'USD',
        at: new Date('2026-08-25T01:00:00.000Z'),
      })).toMatchObject({
        kind: 'priced',
        record: { apiRoute, modelId: 'deepseek-v4-pro', band: 'peak' },
      })
    },
  )

  it.each([
    ['2026-08-24T00:59:59.000Z', 'off-peak'],
    ['2026-08-24T01:00:00.000Z', 'peak'],
    ['2026-08-24T03:59:59.000Z', 'peak'],
    ['2026-08-24T04:00:00.000Z', 'off-peak'],
    ['2026-08-24T05:59:59.000Z', 'off-peak'],
    ['2026-08-24T06:00:00.000Z', 'peak'],
    ['2026-08-24T09:59:59.000Z', 'peak'],
    ['2026-08-24T10:00:00.000Z', 'off-peak'],
    ['2026-08-29T01:00:00.000Z', 'off-peak'],
    ['2026-08-30T06:00:00.000Z', 'off-peak'],
  ] as const)('classifies exact UTC schedule boundary %s as %s', (iso, expected) => {
    expect(priceBandAt(new Date(iso))).toBe(expected)
  })

  it.each([
    [{ provider: 'gateway', baseUrlClass: 'official-public' }, 'provider'],
    [{ provider: 'deepseek-official', baseUrlClass: 'compatible-hmac:v1:test' }, 'base-url'],
    [{ provider: 'deepseek-official', baseUrlClass: 'official-public', modelId: 'deepseek-chat' }, 'model'],
    [{ provider: 'deepseek-official', baseUrlClass: 'official-public', apiRoute: 'other' }, 'route'],
  ] as const)('fails closed instead of aliasing an unknown applicability: %s', (patch, reason) => {
    const resolved = resolveOfficialDeepSeekPrice({
      apiRoute: 'chat-completions',
      modelId: 'deepseek-v4-flash',
      currency: 'USD',
      at: new Date('2026-08-25T01:00:00.000Z'),
      ...patch,
    })
    expect(resolved.kind).toBe('unpriced')
    if (resolved.kind !== 'unpriced')
      throw new Error(`Expected an unpriced result, received ${resolved.kind}`)
    expect(resolved.reason).toContain(reason)
  })

  it('computes provider-usage cost with fixed-point arithmetic, never JS float money', () => {
    const cost = priceOfficialDeepSeekUsage({
      provider: 'deepseek-official',
      baseUrlClass: 'official-public',
      apiRoute: 'chat-completions',
      modelId: 'deepseek-v4-flash',
      currency: 'USD',
      startedAt: new Date('2026-08-25T01:00:00.000Z'),
      completedAt: new Date('2026-08-25T01:01:00.000Z'),
      usage: { cacheReadTokens: 1, cacheMissTokens: 2, outputTokens: 3 },
    })
    expect(cost).toEqual({
      kind: 'exact',
      currency: 'USD',
      band: 'peak',
      // Flash peak rates (0.006 / 0.3 / 1.2) now apply to this legacy alias.
      femtoUnits: '4206000000',
      decimal: '0.000004206',
    })
  })

  it.each(['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'])(
    'bills the retired alias %s at the Flash price',
    (modelId) => {
      const at = (band: 'peak' | 'off-peak') => band === 'peak'
        ? new Date('2026-08-25T01:00:00.000Z')
        : new Date('2026-08-23T01:00:00.000Z')
      for (const currency of ['USD', 'CNY'] as const) {
        for (const band of ['off-peak', 'peak'] as const) {
          const alias = resolveOfficialDeepSeekPrice({
            provider: 'deepseek-official',
            baseUrlClass: 'official-public',
            apiRoute: 'chat-completions',
            modelId,
            currency,
            at: at(band),
          })
          const flash = resolveOfficialDeepSeekPrice({
            provider: 'deepseek-official',
            baseUrlClass: 'official-public',
            apiRoute: 'chat-completions',
            modelId: 'deepseek-flash',
            currency,
            at: at(band),
          })
          if (alias.kind !== 'priced' || flash.kind !== 'priced') {
            throw new Error(`expected both ${modelId} and deepseek-flash to be priced for ${currency}/${band}`)
          }
          // Every field except the identity itself must be identical: the
          // retired alias is billed exactly like deepseek-flash, but its
          // modelId still reports the id that was actually requested.
          const { modelId: aliasModelId, ...aliasRest } = alias.record
          const { modelId: flashModelId, ...flashRest } = flash.record
          expect(aliasModelId).toBe(modelId)
          expect(flashModelId).toBe('deepseek-flash')
          expect(aliasRest).toEqual(flashRest)
        }
      }
      expect(resolveOfficialDeepSeekPrice({
        provider: 'deepseek-official',
        baseUrlClass: 'official-public',
        apiRoute: 'chat-completions',
        modelId,
        currency: 'USD',
        at: at('off-peak'),
      })).toMatchObject({
        kind: 'priced',
        record: { modelVersion: 'DeepSeek-V4.1-Flash', inputCacheHit: '0.003', inputCacheMiss: '0.15', output: '0.6' },
      })
    },
  )

  it('keeps the deepseek-v4-pro model version and tuple untouched by the Flash repricing', () => {
    // `deepseek-v4-pro` is deliberately NOT repriced: the official pricing page
    // still publishes its own tuple, and the V4-Pro artifact keeps its own
    // version string. Pin both so the Flash migration cannot silently bleed
    // into this row.
    for (const [currency, band, hit, miss, output] of [
      ['USD', 'off-peak', '0.022', '0.66', '1.98'],
      ['USD', 'peak', '0.044', '1.32', '3.96'],
      ['CNY', 'off-peak', '0.15', '4.5', '13.5'],
      ['CNY', 'peak', '0.30', '9.0', '27.0'],
    ] as const) {
      const resolved = resolveOfficialDeepSeekPrice({
        provider: 'deepseek-official',
        baseUrlClass: 'official-public',
        apiRoute: 'chat-completions',
        modelId: 'deepseek-v4-pro',
        currency,
        at: band === 'peak'
          ? new Date('2026-08-25T01:00:00.000Z')
          : new Date('2026-08-23T01:00:00.000Z'),
      })
      expect(resolved).toMatchObject({
        kind: 'priced',
        record: {
          modelId: 'deepseek-v4-pro',
          modelVersion: 'DeepSeek-V4-Pro-0813',
          currency,
          band,
          inputCacheHit: hit,
          inputCacheMiss: miss,
          output,
        },
      })
      if (resolved.kind !== 'priced') throw new Error('expected deepseek-v4-pro to be priced')
      expect(resolved.record.modelVersion).not.toBe('DeepSeek-V4.1-Flash')
    }
  })

  it('pins the exact re-verification timestamp covering every bundled row', () => {
    // A partial re-verification that silently keeps an older timestamp would
    // understate how stale the un-rechecked rows are, so pin the exact value.
    expect(DEEPSEEK_OFFICIAL_PRICE_CHECKED_AT).toBe('2026-09-23T01:48:36+08:00')
    for (const modelId of [
      'deepseek-flash',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash-vision-exp',
    ] as const) {
      expect(resolveOfficialDeepSeekPrice({
        provider: 'deepseek-official',
        baseUrlClass: 'official-public',
        apiRoute: 'chat-completions',
        modelId,
        currency: 'USD',
        at: new Date('2026-08-23T01:00:00.000Z'),
      })).toMatchObject({ kind: 'priced', record: { checkedAt: '2026-09-23T01:48:36+08:00' } })
    }
  })

  it('flips the adaptive decision when the alias is billed at the Flash price', () => {
    const rates = (modelId: string, at: Date) => {
      const resolved = resolveOfficialDeepSeekPrice({
        provider: 'deepseek-official',
        baseUrlClass: 'official-public',
        apiRoute: 'chat-completions',
        modelId,
        currency: 'USD',
        at,
      })
      if (resolved.kind !== 'priced') throw new Error(`expected ${modelId} to be priced`)
      return {
        inputCacheHitRate: resolved.record.inputCacheHit,
        inputCacheMissRate: resolved.record.inputCacheMiss,
      }
    }
    const offPeak = new Date('2026-08-23T01:00:00.000Z')
    const bounds = {
      kind: 'available',
      measurementKind: 'exact-tokenizer',
      reclaimedLowerBoundTokens: 1000,
      affectedRetainedSuffixUpperBoundTokens: 25,
      exactPrefixLowerBoundTokens: 0,
    } as const

    // The retired alias now carries the Flash rate, so the cache-loss spread
    // (0.147) is small enough that reclaiming 1000 tokens no longer clearly
    // pays back exposing 25 retained tokens to a cache miss.
    expect(decideConservativeAdaptive({
      capacityPressure: false,
      bounds,
      ...rates('deepseek-v4-flash', offPeak),
    })).toMatchObject({ allowHistory: false, reason: 'cache-risk-not-clearly-paid-back' })

    // Contrast: under the withdrawn V4-Flash rate the spread was 0.213 and the
    // same bounds authorized History. This is why the alias pricing matters.
    expect(decideConservativeAdaptive({
      capacityPressure: false,
      bounds,
      inputCacheHitRate: '0.007',
      inputCacheMissRate: '0.22',
    })).toMatchObject({ allowHistory: true, reason: 'cost-interval-clearly-favourable' })

    // deepseek-flash itself resolves to the same rates as the alias.
    expect(rates('deepseek-flash', offPeak)).toEqual(rates('deepseek-v4-flash', offPeak))
  })

  it('returns a range when one request spans a published price-band boundary', () => {
    const cost = priceOfficialDeepSeekUsage({
      provider: 'deepseek-official',
      baseUrlClass: 'official-public',
      apiRoute: 'chat-completions',
      modelId: 'deepseek-v4-pro',
      currency: 'CNY',
      startedAt: new Date('2026-08-25T03:59:59.000Z'),
      completedAt: new Date('2026-08-25T04:00:01.000Z'),
      usage: { cacheReadTokens: 10, cacheMissTokens: 20, outputTokens: 3 },
    })
    expect(cost).toMatchObject({
      kind: 'range', currency: 'CNY', bands: ['peak', 'off-peak'],
    })
  })

  it('returns a range when both endpoints share a band but the interval crosses peak', () => {
    const cost = priceOfficialDeepSeekUsage({
      provider: 'deepseek-official',
      baseUrlClass: 'official-public',
      apiRoute: 'chat-completions',
      modelId: 'deepseek-v4-flash',
      currency: 'USD',
      startedAt: new Date('2026-08-25T00:59:59.000Z'),
      completedAt: new Date('2026-08-25T04:00:01.000Z'),
      usage: { cacheReadTokens: 10, cacheMissTokens: 20, outputTokens: 3 },
    })
    expect(cost).toMatchObject({
      kind: 'range', currency: 'USD', bands: ['off-peak', 'peak'],
    })
  })

  it.each([
    ['Friday through Monday', '2026-08-28T10:00:01.000Z', '2026-08-31T01:00:01.000Z'],
    ['seven full days', '2026-08-25T00:00:00.000Z', '2026-09-01T00:00:00.000Z'],
  ])('returns a range across %s', (_label, startedAt, completedAt) => {
    expect(priceOfficialDeepSeekUsage({
      provider: 'deepseek-official',
      baseUrlClass: 'official-public',
      apiRoute: 'responses',
      modelId: 'deepseek-v4-flash',
      currency: 'USD',
      startedAt: new Date(startedAt),
      completedAt: new Date(completedAt),
      usage: { cacheReadTokens: 10, cacheMissTokens: 20, outputTokens: 3 },
    })).toMatchObject({ kind: 'range', currency: 'USD' })
  })

  it.each([
    ['invalid start timestamp', new Date('invalid'), new Date('2026-08-25T01:00:00.000Z'), 'timestamp'],
    ['completion before start', new Date('2026-08-25T01:00:01.000Z'), new Date('2026-08-25T01:00:00.000Z'), 'precedes'],
  ] as const)('fails closed for %s', (_label, startedAt, completedAt, reason) => {
    const cost = priceOfficialDeepSeekUsage({
      provider: 'deepseek-official',
      baseUrlClass: 'official-public',
      apiRoute: 'chat-completions',
      modelId: 'deepseek-v4-flash',
      currency: 'USD',
      startedAt,
      completedAt,
      usage: { cacheReadTokens: 1, cacheMissTokens: 2, outputTokens: 3 },
    })
    expect(cost.kind).toBe('unpriced')
    if (cost.kind !== 'unpriced') throw new Error('expected unpriced interval')
    expect(cost.reason).toContain(reason)
  })
})
