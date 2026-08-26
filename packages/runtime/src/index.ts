/**
 * Replay-safe, model-free context-compression selector for tool results.
 *
 * Standard profiles never rewrite ordinary Assistant prose. The only durable
 * replacements emitted here are content-only `tool/result` rewrites whose
 * full source remains in the append-only Session log.
 *
 * @module dsh-context-compression-selector-runtime
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { assertNever, deepFreeze, freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, ToolResultMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-settings'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {
  CompactionTokenView,
  ObservedPromptUsage,
  ProviderMeasurementKey,
  TokenCount,
} from './measurement.ts'
import { measureForCompaction } from './measurement.ts'
import { countExactCanonicalTextFields } from './token-count.ts'
import type {} from '@deepseek-ai/dsh-tools'
import {
  tailTrimMessage,
  tailTrimRef,
  tailTrimStub,
} from './tail-trim.ts'
import { installContextCompressionRetrieve } from './retrieve.ts'
import {
  codePointLength,
  CONTEXT_COMPRESSION_SETTINGS_NAMESPACE,
  ContextCompressionSettingsSchema,
  DEFAULTS,
  PRUNE_MARKER,
  resolveConfig,
  resolvePolicy,
} from './config.ts'
import {
  historicalPlaceholder,
  reduceFreshToolResult,
  verifyReduction,
} from './reducers.ts'
import type {
  CompressionPolicy,
  ContextCompressionSettings,
  HistoryMode,
  PrunedEntry,
  PruneResult,
  PruneSessionOptions,
  PruneStage,
  ResolvedConfig,
  ToolResultPruneConfig,
} from './types.ts'
import { COMPRESSION_PROFILES } from './types.ts'
import {
  decideConservativeAdaptive,
  deriveAdaptiveTokenBounds,
} from './adaptive-cost.ts'
import {
  DEEPSEEK_OFFICIAL_PRICE_CATALOG_VERSION,
  priceOfficialDeepSeekUsage,
  resolveOfficialDeepSeekPrice,
} from './deepseek-official-pricing.ts'
import { emitCompressionAudit } from './audit.ts'
import type {
  CompressionAuditComponent,
  CompressionAuditEvaluationStatus,
} from './audit.ts'

export {
  codePointLength,
  CONTEXT_COMPRESSION_SETTINGS_NAMESPACE,
  ContextCompressionSettingsSchema,
  DEFAULTS,
  isCompressionProfile,
  PRUNE_MARKER,
  resolveConfig,
  resolvePolicy,
} from './config.ts'
export {
  CustomCompressionPolicySchema,
  DEFAULT_CUSTOM_COMPRESSION_POLICY,
  resolveCustomPolicy,
} from './custom-policy.ts'
export type { CustomPolicyResolutionOptions } from './custom-policy.ts'
export { historicalPlaceholder, normalizeTerminalText, reduceFreshToolResult, verifyReduction } from './reducers.ts'
export type {
  CompressionPolicy,
  CompressionProfile,
  CustomCompressionBudget,
  CustomCompressionPolicy,
  CustomCompressionUnit,
  CustomHistoryPolicy,
  CustomPrefixPolicy,
  CustomTailTrimPolicy,
  CustomCompressionPolicyV1,
  CustomCompressionPolicyV2,
  ContextCompressionSettings,
  HistoryMode,
  PrunedEntry,
  PruneResult,
  PruneSessionOptions,
  PruneStage,
  ResolvedConfig,
  ToolResultPruneConfig,
} from './types.ts'

// Re-export the canonical profile list from the type module as a runtime value.
export { COMPRESSION_PROFILES } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    toolResultPruner: ToolResultPruner
  }
}

interface ToolCallInfo {
  readonly name: string
  readonly arguments: string
}

interface SnapshotCandidate {
  readonly seq: number
  readonly event: SessionEvent<'tool/result'>
  readonly call: ToolCallInfo
  /** Authoritative same-revision exact canonical content count. */
  readonly count: TokenCount
  /** Same-revision legacy heuristic price used only by bounded projections. */
  readonly shadowedHeuristicTokenCount: number
  /** Character pressure is candidate-shape telemetry only, never a gate. */
  readonly characterPressure: number
}

interface PlannedReplacement {
  readonly candidate: SnapshotCandidate
  readonly content: ContentBlock[]
  readonly sourceSeq: number
  readonly reducer: string
  readonly stage: PruneStage
  readonly component: CompressionAuditComponent
  readonly historyMode?: HistoryMode
  readonly charsBefore: number
  readonly charsAfter: number
  readonly tokensBefore: number
  readonly tokensAfter: number
  readonly tokenizerId: string
  readonly tokenizerRevision: string
}

const RICH_BLOCK_PRESSURE_COST = 256

/** Mixed deterministic selector behind the existing `ctx.toolResultPruner` seam. */
export class ToolResultPruner extends Service {
  static inject = ['tokenMeter']

  static Config: z<ToolResultPruneConfig> = z.object({
    profile: z.union([...COMPRESSION_PROFILES]).default(DEFAULTS.profile),
    headChars: z.number().step(1).min(0).default(DEFAULTS.headChars),
    tailChars: z.number().step(1).min(0).default(DEFAULTS.tailChars),
    nativeTriggerTokens: z.number().step(1).min(1).required(false),
    nativeTargetTokens: z.number().step(1).min(1).required(false),
    freshTriggerTokens: z.number().step(1).min(1).required(false),
    freshTargetTokens: z.number().step(1).min(1).required(false),
    aggregateTriggerTokens: z.number().step(1).min(1).required(false),
    aggregateTargetTokens: z.number().step(1).min(1).required(false),
    historyTriggerTokens: z.number().step(1).min(1).required(false),
    historyKeepRecentTurns: z.number().step(1).min(0).required(false),
    historyKeepRecentTokens: z.number().step(1).min(1).required(false),
    historyMinReclaimTokens: z.number().step(1).min(1).required(false),
  })

  /** Resolved immutable deployment configuration. */
  readonly config: ResolvedConfig
  /** Complete canonical setting document frozen when each Session first reaches this root service. */
  private readonly sessionSettings = new WeakMap<Session, ContextCompressionSettings>()
  /** Original result seqs whose first-exposure KEEP/REDUCE decision has committed. */
  private readonly firstExposure = new WeakMap<Session, Set<number>>()
  /** Runtime prerequisite warnings deduplicated per Session and failure key. */
  private readonly warnedFailures = new WeakMap<Session, Set<string>>()
  /** Last Adaptive postflight attempt emitted per Session; keeps diagnostics bounded and independent. */
  private readonly postflightDiagnostics = new WeakMap<Session, string>()
  /** Current pre-step chain identity, shared by this producer and downstream compaction-basic. */
  private readonly activeRequestBoundaries = new WeakMap<Session, object>()
  /** Boundary identity that already attempted one fully preflighted TailTrim publication. */
  private readonly tailTrimBoundaryAttempts = new WeakMap<Session, object>()
  /** Distinct effective policy audit keys already emitted for each Session. */
  private readonly policyResolutionAudits = new WeakMap<Session, Set<string>>()

  constructor(ctx: Context, config: ToolResultPruneConfig = {}) {
    super(ctx, 'toolResultPruner')
    ctx.inject(['tools', 'systemPrompt'], recoveryCtx => {
      installContextCompressionRetrieve(recoveryCtx)
    })
    this.config = resolveConfig(config)

    ctx.on('session/event', (session, event) => {
      if (event.type !== 'compaction/summary') return
      emitCompressionAudit(ctx.logger, {
        schemaVersion: 1,
        kind: 'native-auto-compact',
        sessionId: String(session.id),
        manifestEventType: 'compaction/summary',
        manifestSeq: event.seq,
        reducer: 'llm-summary',
        provider: event.data.provider,
        model: event.data.model,
        tokensBefore: event.data.shadowedTokenCount,
        tokensAfter: null,
      })
    })

    // This is the true first-exposure boundary available in the Harness:
    // the preceding step's results are already durable, the new step is open,
    // and the next model request has not yet derived its history.
    ctx.on('agent/pre-step', async ({ agent, signal, turn, step }, next) => {
      const boundary = {}
      this.activeRequestBoundaries.set(agent.session, boundary)
      try {
        if (!signal.aborted) {
          try {
            // Only the immediately preceding step can contain results that have
            // not yet been exposed. This freezes both REDUCE and KEEP decisions:
            // older original events are never reconsidered after a profile change.
            this.runRequestBoundary(agent.session, turn, step - 1, signal)
          } catch (error: unknown) {
            this.auditFailure(agent.session, 'fresh', 'request-boundary', error)
            ctx.logger.warn('context-compression fresh pass failed open: %o', error)
          }
        }
        return await next()
      } finally {
        if (this.activeRequestBoundaries.get(agent.session) === boundary) {
          this.activeRequestBoundaries.delete(agent.session)
        }
      }
    }, { prepend: true })

    ctx.on('agent/turn-stopping', ({ agent, turn, signal }) => {
      if (signal.aborted) return
      try {
        const step = this.latestCompletedToolStep(agent.session, turn)
        if (step !== undefined) this.runRequestBoundary(agent.session, turn, step, signal)
      } catch (error: unknown) {
        this.auditFailure(agent.session, 'fresh', 'terminal-pass', error)
        ctx.logger.warn('context-compression terminal pass failed open: %o', error)
      }
    })
  }

