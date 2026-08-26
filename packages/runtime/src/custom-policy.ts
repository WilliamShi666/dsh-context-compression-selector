/** Strict versioned Custom policy parsing and effective-token resolution. */

import { deepFreeze } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import type {
  CompressionPolicy,
  CustomCompressionPolicy,
} from './types.ts'

const budgetSchema = z.object({
  enabled: z.boolean().required(),
  trigger: z.number().required(),
  target: z.number().required(),
}).required()

const historySchema = z.object({
  enabled: z.boolean().required(),
  trigger: z.number().required(),
  keepRecentTurns: z.number().step(1).min(0).required(),
  keepRecent: z.number().required(),
  minReclaim: z.number().required(),
}).required()

const customCompressionPolicyV1InputSchema = z.object({
  version: z.const(1).required(),
  unit: z.union(['tokens', 'context-percent']).required(),
  fresh: budgetSchema,
  aggregate: budgetSchema,
  history: historySchema,
  prefixPolicy: z.union(['preserve', 'pressure-break']).required(),
}).required()

const customCompressionPolicyV2InputSchema = z.object({
  version: z.const(2).required(),
  unit: z.union(['tokens', 'context-percent']).required(),
  fresh: budgetSchema,
  aggregate: budgetSchema,
  history: historySchema,
  prefixPolicy: z.union(['preserve', 'pressure-break']).required(),
  tailTrim: z.object({
    enabled: z.boolean().required(),
    trigger: z.number().required(),
  }).required(),
}).required()

/** Canonical Custom document accepted by Host settings and the runtime resolver. */
export const CustomCompressionPolicySchema: z<CustomCompressionPolicy> = z.transform(
  z.any().required(),
  (value): CustomCompressionPolicy => {
    assertExactPolicyShape(value)
    const policy = value.version === 1
      ? customCompressionPolicyV1InputSchema(value) as CustomCompressionPolicy
      : customCompressionPolicyV2InputSchema(value) as CustomCompressionPolicy
    assertCanonicalRelations(policy)
    return deepFreeze(structuredClone(policy))
  },
) as z<CustomCompressionPolicy>

/** Balanced-equivalent Custom policy stored as one token-canonical document. */
export const DEFAULT_CUSTOM_COMPRESSION_POLICY: CustomCompressionPolicy = deepFreeze({
  version: 2,
  unit: 'tokens',
  fresh: { enabled: true, trigger: 8_192, target: 3_072 },
  aggregate: { enabled: true, trigger: 32_768, target: 12_288 },
  history: {
    enabled: true,
    trigger: 500_000,
    keepRecentTurns: 4,
    keepRecent: 128_000,
    minReclaim: 96_000,
  },
  prefixPolicy: 'pressure-break',
  tailTrim: { enabled: false, trigger: 700_000 },
})

/** Routed model facts needed only by context-percent Custom documents. */
export interface CustomPolicyResolutionOptions {
  /** Positive resolved shared model context capacity. */
  readonly contextWindowTokens?: number
}

/**
 * Resolve one validated Custom document to the same token policy used by public presets.
 * @param value - untrusted or typed Custom settings value.
 * @param options - routed model capacity for context-percent documents.
 * @returns a detached deeply immutable effective token policy.
 */
export function resolveCustomPolicy(
  value: CustomCompressionPolicy,
  options: CustomPolicyResolutionOptions = {},
): CompressionPolicy {
  const policy = CustomCompressionPolicySchema(value)
  const effective = (name: string, amount: number): number => {
    if (policy.unit === 'tokens') return amount
    const contextWindow = options.contextWindowTokens
    if (!Number.isSafeInteger(contextWindow) || contextWindow === undefined || contextWindow <= 0) {
      throw new Error('Custom context-percent policy requires a resolved positive model context window')
    }
    const tokens = Math.floor(contextWindow * amount / 100)
    if (!Number.isSafeInteger(tokens) || (amount > 0 && tokens <= 0)) {
      throw new Error(`Custom ${name} has no valid effective token value for this model`)
    }
    return tokens
  }
  const resolved: CompressionPolicy = {
    profile: 'custom',
    freshEnabled: policy.fresh.enabled,
    aggregateEnabled: policy.aggregate.enabled,
    historyMode: !policy.history.enabled
      ? 'disabled'
      : policy.prefixPolicy === 'preserve' ? 'capacity-pressure' : 'routine',
    nativeTriggerTokens: Number.MAX_SAFE_INTEGER,
    nativeTargetTokens: Number.MAX_SAFE_INTEGER,
    freshTriggerTokens: effective('Fresh trigger', policy.fresh.trigger),
    freshTargetTokens: effective('Fresh target', policy.fresh.target),
    aggregateTriggerTokens: effective('Aggregate trigger', policy.aggregate.trigger),
    aggregateTargetTokens: effective('Aggregate target', policy.aggregate.target),
    historyTriggerTokens: effective('History trigger', policy.history.trigger),
    historyKeepRecentTurns: policy.history.keepRecentTurns,
    historyKeepRecentTokens: effective('History recent window', policy.history.keepRecent),
    historyMinReclaimTokens: effective('History min-reclaim', policy.history.minReclaim),
    ...policy.version === 1 ? {} : {
      tailTrim: {
        enabled: policy.tailTrim.enabled,
        triggerTokens: effective('TailTrim trigger', policy.tailTrim.trigger),
      },
    },
  }
  assertEffectiveRelations(resolved)
  return deepFreeze(resolved)
}

