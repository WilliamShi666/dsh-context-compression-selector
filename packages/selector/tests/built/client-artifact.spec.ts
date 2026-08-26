import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { describe, expect, it } from 'vitest'

const artifact = resolve(import.meta.dirname, '../../lib/client.js')

describe('built Harness client artifact', () => {
  it('registers a self-contained lazy-CJS factory and injects its CSS', () => {
    const code = readFileSync(artifact, 'utf8')
    let registration: { id: string, factory: (require: (id: string) => unknown) => unknown } | undefined
    const moduleLoader = {
      load(value: typeof registration) {
        registration = value
      },
    }
    Object.defineProperty(window, '__ModuleLoader__', { configurable: true, value: moduleLoader })

    expect(() => Function(code)()).not.toThrow()
    expect(registration?.id).toBe('dsh-context-compression-selector')

    const modules = new Map<string, unknown>([
      ['react', React],
      ['react/jsx-runtime', jsxRuntime],
      // The current selector only keeps this official package as a side-effect
      // external. A minimal public-module stub proves the artifact asks the
      // Harness loader for it without importing the package's raw CSS in Node.
      ['@deepseek-ai/dsh-client-ui-primitives', {}],
    ])
    const exported = registration?.factory((id) => {
      if (!modules.has(id)) throw new Error(`unexpected client dependency: ${id}`)
      return modules.get(id)
    }) as { apply?: unknown, inject?: unknown }

    expect(exported.apply).toBeTypeOf('function')
    expect(exported.inject).toEqual(['slots', 'locale', 'settingsScope'])
    const style = document.querySelector<HTMLStyleElement>(
      'style[data-plugin-css="dsh-context-compression-selector/CompressionProfileSelector.module.css"]',
    )
    expect(style?.dataset.plugin).toBe('dsh-context-compression-selector')
    expect(style?.textContent).toContain('profileGrid')
    expect(document.querySelectorAll('style[data-plugin-css]').length).toBe(1)

    registration?.factory((id) => modules.get(id))
    expect(document.querySelectorAll('style[data-plugin-css]').length).toBe(1)
    expect(code).not.toMatch(/^\s*(?:import|export)\s/mu)
    expect(code).not.toMatch(/(?:\/home\/|[A-Za-z]:\\Users\\)/u)
    expect(code).not.toContain('sourceMappingURL')
  })
})
