/** Structured, content-free runtime audit records for context compression. */

import type {
  CompressionPolicy,
  CompressionProfile,
  ContextCompressionSettings,
  HistoryMode,
  ResolvedConfig,
} from './types.ts'

/** Stable prefix used to locate one JSON audit record in Harness runtime logs. */
export const COMPRESSION_AUDIT_PREFIX = 'context-compression audit '

/** Compression primitive that committed one model-free surface rewrite. */
export type CompressionAuditComponent =
  | 'fresh'
  | 'aggregate'
  | 'history'
  | 'tail-trim'
  | 'native-tool-result'

/** Non-mutating outcome of evaluating one component at one runtime boundary. */
export type CompressionAuditEvaluationStatus = 'disabled' | 'skipped'

interface CompressionAuditBase {
  readonly schemaVersion: 1
  readonly sessionId: string
}

/** Complete settings and deployment config frozen on first runtime observation. */
export interface CompressionPolicyFrozenAuditRecord extends CompressionAuditBase {
  readonly kind: 'policy-frozen'
  readonly settingsSource: 'host-settings' | 'plugin-config-fallback'
  readonly settings: ContextCompressionSettings
  readonly deploymentConfig: ResolvedConfig
}

/** One effective policy resolution, including context-percent capacity when used. */
export interface CompressionPolicyResolvedAuditRecord extends CompressionAuditBase {
  readonly kind: 'policy-resolved'
  readonly policy: CompressionPolicy
  readonly contextWindowTokens?: number
}

/** One committed model-free surface rewrite and its exact token accounting. */
export interface CompressionRewriteAuditRecord extends CompressionAuditBase {
  readonly kind: 'rewrite'
  readonly profile: CompressionProfile
  readonly component: CompressionAuditComponent
  readonly stage: 'fresh' | 'pressure'
  readonly reducer: string
  readonly historyMode?: HistoryMode
  readonly manifestEventType: 'compaction/prune'
  readonly manifestSeq: number
  readonly replacementSeq: number
  readonly sourceSeqs: readonly number[]
  readonly tokensBefore: number
  readonly tokensAfter: number
  readonly tokensRemoved: number
  readonly tokenizerId: string
  readonly tokenizerRevision: string
}

/** Why an enabled component did not rewrite, or why it was disabled. */
export interface CompressionComponentEvaluationAuditRecord extends CompressionAuditBase {
  readonly kind: 'component-evaluation'
  readonly profile: CompressionProfile
  readonly component: CompressionAuditComponent
  readonly stage: 'fresh' | 'pressure'
  readonly status: CompressionAuditEvaluationStatus
  readonly reason: string
  readonly historyMode?: HistoryMode
  readonly measurementKind?: 'exact-tokenizer' | 'tokenizer-estimate' | 'unavailable'
  readonly currentTokens?: number
  readonly triggerTokens?: number
  readonly targetTokens?: number
}

/** One fail-open runtime error, without prompt or tool-result content. */
export interface CompressionFailureAuditRecord extends CompressionAuditBase {
  readonly kind: 'failure'
  readonly stage: 'fresh' | 'pressure'
  readonly operation: 'request-boundary' | 'terminal-pass' | 'policy-resolution' | 'publication'
  readonly component?: CompressionAuditComponent
  readonly manifestSeq?: number
  readonly errorName: string
  readonly errorMessage: string
}

/** One observed core Native auto-compaction summary event. */
export interface NativeAutoCompactAuditRecord extends CompressionAuditBase {
  readonly kind: 'native-auto-compact'
  readonly manifestEventType: 'compaction/summary'
  readonly manifestSeq: number
  readonly reducer: 'llm-summary'
  readonly provider: string
  readonly model: string
  readonly tokensBefore: number | null
  readonly tokensAfter: null
}

/** Closed version-one context-compression audit vocabulary. */
export type CompressionAuditRecord =
  | CompressionPolicyFrozenAuditRecord
  | CompressionPolicyResolvedAuditRecord
  | CompressionRewriteAuditRecord
  | CompressionComponentEvaluationAuditRecord
  | CompressionFailureAuditRecord
  | NativeAutoCompactAuditRecord

/** Minimal logger method consumed by the audit publisher. */
export interface CompressionAuditLogger {
  /**
   * Publish one informational message.
   * @param message - complete single-line audit message.
   * @returns logger-specific chaining value, if any.
   */
  info(message: string): unknown
}

/**
 * Encode one stable single-line audit message.
 * @param record - content-free structured audit record.
 * @returns the fixed prefix followed by one JSON object.
 */
export function formatCompressionAudit(record: CompressionAuditRecord): string {
  return `${COMPRESSION_AUDIT_PREFIX}${JSON.stringify(record)}`
}

/**
 * Publish one audit message through the Harness logger.
 * @param logger - current plugin logger.
 * @param record - structured record committed by the caller.
 */
export function emitCompressionAudit(
  logger: CompressionAuditLogger,
  record: CompressionAuditRecord,
): void {
  try {
    logger.info(formatCompressionAudit(record))
  }
  catch {
    // Swallow logger failures: audit publication must not roll back a committed rewrite.
  }
}
