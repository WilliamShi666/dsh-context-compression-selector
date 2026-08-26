import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { PublicMockAdapter, publicTextResponse } from './support/mock-adapter.ts'
import {
  assessReusablePrefix,
  buildSafeCacheAuditRecord,
  fingerprintStablePrefix,
  type JsonValue,
  type StablePrefixEnvelope,
} from './support/cache-prefix-audit.js'

const SYSTEM = 'You are a terse assistant in an isolated parent-child cache-prefix test. '
  + 'Follow the latest user instruction literally. Answer in one short sentence. '
  + 'Do not use markdown, tools, timestamps, random identifiers, environment values, '
  + 'or unstated facts. This deliberately long stable persona supplies enough repeated '
  + 'context for the provider cache while remaining identical for parent and child requests.'

const PARENT_TEXT = 'Remember that the stable test phrase is cobalt-heron-42 and repeat it once.'
const CHILD_TEXT = 'Repeat the stable test phrase once more.'
const SPAWN_TEXT = 'Answer only with the word fresh.'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

const jsonValue = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue

const envelope = (options: GenerateOptions, messageCount = options.messages.length): StablePrefixEnvelope => ({
  provider: options.provider,
  model: options.model,
  system: options.system ?? null,
  tools: jsonValue(options.tools ?? []) as JsonValue[],
  messages: jsonValue(options.messages.slice(0, messageCount)) as JsonValue[],
})

async function liveHarness(requests: Map<string, GenerateOptions[]>): Promise<Context> {
  const created = new Context()
  await mountAgentLoopTestDependencies(created, { systemPrompt: { persona: SYSTEM } })
  await created.plugin(TokenMeter)
  await created.plugin(AgentLoop, { agents: [] })
  await created.plugin(SubagentRuntime)
  await created.plugin(Fork, { providerName: 'fork' })
  await created.plugin(Spawn, { providerName: 'spawn' })
  await created.plugin(LlmDeepSeek)
  created.on('llm/stream', (options, next) => {
    const sessionId = String(options.sessionId)
    requests.set(sessionId, [...(requests.get(sessionId) ?? []), options])
    return next()
  })
  return created
}

async function keylessHarness(requests: Map<string, GenerateOptions[]>): Promise<Context> {
  const created = new Context()
  await mountAgentLoopTestDependencies(created, { systemPrompt: { persona: SYSTEM } })
  await created.plugin(AgentLoop, { agents: [] })
  await created.plugin(SubagentRuntime)
  await created.plugin(Fork, { providerName: 'fork' })
  await created.plugin(Spawn, { providerName: 'spawn' })
  created.llm.registerAdapter(['mock'], new PublicMockAdapter([
    publicTextResponse('cobalt-heron-42'),
    publicTextResponse('cobalt-heron-42'),
    publicTextResponse('fresh'),
  ]))
  created.on('llm/stream', (options, next) => {
    const sessionId = String(options.sessionId)
    requests.set(sessionId, [...(requests.get(sessionId) ?? []), options])
    return next()
  })
  return created
}

