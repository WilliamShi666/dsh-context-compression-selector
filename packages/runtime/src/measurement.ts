/** Public-API-only measurement adapter for the standalone runtime. */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-token-meter'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import { deepSeekV4TokenizerForModel } from './deepseek-v4-tokenizer.ts'
import {
  countExactCanonicalTextFields,
  unavailableTokenCount,
} from './token-count.ts'
import type { CanonicalTextTokenCounter, TokenCount } from './token-count.ts'

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

/** One same-revision surface node with exact or explicitly unavailable count. */
export interface MeasuredTokenSurfaceNode {
  readonly seq: number
  readonly count: TokenCount
}

/** Compression view derived only from published Session and TokenMeter methods. */
export interface CompactionTokenView extends TokenMeasurement {
  readonly providerRoute?: string
  readonly modelId?: string
  readonly measuredNodes: readonly MeasuredTokenSurfaceNode[]
  readonly currentSurface: TokenCount
  readonly latestEnvelopeKey?: ProviderMeasurementKey
  readonly lastCompletedUsage?: ObservedPromptUsage
  countCanonicalText(text: string): TokenCount
}

/**
 * Capture one route-bound view without calling patched Harness methods.
 * Official `measure()` remains authoritative for request pressure; the bundled
 * tokenizer supplies exact canonical content counts used by safe rewrites.
 */
export function measureForCompaction(ctx: Context, session: Session): CompactionTokenView {
  const header = session.requestHeader()
  const measurement = ctx.tokenMeter.measure(session, header)
  const target = header?.config
  const countCanonicalText = bindCounter(target?.provider, target?.model)
  const measuredNodes = measurement.nodes.map((node): MeasuredTokenSurfaceNode => {
    const event = session.events[node.seq]
    if (event === undefined) {
      return { seq: node.seq, count: unavailableTokenCount(`surface node ${String(node.seq)} is missing`) }
    }
    const message = deriveEventMessage(event)
    if (message === null) {
      return { seq: node.seq, count: unavailableTokenCount(`surface node ${String(node.seq)} is not model-visible`) }
    }
    const fields = canonicalTextFields(message.content)
    if (fields === undefined) {
      return { seq: node.seq, count: unavailableTokenCount(`surface node ${String(node.seq)} contains unsupported rich content`) }
    }
    return {
      seq: node.seq,
      count: countExactCanonicalTextFields(fields, countCanonicalText, `surface node ${String(node.seq)}`),
    }
  })
  const currentSurface = countExactCounts(
    measuredNodes.map(node => node.count),
    'current surface',
  )
  return Object.freeze({
    ...measurement,
    ...(target === undefined ? {} : { providerRoute: target.provider, modelId: target.model }),
    measuredNodes: Object.freeze(measuredNodes),
    currentSurface,
    countCanonicalText,
  })
}

/** Request-level usage exposed by official TokenMeter, without invented route attribution. */
export function officialRequestUsage(view: CompactionTokenView): Readonly<TokenUsage> | undefined {
  return view.baseline.kind === 'usage' ? view.baseline.usage : undefined
}

function bindCounter(provider: string | undefined, model: string | undefined): CanonicalTextTokenCounter {
  if (provider === undefined || model === undefined) {
    return () => unavailableTokenCount('canonical text: no durable provider/model request header')
  }
  if (provider !== 'deepseek' && provider !== 'deepseek-official') {
    return () => unavailableTokenCount(`canonical text: provider "${provider}" is not the supported DeepSeek route`)
  }
  const tokenizer = deepSeekV4TokenizerForModel(model)
  if (tokenizer === undefined) {
    return () => unavailableTokenCount(`canonical text: no verified bundled tokenizer for model "${model}"`)
  }
  return (text: string) => tokenizer.countText(text)
}

function canonicalTextFields(blocks: readonly ContentBlock[]): readonly string[] | undefined {
  const fields: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        fields.push(block.text)
        break
      case 'tool-call':
        fields.push(block.name, block.arguments)
        break
      case 'tool-result': {
        const nested = canonicalTextFields(block.content)
        if (nested === undefined) return undefined
        fields.push(...nested)
        break
      }
      default:
        return undefined
    }
  }
  return fields
}

function countExactCounts(counts: readonly TokenCount[], subject: string): TokenCount {
  if (counts.length === 0) return unavailableTokenCount(`${subject}: no surface nodes`)
  let identity: Extract<TokenCount, { kind: 'exact-tokenizer' }> | undefined
  let tokens = 0
  for (const count of counts) {
    if (count.kind !== 'exact-tokenizer') {
      return unavailableTokenCount(`${subject}: ${count.kind === 'unavailable'
        ? count.reason
        : 'canonical content requires an exact tokenizer count'}`)
    }
    if (identity !== undefined
      && (identity.tokenizerId !== count.tokenizerId
        || identity.tokenizerRevision !== count.tokenizerRevision)) {
      return unavailableTokenCount(`${subject}: tokenizer identity changed within one measurement`)
    }
    identity ??= count
    tokens += count.tokens
  }
  if (identity === undefined || !Number.isSafeInteger(tokens) || tokens < 0) {
    return unavailableTokenCount(`${subject}: invalid token sum`)
  }
  return Object.freeze({ ...identity, tokens })
}
