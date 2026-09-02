/** Public-API-only measurement adapter for the standalone runtime. */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-token-meter'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import {
  DEEPSEEK_VISION_TOKENIZER_ARTIFACT,
  deepSeekV4TokenizerForModel,
} from './deepseek-v4-tokenizer.ts'
import {
  DEEPSEEK_VISION_IMAGE_ESTIMATOR,
  estimateDeepSeekVisionImageTokens,
} from './deepseek-v4-vision-tokens.ts'
import { unavailableTokenCount } from './token-count.ts'
import { sessionEvents } from './session-events.ts'
import type {
  CanonicalTextTokenCounter,
  ExactTokenizerTokenCount,
  TokenCount,
  TokenizerEstimateTokenCount,
} from './token-count.ts'

export type { TokenCount } from './token-count.ts'

/** Request identity retained only when every dimension is publicly known. */
export interface ProviderMeasurementKey {
  readonly provider: string
  readonly baseUrlClass: string
  readonly apiRoute: string
  readonly modelId: string
  readonly requestTemplateRevision: string
  readonly tokenizerRevision: string
  readonly modality: string
}

/** Rich request observation used by Adaptive when a future public API supplies it. */
export interface ObservedPromptUsage {
  readonly attemptId: string
  readonly providerRequestOrdinal: number
  readonly startedAtMs: number
  readonly completedAtMs: number
  readonly measurement: TokenCount
  readonly observedPromptTokens: number
  readonly observedOutputTokens?: number
  readonly responseModelId?: string
  readonly cacheStatus?: 'complete' | 'unknown'
  readonly cacheReadTokens?: number
  readonly cacheMissTokens?: number
  readonly key?: ProviderMeasurementKey
}

/** Metadata-only image dimensions; the pixel payload is never read or logged. */
export interface CanonicalImageAttachment {
  readonly width: number
  readonly height: number
}

/**
 * Intrinsic-grid diagnostic attached to nodes whose count estimates images.
 * It reports ONLY the official block
 * arithmetic evaluated on the attachment's intrinsic dimensions at the two
 * alignment-padding extremes (compress-pad 0 and 3). It is NOT a request-token
 * bound: the adapter may still re-project the image (per-route pixel-budget
 * or image-detail overrides, byte-cap reprojection), which can move the real
 * count below the diagnostic minimum. It never participates in exact gates,
 * rewrite proofs, or any lossy decision.
 */
export interface IntrinsicImageBlockDiagnostic {
  readonly paddingMinimumTokens: number
  readonly paddingMaximumTokens: number
}

/** One same-revision surface node with exact, estimated, or unavailable count. */
export interface MeasuredTokenSurfaceNode {
  readonly seq: number
  readonly count: TokenCount
  /** Intrinsic-grid diagnostic when usable image dimensions were available. */
  readonly intrinsicImageBlockEstimate?: IntrinsicImageBlockDiagnostic
}

/** Compression view derived only from published Session and TokenMeter methods. */
export interface CompactionTokenView extends TokenMeasurement {
  readonly providerRoute?: string
  readonly modelId?: string
  readonly measuredNodes: readonly MeasuredTokenSurfaceNode[]
  readonly currentSurface: TokenCount
  /** Sum of per-node intrinsic padding minima; a diagnostic, not a token bound. */
  readonly intrinsicImageBlockEstimateTokens: number
  readonly latestEnvelopeKey?: ProviderMeasurementKey
  readonly lastCompletedUsage?: ObservedPromptUsage
  countCanonicalText(text: string): TokenCount
}

/** Text plus image gating for one durable request target. */
interface CanonicalCounter {
  readonly countText: CanonicalTextTokenCounter
  readonly countImage: (attachment: CanonicalImageAttachment) => TokenCount
}

const VISION_MODEL_ID = DEEPSEEK_VISION_TOKENIZER_ARTIFACT.modelIds[0] as string

/**
 * Capture one route-bound view without calling patched Harness methods.
 * Official `measure()` remains authoritative for request pressure; the bundled
 * tokenizer supplies exact canonical content counts used by safe rewrites.
 */
