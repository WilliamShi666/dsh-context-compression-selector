import { describe, expect, it } from 'vitest'
import {
  decideConservativeAdaptive,
  deriveAdaptiveTokenBounds,
} from '../src/adaptive-cost.ts'
import type {
  ExactTokenizerTokenCount,
  TokenizerEstimateTokenCount,
} from '../src/token-count.ts'

const exact = (
  tokens: number,
  tokenizerRevision = 'DeepSeek-V4-Pro-0813',
): ExactTokenizerTokenCount => ({
  kind: 'exact-tokenizer',
  tokens,
  tokenizerId: 'deepseek-v4-official',
  tokenizerRevision,
})

const estimate = (
  input: Omit<TokenizerEstimateTokenCount, 'kind'>,
): TokenizerEstimateTokenCount => ({ kind: 'tokenizer-estimate', ...input })

describe('Conservative Adaptive interval', () => {
  it('subtracts removed tokens from the affected retained suffix instead of charging them twice', () => {
    expect(deriveAdaptiveTokenBounds({
      exactReclaimedTokens: 20_000,
      earliestChangedSeq: 2,
      previousPromptTokens: 30_500,
      expectedTokenizerRevision: 'DeepSeek-V4-Pro-0813',
      previousRequestMeasurement: exact(30_500),
      measuredNodes: [
        { seq: 0, count: exact(10_000) },
        { seq: 2, count: exact(20_000) },
        { seq: 3, count: exact(500) },
      ],
    })).toEqual({
      kind: 'available',
      measurementKind: 'exact-tokenizer',
      reclaimedLowerBoundTokens: 20_000,
      affectedRetainedSuffixUpperBoundTokens: 500,
      exactPrefixLowerBoundTokens: 10_000,
    })
  })

  it('subtracts the tokenizer-estimate conservative margin from reclaimed benefit', () => {
    expect(deriveAdaptiveTokenBounds({
      exactReclaimedTokens: 20_000,
      earliestChangedSeq: 2,
      previousPromptTokens: 30_500,
      expectedTokenizerRevision: 'DeepSeek-V4-Pro-0813',
      previousRequestMeasurement: estimate({
        tokens: 30_300,
        upperBoundTokens: 30_500,
        estimatorId: 'deepseek-wire',
        estimatorRevision: 'r1',
        calibration: { sampleCount: 1, conservativeMarginTokens: 200 },
      }),
      measuredNodes: [{ seq: 0, count: exact(10_000) }],
    })).toMatchObject({
      kind: 'available',
      measurementKind: 'tokenizer-estimate',
      reclaimedLowerBoundTokens: 19_800,
      affectedRetainedSuffixUpperBoundTokens: 700,
    })
  })

  it.each([
    [{ kind: 'unavailable', reason: 'no request tokenizer' } as const, 'request-measurement-unavailable'],
    [estimate({
      tokens: 10, upperBoundTokens: 20,
      estimatorId: 'e', estimatorRevision: 'r',
    }), 'estimate-calibration-unavailable'],
  ] as const)('fails closed when D/S cannot be bounded: %s', (measurement, reason) => {
    expect(deriveAdaptiveTokenBounds({
      exactReclaimedTokens: 100,
      earliestChangedSeq: 2,
      previousPromptTokens: 200,
      expectedTokenizerRevision: 'DeepSeek-V4-Pro-0813',
      previousRequestMeasurement: measurement,
      measuredNodes: [{ seq: 0, count: exact(50) }],
    })).toEqual({ kind: 'unknown', reason })
  })

  it('fails closed when the exact request count does not match the provider key tokenizer revision', () => {
    expect(deriveAdaptiveTokenBounds({
      exactReclaimedTokens: 100,
      earliestChangedSeq: 2,
      previousPromptTokens: 200,
      expectedTokenizerRevision: 'DeepSeek-V4-Pro-0813',
      previousRequestMeasurement: exact(200, 'DeepSeek-V4-Flash-0731'),
      measuredNodes: [{ seq: 0, count: exact(50) }],
    })).toEqual({ kind: 'unknown', reason: 'request-tokenizer-revision-mismatch' })
  })

  it('fails closed before subtracting an exact prefix from another tokenizer revision', () => {
    expect(deriveAdaptiveTokenBounds({
      exactReclaimedTokens: 100,
      earliestChangedSeq: 2,
      previousPromptTokens: 200,
      expectedTokenizerRevision: 'DeepSeek-V4-Pro-0813',
      previousRequestMeasurement: exact(200),
      measuredNodes: [{ seq: 0, count: exact(50, 'DeepSeek-V4-Flash-0731') }],
    })).toEqual({ kind: 'unknown', reason: 'exact-prefix-tokenizer-revision-mismatch' })
  })

  it('allows routine History only when minimum removal value beats maximum cache-loss penalty', () => {
    expect(decideConservativeAdaptive({
      capacityPressure: false,
      bounds: {
        kind: 'available', measurementKind: 'exact-tokenizer',
        reclaimedLowerBoundTokens: 20_000,
        affectedRetainedSuffixUpperBoundTokens: 500,
        exactPrefixLowerBoundTokens: 10_000,
      },
      inputCacheHitRate: '0.014',
      inputCacheMissRate: '0.44',
    })).toMatchObject({
      allowHistory: true,
      reason: 'cost-interval-clearly-favourable',
    })
  })

  it.each([
    [19_000, 1_000, 'cache-risk-not-clearly-paid-back'],
    [20_000, 500, 'adaptive-unknown-price'],
  ] as const)('fails closed for overlap or unknown price', (reclaimed, suffix, expected) => {
    expect(decideConservativeAdaptive({
      capacityPressure: false,
      bounds: {
        kind: 'available', measurementKind: 'exact-tokenizer',
        reclaimedLowerBoundTokens: reclaimed,
        affectedRetainedSuffixUpperBoundTokens: suffix,
        exactPrefixLowerBoundTokens: 0,
      },
      ...(expected === 'adaptive-unknown-price'
        ? {}
        : { inputCacheHitRate: '0.014', inputCacheMissRate: '0.44' }),
    })).toMatchObject({ allowHistory: false, reason: expected })
  })

  it('lets capacity safety override missing price and telemetry', () => {
    expect(decideConservativeAdaptive({
      capacityPressure: true,
      bounds: { kind: 'unknown', reason: 'usage-unavailable' },
    })).toEqual({ allowHistory: true, reason: 'capacity-override' })
  })

  it('uses request-level cache hits only as a conservative exposure cap', () => {
    expect(decideConservativeAdaptive({
      capacityPressure: false,
      bounds: {
        kind: 'available', measurementKind: 'exact-tokenizer',
        reclaimedLowerBoundTokens: 20_000,
        affectedRetainedSuffixUpperBoundTokens: 10_000,
        exactPrefixLowerBoundTokens: 0,
      },
      observedCacheReadTokens: 100,
      inputCacheHitRate: '0.014',
      inputCacheMissRate: '0.44',
    })).toMatchObject({
      allowHistory: true,
      maximumCacheLossPenalty: '42600000000',
    })
  })
})