  /**
   * Measure text content in Unicode code points; non-text blocks cost zero.
   * @param blocks - tool-result content to measure.
   * @returns total Unicode code points across text blocks.
   */
  measureContent(blocks: readonly ContentBlock[]): number {
    let chars = 0
    for (const block of blocks) {
      if (block.type === 'text') chars += codePointLength(block.text)
    }
    return chars
  }

  private pressureCost(blocks: readonly ContentBlock[]): number {
    let cost = 0
    for (const block of blocks) {
      switch (block.type) {
        case 'text':
        case 'reasoning':
          cost += codePointLength(block.text)
          break
        case 'tool-call':
          cost += RICH_BLOCK_PRESSURE_COST
            + codePointLength(block.name)
            + codePointLength(block.arguments)
          break
        case 'tool-result':
          cost += RICH_BLOCK_PRESSURE_COST + this.pressureCost(block.content)
          break
        default: {
          // ContentBlockMap is merge-extensible. Unknown model-visible blocks
          // scale with their durable JSON payload instead of receiving a fixed
          // token that a large provider block could bypass.
          const serialized = JSON.stringify(block)
          cost += Math.max(RICH_BLOCK_PRESSURE_COST, codePointLength(serialized))
        }
      }
    }
    return cost
  }

  /**
   * Apply the configured native head/middle/tail transform.
   * @param blocks - original tool-result content.
   * @returns reduced content, or `null` when no reduction is required.
   */
  pruneContent(blocks: readonly ContentBlock[]): ContentBlock[] | null {
    return this.nativePruneContent(
      blocks,
      this.config.headChars + codePointLength(PRUNE_MARKER) + this.config.tailChars,
      this.config.headChars,
      this.config.tailChars,
    )
  }

  /**
   * Run one stable-surface pass. `fresh` is invoked before every request and
   * only reduces original oversized results. `pressure` is called by
   * compaction-basic and may additionally age old results at one high-water.
   * @param session - session whose current tool-result surface may be rewritten.
   * @param options - pass stage and optional completed-step coordinates.
   * @returns landed replacements and aggregate Unicode-code-point savings.
   */
  pruneSession(session: Session, options: PruneSessionOptions = {}): PruneResult {
    const stage = options.stage ?? 'pressure'
    const policy = this.activePolicy(session, options.contextWindowTokens, stage)
    if (policy === undefined) return emptyResult()
    const profile = policy.profile
    const view = measureForCompaction(this.ctx, session)
    if (stage === 'fresh') return this.decideFreshStep(session, options, policy, view)
    if (profile === 'off') return emptyResult()

    const landed: PrunedEntry[] = []
    if (profile === 'native') {
      const candidates = this.snapshot(session, view)
      const eligible = candidates.filter(candidate => candidate.call.name !== 'context_compression_retrieve')
      const exactUnavailable = eligible.some(candidate => candidate.count.kind !== 'exact-tokenizer')
      if (exactUnavailable) {
        this.warnExactUnavailable(session, view, 'native')
      }
      const planned = eligible
        .map(candidate => this.planNative(candidate, session, stage, policy, view))
        .filter((entry): entry is PlannedReplacement => entry !== null)
      landed.push(...this.landAll(session, planned))
      if (landed.length === 0) {
        const exact = eligible.flatMap(candidate => candidate.count.kind === 'exact-tokenizer'
          ? [candidate.count.tokens] : [])
        this.auditComponent(session, policy, 'native-tool-result', 'pressure', 'skipped',
          exactUnavailable ? 'exact-tokenizer-unavailable'
            : exact.length === 0 ? 'no-tool-result-candidates'
              : Math.max(...exact) <= policy.nativeTriggerTokens ? 'at-or-below-trigger'
                : planned.length === 0 ? 'no-valid-reduction'
                  : 'recovery-tool-unavailable', {
            measurementKind: exactUnavailable ? 'unavailable' : 'exact-tokenizer',
            ...(exact.length === 0 ? {} : { currentTokens: Math.max(...exact) }),
            triggerTokens: policy.nativeTriggerTokens,
            targetTokens: policy.nativeTargetTokens,
          })
      }
      return summarize(landed)
    }

    let historyPlans: PlannedReplacement[] = []
    let historyAllowed = false
    if (policy.historyMode === 'adaptive') {
      historyPlans = this.planHistoricalAging(session, policy, view)
      const capacityPressure = this.capacityPressureActive(session, view)
      historyAllowed = this.adaptiveHistoryAllowed(session, view, historyPlans, capacityPressure)
      if (historyAllowed) {
        landed.push(...this.landAll(session, historyPlans))
      }
    } else {
      historyAllowed = this.historyAllowed(session, policy.historyMode, view)
      if (historyAllowed) {
        historyPlans = this.planHistoricalAging(session, policy, view)
        landed.push(...this.landAll(session, historyPlans))
      }
    }
    if (!landed.some(entry => entry.stage === 'pressure')) {
      this.auditHistoryEvaluation(session, policy, view, historyAllowed, historyPlans)
    }
    if (policy.tailTrim?.enabled === true) {
      const tailView = measureForCompaction(this.ctx, session)
      this.landOldestTailTrimGroup(session, policy, tailView)
    } else {
      this.auditComponent(session, policy, 'tail-trim', 'pressure', 'disabled', 'profile-policy')
    }
    return summarize(landed)
  }

  private activeSettings(session: Session): ContextCompressionSettings {
    const frozen = this.sessionSettings.get(session)
    if (frozen !== undefined) return frozen
    const settings = this.ctx.get('settings')?.get(settingsNamespace(CONTEXT_COMPRESSION_SETTINGS_NAMESPACE))
    const resolved = settings === undefined
      ? ContextCompressionSettingsSchema({ profile: this.config.profile } as never)
      : ContextCompressionSettingsSchema(structuredClone(settings) as never)
    const snapshot = deepFreeze(structuredClone(resolved))
    this.sessionSettings.set(session, snapshot)
    emitCompressionAudit(this.ctx.logger, {
      schemaVersion: 1,
      kind: 'policy-frozen',
      sessionId: String(session.id),
      settingsSource: settings === undefined ? 'plugin-config-fallback' : 'host-settings',
      settings: snapshot,
      deploymentConfig: this.config,
    })
    return snapshot
  }

