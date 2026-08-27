import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  CallId,
  createMessage,
  createUserMessage,
  createToolResultMessage,
  LlmAdapter,
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
import { deepSeekV4TokenizerForModel } from '../../src/deepseek-v4-tokenizer.ts'
import { validatePublishedTailTrim } from '../../src/tail-trim.ts'
import { measureForCompaction } from '../../src/measurement.ts'
import {
  COMPRESSION_AUDIT_PREFIX,
  type CompressionAuditRecord,
  type CompressionRewriteAuditRecord,
} from '../../src/audit.ts'

const MODEL = 'deepseek-v4-flash'
const activeContexts: Context[] = []

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
): { readonly assistantSeq: number; readonly resultSeq: number } {
  const callId = CallId(`call-${String(turn)}`)
  session.append('turn/start', { turn })
  if (session.requestHeader() === undefined) {
    session.append('request/header', {
      reason: 'initial',
      header: canonicalHeader({ config: { provider, model: MODEL } }),
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
      source: { kind: 'model', provider: 'deepseek', model: MODEL },
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
  it('loads the pinned official tokenizer and refuses unverified model ids', () => {
    const tokenizer = deepSeekV4TokenizerForModel(MODEL)
    expect(tokenizer?.countText('DeepSeek Harness').tokens).toBeGreaterThan(0)
    expect(deepSeekV4TokenizerForModel('deepseek-v4-flash-vision-exp')).toBeUndefined()
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

    await ctx.plugin(ToolResultPruner, {
      profile: 'balanced',
      freshTriggerTokens: 100_000,
      freshTargetTokens: 90_000,
      aggregateTriggerTokens: 100_000,
      aggregateTargetTokens: 90_000,
      historyTriggerTokens: 100,
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
      historyTriggerTokens: 100,
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

  it('distinguishes inactive and active History capacity-pressure from durable route capacity', async () => {
    const ctx = await runtimeContext()
    const audit = captureAudit(ctx)
    await ctx.plugin(ToolResultPruner, {
      profile: 'cache-strict',
      freshTriggerTokens: 100_000,
      freshTargetTokens: 90_000,
      aggregateTriggerTokens: 100_000,
      aggregateTargetTokens: 90_000,
      historyTriggerTokens: 40,
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
      reason: 'capacity-pressure-inactive',
      historyMode: 'capacity-pressure',
    }))

    const aboveCapacityGate = Session.create(SessionId('public-history-capacity-active'))
    appendToolTurn(aboveCapacityGate, 1, 'capacity active evidence '.repeat(600), true)
    appendToolTurn(aboveCapacityGate, 2, 'newest protected result', true)
    aboveCapacityGate.append('request/context', {
      provider: 'deepseek',
      model: MODEL,
      contextWindow: 100,
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
      trigger: 40,
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
    appendToolTurn(session, 4, 'recent working set', true, 'retain recent context')
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
})
