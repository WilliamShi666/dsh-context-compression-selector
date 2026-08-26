import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')

describe('standalone package contract', () => {
  it('keeps two packages and one install-facing dependency edge', () => {
    const selector = JSON.parse(readFileSync(resolve(root, 'selector/package.json'), 'utf8')) as {
      name: string
      dependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
      publishConfig?: { tag?: string }
    }
    const runtime = JSON.parse(readFileSync(resolve(root, 'runtime/package.json'), 'utf8')) as {
      name: string
      dependencies?: Record<string, string>
      publishConfig?: { tag?: string }
    }
    expect(selector.name).toBe('dsh-context-compression-selector')
    expect(runtime.name).toBe('dsh-context-compression-selector-runtime')
    expect(selector.dependencies?.['dsh-context-compression-selector-runtime']).toBe('0.1.0-beta.1')
    expect(runtime.dependencies?.['@huggingface/tokenizers']).toBe('0.1.3')
    expect(Object.keys(selector.peerDependencies ?? {})).not.toContain('@deepseek-ai/dsh-compaction-tool-result-pruner')
    expect(selector.peerDependencies?.['@deepseek-ai/dsh-compaction-basic'])
      .toBe('>=0.1.1-rc.2 <0.2.0')
    expect(selector.peerDependencies?.['@deepseek-ai/dsh-command-compact'])
      .toBe('>=0.1.1-rc.2 <0.2.0')
    expect(selector.publishConfig?.tag).toBe('beta')
    expect(runtime.publishConfig?.tag).toBe('beta')
  })

  it('uses the community package in the one Bundle patch', () => {
    const patch = readFileSync(resolve(root, 'selector/cordis.patch.yml'), 'utf8')
    expect(patch).toContain("name: 'dsh-context-compression-selector'")
    expect(patch).not.toContain('@deepseek-ai/dsh-client-ui-context-compression-selector')
  })
})