  private activePolicy(
    session: Session,
    contextWindowTokens?: number,
    stage: PruneStage = 'pressure',
  ): CompressionPolicy | undefined {
    const settings = this.activeSettings(session)
    try {
      const policy = resolvePolicy(
        this.config,
        settings.profile,
        settings.custom,
        contextWindowTokens === undefined ? {} : { contextWindowTokens },
      )
      const auditKey = JSON.stringify({ policy, contextWindowTokens: contextWindowTokens ?? null })
      let emittedAuditKeys = this.policyResolutionAudits.get(session)
      if (emittedAuditKeys === undefined) {
        emittedAuditKeys = new Set()
        this.policyResolutionAudits.set(session, emittedAuditKeys)
      }
      if (!emittedAuditKeys.has(auditKey)) {
        emittedAuditKeys.add(auditKey)
        emitCompressionAudit(this.ctx.logger, {
          schemaVersion: 1,
          kind: 'policy-resolved',
          sessionId: String(session.id),
          policy,
          ...contextWindowTokens === undefined ? {} : { contextWindowTokens },
        })
      }
      return policy
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error)
      this.auditFailure(session, stage, 'policy-resolution', error)
      this.warnOnce(
        session,
        `custom-policy:${settings.profile}:${reason}`,
        'context-compression kept original tool results because the Custom policy is not effective: %s',
        reason,
      )
      return undefined
    }
  }

  private contextWindowForRequest(
    session: Session,
  ): number | undefined {
    const settings = this.activeSettings(session)
    if (settings.profile !== 'custom' || settings.custom.unit !== 'context-percent') return undefined
    const config = session.requestHeader()?.config
    const routed = session.requestContext()
    if (config === undefined || config.provider.length === 0 || config.model.length === 0 || routed === undefined) {
      return undefined
    }
    if (routed.provider !== config.provider || routed.model !== config.model) {
      this.warnOnce(
        session,
        `custom-context-window-route:${config.provider}\0${config.model}`,
        'context-compression kept the Custom percentage policy inactive because durable route capacity belongs to %s/%s, not %s/%s',
        routed.provider,
        routed.model,
        config.provider,
        config.model,
      )
      return undefined
    }
    if (!Number.isSafeInteger(routed.contextWindow) || routed.contextWindow === undefined || routed.contextWindow <= 0) {
      this.warnOnce(
        session,
        `custom-context-window-capacity:${config.provider}\0${config.model}`,
        'context-compression kept the Custom percentage policy inactive because %s/%s has no positive durable context capacity',
        config.provider,
        config.model,
      )
      return undefined
    }
    return routed.contextWindow
  }

  private runRequestBoundary(
    session: Session,
    turn: number,
    step: number,
    signal: AbortSignal,
  ): void {
    const contextWindowTokens = this.contextWindowForRequest(session)
    if (signal.aborted) return
    const policy = this.activePolicy(session, contextWindowTokens, 'fresh')
    if (policy === undefined) return
    const capacity = contextWindowTokens === undefined ? {} : { contextWindowTokens }
    this.pruneSession(session, { stage: 'fresh', freshTurn: turn, freshStep: step, ...capacity })
    if (policy.historyMode === 'routine' || policy.historyMode === 'adaptive'
      || policy.tailTrim?.enabled === true) {
      this.pruneSession(session, { stage: 'pressure', ...capacity })
    }
  }

  /** Resolve historical-aging authority without accepting caller-supplied elevation. */
  private historyAllowed(session: Session, mode: HistoryMode, view: CompactionTokenView): boolean {
    switch (mode) {
      case 'disabled':
        return false
      case 'routine':
        return true
      case 'capacity-pressure':
        return this.capacityPressureActive(session, view)
      case 'adaptive':
        return false
      /* v8 ignore next -- closed-union exhaustiveness guard */
      default:
        return assertNever(mode, 'history mode')
    }
  }

  /** Match the default compaction-basic pressure gate using public durable data. */
  private capacityPressureActive(session: Session, view: CompactionTokenView): boolean {
    const header = session.requestHeader()?.config
    const routed = session.requestContext()
    const contextWindow = routed?.contextWindow
    if (header === undefined || routed === undefined
      || routed.provider !== header.provider
      || routed.model !== header.model
      || contextWindow === undefined
      || !Number.isSafeInteger(contextWindow)
      || contextWindow <= 0) return false
    return view.totalTokens >= Math.floor(contextWindow * 0.8)
  }

  /** Emit one bounded, independently correlatable postflight cost diagnostic per completed attempt. */
  private logAdaptivePostflight(session: Session, usage: ObservedPromptUsage): void {
    const attemptId = String(usage.attemptId)
    if (this.postflightDiagnostics.get(session) === attemptId) return
    this.postflightDiagnostics.set(session, attemptId)

    const key = usage.key
    let priceRecord: Readonly<Record<string, unknown>> | undefined
    let cost: ReturnType<typeof priceOfficialDeepSeekUsage> | { readonly kind: 'unpriced'; readonly reason: string }
    if (key === undefined) {
      cost = { kind: 'unpriced', reason: 'measurement key unavailable' }
    } else if (usage.responseModelId !== key.modelId) {
      cost = { kind: 'unpriced', reason: 'response model mismatch or unavailable' }
    } else if (usage.observedOutputTokens === undefined) {
      cost = { kind: 'unpriced', reason: 'output token count unavailable' }
    } else if (usage.cacheStatus !== 'complete'
      || usage.cacheReadTokens === undefined
      || usage.cacheMissTokens === undefined) {
      cost = { kind: 'unpriced', reason: 'complete cache split unavailable' }
    } else {
      const startedAt = new Date(usage.startedAtMs)
      const completedAt = new Date(usage.completedAtMs)
      const resolution = resolveOfficialDeepSeekPrice({
        provider: key.provider,
        baseUrlClass: key.baseUrlClass,
        apiRoute: key.apiRoute,
        modelId: key.modelId,
        currency: 'USD',
        at: startedAt,
      })
      if (resolution.kind === 'priced') {
        priceRecord = {
          catalogVersion: resolution.record.catalogVersion,
          checkedAt: resolution.record.checkedAt,
          sourceUrl: resolution.record.sourceUrl,
          currency: resolution.record.currency,
          modelId: resolution.record.modelId,
          apiRoute: resolution.record.apiRoute,
          startBand: resolution.record.band,
        }
      }
      cost = priceOfficialDeepSeekUsage({
        provider: key.provider,
        baseUrlClass: key.baseUrlClass,
        apiRoute: key.apiRoute,
        modelId: key.modelId,
        currency: 'USD',
        startedAt,
        completedAt,
        usage: {
          cacheReadTokens: usage.cacheReadTokens,
          cacheMissTokens: usage.cacheMissTokens,
          outputTokens: usage.observedOutputTokens,
        },
      })
    }

    this.ctx.logger.debug(`context-compression adaptive postflight ${JSON.stringify({
      sessionId: String(session.id),
      providerRequestOrdinal: Number(usage.providerRequestOrdinal),
      attemptId,
      startedAtMs: usage.startedAtMs,
      completedAtMs: usage.completedAtMs,
      measurementKind: usage.measurement.kind,
      catalogVersion: DEEPSEEK_OFFICIAL_PRICE_CATALOG_VERSION,
      ...(priceRecord === undefined ? {} : { priceRecord }),
      usage: {
        promptTokens: usage.observedPromptTokens,
        ...(usage.observedOutputTokens === undefined ? {} : { outputTokens: usage.observedOutputTokens }),
        cacheStatus: usage.cacheStatus ?? 'unknown',
        ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
        ...(usage.cacheMissTokens === undefined ? {} : { cacheMissTokens: usage.cacheMissTokens }),
      },
      cost,
    })}`)
  }

  /** Decide one already-planned History batch from adjacent request-level facts only. */
  private adaptiveHistoryAllowed(
    session: Session,
    view: CompactionTokenView,
    plans: readonly PlannedReplacement[],
    capacityPressure: boolean,
  ): boolean {
    const log = (
      allowHistory: boolean,
      reason: string,
      detail: Readonly<Record<string, unknown>> = {},
    ): boolean => {
      this.ctx.logger.debug(`context-compression adaptive ${JSON.stringify({
        sessionId: String(session.id),
        allowHistory,
        reason,
        catalogVersion: DEEPSEEK_OFFICIAL_PRICE_CATALOG_VERSION,
        ...detail,
      })}`)
      return allowHistory
    }
    const usage = view.lastCompletedUsage
    if (usage !== undefined) this.logAdaptivePostflight(session, usage)
    if (plans.length === 0) return false
    if (capacityPressure) return log(true, 'capacity-override')

    const currentKey = view.latestEnvelopeKey
    if (usage === undefined) return log(false, 'usage-unavailable')
    if (usage.key === undefined || currentKey === undefined) {
      return log(false, 'measurement-key-unavailable')
    }
    if (!sameProviderMeasurementKey(usage.key, currentKey)) {
      return log(false, 'measurement-key-mismatch')
    }
    if (usage.responseModelId !== usage.key.modelId) {
      return log(false, 'response-model-mismatch-or-unavailable')
    }
    if (usage.cacheStatus !== 'complete'
      || usage.cacheReadTokens === undefined
      || usage.cacheMissTokens === undefined) {
      return log(false, 'cache-split-incomplete')
    }

    const price = resolveOfficialDeepSeekPrice({
      provider: usage.key.provider,
      baseUrlClass: usage.key.baseUrlClass,
      apiRoute: usage.key.apiRoute,
      modelId: usage.key.modelId,
      currency: 'USD',
      at: new Date(),
    })
    if (price.kind === 'unpriced') return log(false, `adaptive-unknown-price:${price.reason}`)

    const exactReclaimedTokens = plans.reduce(
      (sum, plan) => sum + plan.tokensBefore - plan.tokensAfter,
      0,
    )
    const earliestChangedSeq = Math.min(...plans.map(plan => plan.candidate.seq))
    const bounds = deriveAdaptiveTokenBounds({
      exactReclaimedTokens,
      earliestChangedSeq,
      previousPromptTokens: usage.observedPromptTokens,
      expectedTokenizerRevision: usage.key.tokenizerRevision,
      previousRequestMeasurement: usage.measurement,
      measuredNodes: view.measuredNodes,
    })
    const decision = decideConservativeAdaptive({
      capacityPressure: false,
      bounds,
      inputCacheHitRate: price.record.inputCacheHit,
      inputCacheMissRate: price.record.inputCacheMiss,
      observedCacheReadTokens: usage.cacheReadTokens,
    })
    return log(decision.allowHistory, decision.reason, {
      priceBand: price.record.band,
      observedPromptTokens: usage.observedPromptTokens,
      observedCacheReadTokens: usage.cacheReadTokens,
      bounds,
      ...'minimumRemovalValue' in decision
        ? { minimumRemovalValue: decision.minimumRemovalValue }
        : {},
      ...'maximumCacheLossPenalty' in decision
        ? { maximumCacheLossPenalty: decision.maximumCacheLossPenalty }
        : {},
    })
  }

  private latestCompletedToolStep(session: Session, turn: number): number | undefined {
    let latest: number | undefined
    for (const event of session.events) {
      if (event.type === 'step/end' && event.data.turn === turn) latest = event.data.step
    }
    return latest
  }

  private decisions(session: Session): Set<number> {
    let decisions = this.firstExposure.get(session)
    if (decisions === undefined) {
      decisions = new Set()
      this.firstExposure.set(session, decisions)
    }
    return decisions
  }

  private decideFreshStep(
    session: Session,
    options: PruneSessionOptions,
    policy: CompressionPolicy,
    view: CompactionTokenView,
  ): PruneResult {
    if (options.freshTurn === undefined || options.freshStep === undefined) {
      this.auditComponent(session, policy, 'fresh', 'fresh',
        policy.freshEnabled ? 'skipped' : 'disabled',
        policy.freshEnabled ? 'missing-completed-step-coordinates' : 'profile-policy')
      this.auditComponent(session, policy, 'aggregate', 'fresh',
        policy.aggregateEnabled ? 'skipped' : 'disabled',
        policy.aggregateEnabled ? 'missing-completed-step-coordinates' : 'profile-policy')
      return emptyResult()
    }
    const decisions = this.decisions(session)
    const candidates = this.snapshot(session, view).filter(candidate =>
      typeof candidate.event.surfaceOp !== 'object'
      && candidate.event.data.turn === options.freshTurn
      && candidate.event.data.step === options.freshStep
      && !decisions.has(candidate.seq))
    if (candidates.length === 0) {
      this.auditComponent(session, policy, 'fresh', 'fresh',
        policy.freshEnabled ? 'skipped' : 'disabled',
        policy.freshEnabled ? 'no-new-tool-result-candidates' : 'profile-policy')
      this.auditComponent(session, policy, 'aggregate', 'fresh',
        policy.aggregateEnabled ? 'skipped' : 'disabled',
        policy.aggregateEnabled ? 'no-new-tool-result-candidates' : 'profile-policy')
      return emptyResult()
    }

    const plans = new Map<number, PlannedReplacement>()
    let freshPlanned = 0
    const exactCandidateTokens = candidates.map(candidate => exactTokens(candidate.count))
    const exactAvailable = exactCandidateTokens.every(tokens => tokens !== undefined)
    const maxCandidateTokens = exactAvailable
      ? Math.max(...exactCandidateTokens as number[])
      : undefined
    if (policy.freshEnabled) {
      if (candidates.some(candidate => candidate.call.name !== 'context_compression_retrieve'
        && candidate.count.kind !== 'exact-tokenizer')) {
        this.warnExactUnavailable(session, view, 'fresh')
      }
      for (const candidate of candidates) {
        if (candidate.call.name === 'context_compression_retrieve') continue
        const plan = this.planFresh(candidate, session, policy, view)
        if (plan !== null) {
          plans.set(candidate.seq, plan)
          freshPlanned += 1
        }
      }
    }
    let aggregateInputTokens: number | undefined
    let aggregatePlanned = 0
    if (policy.aggregateEnabled) {
      const aggregateAvailable = exactAvailable
      if (!aggregateAvailable) this.warnExactUnavailable(session, view, 'aggregate')
      let total = aggregateAvailable
        ? candidates.reduce((sum, candidate) => sum + (plans.get(candidate.seq)?.tokensAfter
          ?? exactTokens(candidate.count) ?? 0), 0)
        : 0
      if (aggregateAvailable) aggregateInputTokens = total
      if (aggregateAvailable && total > policy.aggregateTriggerTokens) {
        const remaining = candidates
          .filter(candidate => candidate.call.name !== 'context_compression_retrieve')
          .sort((a, b) => Number(this.isError(a)) - Number(this.isError(b))
            || (plans.get(b.seq)?.tokensAfter ?? exactTokens(b.count) ?? 0)
              - (plans.get(a.seq)?.tokensAfter ?? exactTokens(a.count) ?? 0))
        for (const candidate of remaining) {
          const previous = plans.get(candidate.seq)
          const plan = this.planAggregate(candidate, session, view)
          const previousTokens = previous?.tokensAfter ?? exactTokens(candidate.count) ?? 0
          if (plan === null || plan.tokensAfter >= previousTokens) continue
          plans.set(candidate.seq, plan)
          aggregatePlanned += 1
          total -= previousTokens - plan.tokensAfter
          if (total <= policy.aggregateTargetTokens) break
        }
        if (total > policy.aggregateTargetTokens) {
          this.ctx.logger.warn(
            'context-compression fresh aggregate residual: %d tokens exceed target %d',
            total,
            policy.aggregateTargetTokens,
          )
        }
      }
    }

    const landed = this.landAll(session, candidates
      .map(candidate => plans.get(candidate.seq))
      .filter((plan): plan is PlannedReplacement => plan !== undefined))
    const freshLanded = landed.some(entry => entry.stage === 'fresh'
      && plans.get(entry.originalSeq)?.component === 'fresh')
    const aggregateLanded = landed.some(entry => entry.stage === 'fresh'
      && plans.get(entry.originalSeq)?.component === 'aggregate')
    if (!freshLanded) {
      this.auditComponent(session, policy, 'fresh', 'fresh',
        policy.freshEnabled ? 'skipped' : 'disabled',
        !policy.freshEnabled ? 'profile-policy'
          : !exactAvailable ? 'exact-tokenizer-unavailable'
            : (maxCandidateTokens ?? 0) <= policy.freshTriggerTokens ? 'at-or-below-trigger'
              : freshPlanned > 0 && aggregatePlanned > 0 ? 'superseded-by-aggregate'
                : freshPlanned === 0 ? 'no-valid-reduction'
                  : 'recovery-tool-unavailable', {
          measurementKind: exactAvailable ? 'exact-tokenizer' : 'unavailable',
          ...(maxCandidateTokens === undefined ? {} : { currentTokens: maxCandidateTokens }),
          triggerTokens: policy.freshTriggerTokens,
          targetTokens: policy.freshTargetTokens,
        })
    }
    if (!aggregateLanded) {
      this.auditComponent(session, policy, 'aggregate', 'fresh',
        policy.aggregateEnabled ? 'skipped' : 'disabled',
        !policy.aggregateEnabled ? 'profile-policy'
          : !exactAvailable ? 'exact-tokenizer-unavailable'
            : (aggregateInputTokens ?? 0) <= policy.aggregateTriggerTokens ? 'at-or-below-trigger'
              : aggregatePlanned === 0 ? 'no-valid-reduction'
                : 'recovery-tool-unavailable', {
          measurementKind: exactAvailable ? 'exact-tokenizer' : 'unavailable',
          ...(aggregateInputTokens === undefined ? {} : { currentTokens: aggregateInputTokens }),
          triggerTokens: policy.aggregateTriggerTokens,
          targetTokens: policy.aggregateTargetTokens,
        })
    }
    for (const candidate of candidates) decisions.add(candidate.seq)
    return summarize(landed)
  }

  private snapshot(session: Session, view: CompactionTokenView): SnapshotCandidate[] {
    const calls = new Map<string, ToolCallInfo>()
    for (const event of session.events) {
      if (event.type === 'tool/call') {
        calls.set(event.data.callId, { name: event.data.name, arguments: event.data.arguments })
      }
    }
    const candidates: SnapshotCandidate[] = []
    const measured = new Map(view.measuredNodes.map(node => [node.seq, node.count]))
    const projectionPrices = new Map(view.nodes.map(node => [node.seq, node.tokens]))
    for (const seq of [...session.surface.nodes]) {
      const event = session.events[seq]
      if (event?.type !== 'tool/result') continue
      const shadowedHeuristicTokenCount = projectionPrices.get(seq)
      if (shadowedHeuristicTokenCount === undefined) {
        throw new Error(`surface node ${String(seq)} is absent from the atomic legacy projection`)
      }
      const content = event.data.message.content[0].content
      candidates.push({
        seq,
        event,
        call: calls.get(event.data.message.source.callId) ?? { name: 'unknown', arguments: '{}' },
        count: onlyTextBlocks(content) === null
          ? unavailableCount(`surface node ${String(seq)} contains unsupported rich tool-result content`)
          : measured.get(seq) ?? unavailableCount(`surface node ${String(seq)} is absent from the atomic token view`),
        shadowedHeuristicTokenCount,
        characterPressure: this.pressureCost(content),
      })
    }
    return candidates
  }

  private planNative(
    candidate: SnapshotCandidate,
    session: Session,
    stage: PruneStage,
    policy: CompressionPolicy,
    view: CompactionTokenView,
  ): PlannedReplacement | null {
    if (candidate.call.name === 'context_compression_retrieve') return null
    const tokensBefore = exactTokens(candidate.count)
    if (tokensBefore === undefined || tokensBefore <= policy.nativeTriggerTokens) return null
    const result = candidate.event.data.message.content[0]
    if (onlyTextBlocks(result.content) === null) return null
    const sourceSeq = this.rootToolResultSeq(session, candidate.seq)
    const marker = recoveryMarker(this.sourceRef(session, sourceSeq), 'tool result middle pruned')
    let head = this.config.headChars
    let tail = this.config.tailChars
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const threshold = head + codePointLength(marker) + tail
      const content = this.nativePruneContent(result.content, threshold, head, tail, marker)
      if (content !== null) {
        const plan = this.plan(
          candidate,
          content,
          sourceSeq,
          'native-head-tail',
          stage,
          'native-tool-result',
          undefined,
          view,
        )
        if (plan !== null && plan.tokensAfter <= policy.nativeTargetTokens) return plan
      }
      if (head === 0 && tail === 0) break
      head = Math.floor(head / 2)
      tail = Math.floor(tail / 2)
    }
    return this.planAggregate(
      candidate,
      session,
      view,
      'native-whole-result',
      stage,
      policy.nativeTargetTokens,
      'native-tool-result',
    )
  }

  private planFresh(
    candidate: SnapshotCandidate,
    session: Session,
    policy: CompressionPolicy,
    view: CompactionTokenView,
  ): PlannedReplacement | null {
    // A replace event already reflects one frozen first-exposure decision. The
    // pre-step coordinate filter prevents previously-kept originals from ever
    // being reconsidered after their first request.
    if (typeof candidate.event.surfaceOp === 'object') return null
    const result = candidate.event.data.message.content[0]
    const tokensBefore = exactTokens(candidate.count)
    if (tokensBefore === undefined || tokensBefore <= policy.freshTriggerTokens) return null
    const sourceSeq = candidate.seq
    const sourceRef = this.sourceRef(session, sourceSeq)
    const textBlock = onlyTextBlock(result.content)
    if (textBlock !== null) {
      let budgetChars = Math.max(1, Math.floor(codePointLength(textBlock.text) * 0.75))
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const output = reduceFreshToolResult({
          toolName: candidate.call.name,
          argumentsText: candidate.call.arguments,
          text: textBlock.text,
          budgetChars,
          sourceRef,
          isError: result.isError === true || candidate.event.data.error !== undefined,
        })
        if (output !== null) {
          const plan = this.plan(
            candidate,
            [{ ...textBlock, text: output.text }],
            sourceSeq,
            output.reducer,
            'fresh',
            'fresh',
            undefined,
            view,
          )
          if (plan !== null && plan.tokensAfter <= policy.freshTargetTokens) return plan
        }
        if (budgetChars === 1) break
        budgetChars = Math.max(1, Math.floor(budgetChars / 2))
      }
    }

    return this.planAggregate(
      candidate,
      session,
      view,
      'fresh-whole-result',
      'fresh',
      policy.freshTargetTokens,
      'fresh',
    )
  }

  private planAggregate(
    candidate: SnapshotCandidate,
    session: Session,
    view: CompactionTokenView,
    reducer = 'fresh-step-aggregate',
    stage: PruneStage = 'fresh',
    targetTokens?: number,
    component: CompressionAuditComponent = 'aggregate',
    historyMode?: HistoryMode,
  ): PlannedReplacement | null {
    if (this.isError(candidate)) {
      return this.planErrorEvidence(
        candidate,
        session,
        view,
        stage,
        targetTokens,
        component,
        historyMode,
      )
    }
    const sourceSeq = this.rootToolResultSeq(session, candidate.seq)
    const sourceRef = this.sourceRef(session, sourceSeq)
    const text = [
      '[Tool result reduced to satisfy the completed-step aggregate budget]',
      `tool: ${candidate.call.name}`,
      `source: ${sourceRef}`,
      'Use context_compression_retrieve with this source if the omitted evidence is necessary.',
    ].join('\n')
    const plan = this.plan(
      candidate,
      [{ type: 'text', text }],
      sourceSeq,
      reducer,
      stage,
      component,
      historyMode,
      view,
    )
    return plan !== null && (targetTokens === undefined || plan.tokensAfter <= targetTokens)
      ? plan
      : null
  }

  /** Preserve bounded diagnostic evidence whenever an all-text error is reduced. */
  private planErrorEvidence(
    candidate: SnapshotCandidate,
    session: Session,
    view: CompactionTokenView,
    stage: PruneStage,
    targetTokens?: number,
    component: CompressionAuditComponent = 'aggregate',
    historyMode?: HistoryMode,
  ): PlannedReplacement | null {
    if (!this.isError(candidate)) return null
    const result = candidate.event.data.message.content[0]
    const blocks = onlyTextBlocks(result.content)
    if (blocks === null) return null
    const text = blocks.map(block => block.text).join('\n')
    const sourceSeq = this.rootToolResultSeq(session, candidate.seq)
    const sourceRef = this.sourceRef(session, sourceSeq)
    const output = historicalPlaceholder({
      toolName: candidate.call.name,
      sourceRef,
      charsBefore: codePointLength(text),
      isError: true,
      text,
      compact: false,
    })
    const input = {
      toolName: candidate.call.name,
      argumentsText: candidate.call.arguments,
      text,
      budgetChars: 1_200,
      sourceRef,
      isError: true,
    }
    if (!verifyReduction(input, output)) return null
    const plan = this.plan(
      candidate,
      [{ type: 'text', text: output.text }],
      sourceSeq,
      'error-evidence-placeholder',
      stage,
      component,
      historyMode,
      view,
    )
    return plan !== null && (targetTokens === undefined || plan.tokensAfter <= targetTokens)
      ? plan
      : null
  }

  private isError(candidate: SnapshotCandidate): boolean {
    const result = candidate.event.data.message.content[0]
    return result.isError === true || candidate.event.data.error !== undefined
  }

  private planHistoricalAging(
    session: Session,
    policy: CompressionPolicy,
    view: CompactionTokenView,
  ): PlannedReplacement[] {
    const candidates = this.snapshot(session, view)
    const exact: number[] = []
    for (const candidate of candidates) {
      const tokens = exactTokens(candidate.count)
      if (tokens === undefined) {
        this.warnExactUnavailable(session, view, 'history')
        return []
      }
      exact.push(tokens)
    }
    const total = exact.reduce((sum, tokens) => sum + tokens, 0)
    const trigger = policy.historyTriggerTokens
    if (total <= trigger) return []

    let latestTurn = 0
    for (const event of session.events) {
      if (event.type === 'turn/start') latestTurn = Math.max(latestTurn, event.data.turn)
    }
    const protectedSeqs = new Set<number>()
    // `latestTurn` can be the currently open turn. Keep that working turn plus
    // the configured number of preceding complete user turns.
    const protectedTurnFloor = Math.max(1, latestTurn - policy.historyKeepRecentTurns)
    for (const candidate of candidates) {
      if (candidate.event.data.turn >= protectedTurnFloor) protectedSeqs.add(candidate.seq)
    }
    // Tail working set, independent of turn count (OpenCode-style protection).
    let recentTokens = 0
    const recentBudget = policy.historyKeepRecentTokens
    for (let index = candidates.length - 1; index >= 0 && recentTokens < recentBudget; index--) {
      const candidate = candidates[index]
      if (candidate === undefined) continue
      protectedSeqs.add(candidate.seq)
      recentTokens += exactTokens(candidate.count) ?? 0
    }
    const eligible = candidates.filter((candidate) => {
      if (candidate.call.name === 'context_compression_retrieve') return false
      if (protectedSeqs.has(candidate.seq)) return false
      const result = candidate.event.data.message.content[0]
      const block = onlyTextBlock(result.content)
      if (block?.text.includes('[Old tool result content cleared from active context]') === true) return false
      return true
    })
    const planned: PlannedReplacement[] = []
    let reclaim = 0
    const required = Math.max(policy.historyMinReclaimTokens, total - policy.historyTriggerTokens)
    for (const candidate of eligible) {
      const result = candidate.event.data.message.content[0]
      const block = onlyTextBlock(result.content)
      const sourceSeq = this.rootToolResultSeq(session, candidate.seq)
      if (block === null) {
        const plan = this.planAggregate(
          candidate,
          session,
          view,
          'historical-rich-whole-result',
          'pressure',
          undefined,
          'history',
          policy.historyMode,
        )
        if (plan === null) continue
        planned.push(plan)
        reclaim += plan.tokensBefore - plan.tokensAfter
        if (reclaim >= required) break
        continue
      }
      const output = historicalPlaceholder({
        toolName: candidate.call.name,
        sourceRef: this.sourceRef(session, sourceSeq),
        charsBefore: codePointLength(block.text),
        isError: result.isError === true || candidate.event.data.error !== undefined,
        text: block.text,
        compact: false,
      })
      const verifyInput = {
        toolName: candidate.call.name,
        argumentsText: candidate.call.arguments,
        text: block.text,
        budgetChars: 1_200,
        sourceRef: this.sourceRef(session, sourceSeq),
        isError: result.isError === true || candidate.event.data.error !== undefined,
      }
      if (!verifyReduction(verifyInput, output)) continue
      const plan = this.plan(
        candidate,
        [{ ...block, text: output.text }],
        sourceSeq,
        output.reducer,
        'pressure',
        'history',
        policy.historyMode,
        view,
      )
      if (plan === null) continue
      planned.push(plan)
      reclaim += plan.tokensBefore - plan.tokensAfter
      if (reclaim >= required) break
    }
    // Do not pay a cache break for a trivial cleanup.
    return reclaim >= policy.historyMinReclaimTokens ? planned : []
  }

  private protectedHistoryResultSeqs(
    session: Session,
    policy: CompressionPolicy,
    view: CompactionTokenView,
  ): Set<number> | null {
    const candidates = this.snapshot(session, view)
    if (candidates.some(candidate => exactTokens(candidate.count) === undefined)) return null
    let latestTurn = 0
    for (const event of session.events) {
      if (event.type === 'turn/start') latestTurn = Math.max(latestTurn, event.data.turn)
    }
    const protectedSeqs = new Set<number>()
    const protectedTurnFloor = Math.max(1, latestTurn - policy.historyKeepRecentTurns)
    for (const candidate of candidates) {
      if (candidate.event.data.turn >= protectedTurnFloor) protectedSeqs.add(candidate.seq)
    }
    let recentTokens = 0
    for (let index = candidates.length - 1;
      index >= 0 && recentTokens < policy.historyKeepRecentTokens;
      index--) {
      const candidate = candidates[index]
      if (candidate === undefined) continue
      protectedSeqs.add(candidate.seq)
      recentTokens += exactTokens(candidate.count) ?? 0
    }
    return protectedSeqs
  }

  /** Atomically replace at most one oldest safe completed tool-call group. */
  private landOldestTailTrimGroup(
    session: Session,
    policy: CompressionPolicy,
    view: CompactionTokenView,
  ): void {
    const tailTrim = policy.tailTrim
    if (tailTrim?.enabled !== true) return
    if (view.currentSurface.kind !== 'exact-tokenizer'
      || view.currentSurface.tokens <= tailTrim.triggerTokens) {
      if (view.currentSurface.kind !== 'exact-tokenizer') this.warnExactUnavailable(session, view, 'tailtrim')
      this.auditComponent(session, policy, 'tail-trim', 'pressure', 'skipped',
        view.currentSurface.kind !== 'exact-tokenizer'
          ? 'exact-tokenizer-unavailable' : 'at-or-below-trigger', {
          measurementKind: view.currentSurface.kind,
          ...(view.currentSurface.kind === 'exact-tokenizer'
            ? { currentTokens: view.currentSurface.tokens }
            : {}),
          triggerTokens: tailTrim.triggerTokens,
        })
      return
    }
    const surfaceCount = view.currentSurface
    if (!this.hasRecoveryTool(session)) {
      this.auditComponent(session, policy, 'tail-trim', 'pressure', 'skipped',
        'recovery-tool-unavailable', {
          measurementKind: 'exact-tokenizer',
          currentTokens: surfaceCount.tokens,
          triggerTokens: tailTrim.triggerTokens,
        })
      return
    }
    if (!this.hasOpenTurn(session)) {
      this.auditComponent(session, policy, 'tail-trim', 'pressure', 'skipped',
        'no-open-turn', {
          measurementKind: 'exact-tokenizer',
          currentTokens: surfaceCount.tokens,
          triggerTokens: tailTrim.triggerTokens,
        })
      return
    }
    const protectedResults = this.protectedHistoryResultSeqs(session, policy, view)
    if (protectedResults === null) {
      this.auditComponent(session, policy, 'tail-trim', 'pressure', 'skipped',
        'exact-tokenizer-unavailable-in-protected-set', {
          measurementKind: 'unavailable',
          currentTokens: surfaceCount.tokens,
          triggerTokens: tailTrim.triggerTokens,
        })
      return
    }
    const measured = new Map(view.measuredNodes.map(node => [node.seq, node.count]))
    const heuristic = new Map(view.nodes.map(node => [node.seq, node.tokens]))
    const completedTurns = new Set<number>()
    const completedSteps = new Set<string>()
    for (const event of session.events) {
      if (event.type === 'turn/end') completedTurns.add(event.data.turn)
      else if (event.type === 'step/end') completedSteps.add(`${String(event.data.turn)}:${String(event.data.step)}`)
    }
    const firstCompletedSurfaceTurn = session.surface.nodes
      .map(seq => session.events[seq])
      .filter((event): event is SessionEvent<'assistant/message'> | SessionEvent<'tool/result'> =>
        (event?.type === 'assistant/message' || event?.type === 'tool/result')
          && completedTurns.has(event.data.turn))
      .reduce<number | undefined>(
        (first, event) => first === undefined ? event.data.turn : Math.min(first, event.data.turn),
        undefined,
      )
    const nodes = [...session.surface.nodes]
    for (let index = 0; index < nodes.length; index++) {
      const assistantSeq = nodes[index]
      if (assistantSeq === undefined) continue
      const assistant = session.events[assistantSeq]
      if (assistant?.type !== 'assistant/message'
        || assistant.data.interrupted === true
        || assistant.data.message.content.length === 0
        || assistant.data.message.content.some(block => block.type !== 'tool-call')
        || assistant.data.turn === firstCompletedSurfaceTurn
        || !completedTurns.has(assistant.data.turn)
        || !completedSteps.has(`${String(assistant.data.turn)}:${String(assistant.data.step)}`)) continue
      const calls = assistant.data.message.content as Extract<ContentBlock, { type: 'tool-call' }>[]
      if (calls.some(call => call.name === 'context_compression_retrieve')) continue
      const callIds = calls.map(call => String(call.id))
      if (new Set(callIds).size !== callIds.length) continue
      const resultSeqs = nodes.slice(index + 1, index + 1 + calls.length)
      if (resultSeqs.length !== calls.length || resultSeqs.some(seq => protectedResults.has(seq))) continue
      const results = resultSeqs.map(seq => session.events[seq])
      if (results.some((event): boolean => {
        if (event?.type !== 'tool/result'
          || event.data.turn !== assistant.data.turn || event.data.step !== assistant.data.step
          || event.data.error !== undefined) return true
        const block = event.data.message.content[0]
        return block.isError === true
      })) continue
      const next = session.events[nodes[index + 1 + calls.length] ?? -1]
      if (next?.type === 'tool/result'
        && next.data.turn === assistant.data.turn
        && next.data.step === assistant.data.step) continue
      const resultIds = results.map(event => event?.type === 'tool/result'
        ? String(event.data.message.source.callId) : '')
      if (new Set(resultIds).size !== resultIds.length
        || resultIds.some((id, resultIndex) => id !== callIds[resultIndex])) continue
      const shadowedSeqs = [assistantSeq, ...resultSeqs]
      const roots = shadowedSeqs.map(seq => this.uniqueAppendRoot(session, seq))
      if (roots.some(root => root === null)) continue
      const sourceEventSeqs = roots as number[]
      if (new Set(sourceEventSeqs).size !== sourceEventSeqs.length) continue
      const counts = shadowedSeqs.map(seq => measured.get(seq))
      if (counts.some(count => count?.kind !== 'exact-tokenizer')) continue
      const exactCounts = counts as Extract<TokenCount, { kind: 'exact-tokenizer' }>[]
      if (exactCounts.some(count => count.tokenizerId !== surfaceCount.tokenizerId
        || count.tokenizerRevision !== surfaceCount.tokenizerRevision)) continue
      const tokensBefore = exactCounts.reduce((sum, count) => sum + count.tokens, 0)
      const manifestSeq = session.events.length
      const ref = tailTrimRef(String(session.id), manifestSeq)
      const stub = tailTrimStub(ref, calls.map(call => call.name), sourceEventSeqs)
      if (stub === null) continue
      const stubCount = countExactCanonicalTextFields(
        [stub],
        candidate => view.countCanonicalText(candidate),
        'TailTrim group stub',
      )
      if (stubCount.kind !== 'exact-tokenizer'
        || stubCount.tokenizerId !== surfaceCount.tokenizerId
        || stubCount.tokenizerRevision !== surfaceCount.tokenizerRevision
        || stubCount.tokens <= 0
        || tokensBefore - stubCount.tokens < policy.historyMinReclaimTokens) continue
      const heuristicTokens = shadowedSeqs.reduce((sum, seq) => sum + (heuristic.get(seq) ?? 0), 0)
      const range = { start: assistantSeq, end: resultSeqs.at(-1) ?? assistantSeq }
      if (!this.reserveTailTrimBoundaryAttempt(session)) {
        this.auditComponent(session, policy, 'tail-trim', 'pressure', 'skipped',
          'already-attempted-at-request-boundary', {
            measurementKind: 'exact-tokenizer',
            currentTokens: surfaceCount.tokens,
            triggerTokens: tailTrim.triggerTokens,
          })
        return
      }
      const manifest = session.append('compaction/prune', {
        shadowedRange: range,
        shadowedSeqs,
        shadowedTokenCount: heuristicTokens,
      })
      let replacement: SessionEvent<'user/message'>
      try {
        replacement = session.append('user/message', tailTrimMessage(stub), {
          surfaceOp: { op: 'replace', ...range },
          sourceEventSeqs: [manifest.seq, ...shadowedSeqs],
        })
      } catch (error) {
        this.auditPublicationFailure(
          session,
          'pressure',
          'tail-trim',
          manifest.seq,
          error,
        )
        return
      }
      emitCompressionAudit(this.ctx.logger, {
        schemaVersion: 1,
        kind: 'rewrite',
        sessionId: String(session.id),
        profile: policy.profile,
        component: 'tail-trim',
        stage: 'pressure',
        reducer: 'pair-preserving-tail-trim',
        manifestEventType: 'compaction/prune',
        manifestSeq: manifest.seq,
        replacementSeq: replacement.seq,
        sourceSeqs: sourceEventSeqs,
        tokensBefore,
        tokensAfter: stubCount.tokens,
        tokensRemoved: tokensBefore - stubCount.tokens,
        tokenizerId: stubCount.tokenizerId,
        tokenizerRevision: stubCount.tokenizerRevision,
      })
      return
    }
    this.auditComponent(session, policy, 'tail-trim', 'pressure', 'skipped',
      'no-safe-eligible-tool-group', {
        measurementKind: 'exact-tokenizer',
        currentTokens: surfaceCount.tokens,
        triggerTokens: tailTrim.triggerTokens,
      })
  }

  private reserveTailTrimBoundaryAttempt(session: Session): boolean {
    const boundary = this.activeRequestBoundaries.get(session)
    if (boundary === undefined) return true
    if (this.tailTrimBoundaryAttempts.get(session) === boundary) return false
    this.tailTrimBoundaryAttempts.set(session, boundary)
    return true
  }

  private uniqueAppendRoot(session: Session, seq: number): number | null {
    const pending: Array<{ seq: number; depth: number }> = [{ seq, depth: 0 }]
    const visited = new Set<number>()
    const roots = new Set<number>()
    while (pending.length > 0) {
      const next = pending.pop()
      if (next === undefined || next.depth > 64 || visited.has(next.seq)) continue
      visited.add(next.seq)
      if (visited.size > 64) return null
      const event = session.events[next.seq]
      if (event === undefined || (event.type !== 'assistant/message' && event.type !== 'tool/result')) return null
      if (event.surfaceOp === 'append') roots.add(event.seq)
      else if (typeof event.surfaceOp === 'object') {
        const sources = event.sourceEventSeqs
        if (sources === undefined || sources.length === 0) return null
        for (const source of sources) pending.push({ seq: source, depth: next.depth + 1 })
      } else return null
      if (roots.size > 1) return null
    }
    return roots.size === 1 ? [...roots][0] ?? null : null
  }

  private plan(
    candidate: SnapshotCandidate,
    content: ContentBlock[],
    sourceSeq: number,
    reducer: string,
    stage: PruneStage,
    component: CompressionAuditComponent,
    historyMode: HistoryMode | undefined,
    view: CompactionTokenView,
  ): PlannedReplacement | null {
    const countBefore = candidate.count
    if (countBefore.kind !== 'exact-tokenizer') return null
    const countAfter = countToolContent(content, view)
    if (countAfter.kind !== 'exact-tokenizer'
      || countAfter.tokenizerId !== countBefore.tokenizerId
      || countAfter.tokenizerRevision !== countBefore.tokenizerRevision) return null
    const tokensBefore = countBefore.tokens
    const tokensAfter = countAfter.tokens
    if (tokensAfter <= 0 || tokensAfter >= tokensBefore) return null
    const charsBefore = candidate.characterPressure
    const charsAfter = this.pressureCost(content)
    return {
      candidate,
      content,
      sourceSeq,
      reducer,
      stage,
      component,
      ...historyMode === undefined ? {} : { historyMode },
      charsBefore,
      charsAfter,
      tokensBefore,
      tokensAfter,
      tokenizerId: countBefore.tokenizerId,
      tokenizerRevision: countBefore.tokenizerRevision,
    }
  }

  private land(session: Session, plan: PlannedReplacement): PrunedEntry | null {
    const { candidate } = plan
    const result = candidate.event.data.message.content[0]
    const message = freezeMessage<ToolResultMessage>({
      ...candidate.event.data.message,
      content: [{ ...result, content: plan.content }] as [typeof result],
    })
    const manifest = session.append('compaction/prune', {
      shadowedRange: { start: candidate.seq, end: candidate.seq },
      shadowedSeqs: [candidate.seq],
      shadowedTokenCount: candidate.shadowedHeuristicTokenCount,
    })
    let replacement: SessionEvent<'tool/result'>
    try {
      replacement = session.append('tool/result', {
        ...candidate.event.data,
        message,
      }, {
        surfaceOp: { op: 'replace', start: candidate.seq, end: candidate.seq },
        sourceEventSeqs: [candidate.seq],
      })
    } catch (error) {
      this.auditPublicationFailure(
        session,
        plan.stage,
        plan.component,
        manifest.seq,
        error,
      )
      return null
    }
    emitCompressionAudit(this.ctx.logger, {
      schemaVersion: 1,
      kind: 'rewrite',
      sessionId: String(session.id),
      profile: this.activeSettings(session).profile,
      component: plan.component,
      stage: plan.stage,
      reducer: plan.reducer,
      ...plan.historyMode === undefined ? {} : { historyMode: plan.historyMode },
      manifestEventType: 'compaction/prune',
      manifestSeq: manifest.seq,
      replacementSeq: replacement.seq,
      sourceSeqs: [plan.sourceSeq],
      tokensBefore: plan.tokensBefore,
      tokensAfter: plan.tokensAfter,
      tokensRemoved: plan.tokensBefore - plan.tokensAfter,
      tokenizerId: plan.tokenizerId,
      tokenizerRevision: plan.tokenizerRevision,
    })
    return {
      originalSeq: candidate.seq,
      sourceSeq: plan.sourceSeq,
      replacementSeq: replacement.seq,
      callId: candidate.event.data.message.source.callId,
      reducer: plan.reducer,
      stage: plan.stage,
      charsBefore: plan.charsBefore,
      charsAfter: plan.charsAfter,
      tokensBefore: plan.tokensBefore,
      tokensAfter: plan.tokensAfter,
    }
  }

  private landAll(session: Session, plans: readonly PlannedReplacement[]): PrunedEntry[] {
    if (plans.length === 0) return []
    if (!this.hasRecoveryTool(session)) {
      this.warnOnce(
        session,
        'missing-context-retrieve',
        'context-compression kept original tool results because context_compression_retrieve is unavailable',
      )
      return []
    }
    if (!this.hasOpenTurn(session)) {
      throw new Error('tool-result pruning cannot append a surface replacement outside any open turn')
    }
    const landed: PrunedEntry[] = []
    for (const plan of plans) {
      const entry = this.land(session, plan)
      if (entry === null) break
      landed.push(entry)
    }
    return landed
  }

  private hasRecoveryTool(session: Session): boolean {
    const tools = this.ctx.get('tools')
    if (tools === undefined) return false
    const agent = this.ctx.get('agents')?.get(session.id)
    return tools.get('context_compression_retrieve', agent) !== undefined
  }

  private auditHistoryEvaluation(
    session: Session,
    policy: CompressionPolicy,
    view: CompactionTokenView,
    allowed: boolean,
    plans: readonly PlannedReplacement[],
  ): void {
    if (policy.historyMode === 'disabled') {
      this.auditComponent(session, policy, 'history', 'pressure', 'disabled', 'profile-policy', {
        historyMode: policy.historyMode,
      })
      return
    }
    if (!allowed) {
      const capacity = session.requestContext()?.contextWindow
      const capacityTrigger = Number.isSafeInteger(capacity) && capacity !== undefined && capacity > 0
        ? Math.floor(capacity * 0.8)
        : undefined
      this.auditComponent(session, policy, 'history', 'pressure', 'skipped',
        policy.historyMode === 'capacity-pressure'
          ? 'capacity-pressure-inactive' : 'adaptive-policy-rejected', {
          historyMode: policy.historyMode,
          measurementKind: view.currentSurface.kind,
          currentTokens: view.totalTokens,
          ...(capacityTrigger === undefined ? {} : { triggerTokens: capacityTrigger }),
        })
      return
    }
    const candidates = this.snapshot(session, view)
      .filter(candidate => candidate.call.name !== 'context_compression_retrieve')
    const exact = candidates.map(candidate => exactTokens(candidate.count))
    const exactAvailable = exact.every(tokens => tokens !== undefined)
    const total = exactAvailable
      ? (exact as number[]).reduce((sum, tokens) => sum + tokens, 0)
      : undefined
    this.auditComponent(session, policy, 'history', 'pressure', 'skipped',
      !exactAvailable ? 'exact-tokenizer-unavailable'
        : (total ?? 0) <= policy.historyTriggerTokens ? 'at-or-below-trigger'
          : plans.length === 0 ? 'no-eligible-minimum-reclaim'
            : 'recovery-tool-unavailable', {
        historyMode: policy.historyMode,
        measurementKind: exactAvailable ? 'exact-tokenizer' : 'unavailable',
        ...(total === undefined ? {} : { currentTokens: total }),
        triggerTokens: policy.historyTriggerTokens,
      })
  }

  private auditComponent(
    session: Session,
    policy: CompressionPolicy,
    component: CompressionAuditComponent,
    stage: PruneStage,
    status: CompressionAuditEvaluationStatus,
    reason: string,
    detail: Readonly<{
      historyMode?: HistoryMode
      measurementKind?: 'exact-tokenizer' | 'tokenizer-estimate' | 'unavailable'
      currentTokens?: number
      triggerTokens?: number
      targetTokens?: number
    }> = {},
  ): void {
    emitCompressionAudit(this.ctx.logger, {
      schemaVersion: 1,
      kind: 'component-evaluation',
      sessionId: String(session.id),
      profile: policy.profile,
      component,
      stage,
      status,
      reason,
      ...detail,
    })
  }

  private auditFailure(
    session: Session,
    stage: PruneStage,
    operation: 'request-boundary' | 'terminal-pass' | 'policy-resolution',
    error: unknown,
  ): void {
    emitCompressionAudit(this.ctx.logger, {
      schemaVersion: 1,
      kind: 'failure',
      sessionId: String(session.id),
      stage,
      operation,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: error instanceof Error ? error.message : String(error),
    })
  }

  private auditPublicationFailure(
    session: Session,
    stage: PruneStage,
    component: CompressionAuditComponent,
    manifestSeq: number,
    error: unknown,
  ): void {
    emitCompressionAudit(this.ctx.logger, {
      schemaVersion: 1,
      kind: 'failure',
      sessionId: String(session.id),
      stage,
      operation: 'publication',
      component,
      manifestSeq,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: 'surface replacement append failed after compaction/prune committed',
    })
  }

  private warnExactUnavailable(
    session: Session,
    view: CompactionTokenView,
    gate: 'native' | 'fresh' | 'aggregate' | 'history' | 'tailtrim',
  ): void {
    const provider = view.providerRoute ?? 'unbound-provider'
    const model = view.modelId ?? 'unbound-model'
    this.warnOnce(
      session,
      `exact-tokenizer:${gate}:${provider}\0${model}`,
      'context-compression %s kept original tool results because exact tokenizer counts are unavailable for %s/%s',
      gate,
      provider,
      model,
    )
  }

  private warnOnce(
    session: Session,
    key: string,
    message: string,
    ...args: unknown[]
  ): void {
    let warned = this.warnedFailures.get(session)
    if (warned === undefined) {
      warned = new Set()
      this.warnedFailures.set(session, warned)
    }
    if (warned.has(key)) return
    warned.add(key)
    this.ctx.logger.warn(message, ...args)
  }

  /** Surface replacements are durable turn work; reject before writing the audit half. */
  private hasOpenTurn(session: Session): boolean {
    let open = false
    for (const event of session.events) {
      if (event.type === 'turn/start') open = true
      else if (event.type === 'turn/end') open = false
    }
    return open
  }

  private rootToolResultSeq(session: Session, seq: number): number {
    let current = seq
    const seen = new Set<number>()
    while (!seen.has(current)) {
      seen.add(current)
      const event = session.events[current]
      if (event?.type !== 'tool/result' || typeof event.surfaceOp !== 'object') return current
      const previous = event.sourceEventSeqs?.[0]
      if (previous === undefined) return current
      current = previous
    }
    return seq
  }

  private sourceRef(session: Session, seq: number): string {
    return `session://${session.id}/event/${String(seq)}`
  }

  private nativePruneContent(
    blocks: readonly ContentBlock[],
    thresholdChars: number,
    headChars: number,
    tailChars: number,
    marker: string = PRUNE_MARKER,
  ): ContentBlock[] | null {
    const totalChars = this.measureContent(blocks)
    if (totalChars <= thresholdChars) return null
    const markerChars = codePointLength(marker)
    const safeHead = Math.max(0, Math.min(headChars, thresholdChars - markerChars))
    const safeTail = Math.max(0, Math.min(tailChars, thresholdChars - markerChars - safeHead))
    const removedStart = safeHead
    const removedEnd = totalChars - safeTail
    const pruned: ContentBlock[] = []
    let consumed = 0
    let markerInserted = false
    for (const block of blocks) {
      if (block.type !== 'text') {
        pruned.push(block)
        continue
      }
      const points = Array.from(block.text)
      const blockStart = consumed
      const blockEnd = blockStart + points.length
      const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
      const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
      const intersectsRemoved = blockStart < removedEnd && blockEnd > removedStart
      const insertion = intersectsRemoved && !markerInserted ? marker : ''
      if (insertion !== '') markerInserted = true
      const text = points.slice(0, headEnd).join('') + insertion + points.slice(tailStart).join('')
      if (text !== '') pruned.push({ ...block, text })
      consumed = blockEnd
    }
    if (!markerInserted) return null
    const charsAfter = this.measureContent(pruned)
    return charsAfter <= thresholdChars && charsAfter < totalChars ? pruned : null
  }
}

