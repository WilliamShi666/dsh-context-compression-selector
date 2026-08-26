/** Conservative cost interval used by the Adaptive History gate. */

import type {
  MeasuredTokenSurfaceNode,
  TokenCount,
} from './measurement.ts'
import { decimalRateNanoUnits } from './deepseek-official-pricing.ts'

/** Inputs that conservatively bound one already-planned Adaptive History batch. */
export interface AdaptiveTokenBoundsInput {
  /** Exact sum of the planned canonical replacements' net token reduction. */
  readonly exactReclaimedTokens: number
  /** Durable sequence number of the earliest message changed by the plan. */
  readonly earliestChangedSeq: number
  /** Official request-level prompt_tokens from the immediately preceding request. */
  readonly previousPromptTokens: number
  /** Tokenizer artifact revision carried by that request's exact provider key. */
  readonly expectedTokenizerRevision: string
  /** Tokenizer-first measurement of that exact preceding assembled request. */
  readonly previousRequestMeasurement: TokenCount
  /** Same-revision provider-tokenizer counts for the durable surface. */
  readonly measuredNodes: readonly MeasuredTokenSurfaceNode[]
}

/** Available lower-benefit and upper-risk bounds for one History batch. */
export interface AvailableAdaptiveTokenBounds {
  readonly kind: 'available'
  readonly measurementKind: 'exact-tokenizer' | 'tokenizer-estimate'
  /** D: conservative lower bound of input tokens removed by the plan. */
  readonly reclaimedLowerBoundTokens: number
  /** A: conservative upper bound of retained suffix tokens that may lose a hit. */
  readonly affectedRetainedSuffixUpperBoundTokens: number
  /** Known exact canonical prefix before the first changed durable sequence. */
  readonly exactPrefixLowerBoundTokens: number
}

/** Available conservative bounds or an explicit reason they cannot be derived. */
export type AdaptiveTokenBounds = AvailableAdaptiveTokenBounds | {
  readonly kind: 'unknown'
  readonly reason: string
}

/**
 * Bound Adaptive's benefit and cache-loss exposure without attributing the
 * request-level cache split to individual messages. Removed tokens are not
 * charged again as part of the retained suffix.
 * @param input - exact planned reclaim, adjacent request measurement, and same-revision nodes.
 * @returns Conservative removal/cache-risk bounds or an explicit unknown reason.
 */
export function deriveAdaptiveTokenBounds(input: AdaptiveTokenBoundsInput): AdaptiveTokenBounds {
  if (!isCount(input.exactReclaimedTokens) || input.exactReclaimedTokens === 0) {
    return unknown('invalid-reclaimed-token-count')
  }
  if (!isCount(input.earliestChangedSeq)) return unknown('invalid-earliest-changed-seq')
  if (!isCount(input.previousPromptTokens)) return unknown('invalid-previous-prompt-tokens')
  if (input.expectedTokenizerRevision.length === 0) {
    return unknown('expected-tokenizer-revision-unavailable')
  }

  const request = input.previousRequestMeasurement
  let margin = 0
  let measurementKind: AvailableAdaptiveTokenBounds['measurementKind']
  if (request.kind === 'unavailable') return unknown('request-measurement-unavailable')
  if (request.kind === 'exact-tokenizer') {
    if (!isCount(request.tokens) || request.tokens !== input.previousPromptTokens) {
      return unknown('exact-request-usage-mismatch')
    }
    if (request.tokenizerRevision !== input.expectedTokenizerRevision) {
      return unknown('request-tokenizer-revision-mismatch')
    }
    measurementKind = request.kind
  } else {
    const calibration = request.calibration
    if (calibration === undefined) return unknown('estimate-calibration-unavailable')
    if (!isCount(request.tokens)
      || !isCount(request.upperBoundTokens)
      || request.upperBoundTokens < request.tokens
      || input.previousPromptTokens > request.upperBoundTokens
      || !isCount(calibration.sampleCount)
      || !isCount(calibration.conservativeMarginTokens)) {
      return unknown('invalid-estimate-calibration')
    }
    margin = calibration.conservativeMarginTokens
    measurementKind = request.kind
  }

  const reclaimedLowerBoundTokens = Math.max(0, input.exactReclaimedTokens - margin)
  if (reclaimedLowerBoundTokens === 0) return unknown('reclaim-not-positive-after-margin')

  let identity: { readonly tokenizerId: string; readonly tokenizerRevision: string } | undefined
  let exactPrefixLowerBoundTokens = 0
  const seen = new Set<number>()
  for (const node of input.measuredNodes) {
    if (!isCount(node.seq) || seen.has(node.seq)) return unknown('invalid-measured-node-sequence')
    seen.add(node.seq)
    if (node.seq >= input.earliestChangedSeq || node.count.kind !== 'exact-tokenizer') continue
    if (!isCount(node.count.tokens)) return unknown('invalid-exact-prefix-count')
    if (node.count.tokenizerRevision !== input.expectedTokenizerRevision) {
      return unknown('exact-prefix-tokenizer-revision-mismatch')
    }
    if (identity !== undefined
      && (identity.tokenizerId !== node.count.tokenizerId
        || identity.tokenizerRevision !== node.count.tokenizerRevision)) {
      return unknown('exact-prefix-tokenizer-identity-mismatch')
    }
    identity ??= node.count
    exactPrefixLowerBoundTokens += node.count.tokens
    if (!isCount(exactPrefixLowerBoundTokens)) return unknown('exact-prefix-overflow')
  }

  const accounted = exactPrefixLowerBoundTokens + reclaimedLowerBoundTokens
  if (!isCount(accounted) || accounted > input.previousPromptTokens) {
    return unknown('adaptive-bounds-exceed-previous-prompt')
  }
  return {
    kind: 'available',
    measurementKind,
    reclaimedLowerBoundTokens,
    affectedRetainedSuffixUpperBoundTokens: input.previousPromptTokens - accounted,
    exactPrefixLowerBoundTokens,
  }
}

