/** Token counts owned by the standalone compression runtime. */

/** Exact count of one canonical value under a pinned tokenizer artifact. */
export interface ExactTokenizerTokenCount {
  readonly kind: 'exact-tokenizer'
  readonly tokens: number
  readonly tokenizerId: string
  readonly tokenizerRevision: string
}

/** A value that the bundled tokenizer cannot safely count. */
export interface UnavailableTokenCount {
  readonly kind: 'unavailable'
  readonly reason: string
}

/** Best-effort estimate carrying a conservative upper value when available. */
export interface TokenizerEstimateTokenCount {
  readonly kind: 'tokenizer-estimate'
  readonly tokens: number
  readonly upperBoundTokens: number
  readonly estimatorId: string
  readonly estimatorRevision: string
  readonly calibration?: Readonly<{
    readonly sampleCount: number
    readonly conservativeMarginTokens: number
  }>
}

/** Exact, conservative request estimate, or an explicit refusal. */
export type TokenCount = ExactTokenizerTokenCount | TokenizerEstimateTokenCount | UnavailableTokenCount

/** Bound exact text counter for one durable provider/model request target. */
export type CanonicalTextTokenCounter = (text: string) => TokenCount

/** Build an explicit unavailable result without inventing an estimate. */
export function unavailableTokenCount(reason: string): UnavailableTokenCount {
  if (reason.length === 0) throw new TypeError('unavailable token count requires a reason')
  return Object.freeze({ kind: 'unavailable', reason })
}

/** Sum independent canonical fields only when every count has one identity. */
export function countExactCanonicalTextFields(
  fields: readonly string[],
  counter: CanonicalTextTokenCounter,
  subject: string,
): TokenCount {
  if (subject.length === 0) throw new TypeError('canonical text field count requires a subject')
  const values = fields.length === 0 ? [''] : fields
  let identity: ExactTokenizerTokenCount | undefined
  let tokens = 0
  for (const value of values) {
    const count = counter(value)
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
    if (!Number.isSafeInteger(tokens) || tokens < 0) {
      return unavailableTokenCount(`${subject}: token sum is outside the safe integer range`)
    }
  }
  if (identity === undefined) return unavailableTokenCount(`${subject}: no tokenizer identity`)
  return Object.freeze({ ...identity, tokens })
}