function onlyTextBlock(blocks: readonly ContentBlock[]): Extract<ContentBlock, { type: 'text' }> | null {
  return blocks.length === 1 && blocks[0]?.type === 'text' ? blocks[0] : null
}

function onlyTextBlocks(blocks: readonly ContentBlock[]): readonly Extract<ContentBlock, { type: 'text' }>[] | null {
  return blocks.every((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    ? blocks
    : null
}

function countToolContent(blocks: readonly ContentBlock[], view: CompactionTokenView): TokenCount {
  const text = onlyTextBlocks(blocks)
  if (text === null) return unavailableCount('tool result contains unsupported rich content')
  return countExactCanonicalTextFields(
    text.map(block => block.text),
    candidate => view.countCanonicalText(candidate),
    'tool result replacement',
  )
}

function exactTokens(count: TokenCount): number | undefined {
  return count.kind === 'exact-tokenizer' ? count.tokens : undefined
}

function sameProviderMeasurementKey(
  left: Readonly<ProviderMeasurementKey>,
  right: Readonly<ProviderMeasurementKey>,
): boolean {
  return left.provider === right.provider
    && left.baseUrlClass === right.baseUrlClass
    && left.apiRoute === right.apiRoute
    && left.modelId === right.modelId
    && left.requestTemplateRevision === right.requestTemplateRevision
    && left.tokenizerRevision === right.tokenizerRevision
    && left.modality === right.modality
}

function unavailableCount(reason: string): TokenCount {
  return Object.freeze({ kind: 'unavailable', reason })
}

function recoveryMarker(sourceRef: string, label: string): string {
  return `\n\n[... ${label}; source=${sourceRef}; use context_compression_retrieve if needed ...]\n\n`
}

function summarize(entries: readonly PrunedEntry[]): PruneResult {
  return {
    pruned: entries,
    charsRemoved: entries.reduce((sum, entry) => sum + entry.charsBefore - entry.charsAfter, 0),
    tokensRemoved: entries.reduce((sum, entry) => sum + entry.tokensBefore - entry.tokensAfter, 0),
  }
}

function emptyResult(): PruneResult {
  return { pruned: [], charsRemoved: 0, tokensRemoved: 0 }
}

export default ToolResultPruner
