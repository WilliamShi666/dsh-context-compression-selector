import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-presets'
import {
  SettingsProvider,
  settingsNamespace,
  type SettingsNamespace,
} from '@deepseek-ai/dsh-settings'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'
import type { OverlayableAgentPresets } from '../src/preset-overlay.ts'

let root: string | undefined
let ctx: Context | undefined

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

class FakeAgentPresets extends Service implements OverlayableAgentPresets {
  constructor(ctx: Context, readonly preset: AgentPreset) {
    super(ctx, 'agentPresets')
  }

  async resolve(): Promise<AgentPreset> {
    return this.preset
  }

  async mount(_agentCtx: unknown): Promise<AgentPreset> {
    return await this.resolve()
  }

  async recompose(_agentCtx: unknown, _id: string): Promise<AgentPreset> {
    return await this.resolve()
  }

  async standingKeyFor(): Promise<string> {
    return (await this.resolve()).path
  }
}

async function sourcePreset(): Promise<AgentPreset> {
  root = await mkdtemp(join(tmpdir(), 'dsh-selector-host-overlay-'))
  const path = join(root, 'standard', 'agent.cordis.yml')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, "- id: persona\n  name: '/opt/preset/persona.js'\n")
  return { id: 'standard', trust: 'system', path }
}

describe('context compression selector Host preset integration', () => {
  it('decorates native composition only for the lifetime of the selector fiber', async () => {
    const preset = await sourcePreset()
    ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    await ctx.plugin(FakeAgentPresets, preset).await()

    const selector = ctx.plugin({ apply: (child) => {
      apply(child, { presetOverlay: true })
    } })
    await selector.await()

    const service = ctx.agentPresets as unknown as OverlayableAgentPresets
    const mounted = await service.mount({})
    expect(mounted.path).not.toBe(preset.path)
    expect(await readFile(mounted.path, 'utf8')).toContain('id: tool-result-pruner')
    expect((await service.resolve()).path).toBe(preset.path)

    await selector.dispose()
    expect((await service.mount({})).path).toBe(preset.path)
  })

  it('keeps settings and overlay alive across duplicate Host row disposal', async () => {
    const preset = await sourcePreset()
    ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    await ctx.plugin(FakeAgentPresets, preset).await()

    const builtIn = ctx.plugin({ apply })
    await builtIn.await()

    const namespace = settingsNamespace('context-compression')
    const service = ctx.agentPresets as unknown as OverlayableAgentPresets
    expect((await service.mount({})).path).toBe(preset.path)
    expect(ctx.settings.describe().filter(row => row.ns === namespace)).toHaveLength(1)

    await ctx.settings.update(namespace, { profile: 'cache-strict' })
    const selectedSettings = structuredClone(ctx.settings.get(namespace))
    expect(selectedSettings).toMatchObject({ profile: 'cache-strict' })

    const bundle = ctx.plugin({ apply: (child) => {
      apply(child, { presetOverlay: true })
    } })
    await bundle.await()

    const mounted = await service.mount({})
    expect(mounted.path).not.toBe(preset.path)
    expect((await service.recompose({}, 'standard')).path).toBe(mounted.path)
    expect(ctx.settings.get(namespace)).toEqual(selectedSettings)
    expect(ctx.settings.describe().filter(row => row.ns === namespace)).toHaveLength(1)

    await builtIn.dispose()
    expect((await service.mount({})).path).toBe(mounted.path)
    expect(ctx.settings.describe().filter(row => row.ns === namespace)).toHaveLength(1)

    await bundle.dispose()
    expect((await service.mount({})).path).toBe(preset.path)
    expect(ctx.settings.describe().filter(row => row.ns === namespace)).toHaveLength(0)
  })
})
