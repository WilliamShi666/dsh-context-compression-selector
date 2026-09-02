import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  createMessage,
  createUserMessage,
  createToolResultMessage,
  LlmAdapter,
  type ContentBlock,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import SessionStore, {
  Session,
  SessionId,
  canonicalHeader,
} from '@deepseek-ai/dsh-session'
import {
  agentEvents,
  Inbox,
  type Agent,
} from '@deepseek-ai/dsh-agent'
import {
  SettingsProvider,
  settingsNamespace,
  type SettingsNamespace,
} from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SelectorHost from '../../../selector/src/index.ts'
import * as RuntimeInvariant from '../../src/invariant.ts'
import ToolResultPruner, {
  CONTEXT_COMPRESSION_SETTINGS_NAMESPACE,
  DEFAULT_CUSTOM_COMPRESSION_POLICY,
  resolveConfig,
  resolvePolicy,
} from '../../src/index.ts'
import type { CustomCompressionPolicy } from '../../src/index.ts'
import { DEEPSEEK_V4_TOKENIZER_ARTIFACT, deepSeekV4TokenizerForModel } from '../../src/deepseek-v4-tokenizer.ts'
import {
  DEEPSEEK_VISION_DEFAULT_IMAGE_TOKENS,
  DEEPSEEK_VISION_IMAGE_ESTIMATOR,
  DEEPSEEK_VISION_PROJECTION,
  deepSeekVisionImageBlockTokens,
  deepSeekVisionImageGrid,
} from '../../src/deepseek-v4-vision-tokens.ts'
import { validatePublishedTailTrim } from '../../src/tail-trim.ts'
import { measureForCompaction } from '../../src/measurement.ts'
import {
  COMPRESSION_AUDIT_PREFIX,
  type CompressionAuditRecord,
  type CompressionRewriteAuditRecord,
} from '../../src/audit.ts'

const MODEL = 'deepseek-v4-flash'
const VISION_MODEL = 'deepseek-v4-flash-vision-exp'
const activeContexts: Context[] = []

/** Metadata-only raster image block; never carries image bytes. */
function imageBlock(width: number, height: number): ContentBlock {
  // AttachmentId is an opaque brand over string; tests construct the durable
  // reference structurally without importing the attachment package.
  return {
    type: 'image',
    attachment: {
      attachmentId: `test-image-${String(width)}x${String(height)}`,
      mediaType: 'image/png',
      bytes: 1_024,
      width,
      height,
    },
  } as ContentBlock
}

afterEach(async () => {
  for (const ctx of activeContexts.splice(0)) await ctx.fiber.dispose()
})

class TestSettings extends SettingsProvider {
  readonly writable = true
  private readonly stored: Record<string, unknown> = {}

  protected override load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.stored))
  }

  protected override persist(namespace: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.stored[namespace] = structuredClone(section)
    return Promise.resolve()
  }
}

class NativeSummaryAdapter extends LlmAdapter {
  constructor(
    private readonly responses: string[],
    private readonly contextWindow: number,
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const text = this.responses.shift()
    if (text === undefined) throw new Error('NativeSummaryAdapter: response script exhausted')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function runtimeContext(): Promise<Context> {
  const ctx = new Context()
  activeContexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(TokenMeter)
  return ctx
}

function captureAudit(ctx: Context): {
  records(): CompressionAuditRecord[]
} {
  const info = vi.spyOn(ctx.logger, 'info').mockImplementation(() => ctx.logger)
  return {
    records: () => info.mock.calls.flatMap((call) => {
      const line = String(call[0])
      return line.startsWith(COMPRESSION_AUDIT_PREFIX)
        ? [JSON.parse(line.slice(COMPRESSION_AUDIT_PREFIX.length)) as CompressionAuditRecord]
        : []
    }),
  }
}

function rewrites(records: readonly CompressionAuditRecord[]): CompressionRewriteAuditRecord[] {
  return records.filter((record): record is CompressionRewriteAuditRecord => record.kind === 'rewrite')
}

function appendToolTurn(
  session: Session,
  turn: number,
  text: string,
  closeTurn: boolean,
  userText?: string,
  provider = 'deepseek',
  model: string = MODEL,
): { readonly assistantSeq: number; readonly resultSeq: number } {
  const callId = CallId(`call-${String(turn)}`)
  session.append('turn/start', { turn })
  if (session.requestHeader() === undefined) {
    session.append('request/header', {
      reason: 'initial',
      header: canonicalHeader({ config: { provider, model } }),
    })
  }
  if (userText !== undefined) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: userText }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  session.append('step/start', { turn, step: 1 })
  const assistant = session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
      source: { kind: 'model', provider, model },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step: 1, callId, name: 'bash', arguments: '{}' })
  const result = session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  if (closeTurn) session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return { assistantSeq: assistant.seq, resultSeq: result.seq }
}

