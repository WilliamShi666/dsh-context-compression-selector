import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Group from '@deepseek-ai/cordis-plugin-group'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets, { COMPOSITION_FILE } from '@deepseek-ai/dsh-agent-presets'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import {
  SettingsProvider,
  settingsNamespace,
  type SettingsNamespace,
} from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

const CORDIS_ORIGINAL = Symbol.for('cordis.original')
type Traceable = { [CORDIS_ORIGINAL]?: unknown }

let ctx: Context | undefined
let root: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

class MemorySettings extends SettingsProvider {
  readonly writable = true

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve({})
  }

  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

interface CustomSettings {
  profile: string
  custom: {
    history: { trigger: number }
    tailTrim: { enabled: boolean; trigger: number }
  }
}

async function createPresetRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-selector-loader-e2e-'))
  const marker = join(root, 'marker.mjs')
  await writeFile(marker, 'export function apply() {}\n')
  const source = `- id: source-marker\n  name: ${JSON.stringify(marker)}\n`
  for (const id of ['standard', 'custom', 'minimal']) {
    const directory = join(root, id)
    await mkdir(directory)
    await writeFile(join(directory, COMPOSITION_FILE), source)
  }
  return root
}

async function harness(): Promise<Context> {
  const presets = await createPresetRoot()
  const runtime = new Context()
  runtime.baseUrl = `${pathToFileURL(presets).href}/`
  await runtime.plugin(Loader)
  runtime.loader.builtins.include = Include
  runtime.loader.builtins.group = Group
  await runtime.plugin(LlmRuntime)
  await runtime.plugin(SessionStore)
  await runtime.plugin(SystemPrompt, { persona: '' })
  await runtime.plugin(ToolRuntime)
  await runtime.plugin(AgentRegistry)
  await runtime.plugin(AgentLoop, { agents: [] })
  await runtime.plugin(CommandRuntime)
  await runtime.plugin(TokenMeter)
  await runtime.plugin(MemorySettings)
  await runtime.plugin(AgentPresets, {
    default: 'standard',
    roots: [{ path: presets, trust: 'system' }],
    includeUserRoot: false,
  })
  await runtime.plugin({
    apply: (selectorCtx) => {
      apply(selectorCtx, { presetOverlay: true })
    },
  }).await()
  ctx = runtime
  return runtime
}

async function agentOn(runtime: Context, sessionId: string, preset: string): Promise<Agent> {
  const handle = await runtime.agents.create({
    sessionId: SessionId(sessionId),
    setup: async agentCtx => void await runtime.agentPresets.mount(agentCtx, preset),
  })
  return handle.agent
}

function hasCompressionRetrieve(runtime: Context, agent: Agent): boolean {
  return runtime.tools.get('context_compression_retrieve', scopeOf(agent.ctx)) !== undefined
}

function hasCompactCommand(runtime: Context, agent: Agent): boolean {
  return runtime.commands.list(agent).some(command => command.name === 'compact')
}

function expectCompleteCompressionStack(runtime: Context, agent: Agent): void {
  expect(runtime.agentPresets.serviceFor(agent, 'toolResultPruner')).toBeDefined()
  expect(runtime.agentPresets.serviceFor(agent, 'compaction')).toBeDefined()
  expect(hasCompressionRetrieve(runtime, agent)).toBe(true)
  expect(hasCompactCommand(runtime, agent)).toBe(true)
}

function expectNoCompressionStack(runtime: Context, agent: Agent): void {
  expect(runtime.agentPresets.serviceFor(agent, 'toolResultPruner')).toBeUndefined()
  expect(runtime.agentPresets.serviceFor(agent, 'compaction')).toBeUndefined()
  expect(hasCompressionRetrieve(runtime, agent)).toBe(false)
  expect(hasCompactCommand(runtime, agent)).toBe(false)
}

describe('standalone selector Bundle through the real preset Loader', () => {
  it('mounts the complete stack without changing source preset authoring', async () => {
    const runtime = await harness()
    const source = await runtime.agentPresets.resolve('standard')
    const sourceText = await runtime.agentPresets.read('standard')

    const agent = await agentOn(runtime, 'selector-loader-standard', 'standard')

    expectCompleteCompressionStack(runtime, agent)
    expect((await runtime.agentPresets.resolve('standard')).path).toBe(source.path)
    expect(await runtime.agentPresets.read('standard')).toBe(sourceText)
    expect(sourceText).not.toContain('tool-result-pruner')
  })

  it('keeps compression across preset changes and excludes only exact Minimal', async () => {
    const runtime = await harness()
    const agent = await agentOn(runtime, 'selector-loader-switch', 'standard')
    expectCompleteCompressionStack(runtime, agent)

    await runtime.agentPresets.recompose(agent.ctx, 'minimal')
    expectNoCompressionStack(runtime, agent)

    // `custom` deliberately contains the same source rows as Minimal. Its id,
    // not its copied contents, decides the one documented exception.
    await runtime.agentPresets.recompose(agent.ctx, 'custom')
    expectCompleteCompressionStack(runtime, agent)
  })

  it('gives a child the parent\'s exact compression service instances', async () => {
    const runtime = await harness()
    const parent = await agentOn(runtime, 'selector-loader-parent', 'standard')
    const childHandle = await runtime.agents.create({
      sessionId: SessionId('selector-loader-child'),
      setup: childCtx => void runtime.agentPresets.composeFrom(childCtx, parent.ctx),
    })
    const child = childHandle.agent

    const parentPruner = runtime.agentPresets.serviceFor(parent, 'toolResultPruner')
    const childPruner = runtime.agentPresets.serviceFor(child, 'toolResultPruner')
    const parentCompaction = runtime.agentPresets.serviceFor(parent, 'compaction')
    const childCompaction = runtime.agentPresets.serviceFor(child, 'compaction')
    expect(parentPruner).toBeDefined()
    expect(parentCompaction).toBeDefined()
    expect(Object.is(
      (childPruner as Traceable)[CORDIS_ORIGINAL],
      (parentPruner as Traceable)[CORDIS_ORIGINAL],
    )).toBe(true)
    expect(Object.is(
      (childCompaction as Traceable)[CORDIS_ORIGINAL],
      (parentCompaction as Traceable)[CORDIS_ORIGINAL],
    )).toBe(true)
    expect(hasCompressionRetrieve(runtime, child)).toBe(true)
    expect(hasCompactCommand(runtime, child)).toBe(true)
  })

  it('publishes the daily Custom defaults from the plugin-owned settings row', async () => {
    const runtime = await harness()
    const namespace = settingsNamespace('context-compression')
    const settings = runtime.settings.get(namespace) as CustomSettings

    expect(settings.custom.history.trigger).toBe(500_000)
    expect(settings.custom.tailTrim).toEqual({ enabled: false, trigger: 700_000 })
  })
})
