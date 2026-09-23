/**
 * Direct tests for the single-identity guards inside `countSurfaceCounts`.
 *
 * These guards are unreachable through the public `measureForCompaction` path:
 * `countCanonicalImage` hard-codes the estimator identity to the module
 * constant, so one measurement can never observe two different identities. The
 * function is therefore exported with `@internal` (the same pattern as
 * `createDeepSeekV4TokenizerFromAssets` in `deepseek-v4-tokenizer.ts`) so the
 * guards can be driven directly, without widening the public API: `index.ts`
 * does not re-export it.
 */

import { describe, expect, it } from 'vitest'
import type { TokenCount } from '../src/token-count.ts'
import { countSurfaceCounts } from '../src/measurement.ts'

const SUBJECT = 'surface'

function exact(tokens: number, revision = 'rev-a'): TokenCount {
  return {
    kind: 'exact-tokenizer',
    tokens,
    tokenizerId: 'deepseek-ai/DeepSeek-V4.1-Flash',
    tokenizerRevision: revision,
  }
}

function estimate(tokens: number, revision = 'rev-a'): TokenCount {
  return {
    kind: 'tokenizer-estimate',
    tokens,
    upperBoundTokens: tokens + 1,
    estimatorId: 'deepseek-ai/DeepSeek-V4.1-Flash/image-token-estimate',
    estimatorRevision: revision,
  }
}

describe('countSurfaceCounts single-identity guards', () => {
  it('refuses a surface whose image estimator identity changed within one measurement', () => {
    const result = countSurfaceCounts([estimate(10, 'rev-a'), estimate(20, 'rev-b')], SUBJECT)
    expect(result.kind).toBe('unavailable')
    if (result.kind !== 'unavailable') throw new Error('expected unavailable')
    expect(result.reason).toContain('image estimator identity changed within one measurement')
  })

  it('refuses a surface whose tokenizer identity changed within one measurement', () => {
    const result = countSurfaceCounts([exact(10, 'rev-a'), exact(20, 'rev-b')], SUBJECT)
    expect(result.kind).toBe('unavailable')
    if (result.kind !== 'unavailable') throw new Error('expected unavailable')
    expect(result.reason).toContain('tokenizer identity changed within one measurement')
  })

  it('merges same-identity estimate nodes and sums both token fields', () => {
    const result = countSurfaceCounts([estimate(10, 'rev-a'), estimate(20, 'rev-a')], SUBJECT)
    expect(result).toMatchObject({
      kind: 'tokenizer-estimate',
      estimatorRevision: 'rev-a',
      tokens: 30,
      upperBoundTokens: 32,
    })
  })

  it('merges same-identity exact nodes into an exact surface', () => {
    const result = countSurfaceCounts([exact(10, 'rev-a'), exact(20, 'rev-a')], SUBJECT)
    expect(result).toMatchObject({
      kind: 'exact-tokenizer',
      tokenizerRevision: 'rev-a',
      tokens: 30,
    })
  })
})
