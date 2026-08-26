import { describe, expect, it } from 'vitest'
import {
  DEEPSEEK_OFFICIAL_PRICE_CATALOG_VERSION,
  priceBandAt,
  priceOfficialDeepSeekUsage,
  resolveOfficialDeepSeekPrice,
} from '../src/deepseek-official-pricing.ts'

describe('DeepSeek checked-in official price catalog', () => {
  it.each([
    ['deepseek-v4-flash', 'USD', 'off-peak', '0.007', '0.22', '0.66'],
    ['deepseek-v4-flash', 'USD', 'peak', '0.014', '0.44', '1.32'],
    ['deepseek-v4-flash', 'CNY', 'off-peak', '0.05', '1.5', '4.5'],
    ['deepseek-v4-flash', 'CNY', 'peak', '0.10', '3.0', '9.0'],
    ['deepseek-v4-pro', 'USD', 'off-peak', '0.022', '0.66', '1.98'],
    ['deepseek-v4-pro', 'USD', 'peak', '0.044', '1.32', '3.96'],
    ['deepseek-v4-pro', 'CNY', 'off-peak', '0.15', '4.5', '13.5'],
    ['deepseek-v4-pro', 'CNY', 'peak', '0.30', '9.0', '27.0'],
    ['deepseek-v4-flash-vision-exp', 'USD', 'off-peak', '0.007', '0.22', '0.66'],
    ['deepseek-v4-flash-vision-exp', 'USD', 'peak', '0.014', '0.44', '1.32'],
    ['deepseek-v4-flash-vision-exp', 'CNY', 'off-peak', '0.05', '1.5', '4.5'],
    ['deepseek-v4-flash-vision-exp', 'CNY', 'peak', '0.10', '3.0', '9.0'],
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
      femtoUnits: '4854000000',
      decimal: '0.000004854',
    })
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
