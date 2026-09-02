/** Node vision-token arithmetic against the official DeepSeek reference fixtures. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEEPSEEK_VISION_DEFAULT_IMAGE_TOKENS,
  DEEPSEEK_VISION_IMAGE_ESTIMATOR,
  DEEPSEEK_VISION_PROJECTION,
  deepSeekVisionImageGrid,
  deepSeekVisionImageTokens,
  estimateDeepSeekVisionImageTokens,
  isWithinDeepSeekRequestPixelBudget,
} from '../src/deepseek-v4-vision-tokens.ts'

interface GoldenEntry {
  readonly width: number
  readonly height: number
  readonly startTokenPos: number
  readonly nLlmH: number
  readonly nLlmW: number
  readonly tokens: number
}

interface GoldenFixture {
  readonly source: { readonly repository: string, readonly revision: string }
  readonly parameters: Readonly<Record<string, number>>
  readonly singleImages: readonly { width: number, height: number, nLlmH: number, nLlmW: number, tokensAtStart0: number }[]
  readonly startPositions: readonly GoldenEntry[]
  readonly sequences: readonly { entries: readonly GoldenEntry[] }[]
}

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL('fixtures/vision-golden.json', import.meta.url)),
  'utf8',
)) as GoldenFixture

describe('DeepSeek vision token arithmetic matches the official reference', () => {
  it('pins the official projection parameters and revision', () => {
    expect(DEEPSEEK_VISION_PROJECTION.sourceRepository).toBe(fixture.source.repository)
    expect(DEEPSEEK_VISION_PROJECTION.sourceRevision).toBe(fixture.source.revision)
    expect(DEEPSEEK_VISION_PROJECTION.visionPatchSize).toBe(fixture.parameters.visionPatchSize)
    expect(DEEPSEEK_VISION_PROJECTION.visionDownsampleRatio).toBe(fixture.parameters.visionDownsampleRatio)
    expect(DEEPSEEK_VISION_PROJECTION.visionMaxNTokens).toBe(fixture.parameters.visionMaxNTokens)
    expect(DEEPSEEK_VISION_PROJECTION.visionMinPixels).toBe(fixture.parameters.visionMinPixels)
    expect(DEEPSEEK_VISION_PROJECTION.visionMaxWhRatio).toBe(fixture.parameters.visionMaxWhRatio)
  })

  it.each(fixture.singleImages)('expands $width×$height to the official grid', (entry) => {
    const grid = deepSeekVisionImageGrid(entry.width, entry.height)
    expect(grid).toMatchObject({ nLlmH: entry.nLlmH, nLlmW: entry.nLlmW })
    expect(deepSeekVisionImageTokens(entry.width, entry.height, 0)).toBe(entry.tokensAtStart0)
  })

  it.each(fixture.startPositions)('aligns 640×480 at start $startTokenPos to $tokens tokens', (entry) => {
    const grid = deepSeekVisionImageGrid(entry.width, entry.height)
    expect(grid.nLlmH).toBe(entry.nLlmH)
    expect(grid.nLlmW).toBe(entry.nLlmW)
    expect(deepSeekVisionImageTokens(entry.width, entry.height, entry.startTokenPos)).toBe(entry.tokens)
  })

  it('reproduces multi-image sequences with accumulated start positions', () => {
    for (const sequence of fixture.sequences) {
      let position = sequence.entries[0]?.startTokenPos ?? 0
      for (const entry of sequence.entries) {
        expect(position).toBe(entry.startTokenPos)
        const grid = deepSeekVisionImageGrid(entry.width, entry.height)
        expect(grid.nLlmH).toBe(entry.nLlmH)
        expect(grid.nLlmW).toBe(entry.nLlmW)
        const tokens = deepSeekVisionImageTokens(entry.width, entry.height, position)
        expect(tokens).toBe(entry.tokens)
        position += tokens
      }
    }
  })

  it('reports the adapter default request pixel-budget boundary', () => {
    expect(isWithinDeepSeekRequestPixelBudget(640, 480)).toBe(true)
    expect(isWithinDeepSeekRequestPixelBudget(800, 800)).toBe(true) // 640000 exactly
    expect(isWithinDeepSeekRequestPixelBudget(801, 800)).toBe(false) // one pixel over
    expect(isWithinDeepSeekRequestPixelBudget(4096, 4096)).toBe(false)
  })

  it('estimates valid images at the midpoint of all alignment residues', () => {
    const estimate = estimateDeepSeekVisionImageTokens(512, 512)
    const counts = [0, 1, 2, 3].map(position => deepSeekVisionImageTokens(512, 512, position))
    expect(estimate).toEqual({
      tokens: Math.round((Math.min(...counts) + Math.max(...counts)) / 2),
      upperBoundTokens: DEEPSEEK_VISION_PROJECTION.visionMaxNTokens,
      source: 'intrinsic-grid',
      paddingMinimumTokens: Math.min(...counts),
      paddingMaximumTokens: Math.max(...counts),
    })
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(3)
    expect(DEEPSEEK_VISION_IMAGE_ESTIMATOR.revision).toContain(fixture.source.revision)
  })

  it('keeps alignment-only estimation error below ten percent across the official fixture sizes', () => {
    for (const entry of fixture.singleImages) {
      const estimate = estimateDeepSeekVisionImageTokens(entry.width, entry.height)
      expect(estimate.source).toBe('intrinsic-grid')
      for (let position = 0; position < 4; position += 1) {
        const actual = deepSeekVisionImageTokens(entry.width, entry.height, position)
        expect(Math.abs(estimate.tokens - actual) / actual).toBeLessThan(0.1)
      }
    }
  })

  it.each([
    [0, 480],
    [640.5, 480],
    [Number.NaN, 480],
    [Number.POSITIVE_INFINITY, 480],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  ])('uses the fixed fallback for unusable metadata %s×%s', (width, height) => {
    expect(estimateDeepSeekVisionImageTokens(width, height)).toEqual({
      tokens: DEEPSEEK_VISION_DEFAULT_IMAGE_TOKENS,
      upperBoundTokens: DEEPSEEK_VISION_PROJECTION.visionMaxNTokens,
      source: 'default',
    })
  })
})