export function measureForCompaction(ctx: Context, session: Session): CompactionTokenView {
  const header = session.requestHeader()
  const measurement = ctx.tokenMeter.measure(session, header)
  const target = header?.config
  const counter = bindCounter(target?.provider, target?.model)
  const events = sessionEvents(session)
  const measuredNodes = measurement.nodes.map((node): MeasuredTokenSurfaceNode => {
    const event = events[node.seq]
    if (event === undefined) {
      return { seq: node.seq, count: unavailableTokenCount(`surface node ${String(node.seq)} is missing`) }
    }
    const message = deriveEventMessage(event)
    if (message === null) {
      return { seq: node.seq, count: unavailableTokenCount(`surface node ${String(node.seq)} is not model-visible`) }
    }
    const count = countCanonicalContent(message.content, counter, `surface node ${String(node.seq)}`)
    const intrinsicImageBlockEstimate = count.kind === 'tokenizer-estimate'
      ? intrinsicImageDiagnostic(message.content, target)
      : undefined
    return {
      seq: node.seq,
      count,
      ...intrinsicImageBlockEstimate === undefined ? {} : { intrinsicImageBlockEstimate },
    }
  })
  const currentSurface = countSurfaceCounts(
    measuredNodes.map(node => node.count),
    'current surface',
  )
  const intrinsicImageBlockEstimateTokens = measuredNodes.reduce(
    (sum, node) => sum + (node.intrinsicImageBlockEstimate?.paddingMinimumTokens ?? 0),
    0,
  )
  return Object.freeze({
    ...measurement,
    ...(target === undefined ? {} : { providerRoute: target.provider, modelId: target.model }),
    measuredNodes: Object.freeze(measuredNodes),
    currentSurface,
    intrinsicImageBlockEstimateTokens,
    countCanonicalText: counter.countText,
  })
}

/** Request-level usage exposed by official TokenMeter, without invented route attribution. */
export function officialRequestUsage(view: CompactionTokenView): Readonly<TokenUsage> | undefined {
  return view.baseline.kind === 'usage' ? view.baseline.usage : undefined
}

/**
 * Count one canonical content walk in canonical field order.
 *
 * Text, reasoning, tool-call names/arguments, and nested text tool results are
 * counted exactly with one tokenizer identity. Image blocks produce a bounded
 * estimate because the absolute prompt position and the adapter's final
 * projection are not publicly observable. A mixed text/image node is therefore
 * an estimate and never qualifies for an exact rewrite proof.
 */
