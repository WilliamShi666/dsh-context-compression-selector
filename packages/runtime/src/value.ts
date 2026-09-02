/** Version-neutral immutable-value and closed-union helpers for the plugin runtime. */

/**
 * Freeze an object graph in place without relying on a Harness utility export.
 * Live AbortSignals remain mutable so request cancellation continues to work.
 * @param value - Value to freeze recursively.
 * @returns The same deeply frozen value.
 */
export function deepFreeze<T>(value: T): T {
  const seen = new WeakSet<object>()
  const pending: Array<{ readonly kind: 'visit', readonly node: unknown } | {
    readonly kind: 'property'
    readonly source: Record<string, unknown>
    readonly key: string
  }> = [{ kind: 'visit', node: value }]
  while (pending.length > 0) {
    const task = pending.pop()
    /* v8 ignore next -- the loop condition guarantees one pending task. */
    if (task === undefined) continue
    if (task.kind === 'property') {
      pending.push({ kind: 'visit', node: task.source[task.key] })
      continue
    }
    const node = task.node
    if (node === null || typeof node !== 'object' || node instanceof AbortSignal || seen.has(node)) continue
    seen.add(node)
    Object.freeze(node)
    const keys = Object.keys(node)
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]
      /* v8 ignore next -- the loop is bounded by the captured key count. */
      if (key === undefined) continue
      pending.push({ kind: 'property', source: node as Record<string, unknown>, key })
    }
  }
  return value
}

/**
 * Throw for an impossible member of a closed discriminated union.
 * @param value - Value that escaped its closed union type.
 * @param context - Optional switch-site label.
 * @returns Never returns.
 */
export function assertNever(value: never, context?: string): never {
  const rendered = JSON.stringify(value) ?? String(value)
  throw new Error(`unreachable variant${context === undefined ? '' : ` in ${context}`}: ${rendered}`)
}