function appendToolBatchTurn(
  session: Session,
  turn: number,
  texts: readonly string[],
  closeTurn: boolean,
  userText?: string,
): { readonly assistantSeq: number; readonly resultSeqs: readonly number[] } {
  const calls = texts.map((_, index) => ({
    id: CallId(`call-${String(turn)}-${String(index + 1)}`),
    name: 'bash',
  }))
  session.append('turn/start', { turn })
  if (session.requestHeader() === undefined) {
    session.append('request/header', {
      reason: 'initial',
      header: canonicalHeader({ config: { provider: 'deepseek', model: MODEL } }),
    })
  }
  if (userText !== undefined) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: userText }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  session.append('step/start', { turn, step: 1 })
  const assistant = session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: calls.map(call => ({
        type: 'tool-call' as const,
        id: call.id,
        name: call.name,
        arguments: '{}',
      })),
      source: { kind: 'model', provider: 'deepseek', model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  const resultSeqs: number[] = []
  for (const [index, call] of calls.entries()) {
    session.append('tool/call', {
      turn,
      step: 1,
      callId: call.id,
      name: call.name,
      arguments: '{}',
    })
    const result = session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId: call.id,
        content: [{ type: 'text', text: texts[index] ?? '' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    resultSeqs.push(result.seq)
  }
  session.append('step/end', { turn, step: 1 })
  if (closeTurn) session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return { assistantSeq: assistant.seq, resultSeqs }
}

function stubAgent(ctx: Context, session: Session): Agent {
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

describe('standalone runtime on published Harness APIs', () => {
  it('loads the pinned official tokenizers and refuses unverified model ids', () => {
    const tokenizer = deepSeekV4TokenizerForModel(MODEL)
    expect(tokenizer?.countText('DeepSeek Harness').tokens).toBeGreaterThan(0)
    expect(deepSeekV4TokenizerForModel('deepseek-v4-flash-vision-exp')?.countText('DeepSeek Harness')).toMatchObject({
      kind: 'exact-tokenizer',
      tokenizerId: 'deepseek-ai/DeepSeek-V4-Flash-Vision-Exp',
      tokenizerRevision: '6821d6ad3681a4b137b066b76094fa82ebd0a380',
    })
    expect(deepSeekV4TokenizerForModel('deepseek-v4-flash-vision')).toBeUndefined()
  })

  it.each([
    ['off', Number.MAX_SAFE_INTEGER],
    ['native', Number.MAX_SAFE_INTEGER],
    ['balanced', 500_000],
    ['cache-strict', 600_000],
    ['savings', 400_000],
    ['adaptive', 500_000],
  ] as const)('resolves %s with the shared 10-call and 64k token-tail History working set', (profile, trigger) => {
    const policy = resolvePolicy(resolveConfig(), profile)

    expect(policy.historyTriggerTokens).toBe(trigger)
    expect(policy.historyKeepRecentToolCalls).toBe(10)
    expect(policy.historyKeepRecentTokens).toBe(64_000)
  })

  it.each([
    'balanced',
    'cache-strict',
    'savings',
    'adaptive',
    'custom',
  ] as const)('disables native head/middle/tail pruning for %s', (profile) => {
    expect(resolvePolicy(resolveConfig(), profile).nativeToolResultEnabled).toBe(false)
  })

  it('enables native head/middle/tail pruning only for the Native profile', () => {
    expect(resolvePolicy(resolveConfig(), 'native').nativeToolResultEnabled).toBe(true)
    expect(resolvePolicy(resolveConfig(), 'off').nativeToolResultEnabled).toBe(false)
  })

  it('lands a standard compaction/prune plus tool-result replacement without custom events', async () => {
    const ctx = await runtimeContext()
    const audit = captureAudit(ctx)
    await ctx.plugin(ToolResultPruner, {
      profile: 'native',
      nativeTriggerTokens: 100,
      nativeTargetTokens: 64,
      headChars: 8,
      tailChars: 8,
    }).await()
    const pruner = ctx.toolResultPruner
    const session = Session.create(SessionId('public-native-prune'))
    const source = appendToolTurn(session, 1, 'x'.repeat(8_000), false)
    const view = measureForCompaction(ctx, session)
    expect(ctx.tools.get('context_compression_retrieve')).toBeDefined()
    expect(view.currentSurface.kind).toBe('exact-tokenizer')
    if (view.currentSurface.kind === 'exact-tokenizer') {
      expect(view.currentSurface.tokens).toBeGreaterThan(100)
    }

    const result = pruner.pruneSession(session, { stage: 'pressure' })

    expect(result.pruned).toHaveLength(1)
    const manifest = session.events.at(-2)
    const replacement = session.events.at(-1)
    expect(manifest?.type).toBe('compaction/prune')
    expect(session.events.some(event => event.type === ('compaction/group-trim' as string))).toBe(false)
    expect(replacement?.type).toBe('tool/result')
    if (replacement?.type !== 'tool/result') throw new Error('Native prune did not append a tool result replacement')
    expect(replacement.surfaceOp).toEqual({
      op: 'replace',
      start: source.resultSeq,
      end: source.resultSeq,
    })
    expect(replacement.sourceEventSeqs).toContain(source.resultSeq)
    expect(rewrites(audit.records())).toContainEqual(expect.objectContaining({
      component: 'native-tool-result',
      stage: 'pressure',
      manifestSeq: manifest?.seq,
      replacementSeq: replacement?.seq,
      tokensBefore: expect.any(Number),
      tokensAfter: expect.any(Number),
    }))
  })

  it('proves isolated Fresh with exact before/after audit evidence', async () => {
    const ctx = await runtimeContext()
    const audit = captureAudit(ctx)
    await ctx.plugin(ToolResultPruner, {
      profile: 'balanced',
      freshTriggerTokens: 100,
      freshTargetTokens: 64,
      aggregateTriggerTokens: 100_000,
      aggregateTargetTokens: 90_000,
      historyTriggerTokens: 100_000,
    }).await()
    const session = Session.create(SessionId('public-fresh-e2e'))
    appendToolTurn(session, 1, 'fresh evidence '.repeat(1_000), false, undefined, 'deepseek-official')

    const result = ctx.toolResultPruner.pruneSession(session, {
      stage: 'fresh',
      freshTurn: 1,
      freshStep: 1,
    })

    expect(result.pruned).toHaveLength(1)
    const record = rewrites(audit.records()).find(entry => entry.component === 'fresh')
    expect(record).toMatchObject({
      stage: 'fresh',
      reducer: expect.any(String),
      manifestEventType: 'compaction/prune',
      tokenizerId: expect.any(String),
      tokenizerRevision: expect.any(String),
    })
    expect(record?.tokensBefore).toBeGreaterThan(100)
    expect(record?.tokensAfter).toBeLessThanOrEqual(64)
    expect(record?.tokensRemoved).toBe((record?.tokensBefore ?? 0) - (record?.tokensAfter ?? 0))
  })

  it('proves isolated Aggregate while Fresh and History remain below their gates', async () => {
    const ctx = await runtimeContext()
    const audit = captureAudit(ctx)
    await ctx.plugin(ToolResultPruner, {
      profile: 'balanced',
      freshTriggerTokens: 100_000,
      freshTargetTokens: 90_000,
      aggregateTriggerTokens: 100,
      aggregateTargetTokens: 64,
      historyTriggerTokens: 100_000,
    }).await()
    const session = Session.create(SessionId('public-aggregate-e2e'))
    appendToolTurn(session, 1, 'aggregate evidence '.repeat(1_000), false, undefined, 'deepseek-official')

    const result = ctx.toolResultPruner.pruneSession(session, {
      stage: 'fresh',
      freshTurn: 1,
      freshStep: 1,
    })

    expect(result.pruned).toHaveLength(1)
    const record = rewrites(audit.records()).find(entry => entry.component === 'aggregate')
    expect(record).toMatchObject({
      stage: 'fresh',
      reducer: 'fresh-step-aggregate',
      manifestEventType: 'compaction/prune',
    })
    expect(record?.tokensBefore).toBeGreaterThan(100)
    expect(record?.tokensAfter).toBeLessThanOrEqual(64)
    expect(rewrites(audit.records()).some(entry => entry.component === 'fresh')).toBe(false)
    expect(rewrites(audit.records()).some(entry => entry.component === 'history')).toBe(false)
  })

  it('ages only results outside the recent tool-call and token-tail working set', async () => {
    const ctx = await runtimeContext()
    const session = Session.create(SessionId('public-history-tool-call-working-set'))
    const batch = appendToolBatchTurn(
      session,
      1,
      Array.from({ length: 5 }, () => 'working-set evidence '.repeat(1_000)),
      true,
    )
    session.append('turn/start', { turn: 2 })
    const view = measureForCompaction(ctx, session)
    const counts = batch.resultSeqs.map((seq) => {
      const entry = view.measuredNodes.find(node => node.seq === seq)?.count
      if (entry?.kind !== 'exact-tokenizer') throw new Error('working-set test needs exact result counts')
      return entry.tokens
    })
    const recentTailTokens = counts.slice(-3).reduce((sum, tokens) => sum + tokens, 0) - 1
    const totalToolTokens = counts.reduce((sum, tokens) => sum + tokens, 0)

    await ctx.plugin(ToolResultPruner, {
      profile: 'balanced',
      freshTriggerTokens: 100_000,
      freshTargetTokens: 90_000,
      aggregateTriggerTokens: 100_000,
      aggregateTargetTokens: 90_000,
      // The strict required-reclaim gate demands one batch pull tool tokens
      // back below the trigger; 72% leaves exactly the two oldest results as
      // the reclaimable margin above the placeholder residue.
      historyTriggerTokens: Math.floor(totalToolTokens * 0.72),
      historyKeepRecentToolCalls: 2,
      historyKeepRecentTokens: recentTailTokens,
      historyMinReclaimTokens: 1,
    }).await()

    const result = ctx.toolResultPruner.pruneSession(session, { stage: 'pressure' })

    expect(result.pruned).toHaveLength(2)
    expect(result.pruned.map(entry => entry.originalSeq)).toEqual(batch.resultSeqs.slice(0, 2))
    expect(result.pruned.map(entry => entry.originalSeq)).not.toContain(batch.resultSeqs.at(-1))
    expect(result.pruned.map(entry => entry.originalSeq)).not.toContain(batch.resultSeqs.at(-2))
    expect(result.pruned.map(entry => entry.originalSeq)).not.toContain(batch.resultSeqs.at(-3))
  })

  it('proves isolated routine History against completed old turns', async () => {
    const ctx = await runtimeContext()
    const audit = captureAudit(ctx)
    await ctx.plugin(ToolResultPruner, {
      profile: 'savings',
      freshTriggerTokens: 100_000,
      freshTargetTokens: 90_000,
      aggregateTriggerTokens: 100_000,
      aggregateTargetTokens: 90_000,
      historyTriggerTokens: 1_200,
      historyKeepRecentToolCalls: 0,
      historyKeepRecentTokens: 1,
      historyMinReclaimTokens: 1,
    }).await()
    const session = Session.create(SessionId('public-history-e2e'))
    appendToolTurn(session, 1, 'old historical evidence '.repeat(1_000), true)
    // The one-token recent working-set budget protects at least the newest
    // completed result, so provide a second completed turn and age the oldest.
    appendToolTurn(session, 2, 'newer protected evidence', true)
    session.append('turn/start', { turn: 3 })

    const result = ctx.toolResultPruner.pruneSession(session, { stage: 'pressure' })

    expect(result.pruned).toHaveLength(1)
    const record = rewrites(audit.records()).find(entry => entry.component === 'history')
    expect(record).toMatchObject({
      stage: 'pressure',
      historyMode: 'routine',
      manifestEventType: 'compaction/prune',
    })
    expect(record?.tokensBefore).toBeGreaterThan(100)
    expect(record?.tokensAfter).toBeLessThan(record?.tokensBefore ?? 0)
  })

  it('moves the capacity-pressure gate with the frozen Auto Compact threshold', async () => {
    const ctx = await runtimeContext()
    await ctx.plugin(TestSettings).await()
    await ctx.plugin(SelectorHost).await()
    const audit = captureAudit(ctx)
    const namespace = settingsNamespace(CONTEXT_COMPRESSION_SETTINGS_NAMESPACE)

    // A high threshold delays the micro-compact last-chance gate past the old
    // fixed 0.7 ratio: pressure between 0.7*C and D must NOT age history.
    await ctx.settings.update(namespace, { profile: 'cache-strict', autoCompact: { thresholdPercent: 90 } })
    await ctx.plugin(ToolResultPruner, {
      profile: 'cache-strict',
      freshTriggerTokens: 100_000,
      freshTargetTokens: 90_000,
      aggregateTriggerTokens: 100_000,
      aggregateTargetTokens: 90_000,
    }).await()
    const delayed = Session.create(SessionId('public-autocompact-90-delayed'))
    appendToolTurn(delayed, 1, 'delayed gate evidence '.repeat(600), true)
    appendToolTurn(delayed, 2, 'newest protected result', true)
    const delayedTotal = measureForCompaction(ctx, delayed).totalTokens
    const delayedWindow = Math.floor(delayedTotal / 0.72)
    delayed.append('request/context', { provider: 'deepseek', model: MODEL, contextWindow: delayedWindow })
    delayed.append('turn/start', { turn: 3 })
    ctx.toolResultPruner.pruneSession(delayed, { stage: 'pressure' })
    expect(rewrites(audit.records()).some(record =>
      record.sessionId === String(delayed.id) && record.component === 'history')).toBe(false)
    expect(audit.records()).toContainEqual(expect.objectContaining({
      kind: 'component-evaluation',
      sessionId: String(delayed.id),
      component: 'history',
      reason: 'below-micro-deadline',
      triggerTokens: Math.floor(Math.floor(delayedWindow * 90 / 100) * 0.875),
    }))
  })

  it('ages History earlier when the frozen Auto Compact threshold is low', async () => {
    const ctx = await runtimeContext()
    await ctx.plugin(TestSettings).await()
    await ctx.plugin(SelectorHost).await()
    const audit = captureAudit(ctx)
    const namespace = settingsNamespace(CONTEXT_COMPRESSION_SETTINGS_NAMESPACE)

    // A low threshold pulls the micro-compact deadline below the old fixed
    // 0.7 ratio: pressure between D and 0.7*C must age history now.
    await ctx.settings.update(namespace, { profile: 'cache-strict', autoCompact: { thresholdPercent: 50 } })
    await ctx.plugin(ToolResultPruner, {
      profile: 'cache-strict',
      freshTriggerTokens: 100_000,
      freshTargetTokens: 90_000,
      aggregateTriggerTokens: 100_000,
      aggregateTargetTokens: 90_000,
      historyTriggerTokens: 400,
      historyKeepRecentToolCalls: 0,
      historyKeepRecentTokens: 1,
      historyMinReclaimTokens: 1,
    }).await()
    const early = Session.create(SessionId('public-autocompact-50-early'))
    appendToolTurn(early, 1, 'early gate evidence '.repeat(600), true)
    appendToolTurn(early, 2, 'newest protected result', true)
    const earlyTotal = measureForCompaction(ctx, early).totalTokens
    const earlyWindow = Math.floor(earlyTotal / 0.6)
    early.append('request/context', { provider: 'deepseek', model: MODEL, contextWindow: earlyWindow })
    early.append('turn/start', { turn: 3 })
    ctx.toolResultPruner.pruneSession(early, { stage: 'pressure' })

    expect(rewrites(audit.records()).some(record =>
      record.sessionId === String(early.id) && record.component === 'history')).toBe(true)
  })

  it('freezes the generation-owned threshold over later global settings changes', async () => {
    const ctx = await runtimeContext()
    await ctx.plugin(TestSettings).await()
    await ctx.plugin(SelectorHost).await()
    const audit = captureAudit(ctx)
    const namespace = settingsNamespace(CONTEXT_COMPRESSION_SETTINGS_NAMESPACE)
    // The preset overlay captured 70% into this generation's deployment
    // config; the user then moved the global setting to 90 before the first
    // prune. Auto Compact and micro compact must both stay on 70%.
    await ctx.plugin(ToolResultPruner, {
      profile: 'balanced',
      autoCompactThresholdPercent: 70,
    }).await()
    const session = Session.create(SessionId('public-generation-owned-threshold'))
    appendToolTurn(session, 1, 'generation-owned threshold evidence', false)
    session.append('request/context', { provider: 'deepseek', model: MODEL, contextWindow: 1_000_000 })
    await ctx.settings.update(namespace, { profile: 'balanced', autoCompact: { thresholdPercent: 90 } })
    ctx.toolResultPruner.pruneSession(session, { stage: 'fresh', freshTurn: 1, freshStep: 1 })

    const resolved = audit.records().find(record =>
      record.kind === 'policy-resolved' && record.sessionId === String(session.id))
    expect(resolved).toMatchObject({
      coordination: {
        thresholdPercent: 70,
        autoCompactTokens: 700_000,
        microDeadlineTokens: 612_500,
      },
    })
    const frozen = audit.records().find(record =>
      record.kind === 'policy-frozen' && record.sessionId === String(session.id))
    expect(frozen).toMatchObject({
      autoCompactThresholdSource: 'generation-config',
      settings: { autoCompact: { thresholdPercent: 70 } },
    })
  })

  it('fails open to a lossless frozen policy when stored settings are malformed', async () => {
    const ctx = await runtimeContext()
    await ctx.plugin(TestSettings).await()
    await ctx.plugin(SelectorHost).await()
    const audit = captureAudit(ctx)
    const namespace = settingsNamespace(CONTEXT_COMPRESSION_SETTINGS_NAMESPACE)
    // A hand-edited store can surface a document the schema rejects (unknown
    // top-level key). The runtime must not fall back to a lossy-capable
    // profile: the session freezes effectively off and keeps every original
    // tool result.
    const malformed = {
      profile: 'off',
      custom: structuredClone(DEFAULT_CUSTOM_COMPRESSION_POLICY),
      unrelated: true,
    }
    const originalGet = ctx.settings.get.bind(ctx.settings)
    vi.spyOn(ctx.settings, 'get').mockImplementation((ns: unknown) =>
      ns === undefined || String(ns) === String(namespace) ? structuredClone(malformed) : originalGet(ns as never))
    await ctx.plugin(ToolResultPruner, {
      profile: 'balanced',
      freshTriggerTokens: 10,
      freshTargetTokens: 8,
    }).await()
    const session = Session.create(SessionId('public-malformed-settings-fail-open'))
    appendToolTurn(session, 1, 'malformed settings must not compress '.repeat(300), true)
    session.append('turn/start', { turn: 2 })

    const result = ctx.toolResultPruner.pruneSession(session, { stage: 'pressure' })

    expect(result.pruned).toHaveLength(0)
    expect(rewrites(audit.records())).toHaveLength(0)
    const frozen = audit.records().find(record =>
      record.kind === 'policy-frozen' && record.sessionId === String(session.id))
    expect(frozen).toMatchObject({
      settingsInvalidFallback: 'lossless-off',
      settings: { profile: 'off' },
    })
  })

  it.each([
    ['null profile', { profile: null, custom: structuredClone(DEFAULT_CUSTOM_COMPRESSION_POLICY) }],
    ['null custom', { profile: 'balanced', custom: null }],
    ['both sections null', { profile: null, custom: null }],
    ['own-property undefined profile', { profile: undefined, custom: structuredClone(DEFAULT_CUSTOM_COMPRESSION_POLICY) }],
    ['own-property undefined custom', { profile: 'off', custom: undefined }],
    ['profile off plus malformed autoCompact', {
      profile: 'off',
      custom: structuredClone(DEFAULT_CUSTOM_COMPRESSION_POLICY),
      autoCompact: { thresholdPercent: 400 },
    }],
  ])('fails open to a lossless frozen policy when the stored document carries %s', async (label, malformed) => {
    const ctx = await runtimeContext()
    await ctx.plugin(TestSettings).await()
    await ctx.plugin(SelectorHost).await()
    const audit = captureAudit(ctx)
    const namespace = settingsNamespace(CONTEXT_COMPRESSION_SETTINGS_NAMESPACE)
    // Schemastery `.default(...)` would silently replace these present-but-null
    // sections with the balanced/default-v3 policy; the runtime must reject the
    // document and freeze the session losslessly instead.
    const originalGet = ctx.settings.get.bind(ctx.settings)
    vi.spyOn(ctx.settings, 'get').mockImplementation((ns: unknown) =>
      ns === undefined || String(ns) === String(namespace) ? structuredClone(malformed) : originalGet(ns as never))
    await ctx.plugin(ToolResultPruner, {
      profile: 'balanced',
      freshTriggerTokens: 10,
      freshTargetTokens: 8,
    }).await()
    const session = Session.create(SessionId(`public-null-settings-${label.replace(/\s+/gu, '-')}`))
    appendToolTurn(session, 1, 'null settings must not compress '.repeat(300), true)
    session.append('turn/start', { turn: 2 })

    const result = ctx.toolResultPruner.pruneSession(session, { stage: 'pressure' })

    expect(result.pruned).toHaveLength(0)
    expect(rewrites(audit.records())).toHaveLength(0)
    const frozen = audit.records().find(record =>
      record.kind === 'policy-frozen' && record.sessionId === String(session.id))
    expect(frozen).toMatchObject({
      settingsInvalidFallback: 'lossless-off',
      settings: { profile: 'off' },
    })
  })

  it('validates exotic Host settings before any clone can erase their prototype', async () => {
    class AutoCompactDocument {
      thresholdPercent = 73
    }

    const ctx = await runtimeContext()
    await ctx.plugin(TestSettings).await()
    await ctx.plugin(SelectorHost).await()
    const audit = captureAudit(ctx)
    const namespace = settingsNamespace(CONTEXT_COMPRESSION_SETTINGS_NAMESPACE)
    const malformed = {
      profile: 'balanced' as const,
      custom: structuredClone(DEFAULT_CUSTOM_COMPRESSION_POLICY),
      autoCompact: new AutoCompactDocument(),
    }
    const originalGet = ctx.settings.get.bind(ctx.settings)
    vi.spyOn(ctx.settings, 'get').mockImplementation((ns: unknown) =>
      ns === undefined || String(ns) === String(namespace) ? malformed : originalGet(ns as never))
    await ctx.plugin(ToolResultPruner, {
      profile: 'balanced',
      freshTriggerTokens: 10,
      freshTargetTokens: 8,
    }).await()
    const session = Session.create(SessionId('public-exotic-settings-before-clone'))
    appendToolTurn(session, 1, 'exotic settings must not compress '.repeat(300), false)

    const result = ctx.toolResultPruner.pruneSession(session, {
      stage: 'fresh',
      freshTurn: 1,
      freshStep: 1,
    })

    expect(result.pruned).toHaveLength(0)
    expect(rewrites(audit.records())).toHaveLength(0)
    expect(audit.records()).toContainEqual(expect.objectContaining({
      kind: 'policy-frozen',
      sessionId: String(session.id),
      settingsInvalidFallback: 'lossless-off',
      settings: expect.objectContaining({ profile: 'off' }),
    }))
  })

  it('emits a policy audit again when the route returns to a previous value', async () => {
    const ctx = await runtimeContext()
    const audit = captureAudit(ctx)
    await ctx.plugin(ToolResultPruner, { profile: 'balanced' }).await()
    const session = Session.create(SessionId('public-policy-audit-reroute-aba'))
    const route = (model: string) => session.append('request/header', {
      reason: 'change',
      header: canonicalHeader({ config: { provider: 'deepseek', model } }),
    })
    const prune = (turn: number) => {
      appendToolTurn(session, turn, `route evidence ${String(turn)}`, false)
      ctx.toolResultPruner.pruneSession(session, { stage: 'fresh', freshTurn: turn, freshStep: 1 })
    }
    prune(1)
    route('deepseek-v4-pro')
    prune(2)
    route(MODEL)
    prune(3)

    const resolved = audit.records().filter((record): record is Extract<CompressionAuditRecord, { kind: 'policy-resolved' }> =>
      record.kind === 'policy-resolved' && record.sessionId === String(session.id))
    expect(resolved).toHaveLength(3)
    expect(resolved.map(record => record.route?.model)).toEqual([MODEL, 'deepseek-v4-pro', MODEL])
  })

  it('reports no bundled tokenizer for a DeepSeek model behind another provider', async () => {
    const ctx = await runtimeContext()
    const audit = captureAudit(ctx)
    await ctx.plugin(ToolResultPruner, { profile: 'balanced' }).await()
    const session = Session.create(SessionId('public-policy-audit-foreign-provider'))
    appendToolTurn(session, 1, 'foreign provider evidence', false, undefined, 'openai', 'deepseek-v4-pro')
    ctx.toolResultPruner.pruneSession(session, { stage: 'fresh', freshTurn: 1, freshStep: 1 })

    expect(audit.records()).toContainEqual(expect.objectContaining({
      kind: 'policy-resolved',
      sessionId: String(session.id),
      route: { provider: 'openai', model: 'deepseek-v4-pro' },
      tokenizer: { repository: 'unavailable', revision: 'unavailable' },
    }))
  })

  it('emits a fresh policy audit when the durable route changes mid-session', async () => {
    const ctx = await runtimeContext()
    const audit = captureAudit(ctx)
    await ctx.plugin(ToolResultPruner, { profile: 'balanced' }).await()
    const session = Session.create(SessionId('public-policy-audit-reroute'))
    appendToolTurn(session, 1, 'first route evidence', false)
    ctx.toolResultPruner.pruneSession(session, { stage: 'fresh', freshTurn: 1, freshStep: 1 })
    session.append('request/header', {
      reason: 'change',
      header: canonicalHeader({ config: { provider: 'deepseek', model: 'deepseek-v4-pro' } }),
    })
    appendToolTurn(session, 2, 'second route evidence', false, undefined, 'deepseek', 'deepseek-v4-pro')
    ctx.toolResultPruner.pruneSession(session, { stage: 'fresh', freshTurn: 2, freshStep: 1 })

    const resolved = audit.records().filter(record =>
      record.kind === 'policy-resolved' && record.sessionId === String(session.id))
    expect(resolved).toHaveLength(2)
    expect(resolved[0]).toMatchObject({ route: { model: MODEL } })
    expect(resolved[1]).toMatchObject({ route: { model: 'deepseek-v4-pro' } })
  })

  it('audits the Auto Compact coordination block on policy resolution', async () => {
    const ctx = await runtimeContext()
    await ctx.plugin(TestSettings).await()
    await ctx.plugin(SelectorHost).await()
    const audit = captureAudit(ctx)
    const namespace = settingsNamespace(CONTEXT_COMPRESSION_SETTINGS_NAMESPACE)
    await ctx.settings.update(namespace, { autoCompact: { thresholdPercent: 73 } })
    await ctx.plugin(ToolResultPruner, { profile: 'balanced' }).await()
    const session = Session.create(SessionId('public-autocompact-coordination'))
    appendToolTurn(session, 1, 'coordination audit evidence', false)
    session.append('request/context', { provider: 'deepseek', model: MODEL, contextWindow: 1_000_000 })
    ctx.toolResultPruner.pruneSession(session, { stage: 'fresh', freshTurn: 1, freshStep: 1 })

    const resolved = audit.records().find(record =>
      record.kind === 'policy-resolved' && record.sessionId === String(session.id))
    expect(resolved).toMatchObject({
      policy: {
        autoCompactTokens: 730_000,
        microDeadlineTokens: 638_750,
        historyTriggerTokens: 456_250,
      },
      contextWindowTokens: 1_000_000,
      coordination: {
        thresholdPercent: 73,
        autoCompactTokens: 730_000,
        microDeadlineTokens: 638_750,
        paramSource: 'auto-compact-linked',
      },
      route: { provider: 'deepseek', model: MODEL },
      tokenizer: {
        repository: 'deepseek-ai/DeepSeek-V4-Pro',
        revision: DEEPSEEK_V4_TOKENIZER_ARTIFACT.revision,
      },
    })

    // Deployment config overriding every linked History watermark must audit
    // itself as deployment-override, not as linkage-derived.
    const overrideCtx = await runtimeContext()
    await overrideCtx.plugin(TestSettings).await()
    await overrideCtx.plugin(SelectorHost).await()
    const overrideAudit = captureAudit(overrideCtx)
    await overrideCtx.settings.update(namespace, { autoCompact: { thresholdPercent: 73 } })
    await overrideCtx.plugin(ToolResultPruner, {
      profile: 'balanced',
      historyTriggerTokens: 123_456,
      historyKeepRecentTokens: 12_345,
      historyMinReclaimTokens: 1_234,
    }).await()
    const overrideSession = Session.create(SessionId('public-autocompact-deployment-override'))
    appendToolTurn(overrideSession, 1, 'deployment override evidence', false)
    overrideSession.append('request/context', { provider: 'deepseek', model: MODEL, contextWindow: 1_000_000 })
    overrideCtx.toolResultPruner.pruneSession(overrideSession, { stage: 'fresh', freshTurn: 1, freshStep: 1 })
    expect(overrideAudit.records()).toContainEqual(expect.objectContaining({
      kind: 'policy-resolved',
      sessionId: String(overrideSession.id),
      coordination: expect.objectContaining({
        microDeadlineTokens: 638_750,
        paramSource: 'deployment-override',
      }),
    }))

    // A partial override of the linked watermarks reads as mixed.
    const mixedCtx = await runtimeContext()
    await mixedCtx.plugin(TestSettings).await()
    await mixedCtx.plugin(SelectorHost).await()
    const mixedAudit = captureAudit(mixedCtx)
    await mixedCtx.settings.update(namespace, { autoCompact: { thresholdPercent: 73 } })
    await mixedCtx.plugin(ToolResultPruner, {
      profile: 'balanced',
      historyTriggerTokens: 123_456,
    }).await()
    const mixedSession = Session.create(SessionId('public-autocompact-mixed-source'))
    appendToolTurn(mixedSession, 1, 'mixed source evidence', false)
    mixedSession.append('request/context', { provider: 'deepseek', model: MODEL, contextWindow: 1_000_000 })
    mixedCtx.toolResultPruner.pruneSession(mixedSession, { stage: 'fresh', freshTurn: 1, freshStep: 1 })
    expect(mixedAudit.records()).toContainEqual(expect.objectContaining({
      kind: 'policy-resolved',
      sessionId: String(mixedSession.id),
      coordination: expect.objectContaining({
        microDeadlineTokens: 638_750,
        paramSource: 'mixed',
      }),
    }))

    // A route without a verified bundled tokenizer reports the unavailable
    // identity instead of inventing one.
    const unknown = Session.create(SessionId('public-autocompact-unknown-route'))
    appendToolTurn(unknown, 1, 'unknown route evidence', false, undefined, 'deepseek', 'some-other-model')
    ctx.toolResultPruner.pruneSession(unknown, { stage: 'fresh', freshTurn: 1, freshStep: 1 })
    expect(audit.records()).toContainEqual(expect.objectContaining({
      kind: 'policy-resolved',
      sessionId: String(unknown.id),
      route: { provider: 'deepseek', model: 'some-other-model' },
      tokenizer: { repository: 'unavailable', revision: 'unavailable' },
    }))
  })

  it('freezes the Auto Compact threshold per Session and applies new values only to new Sessions', async () => {
    const ctx = await runtimeContext()
    await ctx.plugin(TestSettings).await()
    await ctx.plugin(SelectorHost).await()
    const audit = captureAudit(ctx)
    const namespace = settingsNamespace(CONTEXT_COMPRESSION_SETTINGS_NAMESPACE)
    await ctx.plugin(ToolResultPruner, { profile: 'balanced' }).await()

    const first = Session.create(SessionId('public-autocompact-freeze-first'))
    appendToolTurn(first, 1, 'frozen threshold evidence', false)
    first.append('request/context', { provider: 'deepseek', model: MODEL, contextWindow: 1_000_000 })
    ctx.toolResultPruner.pruneSession(first, { stage: 'fresh', freshTurn: 1, freshStep: 1 })

    await ctx.settings.update(namespace, { autoCompact: { thresholdPercent: 73 } })

    const second = Session.create(SessionId('public-autocompact-freeze-second'))
    appendToolTurn(second, 1, 'new threshold evidence', false)
    second.append('request/context', { provider: 'deepseek', model: MODEL, contextWindow: 1_000_000 })
    ctx.toolResultPruner.pruneSession(second, { stage: 'fresh', freshTurn: 1, freshStep: 1 })

    // The already-observed session keeps its frozen 80% policy even after
    // another prune; only the new session adopts 73%.
    first.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    appendToolTurn(first, 2, 'post-change frozen evidence', false)
    first.append('request/context', { provider: 'deepseek', model: MODEL, contextWindow: 1_000_000 })
    ctx.toolResultPruner.pruneSession(first, { stage: 'fresh', freshTurn: 2, freshStep: 1 })

    const resolvedFor = (sessionId: string) => audit.records().find(record =>
      record.kind === 'policy-resolved' && record.sessionId === sessionId)
    expect(resolvedFor(String(first.id))).toMatchObject({
      coordination: { thresholdPercent: 80, autoCompactTokens: 800_000, microDeadlineTokens: 700_000 },
    })
    expect(resolvedFor(String(second.id))).toMatchObject({
      coordination: { thresholdPercent: 73, autoCompactTokens: 730_000, microDeadlineTokens: 638_750 },
    })
    expect(audit.records().filter(record =>
      record.kind === 'policy-resolved'
      && record.sessionId === String(first.id)
      && record.coordination?.thresholdPercent === 73)).toHaveLength(0)
  })

  it('ages History through the full-request last-chance gate even below the profile trigger', async () => {
    const ctx = await runtimeContext()
    const audit = captureAudit(ctx)
    await ctx.plugin(ToolResultPruner, {
      profile: 'balanced',
      freshTriggerTokens: 100_000,
      freshTargetTokens: 90_000,
      aggregateTriggerTokens: 100_000,
      aggregateTargetTokens: 90_000,
      historyTriggerTokens: 100_000,
      historyKeepRecentToolCalls: 0,
      historyKeepRecentTokens: 1,
      historyMinReclaimTokens: 1,
    }).await()
    const session = Session.create(SessionId('public-history-last-chance'))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', {
      reason: 'initial',
      header: canonicalHeader({ config: { provider: 'deepseek', model: MODEL } }),
    })
    // Non-tool prose carries the full request past the deadline while the
    // tool results alone stay far below the linked profile trigger.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'pressure prose '.repeat(1_000) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: CallId('last-chance-old'), name: 'bash', arguments: '{}' }],
        source: { kind: 'model', provider: 'deepseek', model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('last-chance-old'), name: 'bash', arguments: '{}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('last-chance-old'),
        content: [{ type: 'text', text: 'last-chance aging evidence '.repeat(700) }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    appendToolTurn(session, 2, 'newest protected result', true)
    // 80% default on a 10,000-token window: A = 8000, linked H = 5000, D = 7000.
    session.append('request/context', { provider: 'deepseek', model: MODEL, contextWindow: 10_000 })
    session.append('turn/start', { turn: 3 })

    const before = measureForCompaction(ctx, session)
    const toolResultTokens = before.measuredNodes
      .filter(node => session.events[node.seq]?.type === 'tool/result')
      .reduce((sum, node) => sum + (node.count.kind === 'exact-tokenizer' ? node.count.tokens : 0), 0)
    // Deadline D = 7000 is reached by the complete request, not by the tool
    // results, which stay far below every trigger in force.
    expect(before.totalTokens).toBeGreaterThanOrEqual(7_000)
    expect(toolResultTokens).toBeLessThan(7_000)

    const result = ctx.toolResultPruner.pruneSession(session, { stage: 'pressure' })

    const aged = rewrites(audit.records()).filter(record =>
      record.sessionId === String(session.id) && record.component === 'history')
    expect(aged.length).toBeGreaterThanOrEqual(1)
    expect(result.pruned.length).toBeGreaterThanOrEqual(1)
  })

  it.each(['balanced', 'adaptive'] as const)(
    'skips a linked History batch that cannot reach its reclaim target in %s mode',
    async (profile) => {
    const ctx = await runtimeContext()
    const audit = captureAudit(ctx)
    await ctx.plugin(ToolResultPruner, {
      profile,
      freshTriggerTokens: 100_000,
      freshTargetTokens: 90_000,
      aggregateTriggerTokens: 100_000,
      aggregateTargetTokens: 90_000,
      historyTriggerTokens: 100,
      historyKeepRecentToolCalls: 0,
      historyKeepRecentTokens: 1,
      historyMinReclaimTokens: 1,
    }).await()

    // Below the deadline: the excess above the trigger sits mostly in the
    // protected newest result, so the only reclaimable batch is far too small.
    const below = Session.create(SessionId(`public-history-insufficient-reclaim-${profile}`))
    appendToolTurn(below, 1, 'unreachable reclaim evidence '.repeat(400), true)
    appendToolTurn(below, 2, 'newest protected bulk '.repeat(600), true)
    below.append('request/context', { provider: 'deepseek', model: MODEL, contextWindow: 10_000 })
    below.append('turn/start', { turn: 3 })
    const belowResult = ctx.toolResultPruner.pruneSession(below, { stage: 'pressure' })
    expect(belowResult.pruned).toHaveLength(0)
    expect(rewrites(audit.records()).some(record =>
      record.sessionId === String(below.id) && record.component === 'history')).toBe(false)
    expect(audit.records()).toContainEqual(expect.objectContaining({
      kind: 'component-evaluation',
      sessionId: String(below.id),
      component: 'history',
      status: 'skipped',
      reason: 'insufficient-reclaim',
      reclaimTokens: expect.any(Number),
      requiredTokens: expect.any(Number),
    }))

    // Past the deadline with tool tokens below the trigger: the last-chance
    // gate engages planning, and the skip names the deadline target.
    const past = Session.create(SessionId(`public-history-deadline-unreachable-${profile}`))
    past.append('turn/start', { turn: 1 })
    past.append('request/header', {
      reason: 'initial',
      header: canonicalHeader({ config: { provider: 'deepseek', model: MODEL } }),
    })
    past.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'deadline pressure prose '.repeat(2_000) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    appendToolTurn(past, 1, 'deadline unreachable evidence '.repeat(400), true)
    appendToolTurn(past, 2, 'newest protected bulk '.repeat(600), true)
    past.append('request/context', { provider: 'deepseek', model: MODEL, contextWindow: 10_000 })
    past.append('turn/start', { turn: 2 })
    const pastResult = ctx.toolResultPruner.pruneSession(past, { stage: 'pressure' })
    expect(pastResult.pruned).toHaveLength(0)
    expect(rewrites(audit.records()).some(record =>
      record.sessionId === String(past.id) && record.component === 'history')).toBe(false)
    expect(audit.records()).toContainEqual(expect.objectContaining({
      kind: 'component-evaluation',
      sessionId: String(past.id),
      component: 'history',
      status: 'skipped',
      reason: 'cannot-reach-deadline-target',
      triggerTokens: 7_000,
    }))
    },
  )

  it.each(['balanced', 'adaptive'] as const)(
    'audits below-profile-trigger in %s mode when the tool-result total sits under the History trigger',
    async (profile) => {
    const ctx = await runtimeContext()
    const audit = captureAudit(ctx)
    await ctx.plugin(ToolResultPruner, {
      profile,
      freshTriggerTokens: 100_000,
      freshTargetTokens: 90_000,
      aggregateTriggerTokens: 100_000,
      aggregateTargetTokens: 90_000,
      historyTriggerTokens: 100_000,
      historyKeepRecentToolCalls: 0,
      historyKeepRecentTokens: 1,
      historyMinReclaimTokens: 1,
    }).await()
    const session = Session.create(SessionId(`public-history-below-profile-trigger-${profile}`))
    appendToolTurn(session, 1, 'small routine evidence', true)
    session.append('turn/start', { turn: 2 })
    ctx.toolResultPruner.pruneSession(session, { stage: 'pressure' })
    expect(audit.records()).toContainEqual(expect.objectContaining({
      kind: 'component-evaluation',
      sessionId: String(session.id),
      component: 'history',
      status: 'skipped',
      reason: 'below-profile-trigger',
      triggerTokens: 100_000,
    }))
    },
  )

  it.each(['balanced', 'adaptive'] as const)(
    'audits protected-working-set in %s mode when every safe candidate is inside the protected tail',
    async (profile) => {
    const ctx = await runtimeContext()
    const audit = captureAudit(ctx)
    await ctx.plugin(ToolResultPruner, {
      profile,
      freshTriggerTokens: 100_000,
      freshTargetTokens: 90_000,
      aggregateTriggerTokens: 100_000,
      aggregateTargetTokens: 90_000,
      historyTriggerTokens: 100,
      historyKeepRecentToolCalls: 10,
      historyKeepRecentTokens: 1_000_000,
      historyMinReclaimTokens: 1,
    }).await()
    const session = Session.create(SessionId(`public-history-protected-working-set-${profile}`))
    appendToolTurn(session, 1, 'protected working set evidence '.repeat(300), true)
    appendToolTurn(session, 2, 'newest protected result '.repeat(300), true)
    session.append('turn/start', { turn: 3 })
    const result = ctx.toolResultPruner.pruneSession(session, { stage: 'pressure' })
    expect(result.pruned).toHaveLength(0)
    expect(audit.records()).toContainEqual(expect.objectContaining({
      kind: 'component-evaluation',
      sessionId: String(session.id),
      component: 'history',
      status: 'skipped',
      reason: 'protected-working-set',
    }))
    },
  )

  it.each(['balanced', 'adaptive'] as const)(
    'audits no-safe-candidates in %s mode when the only tool results are recovery-tool output',
    async (profile) => {
    const ctx = await runtimeContext()
    const audit = captureAudit(ctx)
    await ctx.plugin(ToolResultPruner, {
      profile,
      freshTriggerTokens: 100_000,
      freshTargetTokens: 90_000,
      aggregateTriggerTokens: 100_000,
      aggregateTargetTokens: 90_000,
      historyTriggerTokens: 100,
      historyKeepRecentToolCalls: 0,
      historyKeepRecentTokens: 1,
      historyMinReclaimTokens: 1,
    }).await()
    const session = Session.create(SessionId(`public-history-no-safe-candidates-${profile}`))
    // One ordinary turn (protected by nothing) plus one recovery-tool output:
    // filtering only unsafe candidates leaves the ordinary result, so this
    // first pass must NOT read as no-safe-candidates.
    appendToolTurn(session, 1, 'ordinary reclaimable evidence '.repeat(300), true)
    const turn = 2
    const callId = CallId('recovery-call')
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'context_compression_retrieve', arguments: '{}' }],
        source: { kind: 'model', provider: 'deepseek', model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: 'context_compression_retrieve', arguments: '{}' })
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'recovered original group '.repeat(300) }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 3 })
    ctx.toolResultPruner.pruneSession(session, { stage: 'pressure' })
    // The ordinary result remains a safe candidate. Balanced commits it;
    // Adaptive may reject its real plan on cost, but neither profile may
    // misreport this mixed set as no-safe-candidates.
    expect(audit.records().some(record => record.kind === 'component-evaluation'
      && record.sessionId === String(session.id)
      && record.component === 'history'
      && record.reason === 'no-safe-candidates')).toBe(false)
    if (profile === 'balanced') {
      expect(rewrites(audit.records()).some(record =>
        record.sessionId === String(session.id) && record.component === 'history')).toBe(true)
    } else {
      expect(audit.records()).toContainEqual(expect.objectContaining({
        kind: 'component-evaluation',
        sessionId: String(session.id),
        component: 'history',
        reason: 'adaptive-cost-rejected',
      }))
    }

    const onlyUnsafe = Session.create(SessionId(`public-history-no-safe-candidates-only-${profile}`))
    onlyUnsafe.append('turn/start', { turn: 1 })
    onlyUnsafe.append('request/header', {
      reason: 'initial',
      header: canonicalHeader({ config: { provider: 'deepseek', model: MODEL } }),
    })
    onlyUnsafe.append('step/start', { turn: 1, step: 1 })
    onlyUnsafe.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'context_compression_retrieve', arguments: '{}' }],
        source: { kind: 'model', provider: 'deepseek', model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    onlyUnsafe.append('tool/call', { turn: 1, step: 1, callId, name: 'context_compression_retrieve', arguments: '{}' })
    onlyUnsafe.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'only recovery output lives here '.repeat(300) }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    onlyUnsafe.append('step/end', { turn: 1, step: 1 })
    onlyUnsafe.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    onlyUnsafe.append('turn/start', { turn: 2 })
    ctx.toolResultPruner.pruneSession(onlyUnsafe, { stage: 'pressure' })
    expect(audit.records()).toContainEqual(expect.objectContaining({
      kind: 'component-evaluation',
      sessionId: String(onlyUnsafe.id),
      component: 'history',
      status: 'skipped',
      reason: 'no-safe-candidates',
    }))
    },
  )

  it('audits adaptive-cost-rejected when the adaptive estimate refuses the batch', async () => {
    const ctx = await runtimeContext()
    const audit = captureAudit(ctx)
    await ctx.plugin(ToolResultPruner, {
      profile: 'adaptive',
      freshTriggerTokens: 100_000,
      freshTargetTokens: 90_000,
      aggregateTriggerTokens: 100_000,
      aggregateTargetTokens: 90_000,
      historyTriggerTokens: 100,
      historyKeepRecentToolCalls: 0,
      historyKeepRecentTokens: 1,
      historyMinReclaimTokens: 1,
    }).await()
    const session = Session.create(SessionId('public-history-adaptive-cost-rejected'))
    appendToolTurn(session, 1, 'adaptive rejected evidence '.repeat(300), true)
    appendToolTurn(session, 2, 'newest adaptive working-set evidence', true)
    session.append('turn/start', { turn: 3 })
    ctx.toolResultPruner.pruneSession(session, { stage: 'pressure' })
    expect(audit.records()).toContainEqual(expect.objectContaining({
      kind: 'component-evaluation',
      sessionId: String(session.id),
      component: 'history',
      status: 'skipped',
      reason: 'adaptive-cost-rejected',
      historyMode: 'adaptive',
    }))
  })

  it('preserves below-profile-trigger when Adaptive planning never forms a batch', async () => {
    const ctx = await runtimeContext()
    const audit = captureAudit(ctx)
    await ctx.plugin(ToolResultPruner, {
      profile: 'adaptive',
      freshTriggerTokens: 100_000,
      freshTargetTokens: 90_000,
      aggregateTriggerTokens: 100_000,
      aggregateTargetTokens: 90_000,
      historyTriggerTokens: 100_000,
      historyKeepRecentToolCalls: 0,
      historyKeepRecentTokens: 1,
      historyMinReclaimTokens: 1,
    }).await()
    const session = Session.create(SessionId('public-history-adaptive-below-trigger'))
    appendToolTurn(session, 1, 'small adaptive evidence', true)
    session.append('turn/start', { turn: 2 })
    ctx.toolResultPruner.pruneSession(session, { stage: 'pressure' })
    expect(audit.records()).toContainEqual(expect.objectContaining({
      kind: 'component-evaluation',
      sessionId: String(session.id),
      component: 'history',
      status: 'skipped',
      reason: 'below-profile-trigger',
      historyMode: 'adaptive',
      triggerTokens: 100_000,
    }))
  })

  it('preserves exact-tokenizer-unavailable before Adaptive cost authority', async () => {
    const ctx = await runtimeContext()
    const audit = captureAudit(ctx)
    await ctx.plugin(ToolResultPruner, {
      profile: 'adaptive',
      freshTriggerTokens: 100_000,
      freshTargetTokens: 90_000,
      aggregateTriggerTokens: 100_000,
      aggregateTargetTokens: 90_000,
      historyTriggerTokens: 100,
      historyKeepRecentToolCalls: 0,
      historyKeepRecentTokens: 1,
      historyMinReclaimTokens: 1,
    }).await()
    const session = Session.create(SessionId('public-history-adaptive-exact-unavailable'))
    appendToolTurn(
      session,
      1,
      'unknown adaptive model evidence '.repeat(300),
      true,
      undefined,
      'deepseek',
      'unsupported-public-model',
    )
    session.append('turn/start', { turn: 2 })
    ctx.toolResultPruner.pruneSession(session, { stage: 'pressure' })
    expect(audit.records()).toContainEqual(expect.objectContaining({
      kind: 'component-evaluation',
      sessionId: String(session.id),
      component: 'history',
      status: 'skipped',
      reason: 'exact-tokenizer-unavailable',
      historyMode: 'adaptive',
      measurementKind: 'unavailable',
    }))
  })

  it('audits exact-tokenizer-unavailable for History when counts are not exact', async () => {
    const ctx = await runtimeContext()
    const audit = captureAudit(ctx)
    await ctx.plugin(ToolResultPruner, {
      profile: 'balanced',
      freshTriggerTokens: 100_000,
      freshTargetTokens: 90_000,
      aggregateTriggerTokens: 100_000,
      aggregateTargetTokens: 90_000,
      historyTriggerTokens: 100,
      historyKeepRecentToolCalls: 0,
      historyKeepRecentTokens: 1,
      historyMinReclaimTokens: 1,
    }).await()
    const session = Session.create(SessionId('public-history-exact-unavailable'))
    appendToolTurn(session, 1, 'unknown model history evidence '.repeat(300), true, undefined, 'deepseek', 'unsupported-public-model')
    session.append('turn/start', { turn: 2 })
    ctx.toolResultPruner.pruneSession(session, { stage: 'pressure' })
    expect(audit.records()).toContainEqual(expect.objectContaining({
      kind: 'component-evaluation',
      sessionId: String(session.id),
      component: 'history',
      status: 'skipped',
      reason: 'exact-tokenizer-unavailable',
      measurementKind: 'unavailable',
    }))
  })

  it('audits recovery-tool-unavailable when a committed batch cannot land without the recovery tool', async () => {
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(TokenMeter)
    const audit = captureAudit(ctx)
    await ctx.plugin(ToolResultPruner, {
      profile: 'balanced',
      freshTriggerTokens: 100_000,
      freshTargetTokens: 90_000,
      aggregateTriggerTokens: 100_000,
      aggregateTargetTokens: 90_000,
      historyTriggerTokens: 100,
      historyKeepRecentToolCalls: 0,
      historyKeepRecentTokens: 1,
      historyMinReclaimTokens: 1,
    }).await()
    const session = Session.create(SessionId('public-history-recovery-tool-unavailable'))
    // The newest result stays inside the protected tail; the older one plans a
    // committed batch that cannot land without the recovery tool.
    appendToolTurn(session, 1, 'committed batch without recovery tool '.repeat(300), true)
    appendToolTurn(session, 2, 'newest protected result', true)
    session.append('turn/start', { turn: 3 })
    const result = ctx.toolResultPruner.pruneSession(session, { stage: 'pressure' })
    expect(result.pruned).toHaveLength(0)
    expect(audit.records()).toContainEqual(expect.objectContaining({
      kind: 'component-evaluation',
      sessionId: String(session.id),
      component: 'history',
      status: 'skipped',
      reason: 'recovery-tool-unavailable',
    }))
  })

  it('still commits unlinked Custom History batches at the minimum reclaim', async () => {
    const ctx = await runtimeContext()
    await ctx.plugin(TestSettings).await()
    await ctx.plugin(SelectorHost).await()
    const audit = captureAudit(ctx)
    // A protected token tail larger than the trigger leaves the linked-style
    // whole-excess demand unreachable; Custom stays manual and must still
    // commit once a batch passes its explicit minimum reclaim.
    const custom = structuredClone(DEFAULT_CUSTOM_COMPRESSION_POLICY) as CustomCompressionPolicy
    if (custom.version !== 3) throw new Error('unlinked Custom fixture requires policy v3')
    custom.fresh = { enabled: true, trigger: 1_000_000, target: 900_000 }
    custom.aggregate = { enabled: true, trigger: 1_000_000, target: 900_000 }
    custom.history = {
      enabled: true,
      trigger: 20_000,
      keepRecentToolCalls: 2,
      keepRecentTokens: 30_000,
      minReclaim: 1_000,
    }
    custom.prefixPolicy = 'pressure-break'
    custom.tailTrim = { enabled: false, trigger: 700_000 }
    await ctx.settings.update(settingsNamespace(CONTEXT_COMPRESSION_SETTINGS_NAMESPACE), {
      profile: 'custom',
      custom,
    })
    await ctx.plugin(ToolResultPruner, { profile: 'custom' }).await()

    const session = Session.create(SessionId('public-custom-min-reclaim-commit'))
    // Five results of ~14k tokens: the 30k token tail plus 2 newest calls
    // protect the newest three, leaving two old results reclaimable.
    appendToolTurn(session, 1, 'custom old reclaimable evidence '.repeat(3_000), true)
    appendToolTurn(session, 2, 'custom old reclaimable evidence '.repeat(3_000), true)
    appendToolTurn(session, 3, 'custom newer reclaimable evidence '.repeat(3_000), true)
    appendToolTurn(session, 4, 'custom newer reclaimable evidence '.repeat(3_000), true)
    appendToolTurn(session, 5, 'custom newest protected evidence '.repeat(3_000), true)
    session.append('turn/start', { turn: 6 })

    const result = ctx.toolResultPruner.pruneSession(session, { stage: 'pressure' })

    expect(result.pruned.length).toBeGreaterThanOrEqual(1)
    expect(rewrites(audit.records()).some(record =>
      record.sessionId === String(session.id) && record.component === 'history')).toBe(true)
  })

  it('distinguishes inactive and active History capacity-pressure from durable route capacity', async () => {
    const ctx = await runtimeContext()
    const audit = captureAudit(ctx)
    await ctx.plugin(ToolResultPruner, {
      profile: 'cache-strict',
      freshTriggerTokens: 100_000,
      freshTargetTokens: 90_000,
      aggregateTriggerTokens: 100_000,
      aggregateTargetTokens: 90_000,
      historyTriggerTokens: 400,
      historyKeepRecentToolCalls: 0,
      historyKeepRecentTokens: 1,
      historyMinReclaimTokens: 1,
    }).await()

    const belowCapacityGate = Session.create(SessionId('public-history-capacity-inactive'))
    appendToolTurn(belowCapacityGate, 1, 'capacity inactive evidence '.repeat(600), true)
    appendToolTurn(belowCapacityGate, 2, 'newest protected result', true)
    belowCapacityGate.append('request/context', {
      provider: 'deepseek',
      model: MODEL,
      contextWindow: 1_000_000,
    })
    belowCapacityGate.append('turn/start', { turn: 3 })
    ctx.toolResultPruner.pruneSession(belowCapacityGate, { stage: 'pressure' })

    expect(rewrites(audit.records()).some(record =>
      record.sessionId === String(belowCapacityGate.id) && record.component === 'history')).toBe(false)
    expect(audit.records()).toContainEqual(expect.objectContaining({
      kind: 'component-evaluation',
      sessionId: String(belowCapacityGate.id),
      component: 'history',
      status: 'skipped',
      reason: 'below-micro-deadline',
      historyMode: 'capacity-pressure',
    }))

    const aboveCapacityGate = Session.create(SessionId('public-history-capacity-active'))
    appendToolTurn(aboveCapacityGate, 1, 'capacity active evidence '.repeat(600), true)
    appendToolTurn(aboveCapacityGate, 2, 'newest protected result', true)
    const capacityWindow = Math.floor(measureForCompaction(ctx, aboveCapacityGate).totalTokens / 0.75)
    aboveCapacityGate.append('request/context', {
      provider: 'deepseek',
      model: MODEL,
      contextWindow: capacityWindow,
    })
    aboveCapacityGate.append('turn/start', { turn: 3 })
    ctx.toolResultPruner.pruneSession(aboveCapacityGate, { stage: 'pressure' })

    expect(rewrites(audit.records())).toContainEqual(expect.objectContaining({
      sessionId: String(aboveCapacityGate.id),
      component: 'history',
      stage: 'pressure',
      historyMode: 'capacity-pressure',
    }))
  })

  it('runs Cache Strict capacity-pressure History through the real agent pre-step boundary', async () => {
    const ctx = new Context()
    activeContexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeter)
    const audit = captureAudit(ctx)
    ctx.llm.registerAdapter(
      ['deepseek'],
      new NativeSummaryAdapter(['Cache Strict pressure pass complete'], 100),
    )
    await ctx.plugin(ToolResultPruner, {
      profile: 'cache-strict',
      freshTriggerTokens: 100_000,
      freshTargetTokens: 90_000,
      aggregateTriggerTokens: 100_000,
      aggregateTargetTokens: 90_000,
      historyTriggerTokens: 400,
      historyKeepRecentToolCalls: 0,
      historyKeepRecentTokens: 1,
      historyMinReclaimTokens: 1,
    }).await()

    const agent = ctx.agentLoop.create(SessionId('public-history-capacity-request-boundary'), {
      provider: 'deepseek',
      model: MODEL,
    })
    const { session } = agent
    appendToolTurn(session, 1, 'old capacity-pressure evidence '.repeat(600), true)
    appendToolTurn(session, 2, 'newest protected result', true)
    const boundaryTotal = measureForCompaction(ctx, session).totalTokens
    session.append('request/context', {
      provider: 'deepseek',
      model: MODEL,
      // Just under the frozen 80% deadline D = 0.7 * window, so the gate is
      // active while the reclaim target stays reachable for one old result.
      contextWindow: Math.floor(boundaryTotal / 0.72),
    })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'run Cache Strict pressure pass' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(rewrites(audit.records())).toContainEqual(expect.objectContaining({
      sessionId: String(session.id),
      component: 'history',
      stage: 'pressure',
      historyMode: 'capacity-pressure',
    }))
  })

  it('audits enabled-but-below-trigger without claiming a rewrite', async () => {
    const ctx = await runtimeContext()
    const audit = captureAudit(ctx)
    await ctx.plugin(ToolResultPruner, {
      profile: 'balanced',
      freshTriggerTokens: 100_000,
      freshTargetTokens: 90_000,
      aggregateTriggerTokens: 100_000,
      aggregateTargetTokens: 90_000,
      historyTriggerTokens: 100_000,
    }).await()
    const session = Session.create(SessionId('public-below-trigger-audit'))
    appendToolTurn(session, 1, 'small evidence', false)

    ctx.toolResultPruner.pruneSession(session, {
      stage: 'fresh',
      freshTurn: 1,
      freshStep: 1,
    })

    expect(rewrites(audit.records())).toHaveLength(0)
    expect(audit.records()).toContainEqual(expect.objectContaining({
      kind: 'component-evaluation',
      component: 'fresh',
      status: 'skipped',
      reason: 'at-or-below-trigger',
      currentTokens: expect.any(Number),
      triggerTokens: 100_000,
    }))
  })

  it('freezes the complete settings and deployment snapshot on first Session observation', async () => {
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(TestSettings).await()
    await ctx.plugin(SelectorHost).await()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(TokenMeter)
    const audit = captureAudit(ctx)

    const firstCustom = structuredClone(DEFAULT_CUSTOM_COMPRESSION_POLICY) as CustomCompressionPolicy
    firstCustom.fresh = { enabled: true, trigger: 512, target: 256 }
    firstCustom.aggregate.enabled = false
    firstCustom.history.enabled = false
    if (firstCustom.version === 3) firstCustom.tailTrim.enabled = false
    const namespace = settingsNamespace(CONTEXT_COMPRESSION_SETTINGS_NAMESPACE)
    await ctx.settings.update(namespace, { profile: 'custom', custom: firstCustom })
    await ctx.plugin(ToolResultPruner, {
      profile: 'off',
      headChars: 6,
      tailChars: 4,
    }).await()

    const sessionA = Session.create(SessionId('public-policy-freeze-a'))
    appendToolTurn(sessionA, 1, 'first frozen policy result '.repeat(800), false)
    expect(ctx.toolResultPruner.pruneSession(sessionA, {
      stage: 'fresh', freshTurn: 1, freshStep: 1,
    }).pruned).toHaveLength(1)

    const secondCustom = structuredClone(firstCustom)
    secondCustom.fresh.enabled = false
    secondCustom.history.trigger += 123
    await ctx.settings.update(namespace, { custom: secondCustom })
    sessionA.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    appendToolTurn(sessionA, 2, 'second frozen policy result '.repeat(800), false)
    expect(ctx.toolResultPruner.pruneSession(sessionA, {
      stage: 'fresh', freshTurn: 2, freshStep: 1,
    }).pruned).toHaveLength(1)

    const sessionB = Session.create(SessionId('public-policy-freeze-b'))
    const keptB = appendToolTurn(sessionB, 1, 'new Session disabled Fresh '.repeat(800), false)
    expect(ctx.toolResultPruner.pruneSession(sessionB, {
      stage: 'fresh', freshTurn: 1, freshStep: 1,
    })).toEqual({ pruned: [], charsRemoved: 0, tokensRemoved: 0 })
    expect(sessionB.surface.nodes).toContain(keptB.resultSeq)

    const frozen = audit.records().filter(record => record.kind === 'policy-frozen')
    expect(frozen).toHaveLength(2)
    expect(frozen.find(record => record.sessionId === String(sessionA.id))).toMatchObject({
      settingsSource: 'host-settings',
      settings: { profile: 'custom', custom: firstCustom },
      deploymentConfig: { profile: 'off', headChars: 6, tailChars: 4 },
    })
    expect(frozen.find(record => record.sessionId === String(sessionB.id))).toMatchObject({
      settingsSource: 'host-settings',
      settings: { profile: 'custom', custom: secondCustom },
      deploymentConfig: { profile: 'off', headChars: 6, tailChars: 4 },
    })
  })

  it('publishes TailTrim through standard prune + user replacement and validates append roots', async () => {
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(TestSettings).await()
    await ctx.plugin(SelectorHost).await()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(TokenMeter)
    const audit = captureAudit(ctx)

    const policy = structuredClone(DEFAULT_CUSTOM_COMPRESSION_POLICY) as CustomCompressionPolicy
    if (policy.version !== 3) throw new Error('TailTrim public protocol test requires policy v3')
    policy.fresh.enabled = false
    policy.aggregate.enabled = false
    policy.history.enabled = false
    // Isolate TailTrim: keep no History working set protected.
    policy.history.keepRecentToolCalls = 0
    policy.history.keepRecentTokens = 0
    policy.history.minReclaim = 1
    policy.tailTrim = { enabled: true, trigger: 8 }
    await ctx.settings.update(settingsNamespace(CONTEXT_COMPRESSION_SETTINGS_NAMESPACE), {
      profile: 'custom',
      custom: policy,
    })
    await ctx.plugin(ToolResultPruner, { profile: 'off' }).await()
    const pruner = ctx.toolResultPruner
    const session = Session.create(SessionId('public-tailtrim'))
    appendToolTurn(session, 1, 'first completed group'.repeat(40), true)
    const candidate = appendToolTurn(session, 2, 'old candidate result'.repeat(400), true)
    session.append('turn/start', { turn: 3 })
    expect(ctx.tools.get('context_compression_retrieve')).toBeDefined()
    const before = measureForCompaction(ctx, session)
    expect(before.currentSurface.kind).toBe('exact-tokenizer')

    pruner.pruneSession(session, { stage: 'pressure' })

    const manifest = session.events.findLast(event => event.type === 'compaction/prune')
    expect(manifest?.type).toBe('compaction/prune')
    if (manifest?.type !== 'compaction/prune') throw new Error('TailTrim did not publish a standard prune')
    const publication = validatePublishedTailTrim(session, manifest.seq)
    expect(publication).not.toBeNull()
    expect(publication?.manifest.data.shadowedSeqs).toEqual([
      candidate.assistantSeq,
      candidate.resultSeq,
    ])
    expect(publication?.replacement.type).toBe('user/message')
    expect(publication?.ref).toBe(`session://${String(session.id)}/tailtrim/${String(manifest.seq)}`)
    expect(ctx.tools.get('context_compression_retrieve')).toBeDefined()
    expect(rewrites(audit.records())).toContainEqual(expect.objectContaining({
      component: 'tail-trim',
      stage: 'pressure',
      reducer: 'pair-preserving-tail-trim',
      manifestSeq: manifest.seq,
      tokensBefore: expect.any(Number),
      tokensAfter: expect.any(Number),
    }))

    const recovered = await ctx.tools.execute({
      name: 'context_compression_retrieve',
      arguments: { ref: publication?.ref, max_lines: 20 },
      callId: CallId('tailtrim-retrieve-live'),
      signal: new AbortController().signal,
      agent: stubAgent(ctx, session),
    })
    expect(recovered.isError).toBe(false)
    const recoveredText = recovered.content
      .map(block => block.type === 'text' ? block.text : '')
      .join('\n')
    expect(recoveredText).toContain('kind: tailtrim-group')
    expect(recoveredText).toContain('old candidate result')

    const persistedEvents = JSON.parse(JSON.stringify(session.events))
    const replay = Session.create(session.id, persistedEvents)
    const replayPublication = validatePublishedTailTrim(replay, manifest.seq)
    expect(replayPublication?.ref).toBe(publication?.ref)
    expect(replay.deriveMessages()).toEqual(session.deriveMessages())
    const replayRecovered = await ctx.tools.execute({
      name: 'context_compression_retrieve',
      arguments: { ref: replayPublication?.ref, max_lines: 20 },
      callId: CallId('tailtrim-retrieve-replay'),
      signal: new AbortController().signal,
      agent: stubAgent(ctx, replay),
    })
    expect(replayRecovered).toEqual(recovered)
  })

  it('audits TailTrim threshold, tokenizer, safety-group, and min-reclaim skip paths', async () => {
    async function runScenario(options: {
      readonly id: string
      readonly expectedReason: string
      readonly trigger: number
      readonly minReclaim: number
      readonly candidateTurns: number
      readonly model?: string
    }): Promise<void> {
      const ctx = new Context()
      activeContexts.push(ctx)
      await ctx.plugin(TestSettings).await()
      await ctx.plugin(SelectorHost).await()
      await ctx.plugin(SessionStore)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(TokenMeter)
      const audit = captureAudit(ctx)

      const policy = structuredClone(DEFAULT_CUSTOM_COMPRESSION_POLICY) as CustomCompressionPolicy
      if (policy.version !== 3) throw new Error('TailTrim negative-path test requires policy v3')
      policy.fresh.enabled = false
      policy.aggregate.enabled = false
      policy.history.enabled = false
      policy.history.trigger = Math.max(policy.history.trigger, options.minReclaim)
      policy.history.keepRecentToolCalls = 0
      policy.history.keepRecentTokens = 0
      policy.history.minReclaim = options.minReclaim
      policy.tailTrim = { enabled: true, trigger: options.trigger }
      await ctx.settings.update(settingsNamespace(CONTEXT_COMPRESSION_SETTINGS_NAMESPACE), {
        profile: 'custom',
        custom: policy,
      })
      await ctx.plugin(ToolResultPruner, { profile: 'off' }).await()

      const session = Session.create(SessionId(options.id))
      if (options.model !== undefined) {
        session.append('request/header', {
          reason: 'initial',
          header: canonicalHeader({ config: { provider: 'deepseek', model: options.model } }),
        })
      }
      for (let turn = 1; turn <= options.candidateTurns; turn++) {
        appendToolTurn(session, turn, `tailtrim negative ${options.id} `.repeat(200), true)
      }
      session.append('turn/start', { turn: options.candidateTurns + 1 })

      ctx.toolResultPruner.pruneSession(session, { stage: 'pressure' })

      expect(rewrites(audit.records()).filter(record => record.component === 'tail-trim')).toHaveLength(0)
      expect(audit.records()).toContainEqual(expect.objectContaining({
        kind: 'component-evaluation',
        sessionId: String(session.id),
        component: 'tail-trim',
        status: 'skipped',
        reason: options.expectedReason,
      }))
    }

    await runScenario({
      id: 'public-tailtrim-below-trigger',
      expectedReason: 'at-or-below-trigger',
      trigger: 1_000_000,
      minReclaim: 1,
      candidateTurns: 2,
    })
    await runScenario({
      id: 'public-tailtrim-tokenizer-unavailable',
      expectedReason: 'exact-tokenizer-unavailable',
      trigger: 1,
      minReclaim: 1,
      candidateTurns: 2,
      model: 'unsupported-public-model',
    })
    await runScenario({
      id: 'public-tailtrim-first-group-protected',
      expectedReason: 'no-safe-eligible-tool-group',
      trigger: 1,
      minReclaim: 1,
      candidateTurns: 1,
    })
    await runScenario({
      id: 'public-tailtrim-min-reclaim',
      expectedReason: 'no-safe-eligible-tool-group',
      trigger: 1,
      minReclaim: 1_000_000,
      candidateTurns: 2,
    })
  })

  it('fails open after an orphan prune and remains appendable after JSON restart', async () => {
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(TestSettings).await()
    await ctx.plugin(SelectorHost).await()
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(RuntimeInvariant)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(TokenMeter)
    const audit = captureAudit(ctx)

    const policy = structuredClone(DEFAULT_CUSTOM_COMPRESSION_POLICY) as CustomCompressionPolicy
    if (policy.version !== 3) throw new Error('orphan recovery test requires policy v3')
    policy.fresh.enabled = false
    policy.aggregate.enabled = false
    policy.history.enabled = false
    policy.history.keepRecentToolCalls = 0
    policy.history.keepRecentTokens = 0
    policy.history.minReclaim = 1
    policy.tailTrim = { enabled: true, trigger: 8 }
    await ctx.settings.update(settingsNamespace(CONTEXT_COMPRESSION_SETTINGS_NAMESPACE), {
      profile: 'custom',
      custom: policy,
    })
    await ctx.plugin(ToolResultPruner, { profile: 'off' }).await()
    const session = ctx.sessions.create(SessionId('public-tailtrim-orphan-recovery'))
    appendToolTurn(session, 1, 'first completed group'.repeat(40), true)
    appendToolTurn(session, 2, 'orphan source remains intact'.repeat(400), true)
    session.append('turn/start', { turn: 3 })
    const beforeSurface = [...session.surface.nodes]
    const originalAppend = session.append.bind(session)
    const append = vi.spyOn(session, 'append').mockImplementation((type: string, ...args: unknown[]) => {
      const options = args[1] as { surfaceOp?: unknown } | undefined
      if (type === 'user/message' && typeof options?.surfaceOp === 'object') {
        throw new Error('fixture replacement append failure')
      }
      return Reflect.apply(
        originalAppend as (...values: unknown[]) => unknown,
        undefined,
        [type, ...args],
      ) as never
    })

    expect(() => ctx.toolResultPruner.pruneSession(session, { stage: 'pressure' })).not.toThrow()
    append.mockRestore()
    expect(session.events.at(-1)?.type).toBe('compaction/prune')
    expect(session.surface.nodes).toEqual(beforeSurface)
    expect(rewrites(audit.records())).toHaveLength(0)
    expect(audit.records()).toContainEqual(expect.objectContaining({
      kind: 'failure',
      operation: 'publication',
      component: 'tail-trim',
      manifestSeq: session.events.length - 1,
    }))

    expect(() => session.append('turn/end', {
      turn: 3,
      reason: { kind: 'completed' },
    })).not.toThrow()
    const persisted = JSON.parse(JSON.stringify(session.events))

    const resumedCtx = new Context()
    activeContexts.push(resumedCtx)
    await resumedCtx.plugin(SessionStore)
    await resumedCtx.plugin(InvariantRegistry)
    await resumedCtx.plugin(RuntimeInvariant)
    const resumed = resumedCtx.sessions.create(session.id, { seed: persisted })
    expect(resumed.surface.nodes).toEqual(beforeSurface)
    expect(() => resumed.append('turn/start', { turn: 4 })).not.toThrow()
  })

  it('still rejects a malformed adjacent replacement instead of treating it as an orphan', async () => {
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(RuntimeInvariant)
    const session = ctx.sessions.create(SessionId('public-malformed-companion'))
    const source = appendToolTurn(session, 1, 'source remains intact', false)
    session.append('compaction/prune', {
      shadowedRange: { start: source.resultSeq, end: source.resultSeq },
      shadowedSeqs: [source.resultSeq],
      shadowedTokenCount: 1,
    })
    const result = session.events[source.resultSeq]
    if (result?.type !== 'tool/result') throw new Error('missing source result')
    const before = session.seq

    expect(() => session.append('tool/result', result.data, {
      surfaceOp: { op: 'replace', start: source.assistantSeq, end: source.assistantSeq },
      sourceEventSeqs: [source.resultSeq],
    })).toThrow(/sourceEventSeqs|does not replace compaction\/prune range/)
    expect(session.seq).toBe(before)
  })

  it('observes committed Native auto-compact separately from plugin rewrites', async () => {
    const ctx = await runtimeContext()
    const audit = captureAudit(ctx)
    await ctx.plugin(ToolResultPruner, { profile: 'off' }).await()
    const session = Session.create(SessionId('public-native-auto-audit'))
    const summary = session.append('compaction/summary', {
      compactionId: CompactionId('public-native-auto'),
      summary: [{ type: 'text', text: 'summary' }],
      shadowedRange: { start: 0, end: 0 },
      shadowedSeqs: [],
      shadowedTokenCount: 321,
      provider: 'deepseek',
      model: MODEL,
    })

    ctx.emit('session/event', session, summary)

    expect(rewrites(audit.records())).toHaveLength(0)
    expect(audit.records()).toContainEqual(expect.objectContaining({
      kind: 'native-auto-compact',
      manifestEventType: 'compaction/summary',
      manifestSeq: summary.seq,
      provider: 'deepseek',
      model: MODEL,
      tokensBefore: 321,
      tokensAfter: null,
    }))
  })

  it('triggers Native auto-compact through the real AgentLoop pre-step boundary', async () => {
    const ctx = new Context()
    activeContexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeter)
    const audit = captureAudit(ctx)
    ctx.llm.registerAdapter(
      ['deepseek'],
      new NativeSummaryAdapter([
        'first native turn complete',
        'native compact summary',
        'second native turn complete',
      ], 1_000),
    )
    await ctx.plugin(ToolResultPruner, { profile: 'off' }).await()
    void new BasicCompactionEngine(ctx, {
      auto: true,
      thresholdRatio: 0.3,
      retainTokens: 0,
      maxTokens: 100,
      compactionRetries: 0,
    })
    const agent = ctx.agentLoop.create(SessionId('public-native-auto-real'), {
      provider: 'deepseek',
      model: MODEL,
    })

    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'native pressure evidence '.repeat(500) }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'continue after native compaction' }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()

    expect(rewrites(audit.records())).toHaveLength(0)
    const summary = agent.session.events.findLast(event => event.type === 'compaction/summary')
    expect(summary?.type).toBe('compaction/summary')
    expect(audit.records()).toContainEqual(expect.objectContaining({
      kind: 'native-auto-compact',
      manifestEventType: 'compaction/summary',
      manifestSeq: summary?.seq,
      provider: 'deepseek',
      model: MODEL,
      tokensBefore: expect.any(Number),
      tokensAfter: null,
    }))
  })

  it('runs Fresh, Aggregate, History, TailTrim and Native in one non-isolated audited session', async () => {
    const ctx = new Context()
    activeContexts.push(ctx)
    await ctx.plugin(TestSettings).await()
    await ctx.plugin(SelectorHost).await()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(TokenMeter)
    const audit = captureAudit(ctx)

    const policy = structuredClone(DEFAULT_CUSTOM_COMPRESSION_POLICY) as CustomCompressionPolicy
    if (policy.version !== 3) throw new Error('full-pipeline public E2E requires policy v3')
    policy.fresh = { enabled: true, trigger: 512, target: 256 }
    policy.aggregate = { enabled: true, trigger: 1_000, target: 400 }
    policy.history = {
      enabled: true,
      // The strict required-reclaim gate demands one batch pull tool tokens
      // back under this trigger: it must sit above the large protected tail
      // (so the batch is reachable) while the residual total stays far above
      // the auto-compact threshold (half the measured total) afterwards.
      trigger: 7_800,
      keepRecentToolCalls: 0,
      keepRecentTokens: 1,
      minReclaim: 1,
    }
    policy.prefixPolicy = 'pressure-break'
    policy.tailTrim = { enabled: true, trigger: 8 }
    await ctx.settings.update(settingsNamespace(CONTEXT_COMPRESSION_SETTINGS_NAMESPACE), {
      profile: 'custom',
      custom: policy,
    })
    await ctx.plugin(ToolResultPruner, { profile: 'off' }).await()

    const session = ctx.sessions.create(SessionId('public-full-pipeline-e2e'))
    appendToolTurn(session, 1, 'fresh full pipeline '.repeat(600), false, 'run Fresh')
    ctx.toolResultPruner.pruneSession(session, {
      stage: 'fresh',
      freshTurn: 1,
      freshStep: 1,
    })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    appendToolBatchTurn(
      session,
      2,
      Array.from({ length: 30 }, (_, index) => `aggregate-${String(index)} `.repeat(20)),
      false,
      'run Aggregate',
    )
    ctx.toolResultPruner.pruneSession(session, {
      stage: 'fresh',
      freshTurn: 2,
      freshStep: 1,
    })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    // Leave one old, still-original result for the pressure-stage History
    // reducer, then add a newer working-set result that remains protected.
    appendToolTurn(session, 3, 'history full pipeline '.repeat(600), true, 'run History')
    appendToolTurn(session, 4, 'recent protected working-set context '.repeat(1200), true, 'retain recent context')
    session.append('turn/start', { turn: 5 })
    ctx.toolResultPruner.pruneSession(session, { stage: 'pressure' })

    const beforeNative = ctx.tokenMeter.measure(session).totalTokens
    expect(beforeNative).toBeGreaterThan(2)
    ctx.llm.registerAdapter(
      ['deepseek'],
      new NativeSummaryAdapter(['full-pipeline native summary'], beforeNative),
    )
    void new BasicCompactionEngine(ctx, {
      auto: true,
      thresholdRatio: 0.5,
      retainTokens: 0,
      maxTokens: 100,
      compactionRetries: 0,
    })
    const signal = new AbortController().signal
    const decision = await agentEvents(ctx, stubAgent(ctx, session)).waterfall(
      'agent/pre-step',
      { messages: [], turn: 5, step: 1, signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    expect(decision).toEqual({ kind: 'enter', messages: [] })
    const summary = session.events.findLast(event => event.type === 'compaction/summary')
    expect(summary?.type).toBe('compaction/summary')

    const records = audit.records()
    const rewriteRecords = rewrites(records)
    const components = rewriteRecords.map(record => record.component)
    expect(components).toContain('fresh')
    expect(components).toContain('aggregate')
    expect(components).toContain('history')
    expect(components).toContain('tail-trim')
    expect(records).toContainEqual(expect.objectContaining({
      kind: 'native-auto-compact',
      manifestSeq: summary?.seq,
      tokensBefore: expect.any(Number),
    }))

    const firstIndex = (component: CompressionRewriteAuditRecord['component']) =>
      records.findIndex(record => record.kind === 'rewrite' && record.component === component)
    expect(firstIndex('fresh')).toBeLessThan(firstIndex('aggregate'))
    expect(firstIndex('aggregate')).toBeLessThan(firstIndex('history'))
    expect(firstIndex('history')).toBeLessThan(firstIndex('tail-trim'))
    expect(records.findIndex(record => record.kind === 'native-auto-compact'))
      .toBeGreaterThan(firstIndex('tail-trim'))
    expect(session.events.some(event => event.type === ('compaction/group-trim' as string))).toBe(false)
  })

  it('compresses text tool results exactly in a vision session that also carries a user image', async () => {
    const ctx = await runtimeContext()
    const audit = captureAudit(ctx)
    await ctx.plugin(ToolResultPruner, {
      profile: 'balanced',
      freshTriggerTokens: 1_000_000,
      freshTargetTokens: 900_000,
      aggregateTriggerTokens: 100,
      aggregateTargetTokens: 64,
      historyTriggerTokens: 600,
      historyKeepRecentToolCalls: 0,
      historyKeepRecentTokens: 1,
      historyMinReclaimTokens: 1,
    }).await()
    const session = Session.create(SessionId('public-vision-text-session'))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', {
      reason: 'initial',
      header: canonicalHeader({ config: { provider: 'deepseek', model: VISION_MODEL } }),
    })
    session.append('user/message', createUserMessage({
      content: [
        imageBlock(640, 480),
        { type: 'text', text: 'describe the attachment and run the tools' },
      ],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: CallId('vision-call-1'), name: 'bash', arguments: '{}' }],
        source: { kind: 'model', provider: 'deepseek', model: VISION_MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('vision-call-1'), name: 'bash', arguments: '{}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('vision-call-1'),
        content: [{ type: 'text', text: 'vision fresh evidence '.repeat(1_000) }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // One older text result outside the fresh coordinates keeps History above
    // its trigger after Fresh has already shrunk the turn-1 result.
    appendToolTurn(session, 2, 'vision history evidence '.repeat(300), true, undefined, 'deepseek', VISION_MODEL)
    appendToolTurn(session, 3, 'recent protected result', true, undefined, 'deepseek', VISION_MODEL)
    session.append('turn/start', { turn: 4 })

    const fresh = ctx.toolResultPruner.pruneSession(session, { stage: 'fresh', freshTurn: 1, freshStep: 1 })
    const pressure = ctx.toolResultPruner.pruneSession(session, { stage: 'pressure' })

    expect(fresh.pruned).toHaveLength(1)
    expect(pressure.pruned.length).toBeGreaterThanOrEqual(1)
    const visionRewrites = rewrites(audit.records())
      .filter(record => record.sessionId === String(session.id))
    expect(visionRewrites.length).toBeGreaterThanOrEqual(2)
    for (const record of visionRewrites) {
      expect(record.tokenizerId).toBe('deepseek-ai/DeepSeek-V4-Flash-Vision-Exp')
      expect(record.tokenizerRevision).toBe('6821d6ad3681a4b137b066b76094fa82ebd0a380')
    }
    // Fresh is disabled by its trigger; Aggregate is the pre-compression stage
    // that lands on the vision route for the oversized new result.
    expect(visionRewrites.some(record => record.component === 'fresh')).toBe(false)
    expect(visionRewrites.some(record => record.component === 'aggregate')).toBe(true)
    expect(visionRewrites.some(record => record.component === 'history')).toBe(true)
  })

  it('keeps an image-bearing tool result fail-open in a vision session', async () => {
    const ctx = await runtimeContext()
    const audit = captureAudit(ctx)
    await ctx.plugin(ToolResultPruner, {
      profile: 'balanced',
      freshTriggerTokens: 10,
      freshTargetTokens: 8,
      aggregateTriggerTokens: 10,
      aggregateTargetTokens: 8,
      historyTriggerTokens: 10,
      historyKeepRecentToolCalls: 0,
      historyKeepRecentTokens: 1,
      historyMinReclaimTokens: 1,
    }).await()
    const session = Session.create(SessionId('public-vision-image-tool-result'))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', {
      reason: 'initial',
      header: canonicalHeader({ config: { provider: 'deepseek', model: VISION_MODEL } }),
    })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: CallId('vision-image-call'), name: 'screenshot', arguments: '{}' }],
        source: { kind: 'model', provider: 'deepseek', model: VISION_MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('vision-image-call'), name: 'screenshot', arguments: '{}' })
    const imageResult = session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('vision-image-call'),
        content: [
          { type: 'text', text: 'screenshot captured' },
          imageBlock(800, 600),
        ],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })

    const fresh = ctx.toolResultPruner.pruneSession(session, { stage: 'fresh', freshTurn: 1, freshStep: 1 })
    const pressure = ctx.toolResultPruner.pruneSession(session, { stage: 'pressure' })

    expect(fresh.pruned).toHaveLength(0)
    expect(pressure.pruned).toHaveLength(0)
    // The original image-bearing result stays on the surface untouched.
    const original = session.events[imageResult.seq]
    expect(original?.type).toBe('tool/result')
    expect(audit.records()).toContainEqual(expect.objectContaining({
      kind: 'component-evaluation',
      sessionId: String(session.id),
      component: 'fresh',
      status: 'skipped',
      reason: 'exact-tokenizer-unavailable',
    }))
    expect(audit.records()).toContainEqual(expect.objectContaining({
      kind: 'component-evaluation',
      sessionId: String(session.id),
      component: 'history',
      status: 'skipped',
      reason: 'exact-tokenizer-unavailable',
    }))
  })

  it('counts image nodes as estimates while retaining exact text-only siblings', async () => {
    const ctx = await runtimeContext()
    const session = Session.create(SessionId('public-vision-image-surface'))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', {
      reason: 'initial',
      header: canonicalHeader({ config: { provider: 'deepseek', model: VISION_MODEL } }),
    })
    const userMessage = session.append('user/message', createUserMessage({
      content: [
        { type: 'text', text: 'look at this' },
        imageBlock(640, 480),
        { type: 'text', text: 'and describe it' },
      ],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const textOnly = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'still exactly measurable' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const view = measureForCompaction(ctx, session)

    // The exact request expansion is not publicly verifiable, so a mixed
    // text/image node carries a bounded estimate and cannot authorize an exact
    // rewrite proof.
    const node = view.measuredNodes.find(entry => entry.seq === userMessage.seq)
    expect(node?.count).toMatchObject({
      kind: 'tokenizer-estimate',
      estimatorId: DEEPSEEK_VISION_IMAGE_ESTIMATOR.id,
      estimatorRevision: DEEPSEEK_VISION_IMAGE_ESTIMATOR.revision,
    })
    if (node?.count.kind !== 'tokenizer-estimate') throw new Error('image node must carry an estimate')
    expect(node.count.upperBoundTokens).toBeGreaterThanOrEqual(node.count.tokens)
    expect(view.currentSurface.kind).toBe('tokenizer-estimate')
    // Text-only siblings keep their exact counts.
    expect(view.measuredNodes.find(entry => entry.seq === textOnly.seq)?.count).toMatchObject({
      kind: 'exact-tokenizer',
      tokenizerId: 'deepseek-ai/DeepSeek-V4-Flash-Vision-Exp',
    })
    // The official arithmetic is attached as an INTRINSIC diagnostic (the
    // padding extremes on intrinsic dimensions), explicitly not a request
    // bound: the adapter may still re-project the image.
    const grid = deepSeekVisionImageGrid(640, 480)
    expect(node.intrinsicImageBlockEstimate).toMatchObject({
      paddingMinimumTokens: deepSeekVisionImageBlockTokens(grid.nLlmH, grid.nLlmW, 3),
      paddingMaximumTokens: deepSeekVisionImageBlockTokens(grid.nLlmH, grid.nLlmW, 0),
    })
    expect(view.intrinsicImageBlockEstimateTokens).toBe(node.intrinsicImageBlockEstimate?.paddingMinimumTokens)
  })

  it('estimates over-budget image metadata instead of making the surface unavailable', async () => {
    const ctx = await runtimeContext()
    const session = Session.create(SessionId('public-vision-image-over-budget'))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', {
      reason: 'initial',
      header: canonicalHeader({ config: { provider: 'deepseek', model: VISION_MODEL } }),
    })
    const userMessage = session.append('user/message', createUserMessage({
      content: [imageBlock(4096, 4096)],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const view = measureForCompaction(ctx, session)

    const node = view.measuredNodes.find(entry => entry.seq === userMessage.seq)
    expect(node?.count).toMatchObject({
      kind: 'tokenizer-estimate',
      upperBoundTokens: DEEPSEEK_VISION_PROJECTION.visionMaxNTokens,
    })
    expect(view.currentSurface.kind).toBe('tokenizer-estimate')
  })

  it('keeps empty content nodes exact instead of fail-opening the surface', async () => {
    const ctx = await runtimeContext()
    const session = Session.create(SessionId('public-empty-content-node'))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', {
      reason: 'initial',
      header: canonicalHeader({ config: { provider: 'deepseek', model: MODEL } }),
    })
    const empty = session.append('user/message', createUserMessage({
      content: [],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const present = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'still measurable' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const view = measureForCompaction(ctx, session)

    expect(view.measuredNodes.find(node => node.seq === empty.seq)?.count).toMatchObject({
      kind: 'exact-tokenizer',
      tokens: 0,
    })
    expect(view.measuredNodes.find(node => node.seq === present.seq)?.count).toMatchObject({
      kind: 'exact-tokenizer',
    })
    expect(view.currentSurface.kind).toBe('exact-tokenizer')
  })

  it('uses the fixed image-token fallback for malformed metadata', async () => {
    const ctx = await runtimeContext()
    const session = Session.create(SessionId('public-vision-image-malformed-dims'))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', {
      reason: 'initial',
      header: canonicalHeader({ config: { provider: 'deepseek', model: VISION_MODEL } }),
    })
    const userMessage = session.append('user/message', createUserMessage({
      content: [imageBlock(640.5, 480)],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const zeroSize = session.append('user/message', createUserMessage({
      content: [imageBlock(0, 480)],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const view = measureForCompaction(ctx, session)

    expect(view.measuredNodes.find(node => node.seq === userMessage.seq)?.count).toEqual({
      kind: 'tokenizer-estimate',
      tokens: DEEPSEEK_VISION_DEFAULT_IMAGE_TOKENS,
      upperBoundTokens: DEEPSEEK_VISION_PROJECTION.visionMaxNTokens,
      estimatorId: DEEPSEEK_VISION_IMAGE_ESTIMATOR.id,
      estimatorRevision: DEEPSEEK_VISION_IMAGE_ESTIMATOR.revision,
    })
    expect(view.measuredNodes.find(node => node.seq === zeroSize.seq)?.count).toEqual({
      kind: 'tokenizer-estimate',
      tokens: DEEPSEEK_VISION_DEFAULT_IMAGE_TOKENS,
      upperBoundTokens: DEEPSEEK_VISION_PROJECTION.visionMaxNTokens,
      estimatorId: DEEPSEEK_VISION_IMAGE_ESTIMATOR.id,
      estimatorRevision: DEEPSEEK_VISION_IMAGE_ESTIMATOR.revision,
    })
    expect(view.currentSurface).toMatchObject({
      kind: 'tokenizer-estimate',
      tokens: DEEPSEEK_VISION_DEFAULT_IMAGE_TOKENS * 2,
      upperBoundTokens: DEEPSEEK_VISION_PROJECTION.visionMaxNTokens * 2,
    })
  })

  it('keeps image content unavailable for non-vision models', async () => {
    const ctx = await runtimeContext()
    const session = Session.create(SessionId('public-text-model-image-node'))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', {
      reason: 'initial',
      header: canonicalHeader({ config: { provider: 'deepseek', model: MODEL } }),
    })
    const userMessage = session.append('user/message', createUserMessage({
      content: [imageBlock(640, 480)],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const view = measureForCompaction(ctx, session)

    expect(view.measuredNodes.find(entry => entry.seq === userMessage.seq)?.count).toMatchObject({
      kind: 'unavailable',
    })
  })

  it('keeps the vision image estimator unavailable behind a foreign provider', async () => {
    const ctx = await runtimeContext()
    const session = Session.create(SessionId('public-foreign-provider-vision-image-node'))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', {
      reason: 'initial',
      header: canonicalHeader({ config: { provider: 'openai', model: VISION_MODEL } }),
    })
    const userMessage = session.append('user/message', createUserMessage({
      content: [imageBlock(640, 480)],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const view = measureForCompaction(ctx, session)

    expect(view.measuredNodes.find(entry => entry.seq === userMessage.seq)?.count).toMatchObject({
      kind: 'unavailable',
    })
    expect(view.currentSurface).toMatchObject({ kind: 'unavailable' })
  })

  it('never TailTrims a tool group whose results carry images', async () => {
    const ctx = await runtimeContext()
    await ctx.plugin(TestSettings).await()
    await ctx.plugin(SelectorHost).await()
    const audit = captureAudit(ctx)
    await ctx.settings.update(settingsNamespace(CONTEXT_COMPRESSION_SETTINGS_NAMESPACE), {
      profile: 'custom',
      custom: {
        version: 3,
        unit: 'tokens',
        fresh: { enabled: true, trigger: 1_000_000, target: 900_000 },
        aggregate: { enabled: true, trigger: 1_000_000, target: 900_000 },
        history: { enabled: false, trigger: 900_000, keepRecentToolCalls: 0, keepRecentTokens: 0, minReclaim: 1 },
        prefixPolicy: 'preserve',
        tailTrim: { enabled: true, trigger: 10 },
      },
    })
    await ctx.plugin(ToolResultPruner, { profile: 'custom' }).await()
    const session = Session.create(SessionId('public-vision-tailtrim-image-group'))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', {
      reason: 'initial',
      header: canonicalHeader({ config: { provider: 'deepseek', model: VISION_MODEL } }),
    })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: CallId('vision-tailtrim-call'), name: 'screenshot', arguments: '{}' }],
        source: { kind: 'model', provider: 'deepseek', model: VISION_MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('vision-tailtrim-call'), name: 'screenshot', arguments: '{}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('vision-tailtrim-call'),
        content: [
          { type: 'text', text: 'screenshot captured for tail trim' },
          imageBlock(320, 240),
        ],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })

    const result = ctx.toolResultPruner.pruneSession(session, { stage: 'pressure' })

    expect(result.pruned).toHaveLength(0)
    expect(rewrites(audit.records()).some(record =>
      record.sessionId === String(session.id) && record.component === 'tail-trim')).toBe(false)
    expect(session.events.some(event =>
      event.type === 'tool/result'
      && event.data.message.content.some(block => block.type === 'tool-result'
        && block.content.some(inner => inner.type === 'image')))).toBe(true)
    // Either fail-open gate is acceptable: the protected-set scan refuses the
    // image-bearing candidate, and the group scan independently refuses it.
    const tailTrimSkips = audit.records().filter((record): record is Extract<CompressionAuditRecord, { kind: 'component-evaluation' }> =>
      record.kind === 'component-evaluation'
      && record.sessionId === String(session.id)
      && record.component === 'tail-trim'
      && record.status === 'skipped')
    expect(tailTrimSkips.length).toBeGreaterThan(0)
    expect(tailTrimSkips.every(record =>
      record.reason === 'no-safe-eligible-tool-group'
      || record.reason === 'exact-tokenizer-unavailable-in-protected-set'
      || record.reason === 'exact-tokenizer-unavailable')).toBe(true)
  })
})