function measuredValues(policy: CustomCompressionPolicy): readonly number[] {
  return [
    policy.fresh.trigger,
    policy.fresh.target,
    policy.aggregate.trigger,
    policy.aggregate.target,
    policy.history.trigger,
    policy.history.keepRecent,
    policy.history.minReclaim,
    ...policy.version === 1 ? [] : [policy.tailTrim.trigger],
  ]
}

function validMeasuredValues(policy: CustomCompressionPolicy): boolean {
  const values = measuredValues(policy)
  const positive = [
    policy.fresh.trigger,
    policy.fresh.target,
    policy.aggregate.trigger,
    policy.aggregate.target,
    policy.history.trigger,
    policy.history.minReclaim,
    ...policy.version === 1 ? [] : [policy.tailTrim.trigger],
  ]
  if (!positive.every(value => value > 0) || policy.history.keepRecent < 0) return false
  return policy.unit === 'tokens'
    ? values.every(Number.isSafeInteger)
    : values.every(value => Number.isFinite(value) && value <= 100)
}

function assertCanonicalRelations(policy: CustomCompressionPolicy): void {
  if (!Number.isSafeInteger(policy.history.keepRecentTurns) || policy.history.keepRecentTurns < 0) {
    throw new TypeError('Custom History recent turns must be a non-negative safe integer')
  }
  if (!validMeasuredValues(policy)) {
    throw new TypeError('Custom measured values must use the selected canonical unit')
  }
  if (policy.fresh.target >= policy.fresh.trigger) {
    throw new TypeError('Custom Fresh target must be below trigger')
  }
  if (policy.aggregate.target >= policy.aggregate.trigger) {
    throw new TypeError('Custom Aggregate target must be below trigger')
  }
  if (policy.history.minReclaim > policy.history.trigger) {
    throw new TypeError('Custom History min-reclaim must not exceed its trigger')
  }
}

function assertExactPolicyShape(value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw new TypeError('Custom must be a plain object')
  if (value.version !== 1 && value.version !== 2) {
    throw new TypeError('Custom version must be 1 or 2')
  }
  assertExactKeys(
    value,
    value.version === 1
      ? ['version', 'unit', 'fresh', 'aggregate', 'history', 'prefixPolicy']
      : ['version', 'unit', 'fresh', 'aggregate', 'history', 'prefixPolicy', 'tailTrim'],
    'Custom',
  )
  assertExactKeys(value.fresh, ['enabled', 'trigger', 'target'], 'Custom Fresh')
  assertExactKeys(value.aggregate, ['enabled', 'trigger', 'target'], 'Custom Aggregate')
  assertExactKeys(
    value.history,
    ['enabled', 'trigger', 'keepRecentTurns', 'keepRecent', 'minReclaim'],
    'Custom History',
  )
  if (value.version === 2) {
    assertExactKeys(value.tailTrim, ['enabled', 'trigger'], 'Custom TailTrim')
  }
}

function assertExactKeys(value: unknown, allowed: readonly string[], label: string): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw new TypeError(`${label} must be a plain object`)
  const allowedKeys = new Set(allowed)
  const unknown = Object.keys(value).find(key => !allowedKeys.has(key))
  if (unknown !== undefined) throw new TypeError(`${label}: unknown key "${unknown}"`)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}

function assertEffectiveRelations(policy: CompressionPolicy): void {
  if (policy.freshTargetTokens >= policy.freshTriggerTokens) {
    throw new Error('Custom effective Fresh target must be below trigger')
  }
  if (policy.aggregateTargetTokens >= policy.aggregateTriggerTokens) {
    throw new Error('Custom effective Aggregate target must be below trigger')
  }
  if (policy.historyMinReclaimTokens > policy.historyTriggerTokens) {
    throw new Error('Custom effective History min-reclaim must not exceed its trigger')
  }
}
