import { describe, expect, it } from 'vitest'
import {
  assessReusablePrefix,
  buildSafeCacheAuditRecord,
  fingerprintStablePrefix,
  validateCacheUsage,
  type StablePrefixEnvelope,
} from './support/cache-prefix-audit.js'

const parentEnvelope = (): StablePrefixEnvelope => ({
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  system: ['stable-system'],
  tools: [
    { name: 'alpha', description: 'first', parameters: { type: 'object' } },
    { name: 'beta', description: 'second', parameters: { type: 'object' } },
  ],
  messages: [
    { role: 'user', content: 'completed parent turn' },
    { role: 'assistant', content: 'completed response' },
  ],
})

describe('parent/child cache-prefix characterization', () => {
  it('accepts an identical fork prefix and computes the same fingerprint', () => {
    const parent = parentEnvelope()
    const child = structuredClone(parent)
    const result = assessReusablePrefix({ mode: 'fork', inheritsParentContext: true, parent, child })

    expect(result).toEqual({ eligible: true, reason: 'identical-fork-prefix' })
    expect(fingerprintStablePrefix(parent)).toBe(fingerprintStablePrefix(child))
    expect(fingerprintStablePrefix(parent)).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('rejects spawn because it does not inherit parent messages', () => {
    const parent = parentEnvelope()
    const result = assessReusablePrefix({
      mode: 'spawn',
      inheritsParentContext: false,
      parent,
      child: { ...structuredClone(parent), messages: [] },
    })

    expect(result).toEqual({ eligible: false, reason: 'spawn-does-not-inherit' })
  })

  it.each([
    ['system', (child: StablePrefixEnvelope) => { child.system = ['different-persona'] }],
    ['tools', (child: StablePrefixEnvelope) => { child.tools.reverse() }],
    ['provider', (child: StablePrefixEnvelope) => { child.provider = 'another-provider' }],
    ['model', (child: StablePrefixEnvelope) => { child.model = 'another-model' }],
    ['messages', (child: StablePrefixEnvelope) => { child.messages[0] = { role: 'user', content: 'different-history' } }],
  ])('rejects a %s mismatch', (_field, mutate) => {
    const parent = parentEnvelope()
    const child = structuredClone(parent)
    mutate(child)

    expect(assessReusablePrefix({ mode: 'fork', inheritsParentContext: true, parent, child })).toEqual({
      eligible: false,
      reason: 'stable-prefix-mismatch',
    })
  })

  it('emits only allowlisted evidence fields', () => {
    const secret = 'sk-do-not-record-this'
    const toolResult = 'private tool result'
    const record = buildSafeCacheAuditRecord({
      fingerprint: fingerprintStablePrefix(parentEnvelope()),
      estimatedSharedPrefixTokens: 128,
      parentSessionId: 'parent-id',
      childSessionId: 'child-id',
      mode: 'fork',
      eligible: true,
      reason: 'identical-fork-prefix',
      cacheReadTokens: 96,
      cacheMissTokens: 32,
      observedPromptTokens: 128,
    })
    const serialized = JSON.stringify(record)

    expect(Object.keys(record).sort()).toEqual([
      'auditVersion',
      'cacheMissTokens',
      'cacheReadTokens',
      'childSessionId',
      'confirmationStatus',
      'eligible',
      'estimatedSharedPrefixTokens',
      'fingerprint',
      'mode',
      'observedPromptTokens',
      'parentSessionId',
      'reason',
    ])
    expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain(toolResult)
    expect(record.confirmationStatus).toBe('confirmed')
  })

  it('validates official cache usage arithmetic', () => {
    expect(validateCacheUsage({ cacheReadTokens: 96, cacheMissTokens: 32, observedPromptTokens: 128 })).toBe(true)
    expect(validateCacheUsage({ cacheReadTokens: 95, cacheMissTokens: 32, observedPromptTokens: 128 })).toBe(false)
  })

  it('marks missing official cache fields as unconfirmed without inventing zeros', () => {
    const record = buildSafeCacheAuditRecord({
      fingerprint: fingerprintStablePrefix(parentEnvelope()),
      estimatedSharedPrefixTokens: 128,
      parentSessionId: 'parent-id',
      childSessionId: 'child-id',
      mode: 'fork',
      eligible: true,
      reason: 'identical-fork-prefix',
    })

    expect(record).toMatchObject({
      cacheReadTokens: null,
      cacheMissTokens: null,
      observedPromptTokens: null,
      confirmationStatus: 'unconfirmed',
    })
  })
})