function countCanonicalContent(
  blocks: readonly ContentBlock[],
  counter: CanonicalCounter,
  subject: string,
): TokenCount {
  let identity: ExactTokenizerTokenCount | undefined
  let estimateIdentity: Pick<TokenizerEstimateTokenCount, 'estimatorId' | 'estimatorRevision'> | undefined
  let tokens = 0
  let upperBoundTokens = 0
  let firstRefusal: TokenCount | undefined
  const absorb = (count: TokenCount): boolean => {
    if (count.kind === 'unavailable') {
      firstRefusal ??= count
      return false
    }
    if (count.kind === 'exact-tokenizer') {
      if (identity !== undefined
        && (identity.tokenizerId !== count.tokenizerId
          || identity.tokenizerRevision !== count.tokenizerRevision)) {
        firstRefusal ??= unavailableTokenCount(`${subject}: tokenizer identity changed within one measurement`)
        return false
      }
      identity ??= count
      tokens += count.tokens
      upperBoundTokens += count.tokens
    } else {
      if (estimateIdentity !== undefined
        && (estimateIdentity.estimatorId !== count.estimatorId
          || estimateIdentity.estimatorRevision !== count.estimatorRevision)) {
        firstRefusal ??= unavailableTokenCount(`${subject}: image estimator identity changed within one measurement`)
        return false
      }
      estimateIdentity ??= {
        estimatorId: count.estimatorId,
        estimatorRevision: count.estimatorRevision,
      }
      tokens += count.tokens
      upperBoundTokens += count.upperBoundTokens
    }
    return Number.isSafeInteger(tokens) && tokens >= 0
      && Number.isSafeInteger(upperBoundTokens) && upperBoundTokens >= tokens
  }
  const walk = (content: readonly ContentBlock[]): boolean => {
    for (const block of content) {
      switch (block.type) {
        case 'text':
        case 'reasoning': {
          if (!absorb(counter.countText(block.text))) return false
          break
        }
        case 'tool-call': {
          if (!absorb(counter.countText(block.name))) return false
          if (!absorb(counter.countText(block.arguments))) return false
          break
        }
        case 'tool-result': {
          if (!walk(block.content)) return false
          break
        }
        case 'image': {
          if (!absorb(counter.countImage(block.attachment))) return false
          break
        }
        default: {
          firstRefusal ??= unavailableTokenCount(`${subject}: contains an unsupported content block`)
          return false
        }
      }
    }
    return true
  }
  if (!walk(blocks)) {
    if (firstRefusal?.kind === 'unavailable') {
      return unavailableTokenCount(`${subject}: ${firstRefusal.reason}`)
    }
    return unavailableTokenCount(`${subject}: contains content the canonical counter cannot count exactly`)
  }
  if (identity === undefined && estimateIdentity === undefined) {
    // Empty content is a legal durable shape; it keeps the exact-0 count with
    // the bound tokenizer identity instead of fail-opening the whole surface.
    const empty = counter.countText('')
    if (empty.kind !== 'exact-tokenizer') return empty
    return empty
  }
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    return unavailableTokenCount(`${subject}: invalid token sum`)
  }
  if (estimateIdentity !== undefined) {
    return Object.freeze({
      kind: 'tokenizer-estimate',
      ...estimateIdentity,
      tokens,
      upperBoundTokens,
    })
  }
  if (identity === undefined) return unavailableTokenCount(`${subject}: no tokenizer identity`)
  return Object.freeze({ ...identity, tokens })
}

function bindCounter(provider: string | undefined, model: string | undefined): CanonicalCounter {
  if (provider === undefined || model === undefined) {
    const unavailable = () => unavailableTokenCount('canonical text: no durable provider/model request header')
    return { countText: unavailable, countImage: () => unavailableTokenCount('canonical image: no durable provider/model request header') }
  }
  if (provider !== 'deepseek' && provider !== 'deepseek-official') {
    const reason = `canonical text: provider "${provider}" is not the supported DeepSeek route`
    return { countText: () => unavailableTokenCount(reason), countImage: () => unavailableTokenCount(`canonical image: provider "${provider}" is not the supported DeepSeek route`) }
  }
  const tokenizer = deepSeekV4TokenizerForModel(model)
  if (tokenizer === undefined) {
    const reason = `canonical text: no verified bundled tokenizer for model "${model}"`
    return {
      countText: () => unavailableTokenCount(reason),
      // Image arithmetic is independently pinned and does not need the text
      // tokenizer asset. A pure-image node can therefore retain its estimate
      // even when text measurement fails closed.
      countImage: attachment => countCanonicalImage(model, attachment),
    }
  }
  return {
    countText: (text: string) => tokenizer.countText(text),
    countImage: attachment => countCanonicalImage(model, attachment),
  }
}

/**
 * Images never claim an exact count. The official expansion depends on the
 * absolute prompt position (system prompt, chat-template framing, adapter
 * image handles) and on the adapter's final request-image projection, neither
 * of which is exposed through a public API; a route may even override the
 * pixel budget or re-project under the byte cap. Valid dimensions therefore
 * use the midpoint of the four alignment residues as a bounded estimate;
 * malformed dimensions use a fixed default. Estimate-bearing nodes remain
 * ineligible for exact rewrite proofs.
 */
