import { describe, expect, it } from 'vitest'
import { assertNever, deepFreeze } from '../src/value.ts'

describe('version-neutral runtime values', () => {
  it('freezes nested and cyclic data without freezing a live AbortSignal', () => {
    const controller = new AbortController()
    const value: { nested: { value: number }, self?: unknown, signal: AbortSignal } = {
      nested: { value: 1 },
      signal: controller.signal,
    }
    value.self = value

    expect(deepFreeze(value)).toBe(value)
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.nested)).toBe(true)
    expect(Object.isFrozen(controller.signal)).toBe(false)
  })

  it('reports an escaped closed-union member with its switch context', () => {
    expect(() => assertNever({ kind: 'unexpected' } as never, 'value test'))
      .toThrow('unreachable variant in value test: {"kind":"unexpected"}')
  })
})
