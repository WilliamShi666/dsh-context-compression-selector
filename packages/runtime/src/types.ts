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

/** Legacy Custom History gate and turn/token working-set protection. */
export interface LegacyCustomHistoryPolicy {
  enabled: boolean
  trigger: number
  keepRecentTurns: number
  keepRecent: number
  minReclaim: number
}

/** Custom History gate and recent tool-call/token working-set protection. */
export interface CustomHistoryPolicy {
  enabled: boolean
  trigger: number
  keepRecentToolCalls: number
  keepRecentTokens: number
  minReclaim: number
}

/** Custom-only experimental TailTrim gate. */
export interface CustomTailTrimPolicy {
  enabled: boolean
  trigger: number
}

/** Common user-authored Custom stages shared by persisted policy versions. */
interface CustomCompressionPolicyFields<HistoryPolicy> {
  unit: CustomCompressionUnit
  fresh: CustomCompressionBudget
  aggregate: CustomCompressionBudget
  history: HistoryPolicy
  prefixPolicy: CustomPrefixPolicy
}

/** Legacy R4 Custom policy, accepted without migration. */
export interface CustomCompressionPolicyV1 extends CustomCompressionPolicyFields<LegacyCustomHistoryPolicy> {
  version: 1
}

/** R5 Custom policy with an explicit default-off TailTrim stage. */
export interface CustomCompressionPolicyV2 extends CustomCompressionPolicyFields<LegacyCustomHistoryPolicy> {
  version: 2
  tailTrim: CustomTailTrimPolicy
}

/** Custom policy with tool-call working-set protection. */
export interface CustomCompressionPolicyV3 extends CustomCompressionPolicyFields<CustomHistoryPolicy> {
  version: 3
  tailTrim: CustomTailTrimPolicy
}

/** Strict persisted Custom policy union. */
export type CustomCompressionPolicy = CustomCompressionPolicyV1 | CustomCompressionPolicyV2 | CustomCompressionPolicyV3

/** User-tunable Auto Compact coordination preferences. */
export interface AutoCompactSettings {
  /** Routed-context percentage that triggers model-driven Auto Compact. */
  thresholdPercent: number
}

/** Durable global preference exposed through `ctx.settings`. */
export interface ContextCompressionSettings {
  /** Default strategy snapped when a Session first reaches the pruner. */
  profile: CompressionProfile
  /** Versioned Custom policy snapped with `profile` for a newly observed Session. */
  custom: CustomCompressionPolicy
  /** Auto Compact trigger preference snapped with `profile` for a newly observed Session. */
  autoCompact: AutoCompactSettings
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
  /** Recent completed agent tool calls protected from historical aging. Profile default when omitted. */
  historyKeepRecentToolCalls?: number
  /** Recent tool-result token tail protected in addition to tool calls. Profile default when omitted. */
  historyKeepRecentTokens?: number
  /** Minimum reclaim required before historical aging is worth a cache break. Profile default when omitted. */
  historyMinReclaimTokens?: number
  /**
   * Auto Compact threshold percent frozen into this deployment by the preset
   * overlay generation (50–90 integer). When present it supersedes the live
   * Host setting so one generation never splits Auto Compact and micro
   * compact across two thresholds.
   */
  autoCompactThresholdPercent?: number
}

/** Resolved per-profile behavior. */
export interface CompressionPolicy {
  readonly profile: CompressionProfile
  /** Whether this Session may use the selector's native-style head/middle/tail reducer. */
  readonly nativeToolResultEnabled: boolean
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
  readonly historyKeepRecentToolCalls: number
  readonly historyKeepRecentTokens: number
  readonly historyMinReclaimTokens: number
  /**
   * Auto Compact token watermark `A = floor(C × a)` when the standard-profile
   * History linkage resolved for this Session; absent for Custom, Off, Native,
   * or unresolved routed capacity.
   */
  readonly autoCompactTokens?: number
  /**
   * Micro-compact last-chance watermark `D = floor(A × 0.875)`. Absent when
   * {@link autoCompactTokens} is absent; capacity-pressure gates fall back to
   * the fixed 0.7 routed-context ratio in that case.
   */
  readonly microDeadlineTokens?: number
  /** Present for Custom v3; standard profiles and legacy Custom policies carry no TailTrim policy. */
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
  readonly historyKeepRecentToolCalls?: number
  readonly historyKeepRecentTokens?: number
  readonly historyMinReclaimTokens?: number
  /**
   * Auto Compact threshold percent frozen into this deployment by the preset
   * overlay generation (50-90 integer). Supersedes the live Host setting.
   */
  readonly autoCompactThresholdPercent?: number
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
