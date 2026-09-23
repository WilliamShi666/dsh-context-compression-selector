/** Full-sweep equivalence between the Node vision arithmetic and the official Python implementation. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEEPSEEK_VISION_PROJECTION,
  deepSeekVisionImageBlockTokens,
  deepSeekVisionImageGrid,
  estimateDeepSeekVisionImageTokens,
} from '../src/deepseek-v4-vision-tokens.ts'

interface SweepCase {
  readonly width: number
  readonly height: number
  readonly nLlmH: number
  readonly nLlmW: number
  readonly tokens: number
}

interface SweepFixture {
  readonly source: { readonly repository: string, readonly revision: string, readonly imageProcessorSha256: string }
  readonly parameters: Readonly<Record<string, number | null>>
  readonly totals: { readonly cases: number, readonly maxTokens: number }
  readonly cases: readonly SweepCase[]
}

const sweep = JSON.parse(readFileSync(
  fileURLToPath(new URL('fixtures/vision-official-sweep.json', import.meta.url)),
  'utf8',
)) as SweepFixture

/** Stream offsets used to assert position independence on every swept size. */
const POSITIONS = [0, 1, 2, 3, 7, 17, 64, 383, 1024]

describe('Node vision arithmetic matches the official Python sweep case-by-case', () => {
  it('pins the official source revision and parameter set', () => {
    expect(sweep.source.repository).toBe('deepseek-ai/DeepSeek-V4.1-Flash')
    expect(sweep.source.revision).toBe(DEEPSEEK_VISION_PROJECTION.sourceRevision)
    expect(sweep.parameters.visionPatchSize).toBe(DEEPSEEK_VISION_PROJECTION.visionPatchSize)
    expect(sweep.parameters.visionDownsampleRatio).toBe(DEEPSEEK_VISION_PROJECTION.visionDownsampleRatio)
    expect(sweep.parameters.visionMaxNTokens).toBe(DEEPSEEK_VISION_PROJECTION.visionMaxNTokens)
    expect(sweep.parameters.visionMinPixels).toBe(DEEPSEEK_VISION_PROJECTION.visionMinPixels)
    expect(sweep.parameters.visionMaxWhRatio).toBeNull()
    expect(sweep.cases).toHaveLength(sweep.totals.cases)
  })

  it.each(sweep.cases)('reproduces the official grid for $width×$height', (entry) => {
    const grid = deepSeekVisionImageGrid(entry.width, entry.height)
    expect(grid).toMatchObject({ nLlmH: entry.nLlmH, nLlmW: entry.nLlmW })
    const tokens = deepSeekVisionImageBlockTokens(grid.nLlmH, grid.nLlmW, 0)
    expect(tokens).toBe(entry.tokens)
    // The official block length is the whole V4.1 block; it never exceeds the cap.
    expect(tokens).toBeLessThanOrEqual(DEEPSEEK_VISION_PROJECTION.visionMaxNTokens)
    expect(tokens).toBe(entry.nLlmH * (entry.nLlmW + 1) + 2)
  })

  it('never exceeds the 1024-token cap and peaks at the official maximum', () => {
    const counts = sweep.cases.map((entry) => {
      const grid = deepSeekVisionImageGrid(entry.width, entry.height)
      return deepSeekVisionImageBlockTokens(grid.nLlmH, grid.nLlmW, 0)
    })
    expect(Math.max(...counts)).toBeLessThanOrEqual(DEEPSEEK_VISION_PROJECTION.visionMaxNTokens)
    expect(Math.max(...counts)).toBe(sweep.totals.maxTokens)
    expect(sweep.totals.maxTokens).toBe(1017)
  })

  it('stays position-independent on every swept size', () => {
    for (const entry of sweep.cases) {
      const grid = deepSeekVisionImageGrid(entry.width, entry.height)
      for (const position of POSITIONS) {
        expect(deepSeekVisionImageBlockTokens(grid.nLlmH, grid.nLlmW, position)).toBe(entry.tokens)
      }
    }
  })

  it('reports an intrinsic-grid estimate equal to the official block length', () => {
    for (const entry of sweep.cases) {
      const estimate = estimateDeepSeekVisionImageTokens(entry.width, entry.height)
      expect(estimate.source).toBe('intrinsic-grid')
      expect(estimate.tokens).toBe(entry.tokens)
      expect(estimate.paddingMinimumTokens).toBe(entry.tokens)
      expect(estimate.paddingMaximumTokens).toBe(entry.tokens)
      expect(estimate.upperBoundTokens).toBe(DEEPSEEK_VISION_PROJECTION.visionMaxNTokens)
    }
  })

  it('returns a bounded grid instead of throwing on extreme aspect ratios the official PIL path rejects', () => {
    // The official `load_image` raises inside PIL for pathological inputs such
    // as 100000x1 (after the resize step), so those sizes cannot appear in the
    // official sweep. The port has no such failure mode and must stay bounded.
    for (const [width, height] of [[100_000, 1], [1, 100_000], [50_000, 1], [1, 1]] as const) {
      const grid = deepSeekVisionImageGrid(width, height)
      const tokens = deepSeekVisionImageBlockTokens(grid.nLlmH, grid.nLlmW, 0)
      expect(Number.isSafeInteger(tokens)).toBe(true)
      expect(tokens).toBeGreaterThan(0)
      expect(tokens).toBeLessThanOrEqual(DEEPSEEK_VISION_PROJECTION.visionMaxNTokens)
    }
  })
})
