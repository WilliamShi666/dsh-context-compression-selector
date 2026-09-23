/** Registry behavior for the bundled official DeepSeek tokenizer artifacts. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEEPSEEK_V4_TOKENIZER_ARTIFACT,
  DEEPSEEK_V41_FLASH_TOKENIZER_ARTIFACT,
  createDeepSeekV4TokenizerFromAssets,
  deepSeekTokenizerArtifacts,
  deepSeekV4TokenizerFailureReason,
  deepSeekV4TokenizerForModel,
} from '../src/deepseek-v4-tokenizer.ts'

const RUNTIME_ROOT = new URL('../', import.meta.url)

const V41_FLASH_REPOSITORY = 'deepseek-ai/DeepSeek-V4.1-Flash'
const V41_FLASH_REVISION = 'dba1be0a40aa45a94ad051997016db3960a90277'
const V41_FLASH_MODEL_IDS = ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'] as const
const V4_PRO_REPOSITORY = 'deepseek-ai/DeepSeek-V4-Pro'
const V4_PRO_REVISION = '0e1a0e5e52aea73055f50fef6f2423db370265b6'

describe('bundled DeepSeek tokenizer artifact registry', () => {
  it('resolves deepseek-flash to the pinned V4.1-Flash artifact', () => {
    expect(deepSeekV4TokenizerForModel('deepseek-flash')?.countText('identity probe')).toMatchObject({
      kind: 'exact-tokenizer',
      tokenizerId: V41_FLASH_REPOSITORY,
      tokenizerRevision: V41_FLASH_REVISION,
    })
  })

  it('routes every V4.1-Flash alias to the same artifact identity', () => {
    for (const modelId of V41_FLASH_MODEL_IDS) {
      expect(deepSeekV4TokenizerForModel(modelId)?.countText('identity probe')).toMatchObject({
        kind: 'exact-tokenizer',
        tokenizerId: V41_FLASH_REPOSITORY,
        tokenizerRevision: V41_FLASH_REVISION,
      })
    }
  })

  it('keeps deepseek-v4-pro on the V4-Pro artifact', () => {
    expect(deepSeekV4TokenizerForModel('deepseek-v4-pro')?.countText('identity probe')).toMatchObject({
      kind: 'exact-tokenizer',
      tokenizerId: V4_PRO_REPOSITORY,
      tokenizerRevision: V4_PRO_REVISION,
    })
  })

  it('shares one tokenizer instance across every V4.1-Flash alias', () => {
    const [first, ...rest] = V41_FLASH_MODEL_IDS.map(modelId => deepSeekV4TokenizerForModel(modelId))
    expect(first).toBeDefined()
    for (const tokenizer of rest) expect(tokenizer).toBe(first)
  })

  it('pins the exact modelIds of both artifacts', () => {
    expect(DEEPSEEK_V41_FLASH_TOKENIZER_ARTIFACT.modelIds).toEqual([...V41_FLASH_MODEL_IDS])
    expect(DEEPSEEK_V4_TOKENIZER_ARTIFACT.modelIds).toEqual(['deepseek-v4-pro'])
  })

  it('pins the V4.1-Flash artifact provenance', () => {
    expect(DEEPSEEK_V41_FLASH_TOKENIZER_ARTIFACT).toMatchObject({
      repository: V41_FLASH_REPOSITORY,
      revision: V41_FLASH_REVISION,
      license: 'MIT',
      tokenizerSha256: 'c90dfa01249db1be4245780a052ede752e1361c612ac6d08e2bdada7d599476b',
      tokenizerConfigSha256: '6ac8c8dc065ed118161d02dd532749ae3f52c243deac27872134fae2f50d8547',
    })
  })

  it('does not collapse the V4.1 vocabulary onto the V4-Pro vocabulary', () => {
    const flash = deepSeekV4TokenizerForModel('deepseek-flash')?.countText('<｜deepseek_image｜>').tokens
    const pro = deepSeekV4TokenizerForModel('deepseek-v4-pro')?.countText('<｜deepseek_image｜>').tokens
    expect(flash).toBe(1)
    expect(pro).toBe(7)
    expect(pro).toBeGreaterThan(1)
  })

  it('does not collapse the V4-Pro placeholder onto the V4.1 vocabulary', () => {
    expect(deepSeekV4TokenizerForModel('deepseek-flash')?.countText('<｜image｜>').tokens).toBe(5)
    expect(deepSeekV4TokenizerForModel('deepseek-v4-pro')?.countText('<｜image｜>').tokens).toBe(1)
  })

  it('lists both artifacts in stable registration order', () => {
    const artifacts = deepSeekTokenizerArtifacts()
    expect(artifacts).toHaveLength(2)
    expect(artifacts[0]?.repository).toBe(V4_PRO_REPOSITORY)
    expect(artifacts[1]?.repository).toBe(V41_FLASH_REPOSITORY)
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
    'deepseek-flash-vision',
    'deepseek-v4.1-flash',
    'DeepSeek-V4.1-Flash',
    'deepseek-v41-flash',
    'deepseek-flash-2',
    'deepseek-v4-flash-exp',
  ])('refuses the non-exact model id %s', (modelId) => {
    expect(deepSeekV4TokenizerForModel(modelId)).toBeUndefined()
    expect(deepSeekV4TokenizerFailureReason(modelId)).toBeUndefined()
  })

  it('reports no cached failure for the healthy artifacts', () => {
    expect(deepSeekV4TokenizerFailureReason('deepseek-v4-pro')).toBeUndefined()
    expect(deepSeekV4TokenizerFailureReason('deepseek-flash')).toBeUndefined()
    expect(deepSeekV4TokenizerFailureReason('deepseek-v4-flash-vision-exp')).toBeUndefined()
    expect(deepSeekV4TokenizerFailureReason()).toBeUndefined()
  })

  // R-11 / R-12 / R-13 / R-15 are kept as separate spec-named cases so each
  // required behaviour fails independently rather than as one merged assertion.
  const flashAssetRoot = new URL('assets/deepseek-v4.1-flash/', RUNTIME_ROOT)
  const intactFlashIntegrity = () => {
    const tokenizerBytes = readFileSync(fileURLToPath(new URL('tokenizer.json', flashAssetRoot)))
    return {
      tokenizer: { bytes: tokenizerBytes.byteLength, sha256: DEEPSEEK_V41_FLASH_TOKENIZER_ARTIFACT.tokenizerSha256 },
      config: { bytes: 801, sha256: DEEPSEEK_V41_FLASH_TOKENIZER_ARTIFACT.tokenizerConfigSha256 },
    }
  }

  it('fails closed on byte-length corruption of the V4.1-Flash artifact', () => {
    const good = intactFlashIntegrity()
    expect(() => createDeepSeekV4TokenizerFromAssets(flashAssetRoot, {
      tokenizer: { ...good.tokenizer, bytes: good.tokenizer.bytes + 1 },
      config: good.config,
    })).toThrow(/bytes/)
  })

  it('fails closed on SHA-256 corruption of the V4.1-Flash artifact', () => {
    const good = intactFlashIntegrity()
    expect(() => createDeepSeekV4TokenizerFromAssets(flashAssetRoot, {
      tokenizer: { ...good.tokenizer, sha256: '0'.repeat(64) },
      config: good.config,
    })).toThrow(/SHA-256/)
  })

  it('accepts the intact V4.1-Flash artifact', () => {
    expect(() => createDeepSeekV4TokenizerFromAssets(flashAssetRoot, intactFlashIntegrity())).not.toThrow()
  })

  it('keeps the V4-Pro artifact serving after a V4.1-Flash corruption', () => {
    const good = intactFlashIntegrity()
    expect(() => createDeepSeekV4TokenizerFromAssets(flashAssetRoot, {
      tokenizer: { ...good.tokenizer, bytes: good.tokenizer.bytes + 1 },
      config: good.config,
    })).toThrow(/bytes/)
    // The shared registry still serves the independent text artifact.
    expect(deepSeekV4TokenizerForModel('deepseek-v4-pro')?.countText('still exact')).toMatchObject({
      kind: 'exact-tokenizer',
      tokenizerId: V4_PRO_REPOSITORY,
    })
  })

  it('keeps the V4.1-Flash artifact serving after a V4-Pro corruption', () => {
    const proRoot = new URL('assets/deepseek-v4/', RUNTIME_ROOT)
    const tokenizerBytes = readFileSync(fileURLToPath(new URL('tokenizer.json', proRoot)))
    expect(() => createDeepSeekV4TokenizerFromAssets(proRoot, {
      tokenizer: { bytes: tokenizerBytes.byteLength + 1, sha256: DEEPSEEK_V4_TOKENIZER_ARTIFACT.tokenizerSha256 },
      config: { bytes: 801, sha256: DEEPSEEK_V4_TOKENIZER_ARTIFACT.tokenizerConfigSha256 },
    })).toThrow(/bytes/)
    expect(deepSeekV4TokenizerForModel('deepseek-flash')?.countText('still exact')).toMatchObject({
      kind: 'exact-tokenizer',
      tokenizerId: V41_FLASH_REPOSITORY,
    })
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
      ['deepseek-v4.1-flash', DEEPSEEK_V41_FLASH_TOKENIZER_ARTIFACT],
      ['deepseek-v4', DEEPSEEK_V4_TOKENIZER_ARTIFACT],
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
