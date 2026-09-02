import { realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, Inbox } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import LlmRuntime, {
  CallId,
  createMessage,
  createUserMessage,
  createToolResultMessage,
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, canonicalHeader } from '@deepseek-ai/dsh-session'
import { SettingsProvider, settingsNamespace } from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'

const MODEL = 'deepseek-v4-flash'
const AUDIT_PREFIX = 'context-compression audit '
const consumerRoot = await realpath(dirname(fileURLToPath(import.meta.url)))
const consumerRequire = createRequire(import.meta.url)
const selectorPackage = consumerRequire.resolve('dsh-context-compression-selector/package.json')
const selectorRequire = createRequire(selectorPackage)
const runtimePackage = selectorRequire.resolve('dsh-context-compression-selector-runtime/package.json')
const SelectorHost = await import(pathToFileURL(consumerRequire.resolve('dsh-context-compression-selector')).href)
const Runtime = await import(pathToFileURL(selectorRequire.resolve('dsh-context-compression-selector-runtime')).href)

const assert = (condition, message) => {
  if (!condition) throw new Error(`packed component smoke: ${message}`)
}

for (const path of [selectorPackage, runtimePackage]) {
  const resolved = await realpath(path)
  assert(resolved.startsWith(`${consumerRoot}${sep}node_modules${sep}`),
    `product module resolved outside the packed consumer: ${resolved}`)
}

class MemorySettings extends SettingsProvider {
  writable = true
  stored = {}

  load() {
    return Promise.resolve(structuredClone(this.stored))
  }

  persist(namespace, section) {
    this.stored[namespace] = structuredClone(section)
    return Promise.resolve()
  }
}

