import { createHash } from 'node:crypto'

const CACHE_PREFIX_AUDIT_VERSION = 'dsh-prefix-audit-v1' as const

type JsonPrimitive = boolean | number | string | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export interface StablePrefixEnvelope {
  provider: string
  model: string
  system: JsonValue
  tools: JsonValue[]
  messages: JsonValue[]
}

export interface PrefixAssessmentInput {
  mode: 'fork' | 'spawn'
  inheritsParentContext: boolean
  parent: StablePrefixEnvelope
  child: StablePrefixEnvelope
}

export interface CacheUsage {
  cacheReadTokens: number
  cacheMissTokens: number
  observedPromptTokens: number
}

export interface SafeCacheAuditInput {
  fingerprint: string
  estimatedSharedPrefixTokens: number
  parentSessionId: string
  childSessionId: string
  mode: 'fork' | 'spawn'
  eligible: boolean
  reason: string
  cacheReadTokens?: number
  cacheMissTokens?: number
  observedPromptTokens?: number
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value === null || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalize(item)]),
  )
}

const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value))

export const fingerprintStablePrefix = (envelope: StablePrefixEnvelope): string => {
  const payload = canonicalJson({ auditVersion: CACHE_PREFIX_AUDIT_VERSION, envelope })
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

export const assessReusablePrefix = (
  input: PrefixAssessmentInput,
): { eligible: boolean; reason: 'identical-fork-prefix' | 'spawn-does-not-inherit' | 'stable-prefix-mismatch' } => {
  if (input.mode === 'spawn' || !input.inheritsParentContext) {
    return { eligible: false, reason: 'spawn-does-not-inherit' }
  }
  if (canonicalJson(input.parent) !== canonicalJson(input.child)) {
    return { eligible: false, reason: 'stable-prefix-mismatch' }
  }
  return { eligible: true, reason: 'identical-fork-prefix' }
}

export const validateCacheUsage = (usage: CacheUsage): boolean => (
  Number.isSafeInteger(usage.cacheReadTokens)
  && Number.isSafeInteger(usage.cacheMissTokens)
  && Number.isSafeInteger(usage.observedPromptTokens)
  && usage.cacheReadTokens >= 0
  && usage.cacheMissTokens >= 0
  && usage.observedPromptTokens >= 0
  && usage.cacheReadTokens + usage.cacheMissTokens === usage.observedPromptTokens
)

export const buildSafeCacheAuditRecord = (input: SafeCacheAuditInput) => ({
  auditVersion: CACHE_PREFIX_AUDIT_VERSION,
  fingerprint: input.fingerprint,
  estimatedSharedPrefixTokens: input.estimatedSharedPrefixTokens,
  parentSessionId: input.parentSessionId,
  childSessionId: input.childSessionId,
  mode: input.mode,
  eligible: input.eligible,
  reason: input.reason,
  cacheReadTokens: input.cacheReadTokens ?? null,
  cacheMissTokens: input.cacheMissTokens ?? null,
  observedPromptTokens: input.observedPromptTokens ?? null,
  confirmationStatus: input.cacheReadTokens !== undefined
    && input.cacheMissTokens !== undefined
    && input.observedPromptTokens !== undefined
    && input.cacheReadTokens > 0
    && validateCacheUsage({
      cacheReadTokens: input.cacheReadTokens,
      cacheMissTokens: input.cacheMissTokens,
      observedPromptTokens: input.observedPromptTokens,
    })
    ? 'confirmed'
    : 'unconfirmed',
})
