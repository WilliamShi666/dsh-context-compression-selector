/** Node loader equivalence against Hugging Face Python tokenizer golden counts. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { deepSeekV4TokenizerForModel } from '../src/deepseek-v4-tokenizer.ts'

interface GoldenTokenizerCase {
  readonly label: string
  readonly text: string
  readonly counts: Readonly<Record<string, number>>
}

interface GoldenFixture {
  readonly generator: string
  readonly revision: string
  readonly tokenizers: Readonly<Record<string, string>>
  readonly cases: readonly GoldenTokenizerCase[]
}

const fixture = JSON.parse(readFileSync(
  fileURLToPath(new URL('fixtures/tokenizer-golden.json', import.meta.url)),
  'utf8',
)) as GoldenFixture

const MODEL_BY_TOKENIZER: Readonly<Record<string, string>> = {
  'deepseek-ai/DeepSeek-V4-Pro': 'deepseek-v4-pro',
  'deepseek-ai/DeepSeek-V4.1-Flash': 'deepseek-flash',
}

describe('bundled tokenizers match Hugging Face Python golden counts', () => {
  it('carries cases for both pinned artifacts with distinct vocabularies', () => {
    expect(Object.keys(fixture.tokenizers).sort()).toEqual(Object.keys(MODEL_BY_TOKENIZER).sort())
    expect(Object.keys(fixture.tokenizers).sort())
      .toEqual(['deepseek-ai/DeepSeek-V4-Pro', 'deepseek-ai/DeepSeek-V4.1-Flash'].sort())
    // At least one case must prove the vocabularies differ (vision-only special token).
    const imageCase = fixture.cases.find(entry => entry.text.includes('deepseek_image'))
    expect(imageCase).toBeDefined()
    expect(imageCase?.counts['deepseek-ai/DeepSeek-V4-Pro'])
      .not.toBe(imageCase?.counts['deepseek-ai/DeepSeek-V4.1-Flash'])
    // Frozen values: the V4.1 vocabulary knows the vision placeholder as one token.
    expect(imageCase?.counts['deepseek-ai/DeepSeek-V4.1-Flash']).toBe(3)
    expect(imageCase?.counts['deepseek-ai/DeepSeek-V4-Pro']).toBe(9)
  })

  it('pins the V4.1-Flash revision in the fixture', () => {
    expect(fixture.tokenizers['deepseek-ai/DeepSeek-V4.1-Flash'])
      .toBe('dba1be0a40aa45a94ad051997016db3960a90277')
  })

  it.each(fixture.cases)('counts "$label" identically in every tokenizer', (entry) => {
    for (const [repository, expected] of Object.entries(entry.counts)) {
      const modelId = MODEL_BY_TOKENIZER[repository]
      if (modelId === undefined) throw new Error(`golden fixture cites unknown tokenizer ${repository}`)
      const count = deepSeekV4TokenizerForModel(modelId)?.countText(entry.text)
      expect(count, `${repository} must resolve for ${modelId}`).toMatchObject({
        kind: 'exact-tokenizer',
        tokenizerId: repository,
      })
      expect(count?.tokens).toBe(expected)
    }
  })
})
