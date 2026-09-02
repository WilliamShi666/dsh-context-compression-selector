import { describe, expect, it, vi } from 'vitest'
import {
  COMPRESSION_AUDIT_PREFIX,
  emitCompressionAudit,
  formatCompressionAudit,
} from '../src/audit.ts'
import type { CompressionAuditRecord } from '../src/audit.ts'

const custom = {
  version: 3 as const,
  unit: 'tokens' as const,
  fresh: { enabled: true, trigger: 8_192, target: 3_072 },
  aggregate: { enabled: true, trigger: 32_768, target: 12_288 },
  history: {
    enabled: true,
    trigger: 500_000,
    keepRecentToolCalls: 10,
    keepRecentTokens: 64_000,
    minReclaim: 96_000,
  },
  prefixPolicy: 'pressure-break' as const,
  tailTrim: { enabled: true, trigger: 700_000 },
}

describe('context-compression audit records', () => {
  it('formats one complete frozen-policy record without model-visible content', () => {
    const record: CompressionAuditRecord = {
      schemaVersion: 1,
      kind: 'policy-frozen',
      sessionId: 'audit-session',
      settingsSource: 'host-settings',
      settings: { profile: 'custom', custom, autoCompact: { thresholdPercent: 80 } },
      deploymentConfig: {
        profile: 'balanced',
        headChars: 4_096,
        tailChars: 1_024,
      },
    }

    const line = formatCompressionAudit(record)

    expect(line).toBe(`${COMPRESSION_AUDIT_PREFIX}${JSON.stringify(record)}`)
    expect(JSON.parse(line.slice(COMPRESSION_AUDIT_PREFIX.length))).toEqual(record)
    expect(line).not.toContain('prompt')
    expect(line).not.toContain('toolArguments')
    expect(line).not.toContain('toolResult')
    expect(line).not.toContain('apiKey')
  })

  it('keeps component provenance and exact token arithmetic on rewrite records', () => {
    const record: CompressionAuditRecord = {
      schemaVersion: 1,
      kind: 'rewrite',
      sessionId: 'history-session',
      profile: 'cache-strict',
      component: 'history',
      stage: 'pressure',
      reducer: 'historical-tool-result-aging',
      historyMode: 'capacity-pressure',
      manifestEventType: 'compaction/prune',
      manifestSeq: 41,
      replacementSeq: 42,
      sourceSeqs: [12],
      tokensBefore: 600_100,
      tokensAfter: 100,
      tokensRemoved: 600_000,
      tokenizerId: 'mock-tokenizer',
      tokenizerRevision: 'r1',
    }

    const parsed = JSON.parse(
      formatCompressionAudit(record).slice(COMPRESSION_AUDIT_PREFIX.length),
    ) as CompressionAuditRecord

    expect(parsed).toEqual(record)
    expect(parsed.kind === 'rewrite' && parsed.tokensRemoved)
      .toBe(record.tokensBefore - record.tokensAfter)
  })

  it('publishes exactly one single-line info message', () => {
    const info = vi.fn()
    const record: CompressionAuditRecord = {
      schemaVersion: 1,
      kind: 'native-auto-compact',
      sessionId: 'native-session',
      manifestEventType: 'compaction/summary',
      manifestSeq: 9,
      reducer: 'llm-summary',
      provider: 'mock',
      model: 'mock',
      tokensBefore: 1_024,
      tokensAfter: null,
    }

    emitCompressionAudit({ info }, record)

    expect(info).toHaveBeenCalledOnce()
    expect(info).toHaveBeenCalledWith(formatCompressionAudit(record))
    expect(String(info.mock.calls[0]?.[0])).not.toContain('\n')
  })

  it('does not let logger failure roll back an already committed rewrite', () => {
    const record: CompressionAuditRecord = {
      schemaVersion: 1,
      kind: 'native-auto-compact',
      sessionId: 'native-session',
      manifestEventType: 'compaction/summary',
      manifestSeq: 9,
      reducer: 'llm-summary',
      provider: 'mock',
      model: 'mock',
      tokensBefore: 1_024,
      tokensAfter: null,
    }

    expect(() => {
      emitCompressionAudit({
        info: () => {
          throw new Error('logger unavailable')
        },
      }, record)
    }).not.toThrow()
  })
})