/** Conservative bounds, capacity authority, and applicable official input prices. */
export interface ConservativeAdaptiveDecisionInput {
  readonly capacityPressure: boolean
  readonly bounds: AdaptiveTokenBounds
  /** Official price per one million cache-hit input tokens. */
  readonly inputCacheHitRate?: string
  /** Official price per one million cache-miss input tokens. */
  readonly inputCacheMissRate?: string
  /** Request-level hit total; caps, but never attributes, the affected hit exposure. */
  readonly observedCacheReadTokens?: number
}

/** Authorization decision plus fixed-point comparison telemetry when evaluated. */
export type ConservativeAdaptiveDecision =
  | { readonly allowHistory: true; readonly reason: 'capacity-override' }
  | {
    readonly allowHistory: boolean
    readonly reason: string
    readonly minimumRemovalValue?: string
    readonly maximumCacheLossPenalty?: string
  }

/**
 * Allow routine History only when D*P_hit is strictly greater than A*(P_miss-P_hit).
 * @param input - capacity state, token bounds, request hit cap, and official input rates.
 * @returns Capacity override or a strict fixed-point conservative-cost decision.
 */
export function decideConservativeAdaptive(
  input: ConservativeAdaptiveDecisionInput,
): ConservativeAdaptiveDecision {
  if (input.capacityPressure) return { allowHistory: true, reason: 'capacity-override' }
  if (input.bounds.kind === 'unknown') {
    return { allowHistory: false, reason: input.bounds.reason }
  }
  if (input.inputCacheHitRate === undefined || input.inputCacheMissRate === undefined) {
    return { allowHistory: false, reason: 'adaptive-unknown-price' }
  }
  const hit = decimalRateNanoUnits(input.inputCacheHitRate)
  const miss = decimalRateNanoUnits(input.inputCacheMissRate)
  if (hit === undefined || miss === undefined || miss < hit) {
    return { allowHistory: false, reason: 'adaptive-unknown-price' }
  }
  if (input.observedCacheReadTokens !== undefined && !isCount(input.observedCacheReadTokens)) {
    return { allowHistory: false, reason: 'adaptive-invalid-cache-telemetry' }
  }
  const affectedHitUpperBound = input.observedCacheReadTokens === undefined
    ? input.bounds.affectedRetainedSuffixUpperBoundTokens
    : Math.min(
      input.bounds.affectedRetainedSuffixUpperBoundTokens,
      input.observedCacheReadTokens,
    )
  const minimumRemovalValue = BigInt(input.bounds.reclaimedLowerBoundTokens) * hit
  const maximumCacheLossPenalty = BigInt(affectedHitUpperBound)
    * (miss - hit)
  return {
    allowHistory: minimumRemovalValue > maximumCacheLossPenalty,
    reason: minimumRemovalValue > maximumCacheLossPenalty
      ? 'cost-interval-clearly-favourable'
      : 'cache-risk-not-clearly-paid-back',
    minimumRemovalValue: minimumRemovalValue.toString(),
    maximumCacheLossPenalty: maximumCacheLossPenalty.toString(),
  }
}

function unknown(reason: string): AdaptiveTokenBounds {
  return { kind: 'unknown', reason }
}

function isCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}