function countCanonicalImage(
  model: string,
  attachment: CanonicalImageAttachment,
): TokenCount {
  if (model !== VISION_MODEL_ID) {
    return unavailableTokenCount(`canonical image: model "${model}" has no vision image counter`)
  }
  const estimate = estimateDeepSeekVisionImageTokens(attachment.width, attachment.height)
  return Object.freeze({
    kind: 'tokenizer-estimate',
    tokens: estimate.tokens,
    upperBoundTokens: estimate.upperBoundTokens,
    estimatorId: DEEPSEEK_VISION_IMAGE_ESTIMATOR.id,
    estimatorRevision: DEEPSEEK_VISION_IMAGE_ESTIMATOR.revision,
  })
}

/**
 * Intrinsic-grid diagnostic for one content walk: the official block
 * arithmetic on intrinsic dimensions at both alignment extremes. Only images
 * on the pinned DeepSeek vision route with usable metadata contribute.
 */
function intrinsicImageDiagnostic(
  blocks: readonly ContentBlock[],
  target: { readonly provider: string, readonly model: string } | undefined,
): IntrinsicImageBlockDiagnostic | undefined {
  // Mirror the gating route: only the DeepSeek vision route carries the
  // official-arithmetic bounds.
  if (target === undefined
    || (target.provider !== 'deepseek' && target.provider !== 'deepseek-official')
    || target.model !== VISION_MODEL_ID) return undefined
  let paddingMinimumTokens = 0
  let paddingMaximumTokens = 0
  let seen = false
  const walk = (content: readonly ContentBlock[]): void => {
    for (const block of content) {
      if (block.type === 'image') {
        const { width, height } = block.attachment
        const estimate = estimateDeepSeekVisionImageTokens(width, height)
        if (estimate.source !== 'intrinsic-grid'
          || estimate.paddingMinimumTokens === undefined
          || estimate.paddingMaximumTokens === undefined) continue
        paddingMinimumTokens += estimate.paddingMinimumTokens
        paddingMaximumTokens += estimate.paddingMaximumTokens
        seen = true
      } else if (block.type === 'tool-result') {
        walk(block.content)
      }
    }
  }
  walk(blocks)
  return seen ? Object.freeze({ paddingMinimumTokens, paddingMaximumTokens }) : undefined
}

function countSurfaceCounts(counts: readonly TokenCount[], subject: string): TokenCount {
  if (counts.length === 0) return unavailableTokenCount(`${subject}: no surface nodes`)
  let identity: Extract<TokenCount, { kind: 'exact-tokenizer' }> | undefined
  let estimateIdentity: Pick<TokenizerEstimateTokenCount, 'estimatorId' | 'estimatorRevision'> | undefined
  let tokens = 0
  let upperBoundTokens = 0
  for (const count of counts) {
    if (count.kind === 'unavailable') {
      return unavailableTokenCount(`${subject}: ${count.reason}`)
    }
    if (count.kind === 'exact-tokenizer') {
      if (identity !== undefined
        && (identity.tokenizerId !== count.tokenizerId
          || identity.tokenizerRevision !== count.tokenizerRevision)) {
        return unavailableTokenCount(`${subject}: tokenizer identity changed within one measurement`)
      }
      identity ??= count
      tokens += count.tokens
      upperBoundTokens += count.tokens
    } else {
      if (estimateIdentity !== undefined
        && (estimateIdentity.estimatorId !== count.estimatorId
          || estimateIdentity.estimatorRevision !== count.estimatorRevision)) {
        return unavailableTokenCount(`${subject}: image estimator identity changed within one measurement`)
      }
      estimateIdentity ??= {
        estimatorId: count.estimatorId,
        estimatorRevision: count.estimatorRevision,
      }
      tokens += count.tokens
      upperBoundTokens += count.upperBoundTokens
    }
  }
  if (!Number.isSafeInteger(tokens) || tokens < 0
    || !Number.isSafeInteger(upperBoundTokens) || upperBoundTokens < tokens) {
    return unavailableTokenCount(`${subject}: invalid token sum`)
  }
  if (estimateIdentity !== undefined) {
    return Object.freeze({
      kind: 'tokenizer-estimate',
      ...estimateIdentity,
      tokens,
      upperBoundTokens,
    })
  }
  if (identity === undefined) return unavailableTokenCount(`${subject}: no tokenizer identity`)
  return Object.freeze({ ...identity, tokens })
}
