import type { CallId } from '@deepseek-ai/dsh-llm'

/** User-facing mixed strategy profile. */
export const COMPRESSION_PROFILES = [
  'off',
  'native',
  'balanced',
  'cache-strict',
  'savings',
  'adaptive',
  'custom',
] as const

/** Public compression strategy selected for one Session. */
export type CompressionProfile = typeof COMPRESSION_PROFILES[number]

/** When historical tool results may be aged for one Session policy. */
export type HistoryMode = 'disabled' | 'routine' | 'capacity-pressure' | 'adaptive'

/** Canonical unit stored by one versioned Custom policy. */
export type CustomCompressionUnit = 'tokens' | 'context-percent'

/** Whether routine History may rewrite a previously sent Harness prefix. */
export type CustomPrefixPolicy = 'preserve' | 'pressure-break'

/** One independently selectable Custom Fresh or Aggregate stage. */
export interface CustomCompressionBudget {
  enabled: boolean
  trigger: number
  target: number
}

/** Custom History gate and recent working-set protection. */
export interface CustomHistoryPolicy {
  enabled: boolean
  trigger: number
  keepRecentTurns: number
  keepRecent: number
  minReclaim: number
}

/** Custom-only experimental TailTrim gate. */
export interface CustomTailTrimPolicy {
  enabled: boolean
  trigger: number
}

/** Common user-authored Custom stages shared by persisted policy versions. */
interface CustomCompressionPolicyFields {
  unit: CustomCompressionUnit
  fresh: CustomCompressionBudget
  aggregate: CustomCompressionBudget
  history: CustomHistoryPolicy
  prefixPolicy: CustomPrefixPolicy
}

/** Legacy R4 Custom policy, accepted without migration. */
export interface CustomCompressionPolicyV1 extends CustomCompressionPolicyFields {
  version: 1
}

/** R5 Custom policy with an explicit default-off TailTrim stage. */
export interface CustomCompressionPolicyV2 extends CustomCompressionPolicyFields {
  version: 2
  tailTrim: CustomTailTrimPolicy
}

/** Strict persisted Custom policy union. */
export type CustomCompressionPolicy = CustomCompressionPolicyV1 | CustomCompressionPolicyV2

/** Durable global preference exposed through `ctx.settings`. */
export interface ContextCompressionSettings {
  /** Default strategy snapped when a Session first reaches the pruner. */
  profile: CompressionProfile
  /** Versioned Custom policy snapped with `profile` for a newly observed Session. */
  custom: CustomCompressionPolicy
}

/** Token-gated policy with character fields limited to reducer candidate shape. */
export interface ToolResultPruneConfig {
  /** Composition fallback when Host settings are unavailable. Defaults to `balanced`. */
  profile?: CompressionProfile
  /** Native fallback leading Unicode code points. Defaults to `4096`. */
  headChars?: number
  /** Native fallback trailing Unicode code points. Defaults to `1024`. */
  tailChars?: number
  /** Native original-content token trigger. Profile default when omitted. */
  nativeTriggerTokens?: number
  /** Native replacement token target. Profile default when omitted. */
  nativeTargetTokens?: number
  /** Fresh-result exact-token trigger. Profile default when omitted. */
  freshTriggerTokens?: number
  /** Maximum fresh-result exact-token replacement size. Profile default when omitted. */
  freshTargetTokens?: number
  /** Combined completed-step token pressure that starts aggregate reduction. */
  aggregateTriggerTokens?: number
  /** Aggregate token target after completed-step pressure exceeds its trigger. */
  aggregateTargetTokens?: number
  /** Total live tool-result tokens that permit historical aging. Profile default when omitted. */
  historyTriggerTokens?: number
  /** Recent complete user turns protected from historical aging. Profile default when omitted. */
  historyKeepRecentTurns?: number
  /** Recent tool-result token working set protected in addition to turns. Profile default when omitted. */
  historyKeepRecentTokens?: number
  /** Minimum reclaim required before historical aging is worth a cache break. Profile default when omitted. */
  historyMinReclaimTokens?: number
}

/** Resolved per-profile behavior. */
export interface CompressionPolicy {
  readonly profile: CompressionProfile
  readonly freshEnabled: boolean
  readonly aggregateEnabled: boolean
  readonly historyMode: HistoryMode
  readonly nativeTriggerTokens: number
  readonly nativeTargetTokens: number
  readonly freshTriggerTokens: number
  readonly freshTargetTokens: number
  readonly aggregateTriggerTokens: number
  readonly aggregateTargetTokens: number
  readonly historyTriggerTokens: number
  readonly historyKeepRecentTurns: number
  readonly historyKeepRecentTokens: number
  readonly historyMinReclaimTokens: number
  /** Present only for Custom v2; standard profiles and Custom v1 carry no TailTrim policy. */
  readonly tailTrim?: {
    readonly enabled: boolean
    readonly triggerTokens: number
  }
}

/** Validated, detached, deeply immutable configuration. */
export interface ResolvedConfig {
  readonly profile: CompressionProfile
  readonly headChars: number
  readonly tailChars: number
  readonly nativeTriggerTokens?: number
  readonly nativeTargetTokens?: number
  readonly freshTriggerTokens?: number
  readonly freshTargetTokens?: number
  readonly aggregateTriggerTokens?: number
  readonly aggregateTargetTokens?: number
  readonly historyTriggerTokens?: number
  readonly historyKeepRecentTurns?: number
  readonly historyKeepRecentTokens?: number
  readonly historyMinReclaimTokens?: number
}

/** Why a pruning pass runs. */
export type PruneStage = 'fresh' | 'pressure'

/** Optional control over one pruning pass. */
export interface PruneSessionOptions {
  /** `fresh` only reduces never-before-seen oversized results; `pressure` may age older results too. */
  stage?: PruneStage
  /** Routed model context capacity used only to resolve a context-percent Custom snapshot. */
  contextWindowTokens?: number
  /** Proposed turn at the pre-step boundary. Used with `freshStep` to freeze keep/reduce decisions. */
  freshTurn?: number
  /** The immediately preceding completed step whose tool results have not yet entered a model request. */
  freshStep?: number
}

/** Cited source event and size accounting for one landed surface replacement. */
export interface PrunedEntry {
  /** Current surface event shadowed by this replacement. */
  readonly originalSeq: number
  /** Root full-fidelity source event used in the recovery reference. */
  readonly sourceSeq: number
  /** Newly appended compressed tool-result event. */
  readonly replacementSeq: number
  /** Tool call shared by the original and replacement. */
  readonly callId: CallId
  /** Reducer or aging strategy that produced the replacement. */
  readonly reducer: string
  /** Pass stage that landed the replacement. */
  readonly stage: PruneStage
  /** Original deterministic pressure cost. */
  readonly charsBefore: number
  /** Replacement deterministic pressure cost. */
  readonly charsAfter: number
  /** Authoritative exact canonical content tokens before replacement. */
  readonly tokensBefore: number
  /** Authoritative exact canonical content tokens after replacement. */
  readonly tokensAfter: number
}

/** Aggregate outcome of one stable-surface pruning pass. */
export interface PruneResult {
  /** Replacements in landing order. */
  readonly pruned: readonly PrunedEntry[]
  /** Total deterministic pressure cost removed across replacements. */
  readonly charsRemoved: number
  /** Authoritative exact canonical content tokens removed. */
  readonly tokensRemoved: number
}
