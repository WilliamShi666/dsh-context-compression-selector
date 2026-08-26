import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-presets'
import {
  decorateAgentPresets,
  type CompressionModulePaths,
  type OverlayableAgentPresets,
} from '../src/preset-overlay.ts'

const MODULES: CompressionModulePaths = {
  compactionBasic: '/opt/context-selector/compaction-basic.js',
  commandCompact: '/opt/context-selector/command-compact.js',
  toolResultPruner: '/opt/context-selector/tool-result-pruner.js',
}

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{
  root: string
  standard: AgentPreset
  minimal: AgentPreset
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-selector-overlay-test-'))
  roots.push(root)
  const standardPath = join(root, 'standard', 'agent.cordis.yml')
  const minimalPath = join(root, 'minimal', 'agent.cordis.yml')
  await mkdir(dirname(standardPath), { recursive: true })
  await mkdir(dirname(minimalPath), { recursive: true })
  await writeFile(standardPath, [
    '- id: persona',
    "  name: '/opt/preset/persona.js'",
    '- id: tool-context-retrieve',
    "  name: '@deepseek-ai/dsh-tool-context-retrieve'",
    '- id: compaction',
    '  name: cordis:group',
    '  group: true',
    '  isolate:',
    '    compaction: true',
    '    toolResultPruner: true',
    '  config:',
    '    - id: compaction-basic',
    "      name: '@deepseek-ai/dsh-compaction-basic'",
    '    - id: command-compact',
    "      name: '@deepseek-ai/dsh-command-compact'",
    '    - id: tool-result-pruner',
    "      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'",
    '',
  ].join('\n'))
  await writeFile(minimalPath, "- id: persona\n  name: '/opt/preset/minimal.js'\n")
  return {
    root,
    standard: { id: 'standard', trust: 'system', path: standardPath },
    minimal: { id: 'minimal', trust: 'system', path: minimalPath },
  }
}

class FakeAgentPresets implements OverlayableAgentPresets {
  constructor(private readonly presets: ReadonlyMap<string, AgentPreset>) {}

  async resolve(id = 'standard'): Promise<AgentPreset> {
    const preset = this.presets.get(id)
    if (preset === undefined) throw new Error(`unknown preset: ${id}`)
    return preset
  }

  async mount(_agentCtx: unknown, id?: string): Promise<AgentPreset> {
    return await this.resolve(id)
  }

  async recompose(_agentCtx: unknown, id: string): Promise<AgentPreset> {
    return await this.resolve(id)
  }

  async standingKeyFor(id?: string): Promise<string> {
    return (await this.resolve(id)).path
  }

  async read(id: string): Promise<string> {
    return await readFile((await this.resolve(id)).path, 'utf8')
  }
}

function rowsAt(text: string): Array<Record<string, unknown>> {
  const rows = load(text)
  if (!Array.isArray(rows)) throw new TypeError('expected entry list')
  return rows as Array<Record<string, unknown>>
}

function flatten(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.flatMap((row) => {
    const nested = row.group === true && Array.isArray(row.config)
      ? flatten(row.config as Array<Record<string, unknown>>)
      : []
    return [row, ...nested]
  })
}

describe('plugin-owned preset overlay decorator', () => {
  it('enhances only composition operations while authoring sees the source preset', async () => {
    const { root, standard, minimal } = await fixture()
    const presets = new FakeAgentPresets(new Map([
      ['standard', standard],
      ['minimal', minimal],
    ]))
    const installation = decorateAgentPresets(presets, {
      modules: MODULES,
      excludedPresetIds: ['minimal'],
      tempParent: root,
    })

    expect((await presets.resolve('standard')).path).toBe(standard.path)
    expect(await presets.read('standard')).toBe(await readFile(standard.path, 'utf8'))

    const mounted = await presets.mount({}, 'standard')
    expect(mounted.path).not.toBe(standard.path)
    expect((await presets.recompose({}, 'standard')).path).toBe(mounted.path)
    expect(await presets.standingKeyFor('standard')).toBe(mounted.path)
    expect((await presets.mount({}, 'minimal')).path).toBe(minimal.path)
    expect((await presets.resolve('standard')).path).toBe(standard.path)

    const all = flatten(rowsAt(await readFile(mounted.path, 'utf8')))
    expect(all.filter(row => row.id === 'tool-context-retrieve')).toHaveLength(1)
    expect(all.filter(row => row.id === 'compaction')).toHaveLength(1)
    expect(all.filter(row => row.id === 'compaction-basic')).toHaveLength(1)
    expect(all.filter(row => row.id === 'command-compact')).toHaveLength(1)
    expect(all.filter(row => row.id === 'tool-result-pruner')).toHaveLength(1)
    expect(all.find(row => row.id === 'tool-context-retrieve')?.name)
      .toBe('@deepseek-ai/dsh-tool-context-retrieve')
    expect(all.find(row => row.id === 'tool-result-pruner')?.name).toBe(MODULES.toolResultPruner)

    await installation.dispose()
    expect((await presets.mount({}, 'standard')).path).toBe(standard.path)
    await expect(access(dirname(mounted.path))).rejects.toThrow()
  })

  it('keeps direct concurrent resolve outside the operation-local overlay', async () => {
    const { root, standard } = await fixture()
    const presets = new FakeAgentPresets(new Map([['standard', standard]]))
    const installation = decorateAgentPresets(presets, { modules: MODULES, tempParent: root })

    const [mounted, resolved] = await Promise.all([
      presets.mount({}, 'standard'),
      presets.resolve('standard'),
    ])

    expect(mounted.path).not.toBe(standard.path)
    expect(resolved.path).toBe(standard.path)
    await installation.dispose()
  })

  it('uses owner-only files and starts a new generation after source content changes', async () => {
    const { root, standard } = await fixture()
    const presets = new FakeAgentPresets(new Map([['standard', standard]]))
    const installation = decorateAgentPresets(presets, { modules: MODULES, tempParent: root })

    const first = await presets.mount({}, 'standard')
    const same = await presets.mount({}, 'standard')
    expect(same.path).toBe(first.path)
    expect((await stat(dirname(first.path))).mode & 0o777).toBe(0o700)
    expect((await stat(first.path)).mode & 0o777).toBe(0o600)

    await writeFile(standard.path, `${await readFile(standard.path, 'utf8')}\n- id: later\n  name: '/opt/preset/later.js'\n`)
    const changed = await presets.mount({}, 'standard')
    expect(changed.path).not.toBe(first.path)
    expect(await readFile(changed.path, 'utf8')).toContain('id: later')

    await installation.dispose()
  })

  it('shares one decoration across duplicate Bundle and built-in loads', async () => {
    const { root, standard } = await fixture()
    const presets = new FakeAgentPresets(new Map([['standard', standard]]))
    const first = decorateAgentPresets(presets, { modules: MODULES, tempParent: root })
    const second = decorateAgentPresets(presets, { modules: MODULES, tempParent: root })

    const mounted = await presets.mount({}, 'standard')
    const all = flatten(rowsAt(await readFile(mounted.path, 'utf8')))
    expect(all.filter(row => row.id === 'compaction')).toHaveLength(1)
    expect(all.filter(row => row.id === 'tool-result-pruner')).toHaveLength(1)

    await first.dispose()
    expect((await presets.mount({}, 'standard')).path).toBe(mounted.path)

    await second.dispose()
    expect((await presets.mount({}, 'standard')).path).toBe(standard.path)
  })
})
