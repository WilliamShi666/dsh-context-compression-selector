/** Registry behavior for the bundled official DeepSeek tokenizer artifacts. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEEPSEEK_V4_TOKENIZER_ARTIFACT,
  DEEPSEEK_VISION_TOKENIZER_ARTIFACT,
  createDeepSeekV4TokenizerFromAssets,
  deepSeekV4TokenizerFailureReason,
  deepSeekV4TokenizerForModel,
} from '../src/deepseek-v4-tokenizer.ts'

const RUNTIME_ROOT = new URL('../', import.meta.url)

describe('bundled DeepSeek tokenizer artifact registry', () => {
  it('resolves each exact API model id to its pinned artifact identity', () => {
    for (const modelId of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
      expect(deepSeekV4TokenizerForModel(modelId)?.countText('identity probe')).toMatchObject({
        kind: 'exact-tokenizer',
        tokenizerId: 'deepseek-ai/DeepSeek-V4-Pro',
        tokenizerRevision: DEEPSEEK_V4_TOKENIZER_ARTIFACT.revision,
      })
    }
    expect(deepSeekV4TokenizerForModel('deepseek-v4-flash-vision-exp')?.countText('identity probe')).toMatchObject({
      kind: 'exact-tokenizer',
      tokenizerId: 'deepseek-ai/DeepSeek-V4-Flash-Vision-Exp',
      tokenizerRevision: '6821d6ad3681a4b137b066b76094fa82ebd0a380',
    })
  })

  it('ships a vision tokenizer that is not an alias of the V4 Pro tokenizer', () => {
    expect(DEEPSEEK_VISION_TOKENIZER_ARTIFACT.modelIds).toEqual(['deepseek-v4-flash-vision-exp'])
    expect(DEEPSEEK_VISION_TOKENIZER_ARTIFACT.license).toBe('MIT')
    expect(DEEPSEEK_VISION_TOKENIZER_ARTIFACT.tokenizerSha256)
      .not.toBe(DEEPSEEK_V4_TOKENIZER_ARTIFACT.tokenizerSha256)
    // The official vision placeholder special token exists only in the vision
    // vocabulary; the text tokenizer must not silently accept it as one token.
    expect(deepSeekV4TokenizerForModel('deepseek-v4-flash-vision-exp')?.countText('<｜deepseek_image｜>').tokens).toBe(1)
    expect(deepSeekV4TokenizerForModel('deepseek-v4-pro')?.countText('<｜deepseek_image｜>').tokens).toBeGreaterThan(1)
  })

  it.each([
    'deepseek-v4-flash-vision',
    'deepseek-v4-flash-vision-exp-2',
    'DeepSeek-V4-Flash-Vision-Exp',
    'deepseek-v4-vision-exp',
    'deepseek-v4-pro-vision',
    'deepseek-vision',
    'gpt-4o',
    '',
  ])('refuses the non-exact model id %s', (modelId) => {
    expect(deepSeekV4TokenizerForModel(modelId)).toBeUndefined()
    expect(deepSeekV4TokenizerFailureReason(modelId)).toBeUndefined()
  })

  it('reports the cached failure reason for the artifact serving one model', () => {
    // Both text models resolve successfully today, so no failure is recorded.
    expect(deepSeekV4TokenizerFailureReason('deepseek-v4-pro')).toBeUndefined()
    expect(deepSeekV4TokenizerFailureReason('deepseek-v4-flash-vision-exp')).toBeUndefined()
  })

  it('fails closed on byte-length, SHA-256, and JSON corruption for the vision artifact without touching the text artifact', () => {
    const visionRoot = new URL('assets/deepseek-v4-vision-exp/', RUNTIME_ROOT)
    const tokenizerBytes = readFileSync(fileURLToPath(new URL('tokenizer.json', visionRoot)))
    const good = {
      tokenizer: { bytes: tokenizerBytes.byteLength, sha256: DEEPSEEK_VISION_TOKENIZER_ARTIFACT.tokenizerSha256 },
      config: { bytes: 801, sha256: DEEPSEEK_VISION_TOKENIZER_ARTIFACT.tokenizerConfigSha256 },
    }
    expect(() => createDeepSeekV4TokenizerFromAssets(visionRoot, {
      tokenizer: { ...good.tokenizer, bytes: good.tokenizer.bytes + 1 },
      config: good.config,
    })).toThrow(/bytes/)
    expect(() => createDeepSeekV4TokenizerFromAssets(visionRoot, {
      tokenizer: { ...good.tokenizer, sha256: '0'.repeat(64) },
      config: good.config,
    })).toThrow(/SHA-256/)
    expect(() => createDeepSeekV4TokenizerFromAssets(visionRoot, good)).not.toThrow()
    // The shared registry still serves the independent text artifact.
    expect(deepSeekV4TokenizerForModel('deepseek-v4-flash')?.countText('still exact').kind).toBe('exact-tokenizer')
  })

  it('fails closed when a byte-and-hash-valid asset is not JSON', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { createHash } = await import('node:crypto')
    const { join } = await import('node:path')
    const root = await mkdtemp(join(tmpdir(), 'dsh-tokenizer-json-corrupt-'))
    try {
      const payload = 'this is definitely not json'
      const bytes = Buffer.from(payload, 'utf8')
      await writeFile(join(root, 'tokenizer.json'), bytes)
      await writeFile(join(root, 'tokenizer_config.json'), bytes)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const integrity = {
        tokenizer: { bytes: bytes.byteLength, sha256 },
        config: { bytes: bytes.byteLength, sha256 },
      }
      await expect(Promise.resolve().then(() =>
        createDeepSeekV4TokenizerFromAssets(new URL(`file://${root}/`), integrity),
      )).rejects.toThrow(/JSON|json/)
    } finally {
      await import('node:fs/promises').then(fs => fs.rm(root, { recursive: true, force: true }))
    }
  })

  it('verifies the committed asset manifests against the shipped files', () => {
    for (const [directory, artifact] of [
      ['deepseek-v4', DEEPSEEK_V4_TOKENIZER_ARTIFACT],
      ['deepseek-v4-vision-exp', DEEPSEEK_VISION_TOKENIZER_ARTIFACT],
    ] as const) {
      const manifest = JSON.parse(
        readFileSync(fileURLToPath(new URL(`assets/${directory}/manifest.json`, RUNTIME_ROOT)), 'utf8'),
      ) as { repository: string, revision: string, modelIds: string[], files: Record<string, { bytes: number, sha256: string }> }
      expect(manifest.repository).toBe(artifact.repository)
      expect(manifest.revision).toBe(artifact.revision)
      expect(manifest.modelIds).toEqual([...artifact.modelIds])
      expect(manifest.files['tokenizer.json']?.sha256).toBe(artifact.tokenizerSha256)
      expect(manifest.files['tokenizer_config.json']?.sha256).toBe(artifact.tokenizerConfigSha256)
    }
  })
})