describe('parent/child prefix behavior (keyless full-loop E2E)', () => {
  it('runs parent, fork, and spawn through the real loop and session providers', async () => {
    const requests = new Map<string, GenerateOptions[]>()
    ctx = await keylessHarness(requests)
    const parent = ctx.agentLoop.create(SessionId('cache-parent-keyless-e2e'), {
      provider: 'mock',
      model: 'mock',
    })
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: PARENT_TEXT }],
      source: { kind: 'user' },
    }))
    await parent.whenIdle()
    const parentEvents = parent.session.events.slice()
    const parentRequest = requests.get(String(parent.id))?.at(-1)
    expect(parentRequest).toBeDefined()

    const forkRun = await ctx.subagents.start('fork', {
      prompt: [{ type: 'text', text: CHILD_TEXT }],
      parent,
      signal: new AbortController().signal,
    })
    await forkRun.result
    const forkChild = forkRun.localAgent
    const forkRequest = requests.get(String(forkRun.id))?.at(-1)
    expect(forkChild).toBeDefined()
    expect(forkRequest).toBeDefined()
    if (forkChild === undefined || forkRequest === undefined || parentRequest === undefined) {
      throw new Error('keyless fork did not publish its complete evidence')
    }
    expect(forkChild.session.header.seedLength).toBe(parentEvents.length)
    expect(forkChild.session.events.slice(0, parentEvents.length)).toEqual(parentEvents)
    const parentStable = envelope(parentRequest)
    const forkStablePrefix = envelope(forkRequest, parentRequest.messages.length)
    expect(fingerprintStablePrefix(forkStablePrefix)).toBe(fingerprintStablePrefix(parentStable))
    expect(Object.isFrozen(forkRequest)).toBe(true)

    const spawnRun = await ctx.subagents.start('spawn', {
      prompt: [{ type: 'text', text: SPAWN_TEXT }],
      parent,
      signal: new AbortController().signal,
    })
    await spawnRun.result
    const spawnChild = spawnRun.localAgent
    const spawnRequest = requests.get(String(spawnRun.id))?.at(-1)
    expect(spawnChild?.session.header.seedLength).toBeUndefined()
    expect(spawnRequest).toBeDefined()
    expect(JSON.stringify(spawnRequest?.messages)).not.toContain(PARENT_TEXT)
    expect(assessReusablePrefix({
      mode: 'spawn',
      inheritsParentContext: false,
      parent: parentStable,
      child: envelope(spawnRequest!),
    })).toEqual({ eligible: false, reason: 'spawn-does-not-inherit' })

    const safeRecord = buildSafeCacheAuditRecord({
      fingerprint: fingerprintStablePrefix(parentStable),
      estimatedSharedPrefixTokens: Math.ceil(JSON.stringify(parentStable).length / 4),
      parentSessionId: String(parent.session.header.id),
      childSessionId: String(forkChild.session.header.id),
      mode: 'fork',
      eligible: true,
      reason: 'identical-fork-prefix',
    })
    expect(safeRecord.confirmationStatus).toBe('unconfirmed')
    expect(JSON.stringify(safeRecord)).not.toContain(PARENT_TEXT)

    await spawnRun.dispose()
    await forkRun.dispose()
  })
})

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('parent/child natural cache-prefix reuse (real DeepSeek API)', () => {
  it('preserves the fork prefix, separates spawn, and records only official usage evidence', async () => {
    const requests = new Map<string, GenerateOptions[]>()
    ctx = await liveHarness(requests)
    const parent = ctx.agentLoop.create(SessionId('cache-parent-e2e'), {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: PARENT_TEXT }],
      source: { kind: 'user' },
    }))
    await parent.whenIdle()
    const parentEvents = parent.session.events.slice()
    const parentRequest = requests.get(String(parent.id))?.at(-1)
    expect(parentRequest).toBeDefined()

    const forkRun = await ctx.subagents.start('fork', {
      prompt: [{ type: 'text', text: CHILD_TEXT }],
      parent,
      signal: new AbortController().signal,
    })
    await forkRun.result
    const forkChild = forkRun.localAgent
    expect(forkChild).toBeDefined()
    if (forkChild === undefined) throw new Error('fork did not publish a local agent')
    const forkRequest = requests.get(String(forkRun.id))?.at(-1)
    expect(forkRequest).toBeDefined()
    expect(forkChild.session.header).toMatchObject({
      parentSession: parent.session.header.id,
      seedLength: parentEvents.length,
    })
    expect(forkChild.session.events.slice(0, parentEvents.length)).toEqual(parentEvents)

    const parentStable = envelope(parentRequest!)
    const forkStablePrefix = envelope(forkRequest!, parentRequest!.messages.length)
    expect(assessReusablePrefix({
      mode: 'fork',
      inheritsParentContext: true,
      parent: parentStable,
      child: forkStablePrefix,
    })).toEqual({ eligible: true, reason: 'identical-fork-prefix' })
    expect(fingerprintStablePrefix(parentStable)).toBe(fingerprintStablePrefix(forkStablePrefix))
    expect(Object.isFrozen(forkRequest)).toBe(true)

    const measurement = ctx.tokenMeter.measure(forkChild.session)
    const usage = measurement.baseline.kind === 'usage' ? measurement.baseline.usage : undefined
    const cacheMissTokens = usage === undefined
      ? undefined
      : usage.inputTokens + (usage.cacheWriteTokens ?? 0)
    const observedPromptTokens = usage === undefined
      ? undefined
      : cacheMissTokens! + (usage.cacheReadTokens ?? 0)
    const record = buildSafeCacheAuditRecord({
      fingerprint: fingerprintStablePrefix(parentStable),
      estimatedSharedPrefixTokens: Math.ceil(JSON.stringify(parentStable).length / 4),
      parentSessionId: String(parent.session.header.id),
      childSessionId: String(forkChild.session.header.id),
      mode: 'fork',
      eligible: true,
      reason: 'identical-fork-prefix',
      ...(usage?.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
      ...(cacheMissTokens === undefined ? {} : { cacheMissTokens }),
      ...(observedPromptTokens === undefined ? {} : { observedPromptTokens }),
    })
    expect(JSON.stringify(record)).not.toContain(PARENT_TEXT)
    expect(JSON.stringify(record)).not.toContain(CHILD_TEXT)
    console.info(`SUBAGENT_CACHE_E2E ${JSON.stringify(record)}`)

    const spawnRun = await ctx.subagents.start('spawn', {
      prompt: [{ type: 'text', text: SPAWN_TEXT }],
      parent,
      signal: new AbortController().signal,
    })
    await spawnRun.result
    const spawnChild = spawnRun.localAgent
    expect(spawnChild).toBeDefined()
    if (spawnChild === undefined) throw new Error('spawn did not publish a local agent')
    const spawnRequest = requests.get(String(spawnRun.id))?.at(-1)
    expect(spawnChild.session.header.parentSession).toBe(parent.session.header.id)
    expect(spawnChild.session.header.seedLength).toBeUndefined()
    expect(spawnRequest).toBeDefined()
    expect(JSON.stringify(spawnRequest!.messages)).not.toContain(PARENT_TEXT)
    expect(assessReusablePrefix({
      mode: 'spawn',
      inheritsParentContext: false,
      parent: parentStable,
      child: envelope(spawnRequest!),
    })).toEqual({ eligible: false, reason: 'spawn-does-not-inherit' })

    await spawnRun.dispose()
    await forkRun.dispose()
  }, 180_000)
})