class NativeSummaryAdapter extends LlmAdapter {
  constructor(responses, contextWindow) {
    super()
    this.responses = [...responses]
    this.contextWindow = contextWindow
  }

  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
    })
  }

  async * stream(options) {
    options.signal?.throwIfAborted()
    const text = this.responses.shift()
    if (text === undefined) throw new Error('NativeSummaryAdapter response script exhausted')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function captureAudit(ctx) {
  const records = []
  Object.defineProperty(ctx.logger, 'info', {
    configurable: true,
    value(message) {
      const line = String(message)
      if (line.startsWith(AUDIT_PREFIX)) records.push(JSON.parse(line.slice(AUDIT_PREFIX.length)))
      return ctx.logger
    },
  })
  return records
}

function appendToolTurn(session, turn, text, closeTurn, userText, provider = 'deepseek', model = MODEL) {
  const callId = CallId(`packed-call-${String(turn)}`)
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

function appendToolBatchTurn(session, turn, texts, closeTurn, userText) {
  const calls = texts.map((_, index) => ({
    id: CallId(`packed-call-${String(turn)}-${String(index + 1)}`),
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
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: calls.map(call => ({
        type: 'tool-call', id: call.id, name: call.name, arguments: '{}',
      })),
      source: { kind: 'model', provider: 'deepseek', model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  for (const [index, call] of calls.entries()) {
    session.append('tool/call', {
      turn, step: 1, callId: call.id, name: call.name, arguments: '{}',
    })
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId: call.id,
        content: [{ type: 'text', text: texts[index] ?? '' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
  }
  session.append('step/end', { turn, step: 1 })
  if (closeTurn) session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function stubAgent(ctx, session) {
  return {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }),
    status: 'idle',
    ctx,
    send() {},
    followup() {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' }) }),
    inject() {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

const ctx = new Context()
try {
  await ctx.plugin(MemorySettings).await()
  await ctx.plugin(SelectorHost).await()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(TokenMeter)
  const audit = captureAudit(ctx)

  const policy = structuredClone(Runtime.DEFAULT_CUSTOM_COMPRESSION_POLICY)
  assert(policy.version === 3, 'TailTrim requires the public Custom v3 policy')
  policy.fresh = { enabled: true, trigger: 512, target: 256 }
  policy.aggregate = { enabled: true, trigger: 1_000, target: 400 }
  policy.history = {
    enabled: true,
    // Strict required-reclaim: the batch must pull tool tokens back under the
    // trigger, so it sits above the large protected tail and placeholder
    // residue while remaining below the session's tool-result total.
    trigger: 7_800,
    keepRecentToolCalls: 0,
    keepRecentTokens: 1,
    minReclaim: 1,
  }
  policy.prefixPolicy = 'pressure-break'
  policy.tailTrim = { enabled: true, trigger: 8 }
  const namespace = settingsNamespace(Runtime.CONTEXT_COMPRESSION_SETTINGS_NAMESPACE)
  await ctx.settings.update(namespace, { profile: 'custom', custom: policy })
  await ctx.plugin(Runtime.default, {
    profile: 'native',
    nativeTriggerTokens: 100,
    nativeTargetTokens: 64,
    headChars: 8,
    tailChars: 8,
  }).await()

  const session = ctx.sessions.create(SessionId('packed-components-full-pipeline'))
  appendToolTurn(session, 1, 'packed Fresh '.repeat(600), false, 'run packed Fresh')
  ctx.toolResultPruner.pruneSession(session, { stage: 'fresh', freshTurn: 1, freshStep: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  appendToolBatchTurn(
    session,
    2,
    Array.from({ length: 30 }, (_, index) => `packed Aggregate ${String(index)} `.repeat(20)),
    false,
    'run packed Aggregate',
  )
  ctx.toolResultPruner.pruneSession(session, { stage: 'fresh', freshTurn: 2, freshStep: 1 })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
  appendToolTurn(session, 3, 'packed History '.repeat(600), true, 'run packed History')
  appendToolTurn(session, 4, 'packed recent protected working-set context '.repeat(1000), true, 'retain packed recent context')
  session.append('turn/start', { turn: 5 })
  ctx.toolResultPruner.pruneSession(session, { stage: 'pressure' })

  const tail = audit.find(record => record.kind === 'rewrite' && record.component === 'tail-trim')
  assert(tail !== undefined, 'TailTrim did not commit from installed Runtime')
  const ref = `session://${String(session.id)}/tailtrim/${String(tail.manifestSeq)}`
  const recovered = await ctx.tools.execute({
    name: 'context_compression_retrieve',
    arguments: { ref, max_lines: 20 },
    callId: CallId('packed-tailtrim-retrieve'),
    signal: new AbortController().signal,
    agent: stubAgent(ctx, session),
  })
  assert(recovered.isError === false, 'installed TailTrim recovery returned an error')
  const recoveredText = recovered.content
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n')
  assert(recoveredText.includes('kind: tailtrim-group'),
    'installed TailTrim recovery did not return a TailTrim group')
  const tailSourcePayloads = tail.sourceSeqs
    .map(seq => session.events[seq])
    .filter(event => event !== undefined)
    .map(event => JSON.stringify(event))
  const recoveredMarker = [
    'packed Fresh',
    'packed Aggregate',
    'packed History',
    'packed recent working set',
  ].find(marker => tailSourcePayloads.some(payload => payload.includes(marker)))
  assert(recoveredMarker !== undefined,
    'installed TailTrim audit did not identify an original source payload marker')
  assert(recoveredText.includes(recoveredMarker),
    'installed TailTrim recovery did not contain the audited original source payload')

  const capacityPolicy = structuredClone(policy)
  capacityPolicy.fresh.enabled = false
  capacityPolicy.aggregate.enabled = false
  capacityPolicy.history = {
    enabled: true,
    trigger: 400,
    keepRecentToolCalls: 0,
    keepRecentTokens: 1,
    minReclaim: 1,
  }
  capacityPolicy.prefixPolicy = 'preserve'
  capacityPolicy.tailTrim.enabled = false
  await ctx.settings.update(namespace, { profile: 'custom', custom: capacityPolicy })

  const inactiveCapacity = ctx.sessions.create(SessionId('packed-history-capacity-inactive'))
  appendToolTurn(inactiveCapacity, 1, 'packed capacity inactive '.repeat(600), true)
  appendToolTurn(inactiveCapacity, 2, 'packed newest protected result', true)
  inactiveCapacity.append('request/context', {
    provider: 'deepseek',
    model: MODEL,
    contextWindow: 1_000_000,
  })
  inactiveCapacity.append('turn/start', { turn: 3 })
  ctx.toolResultPruner.pruneSession(inactiveCapacity, { stage: 'pressure' })
  const inactiveCapacityAudit = audit.find(record => record.kind === 'component-evaluation'
    && record.sessionId === String(inactiveCapacity.id)
    && record.component === 'history')
  assert(inactiveCapacityAudit?.status === 'skipped'
    && inactiveCapacityAudit.reason === 'below-micro-deadline'
    && inactiveCapacityAudit.historyMode === 'capacity-pressure',
  'installed History did not prove the inactive capacity-pressure gate')

  const activeCapacity = ctx.sessions.create(SessionId('packed-history-capacity-active'))
  appendToolTurn(activeCapacity, 1, 'packed capacity active '.repeat(600), true)
  appendToolTurn(activeCapacity, 2, 'packed newest protected result', true)
  const activeCapacityWindow = Math.floor(ctx.tokenMeter.measure(activeCapacity).totalTokens / 0.75)
  activeCapacity.append('request/context', {
    provider: 'deepseek',
    model: MODEL,
    contextWindow: activeCapacityWindow,
  })
  activeCapacity.append('turn/start', { turn: 3 })
  ctx.toolResultPruner.pruneSession(activeCapacity, { stage: 'pressure' })
  const capacityRewrite = audit.find(record => record.kind === 'rewrite'
    && record.sessionId === String(activeCapacity.id)
    && record.component === 'history')
  assert(capacityRewrite?.historyMode === 'capacity-pressure'
    && capacityRewrite.stage === 'pressure'
    && typeof capacityRewrite.reducer === 'string'
    && Number.isSafeInteger(capacityRewrite.tokensBefore)
    && Number.isSafeInteger(capacityRewrite.tokensAfter)
    && capacityRewrite.tokensBefore > capacityRewrite.tokensAfter,
  'installed History did not commit exact capacity-pressure evidence')

  const boundaryCtx = new Context()
  try {
    await mountAgentLoopTestDependencies(boundaryCtx)
    await boundaryCtx.plugin(AgentLoop, { agents: [] })
    await boundaryCtx.plugin(TokenMeter)
    const boundaryAudit = captureAudit(boundaryCtx)
    boundaryCtx.llm.registerAdapter(
      ['deepseek'],
      new NativeSummaryAdapter(['packed Cache Strict pressure pass complete'], 100),
    )
    await boundaryCtx.plugin(Runtime.default, {
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
    const boundaryAgent = boundaryCtx.agentLoop.create(
      SessionId('packed-history-capacity-request-boundary'),
      { provider: 'deepseek', model: MODEL },
    )
    const boundarySession = boundaryAgent.session
    appendToolTurn(boundarySession, 1, 'packed old capacity-pressure evidence '.repeat(600), true)
    appendToolTurn(boundarySession, 2, 'packed newest protected result', true)
    const boundaryTotal = boundaryCtx.tokenMeter.measure(boundarySession).totalTokens
    boundarySession.append('request/context', {
      provider: 'deepseek',
      model: MODEL,
      // Just under the frozen 80% deadline D = 0.7 * window so the gate is
      // active while the strict reclaim target stays reachable.
      contextWindow: Math.floor(boundaryTotal / 0.72),
    })
    boundaryAgent.followup(createUserMessage({
      content: [{ type: 'text', text: 'run packed Cache Strict pressure pass' }],
      source: { kind: 'user' },
    }))
    await boundaryAgent.whenIdle()
    const boundaryRewrite = boundaryAudit.find(record => record.kind === 'rewrite'
      && record.sessionId === String(boundarySession.id)
      && record.component === 'history')
    assert(boundaryRewrite?.stage === 'pressure'
      && boundaryRewrite.historyMode === 'capacity-pressure'
      && boundaryRewrite.tokensBefore > boundaryRewrite.tokensAfter,
    'installed Cache Strict did not schedule History from the real request boundary')
  } finally {
    await boundaryCtx.fiber.dispose()
  }

  // Packed vision-session gate: the installed runtime must actually resolve
  // the deepseek-v4-flash-vision-exp route, count text exactly with the
  // separately bundled vision tokenizer, estimate image surfaces, and keep
  // image-bearing results outside exact rewrite proofs.
  const VISION_MODEL = 'deepseek-v4-flash-vision-exp'
  const VISION_TOKENIZER_REPOSITORY = 'deepseek-ai/DeepSeek-V4-Flash-Vision-Exp'
  const VISION_TOKENIZER_REVISION = '6821d6ad3681a4b137b066b76094fa82ebd0a380'
  const imageBlock = (width, height) => ({
    type: 'image',
    attachment: {
      attachmentId: `packed-image-${String(width)}x${String(height)}`,
      mediaType: 'image/png',
      bytes: 1_024,
      width,
      height,
    },
  })
  const visionCtx = new Context()
  try {
    await visionCtx.plugin(MemorySettings).await()
    await visionCtx.plugin(SelectorHost).await()
    await visionCtx.plugin(LlmRuntime)
    await visionCtx.plugin(SessionStore)
    await visionCtx.plugin(SystemPrompt)
    await visionCtx.plugin(ToolRuntime)
    await visionCtx.plugin(TokenMeter)
    const visionAudit = captureAudit(visionCtx)
    await visionCtx.plugin(Runtime.default, {
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

    // (a) A user image plus pure-text tool results: the text rewrites must be
    // exact and carry the vision tokenizer's repository/revision.
    const visionText = visionCtx.sessions.create(SessionId('packed-vision-text-session'))
    visionText.append('turn/start', { turn: 1 })
    visionText.append('request/header', {
      reason: 'initial',
      header: canonicalHeader({ config: { provider: 'deepseek', model: VISION_MODEL } }),
    })
    visionText.append('user/message', createUserMessage({
      content: [
        imageBlock(640, 480),
        { type: 'text', text: 'describe the attachment and run the tools' },
      ],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    visionText.append('step/start', { turn: 1, step: 1 })
    visionText.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: CallId('packed-vision-call-1'), name: 'bash', arguments: '{}' }],
        source: { kind: 'model', provider: 'deepseek', model: VISION_MODEL },
      }),
    }, { surfaceOp: 'append' })
    visionText.append('tool/call', { turn: 1, step: 1, callId: CallId('packed-vision-call-1'), name: 'bash', arguments: '{}' })
    visionText.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('packed-vision-call-1'),
        content: [{ type: 'text', text: 'packed vision fresh evidence '.repeat(1_000) }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    visionText.append('step/end', { turn: 1, step: 1 })
    visionText.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    appendToolTurn(visionText, 2, 'packed vision history evidence '.repeat(300), true, undefined, 'deepseek', VISION_MODEL)
    appendToolTurn(visionText, 3, 'packed recent protected result', true, undefined, 'deepseek', VISION_MODEL)
    visionText.append('turn/start', { turn: 4 })
    const visionFresh = visionCtx.toolResultPruner.pruneSession(visionText, { stage: 'fresh', freshTurn: 1, freshStep: 1 })
    const visionPressure = visionCtx.toolResultPruner.pruneSession(visionText, { stage: 'pressure' })
    assert(visionFresh.pruned.length === 1 && visionPressure.pruned.length >= 1,
      'packed vision text session did not rewrite pure-text results')
    const visionRewrites = visionAudit
      .filter(record => record.kind === 'rewrite' && record.sessionId === String(visionText.id))
    assert(visionRewrites.length >= 2, 'packed vision text session lacks aggregate and history rewrites')
    for (const record of visionRewrites) {
      assert(record.tokenizerId === VISION_TOKENIZER_REPOSITORY
        && record.tokenizerRevision === VISION_TOKENIZER_REVISION,
      `packed vision rewrite used tokenizer ${String(record.tokenizerId)}@${String(record.tokenizerRevision)}`)
    }
    assert(visionRewrites.some(record => record.component === 'aggregate')
      && visionRewrites.some(record => record.component === 'history'),
    'packed vision text session lacks an aggregate/history component rewrite')

    // (b) An image-bearing tool result: its surface may be estimated, but every
    // rewrite path still requires exact counts. The original event is untouched
    // and the audits say why no rewrite was authorized.
    const visionImage = visionCtx.sessions.create(SessionId('packed-vision-image-tool-result'))
    visionImage.append('turn/start', { turn: 1 })
    visionImage.append('request/header', {
      reason: 'initial',
      header: canonicalHeader({ config: { provider: 'deepseek', model: VISION_MODEL } }),
    })
    const estimatedUserImage = visionImage.append('user/message', createUserMessage({
      content: [imageBlock(800, 600)],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    visionImage.append('step/start', { turn: 1, step: 1 })
    visionImage.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: CallId('packed-vision-image-call'), name: 'screenshot', arguments: '{}' }],
        source: { kind: 'model', provider: 'deepseek', model: VISION_MODEL },
      }),
    }, { surfaceOp: 'append' })
    visionImage.append('tool/call', { turn: 1, step: 1, callId: CallId('packed-vision-image-call'), name: 'screenshot', arguments: '{}' })
    const imageResult = visionImage.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('packed-vision-image-call'),
        content: [
          { type: 'text', text: 'packed screenshot captured' },
          imageBlock(800, 600),
        ],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    visionImage.append('step/end', { turn: 1, step: 1 })
    visionImage.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    visionImage.append('turn/start', { turn: 2 })
    const imageFresh = visionCtx.toolResultPruner.pruneSession(visionImage, { stage: 'fresh', freshTurn: 1, freshStep: 1 })
    const imagePressure = visionCtx.toolResultPruner.pruneSession(visionImage, { stage: 'pressure' })
    assert(imageFresh.pruned.length === 0 && imagePressure.pruned.length === 0,
      'packed vision image-bearing result was rewritten lossily')
    const imageMeasurement = Runtime.measureForCompaction(visionCtx, visionImage)
    const estimatedImageCount = imageMeasurement.measuredNodes
      .find(node => node.seq === estimatedUserImage.seq)?.count
    assert(estimatedImageCount?.kind === 'tokenizer-estimate',
      `packed vision image surface is ${String(estimatedImageCount?.kind)}, expected tokenizer-estimate`)
    assert(estimatedImageCount.tokens === 340,
      `packed vision 800x600 estimate is ${String(estimatedImageCount.tokens)}, expected 340`)
    assert(estimatedImageCount.upperBoundTokens === 384,
      `packed vision image upper bound is ${String(estimatedImageCount.upperBoundTokens)}, expected 384`)
    assert(estimatedImageCount.estimatorId === `${VISION_TOKENIZER_REPOSITORY}/image-token-estimate`,
      `packed vision image estimator id is ${String(estimatedImageCount.estimatorId)}`)
    assert(estimatedImageCount.estimatorRevision === `${VISION_TOKENIZER_REVISION}:v1`,
      `packed vision image estimator revision is ${String(estimatedImageCount.estimatorRevision)}`)
    assert(imageMeasurement.currentSurface.kind === 'tokenizer-estimate',
      `packed vision current surface is ${imageMeasurement.currentSurface.kind}, expected tokenizer-estimate`)
    // Tool-result events carry one envelope block whose nested content holds
    // the original [text, image] blocks; the durable attachment reference must
    // still be there verbatim.
    const originalImage = visionImage.events[imageResult.seq]
    assert(originalImage?.type === 'tool/result'
      && JSON.stringify(originalImage).includes('packed-image-800x600')
      && JSON.stringify(originalImage).includes('"type":"image"'),
    'packed vision image-bearing result is no longer intact on the surface')
    for (const component of ['fresh', 'history']) {
      assert(visionAudit.some(record => record.kind === 'component-evaluation'
        && record.sessionId === String(visionImage.id)
        && record.component === component
        && record.status === 'skipped'
        && record.reason === 'exact-tokenizer-unavailable'),
      `packed vision image session lacks the ${component} exact-tokenizer-unavailable audit`)
    }

    console.info(`PACKED_VISION_E2E ${JSON.stringify({
      model: VISION_MODEL,
      tokenizer: { repository: VISION_TOKENIZER_REPOSITORY, revision: VISION_TOKENIZER_REVISION },
      textSession: 'exact-rewrites-with-vision-tokenizer',
      imageSession: {
        measurement: estimatedImageCount,
        currentSurfaceKind: imageMeasurement.currentSurface.kind,
        exactRewriteIneligible: true,
        originalIntact: true,
      },
    })}`)
  } finally {
    await visionCtx.fiber.dispose()
  }

  const beforeNative = ctx.tokenMeter.measure(session).totalTokens
  assert(beforeNative > 2, 'installed pipeline has no Native pressure')
  ctx.llm.registerAdapter(['deepseek'], new NativeSummaryAdapter(['packed native summary'], beforeNative))
  void new BasicCompactionEngine(ctx, {
    auto: true,
    thresholdRatio: 0.5,
    retainTokens: 0,
    maxTokens: 100,
    compactionRetries: 0,
  })
  const decision = await agentEvents(ctx, stubAgent(ctx, session)).waterfall(
    'agent/pre-step',
    { messages: [], turn: 5, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: [] }),
  )
  assert(decision.kind === 'enter', 'Native pre-step did not return enter')
  assert(session.events.some(event => event.type === 'compaction/summary'),
    'official BasicCompactionEngine did not commit Native summary')

  await ctx.settings.update(namespace, { profile: 'native' })
  const nativeSession = ctx.sessions.create(SessionId('packed-native-tool-result'))
  appendToolTurn(nativeSession, 1, 'packed native tool result '.repeat(800), false)
  const nativeResult = ctx.toolResultPruner.pruneSession(nativeSession, { stage: 'pressure' })
  assert(nativeResult.pruned.length === 1, 'installed Native tool-result profile did not rewrite')

  const firstFrozen = structuredClone(policy)
  firstFrozen.fresh = { enabled: true, trigger: 512, target: 256 }
  firstFrozen.aggregate.enabled = false
  firstFrozen.history.enabled = false
  firstFrozen.tailTrim.enabled = false
  await ctx.settings.update(namespace, { profile: 'custom', custom: firstFrozen })
  const frozenA = ctx.sessions.create(SessionId('packed-policy-freeze-a'))
  appendToolTurn(frozenA, 1, 'packed frozen first '.repeat(800), false)
  assert(ctx.toolResultPruner.pruneSession(frozenA, {
    stage: 'fresh', freshTurn: 1, freshStep: 1,
  }).pruned.length === 1, 'first frozen policy did not run Fresh')
  const edited = structuredClone(firstFrozen)
  edited.fresh.enabled = false
  edited.history.trigger += 123
  await ctx.settings.update(namespace, { custom: edited })
  frozenA.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  appendToolTurn(frozenA, 2, 'packed frozen second '.repeat(800), false)
  assert(ctx.toolResultPruner.pruneSession(frozenA, {
    stage: 'fresh', freshTurn: 2, freshStep: 1,
  }).pruned.length === 1, 'observed Session did not retain its complete frozen policy')
  const frozenB = ctx.sessions.create(SessionId('packed-policy-freeze-b'))
  appendToolTurn(frozenB, 1, 'packed new disabled Fresh '.repeat(800), false)
  assert(ctx.toolResultPruner.pruneSession(frozenB, {
    stage: 'fresh', freshTurn: 1, freshStep: 1,
  }).pruned.length === 0, 'new Session did not adopt the edited complete policy')

  const rewrites = audit.filter(record => record.kind === 'rewrite')
  const firstIndex = component => audit.findIndex(record => record.kind === 'rewrite'
    && record.sessionId === String(session.id) && record.component === component)
  for (const component of ['fresh', 'aggregate', 'history', 'tail-trim']) {
    assert(firstIndex(component) >= 0, `installed pipeline lacks ${component} rewrite`)
  }
  const routineHistory = rewrites.find(record => record.sessionId === String(session.id)
    && record.component === 'history')
  assert(routineHistory?.historyMode === 'routine',
    'installed full pipeline did not identify routine History')
  assert(firstIndex('fresh') < firstIndex('aggregate')
    && firstIndex('aggregate') < firstIndex('history')
    && firstIndex('history') < firstIndex('tail-trim'),
  'installed component rewrite order is wrong')
  const pipelineRewrites = rewrites.filter(record => record.sessionId === String(session.id))
  assert(pipelineRewrites.every(record => Number.isSafeInteger(record.tokensBefore)
    && Number.isSafeInteger(record.tokensAfter) && record.tokensBefore > record.tokensAfter),
  'installed rewrite lacks exact decreasing token evidence')
  assert(audit.some(record => record.kind === 'native-auto-compact'
    && record.sessionId === String(session.id)),
  'installed Runtime did not audit official Native summary')
  assert(rewrites.some(record => record.component === 'native-tool-result'
    && record.sessionId === String(nativeSession.id)),
  'installed Runtime lacks Native tool-result audit')
  const frozenAuditA = audit.find(record => record.kind === 'policy-frozen'
    && record.sessionId === String(frozenA.id))
  const frozenAuditB = audit.find(record => record.kind === 'policy-frozen'
    && record.sessionId === String(frozenB.id))
  assert(frozenAuditA?.settings?.custom?.fresh?.enabled === true,
    'first installed policy-frozen record lacks original complete settings')
  assert(frozenAuditB?.settings?.custom?.fresh?.enabled === false,
    'new installed policy-frozen record lacks edited complete settings')

  console.info(`PACKED_COMPONENTS_E2E ${JSON.stringify({
    productImports: 'consumer-node_modules',
    components: ['fresh', 'aggregate', 'history', 'tail-trim', 'native-tool-result'],
    coreNative: 'compaction/summary',
    tailTrimRecovery: 'original-group-recovered',
    policyFreeze: 'old-session-retained-new-session-adopted',
    exactTokenEvidence: 'before-greater-than-after',
    historyModes: {
      routine: {
        stage: routineHistory.stage,
        reducer: routineHistory.reducer,
        tokensBefore: routineHistory.tokensBefore,
        tokensAfter: routineHistory.tokensAfter,
      },
      capacityPressure: {
        inactiveReason: inactiveCapacityAudit.reason,
        stage: capacityRewrite.stage,
        reducer: capacityRewrite.reducer,
        tokensBefore: capacityRewrite.tokensBefore,
        tokensAfter: capacityRewrite.tokensAfter,
      },
      capacityPressureRequestBoundary: 'scheduled-history-rewrite',
    },
    rewriteEvidence: ['fresh', 'aggregate', 'history', 'tail-trim'].map(component => {
      const record = pipelineRewrites.find(candidate => candidate.component === component)
      assert(record !== undefined, `installed Runtime lacks ${component} rewrite evidence`)
      return {
        component: record.component,
        stage: record.stage,
        reducer: record.reducer,
        tokensBefore: record.tokensBefore,
        tokensAfter: record.tokensAfter,
      }
    }),
    customEvents: session.events.some(event => event.type === 'compaction/group-trim') ? 'present' : 'absent',
  })}`)
} finally {
  await ctx.fiber.dispose()
}
