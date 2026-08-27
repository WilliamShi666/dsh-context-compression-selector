/** Public context-compression choices shared by the Host schema and browser selector. */
export const COMPRESSION_PROFILES = [
  'off',
  'native',
  'balanced',
  'cache-strict',
  'savings',
  'adaptive',
  'custom',
] as const

/** One supported context-compression profile. */
export type CompressionProfile = typeof COMPRESSION_PROFILES[number]

/** Single canonical unit stored by a version-1 browser Custom document. */
export type CustomCompressionUnit = 'tokens' | 'context-percent'

/** Whether Custom History may routinely rewrite an already-sent prefix. */
export type CustomPrefixPolicy = 'preserve' | 'pressure-break'

/** Browser representation of one independently enabled Fresh or Aggregate budget. */
export interface CustomCompressionBudget {
  enabled: boolean
  trigger: number
  target: number
}

/** Legacy browser representation of the Custom History working set. */
export interface LegacyCustomHistoryPolicy {
  enabled: boolean
  trigger: number
  keepRecentTurns: number
  keepRecent: number
  minReclaim: number
}

/** Browser representation of Custom History tool-call and token-tail protection. */
export interface CustomHistoryPolicy {
  enabled: boolean
  trigger: number
  keepRecentToolCalls: number
  keepRecentTokens: number
  minReclaim: number
}

/** Browser representation of the Custom-only Experimental TailTrim gate. */
export interface CustomTailTrimPolicy {
  enabled: boolean
  trigger: number
}

interface CustomCompressionPolicyCommon<HistoryPolicy> {
  unit: CustomCompressionUnit
  fresh: CustomCompressionBudget
  aggregate: CustomCompressionBudget
  history: HistoryPolicy
  prefixPolicy: CustomPrefixPolicy
}

/** Legacy public Custom document; accepted and normalized before editing. */
export interface CustomCompressionPolicyV1 extends CustomCompressionPolicyCommon<LegacyCustomHistoryPolicy> {
  version: 1
}

/** Legacy Custom document with a default-disabled TailTrim stage. */
export interface CustomCompressionPolicyV2 extends CustomCompressionPolicyCommon<LegacyCustomHistoryPolicy> {
  version: 2
  tailTrim: CustomTailTrimPolicy
}

/** Public Custom document with tool-call working-set protection. */
export interface CustomCompressionPolicyV3 extends CustomCompressionPolicyCommon<CustomHistoryPolicy> {
  version: 3
  tailTrim: CustomTailTrimPolicy
}

/** Exact public Custom document accepted by the Host and browser boundary. */
export type CustomCompressionPolicy = CustomCompressionPolicyV1 | CustomCompressionPolicyV2 | CustomCompressionPolicyV3

/** Browser-safe mirror of the Host's Balanced-equivalent Custom default. */
export const DEFAULT_CUSTOM_COMPRESSION_POLICY: CustomCompressionPolicyV3 = {
  version: 3,
  unit: 'tokens',
  fresh: { enabled: true, trigger: 8_192, target: 3_072 },
  aggregate: { enabled: true, trigger: 32_768, target: 12_288 },
  history: {
    enabled: true,
    trigger: 500_000,
    keepRecentToolCalls: 10,
    keepRecentTokens: 64_000,
    minReclaim: 96_000,
  },
  prefixPolicy: 'pressure-break',
  tailTrim: { enabled: false, trigger: 700_000 },
}

/** Durable settings section owned by this package. */
export interface ContextCompressionSettings {
  /** Default profile captured when each Session first reaches the pruner. */
  profile: CompressionProfile
  /** Complete canonical policy captured with `profile` when the runtime first observes a Session. */
  custom: CustomCompressionPolicy
}

/**
 * Narrow an unknown settings value to a complete supported Custom policy.
 * @param value - Candidate settings value received from the Host or edited locally.
 * @returns Whether the value is a relation-valid Custom policy.
 */
export function isCustomCompressionPolicy(value: unknown): value is CustomCompressionPolicy {
  if (!hasExactKeys(
    value,
    value !== null && typeof value === 'object' && 'version' in value && value.version === 1
      ? ['version', 'unit', 'fresh', 'aggregate', 'history', 'prefixPolicy']
      : ['version', 'unit', 'fresh', 'aggregate', 'history', 'prefixPolicy', 'tailTrim'],
  )) return false
  if ((value.version !== 1 && value.version !== 2 && value.version !== 3)
    || (value.unit !== 'tokens' && value.unit !== 'context-percent')) return false
  if (value.prefixPolicy !== 'preserve' && value.prefixPolicy !== 'pressure-break') return false
  if (!isBudget(value.fresh) || !isBudget(value.aggregate)) return false
  const modernHistory = value.version === 3
  if (!hasExactKeys(
    value.history,
    modernHistory
      ? ['enabled', 'trigger', 'keepRecentToolCalls', 'keepRecentTokens', 'minReclaim']
      : ['enabled', 'trigger', 'keepRecentTurns', 'keepRecent', 'minReclaim'],
  )) return false
  if (typeof value.history.enabled !== 'boolean'
    || typeof value.history.trigger !== 'number'
    || typeof value.history.minReclaim !== 'number') return false
  const recent = modernHistory
    ? value.history.keepRecentTokens
    : value.history.keepRecent
  const calls = modernHistory ? value.history.keepRecentToolCalls : value.history.keepRecentTurns
  if (typeof recent !== 'number'
    || typeof calls !== 'number'
    || !Number.isSafeInteger(calls)
    || calls < 0) return false
  let tailTrimTrigger: number | undefined
  if (value.version !== 1) {
    const tailTrim = value.tailTrim
    if (!hasExactKeys(tailTrim, ['enabled', 'trigger'])
      || typeof tailTrim.enabled !== 'boolean'
      || typeof tailTrim.trigger !== 'number') return false
    tailTrimTrigger = tailTrim.trigger
  }
  const measured = [
    value.fresh.trigger, value.fresh.target,
    value.aggregate.trigger, value.aggregate.target,
    value.history.trigger, recent, value.history.minReclaim,
    ...tailTrimTrigger === undefined ? [] : [tailTrimTrigger],
  ]
  if (!measured.every(entry => typeof entry === 'number' && Number.isFinite(entry))) return false
  if (value.fresh.trigger <= 0 || value.fresh.target <= 0
    || value.aggregate.trigger <= 0 || value.aggregate.target <= 0
    || value.history.trigger <= 0 || recent < 0
    || value.history.minReclaim <= 0
    || (tailTrimTrigger !== undefined && tailTrimTrigger <= 0)) return false
  if (value.unit === 'tokens' && !measured.every(Number.isSafeInteger)) return false
  if (value.unit === 'context-percent' && !measured.every(entry => entry <= 100)) return false
  return value.fresh.target < value.fresh.trigger
    && value.aggregate.target < value.aggregate.trigger
    && value.history.minReclaim <= value.history.trigger
}

function isBudget(value: unknown): value is CustomCompressionBudget {
  return hasExactKeys(value, ['enabled', 'trigger', 'target'])
    && typeof value.enabled === 'boolean'
    && typeof value.trigger === 'number'
    && typeof value.target === 'number'
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return keys.length === expected.length && keys.every(key => expected.includes(key))
}
