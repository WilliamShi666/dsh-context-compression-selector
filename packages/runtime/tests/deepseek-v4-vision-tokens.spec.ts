/** Node vision-token arithmetic against the official DeepSeek V4.1-Flash reference fixture. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEEPSEEK_VISION_DEFAULT_IMAGE_TOKENS,
  DEEPSEEK_VISION_IMAGE_ESTIMATOR,
  DEEPSEEK_VISION_PROJECTION,
  deepSeekVisionImageBlockTokens,
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
  readonly parameters: Readonly<Record<string, number | null>>
  readonly singleImages: readonly { width: number, height: number, nLlmH: number, nLlmW: number, tokensAtStart0: number }[]
  readonly startPositions: readonly GoldenEntry[]
  readonly sequences: readonly { entries: readonly GoldenEntry[] }[]
}

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL('fixtures/vision-golden.json', import.meta.url)),
  'utf8',
)) as GoldenFixture

const V41_FLASH_REVISION = 'dba1be0a40aa45a94ad051997016db3960a90277'
const START_POSITIONS = [0, 1, 2, 3, 4, 5, 7, 8, 17, 64, 101, 383, 384, 766, 767]

describe('DeepSeek vision token arithmetic matches the official V4.1-Flash reference', () => {
  it('pins the V4.1-Flash projection parameters and revision', () => {
    expect(DEEPSEEK_VISION_PROJECTION.sourceRepository).toBe(fixture.source.repository)
    expect(DEEPSEEK_VISION_PROJECTION.sourceRevision).toBe(fixture.source.revision)
    expect(DEEPSEEK_VISION_PROJECTION.sourceRepository).toBe('deepseek-ai/DeepSeek-V4.1-Flash')
    expect(DEEPSEEK_VISION_PROJECTION.sourceRevision).toBe(V41_FLASH_REVISION)
    expect(DEEPSEEK_VISION_PROJECTION.visionPatchSize).toBe(fixture.parameters.visionPatchSize)
    expect(DEEPSEEK_VISION_PROJECTION.visionDownsampleRatio).toBe(fixture.parameters.visionDownsampleRatio)
    expect(DEEPSEEK_VISION_PROJECTION.visionMaxNTokens).toBe(fixture.parameters.visionMaxNTokens)
    expect(DEEPSEEK_VISION_PROJECTION.visionMinPixels).toBe(fixture.parameters.visionMinPixels)
    expect(DEEPSEEK_VISION_PROJECTION.visionPatchSize).toBe(14)
    expect(DEEPSEEK_VISION_PROJECTION.visionDownsampleRatio).toBe(3)
    expect(DEEPSEEK_VISION_PROJECTION.visionMaxNTokens).toBe(1024)
    expect(DEEPSEEK_VISION_PROJECTION.visionMinPixels).toBe(295_936)
    // The official config pins vision_max_wh_ratio to JSON null; the TS field is
    // `undefined` so the aspect-clamp branch can never become a tautology.
    expect(DEEPSEEK_VISION_PROJECTION.visionMaxWhRatio).toBeUndefined()
    expect(DEEPSEEK_VISION_PROJECTION.visionMaxWhRatio ?? null).toBe(fixture.parameters.visionMaxWhRatio)
    expect(fixture.parameters.visionMaxWhRatio).toBeNull()
  })

  it.each(fixture.singleImages)('matches the regenerated golden grid for $width×$height', (entry) => {
    const grid = deepSeekVisionImageGrid(entry.width, entry.height)
    expect(grid).toMatchObject({ nLlmH: entry.nLlmH, nLlmW: entry.nLlmW })
    expect(deepSeekVisionImageTokens(entry.width, entry.height, 0)).toBe(entry.tokensAtStart0)
  })

  it('makes startTokenPos inert under V4.1', () => {
    for (const position of START_POSITIONS) {
      expect(deepSeekVisionImageTokens(800, 600, position)).toBe(317)
    }
    for (const position of START_POSITIONS) {
      expect(deepSeekVisionImageTokens(640, 480, position)).toBe(206)
    }
  })

  it('uses the official position-independent block formula', () => {
    for (const position of [0, 1, 2, 3]) {
      expect(deepSeekVisionImageBlockTokens(15, 20, position)).toBe(15 * (20 + 1) + 2)
      expect(deepSeekVisionImageBlockTokens(15, 20, position)).toBe(317)
    }
    for (const [nLlmH, nLlmW] of [[1, 1], [2, 130], [13, 13], [31, 31]] as const) {
      expect(deepSeekVisionImageBlockTokens(nLlmH, nLlmW, 0))
        .toBe(deepSeekVisionImageBlockTokens(nLlmH, nLlmW, 7))
      expect(deepSeekVisionImageBlockTokens(nLlmH, nLlmW, 0)).toBe(nLlmH * (nLlmW + 1) + 2)
    }
  })

  it('reports the golden start-position sweep as position-independent', () => {
    for (const entry of fixture.startPositions) {
      const grid = deepSeekVisionImageGrid(entry.width, entry.height)
      expect(grid.nLlmH).toBe(entry.nLlmH)
      expect(grid.nLlmW).toBe(entry.nLlmW)
      expect(deepSeekVisionImageTokens(entry.width, entry.height, entry.startTokenPos)).toBe(entry.tokens)
    }
    expect(new Set(fixture.startPositions.map(entry => entry.tokens)).size).toBe(1)
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
    expect(DEEPSEEK_VISION_PROJECTION.requestImagePixelBudget).toBe(640_000)
    expect(isWithinDeepSeekRequestPixelBudget(640, 480)).toBe(true)
    expect(isWithinDeepSeekRequestPixelBudget(800, 800)).toBe(true) // 640000 exactly
    expect(isWithinDeepSeekRequestPixelBudget(801, 800)).toBe(false) // one pixel over
    expect(isWithinDeepSeekRequestPixelBudget(4096, 4096)).toBe(false)
  })

  it('reports equal padding bounds at the intrinsic grid', () => {
    expect(estimateDeepSeekVisionImageTokens(512, 512)).toEqual({
      tokens: 184,
      upperBoundTokens: 1024,
      source: 'intrinsic-grid',
      paddingMinimumTokens: 184,
      paddingMaximumTokens: 184,
    })
    // The block length is position-independent, so every residue agrees.
    const counts = START_POSITIONS.map(position => deepSeekVisionImageTokens(512, 512, position))
    expect(new Set(counts).size).toBe(1)
    expect(counts[0]).toBe(184)
  })

  it('keeps the estimate within ten percent of every residue', () => {
    for (const entry of fixture.singleImages) {
      const estimate = estimateDeepSeekVisionImageTokens(entry.width, entry.height)
      expect(estimate.source).toBe('intrinsic-grid')
      expect(estimate.paddingMinimumTokens).toBe(estimate.paddingMaximumTokens)
      expect(estimate.tokens).toBe(estimate.paddingMinimumTokens)
      for (const position of [0, 1, 2, 3]) {
        const actual = deepSeekVisionImageTokens(entry.width, entry.height, position)
        expect(Math.abs(estimate.tokens - actual) / actual).toBeLessThan(0.1)
      }
    }
  })

  it('shrinks a 4000x3000 image under the 1024-token cap', () => {
    expect(deepSeekVisionImageGrid(4000, 3000)).toMatchObject({ nLlmH: 27, nLlmW: 36 })
    expect(deepSeekVisionImageTokens(4000, 3000, 0)).toBe(1001)
    expect(deepSeekVisionImageTokens(4000, 3000, 0)).toBeLessThanOrEqual(1024)
  })

  it('upscales a tiny image to the 295936-pixel floor', () => {
    expect(deepSeekVisionImageGrid(14, 14)).toMatchObject({ nLlmH: 13, nLlmW: 13 })
    expect(deepSeekVisionImageTokens(14, 14, 0)).toBe(184)
  })

  it('never exceeds the 1024-token cap on any golden size', () => {
    for (const entry of fixture.singleImages) {
      expect(entry.tokensAtStart0).toBeLessThanOrEqual(1024)
    }
    expect(Math.max(...fixture.singleImages.map(entry => entry.tokensAtStart0))).toBe(1001)
  })

  it('pins the V4.1 estimator identity', () => {
    expect(DEEPSEEK_VISION_IMAGE_ESTIMATOR.id).toBe('deepseek-ai/DeepSeek-V4.1-Flash/image-token-estimate')
    expect(DEEPSEEK_VISION_IMAGE_ESTIMATOR.revision).toBe(`${V41_FLASH_REVISION}:v1`)
    expect(DEEPSEEK_VISION_IMAGE_ESTIMATOR.revision).toContain(fixture.source.revision)
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
    expect(DEEPSEEK_VISION_DEFAULT_IMAGE_TOKENS).toBe(256)
    expect(estimateDeepSeekVisionImageTokens(width, height)).not.toHaveProperty('paddingMinimumTokens')
    expect(estimateDeepSeekVisionImageTokens(width, height)).not.toHaveProperty('paddingMaximumTokens')
  })
})
