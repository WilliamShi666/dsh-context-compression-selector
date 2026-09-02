/** Offline DeepSeek tokenizers backed by pinned official Hugging Face assets. */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Tokenizer } from '@huggingface/tokenizers'
import type { ExactTokenizerTokenCount } from './token-count.ts'

const TOKENIZER_ID = 'deepseek-ai/DeepSeek-V4-Pro'
const TOKENIZER_REVISION = '0e1a0e5e52aea73055f50fef6f2423db370265b6'
const TOKENIZER_SHA256 = '8f9f37ca37fdc4f5fd36d5cf4d3b0e8392edb4e894fd10cc0d70b4957c8633cf'
const CONFIG_SHA256 = '6ac8c8dc065ed118161d02dd532749ae3f52c243deac27872134fae2f50d8547'
const VISION_TOKENIZER_ID = 'deepseek-ai/DeepSeek-V4-Flash-Vision-Exp'
const VISION_TOKENIZER_REVISION = '6821d6ad3681a4b137b066b76094fa82ebd0a380'
const VISION_TOKENIZER_SHA256 = 'c90dfa01249db1be4245780a052ede752e1361c612ac6d08e2bdada7d599476b'
const VISION_CONFIG_SHA256 = '6ac8c8dc065ed118161d02dd532749ae3f52c243deac27872134fae2f50d8547'

/** Auditable origin and compatibility mapping for one bundled tokenizer. */
export interface DeepSeekTokenizerArtifactOrigin {
  /** Hugging Face repository the assets were pinned from. */
  readonly repository: string
  /** Immutable commit revision the assets were pinned from. */
  readonly revision: string
  /** Upstream license of the repository. */
  readonly license: string
  /** Exact API wire model ids served by this artifact. */
  readonly modelIds: readonly string[]
  readonly tokenizerSha256: string
  readonly tokenizerConfigSha256: string
}

/** Auditable origin and compatibility mapping for the bundled V4 Pro tokenizer. */
export const DEEPSEEK_V4_TOKENIZER_ARTIFACT: DeepSeekTokenizerArtifactOrigin = Object.freeze({
  repository: TOKENIZER_ID,
  revision: TOKENIZER_REVISION,
  license: 'MIT',
  tokenizerSha256: TOKENIZER_SHA256,
  tokenizerConfigSha256: CONFIG_SHA256,
  modelIds: Object.freeze(['deepseek-v4-flash', 'deepseek-v4-pro']),
})

/**
 * Auditable origin and compatibility mapping for the bundled V4 Flash Vision
 * tokenizer. The vision repository ships a distinct `tokenizer.json` (it adds
 * the `<｜deepseek_image｜>` special token), so the vision model must never be
 * mapped onto the V4 Pro tokenizer as an alias.
 */
export const DEEPSEEK_VISION_TOKENIZER_ARTIFACT: DeepSeekTokenizerArtifactOrigin = Object.freeze({
  repository: VISION_TOKENIZER_ID,
  revision: VISION_TOKENIZER_REVISION,
  license: 'MIT',
  tokenizerSha256: VISION_TOKENIZER_SHA256,
  tokenizerConfigSha256: VISION_CONFIG_SHA256,
  modelIds: Object.freeze(['deepseek-v4-flash-vision-exp']),
})

/** Synchronous exact counter backed only by the verified local V4 artifacts. */
export interface DeepSeekV4TextTokenizer {
  /** Count one fully determined text value with the official tokenizer. */
  countText(text: string): ExactTokenizerTokenCount
}

/** Integrity tuple for one tokenizer JSON asset. @internal */
export interface DeepSeekV4TokenizerAssetDescriptor {
  readonly bytes: number
  readonly sha256: string
}

/** Injectable integrity manifest used by negative loader tests. @internal */
export interface DeepSeekV4TokenizerAssetIntegrity {
  readonly tokenizer: DeepSeekV4TokenizerAssetDescriptor
  readonly config: DeepSeekV4TokenizerAssetDescriptor
}

interface TokenizerArtifact {
  readonly origin: DeepSeekTokenizerArtifactOrigin
  readonly assetRoot: URL
  readonly integrity: DeepSeekV4TokenizerAssetIntegrity
}

/**
 * Every bundled artifact is registered with independent asset roots, integrity
 * manifests, and cache entries: one corrupted artifact must never disable the
 * tokenizer serving the other model family.
 */
const ARTIFACTS: readonly TokenizerArtifact[] = Object.freeze([
  Object.freeze({
    origin: DEEPSEEK_V4_TOKENIZER_ARTIFACT,
    assetRoot: new URL('../assets/deepseek-v4/', import.meta.url),
    integrity: Object.freeze({
      tokenizer: Object.freeze({ bytes: 6_367_146, sha256: TOKENIZER_SHA256 }),
      config: Object.freeze({ bytes: 801, sha256: CONFIG_SHA256 }),
    }),
  }),
  Object.freeze({
    origin: DEEPSEEK_VISION_TOKENIZER_ARTIFACT,
    assetRoot: new URL('../assets/deepseek-v4-vision-exp/', import.meta.url),
    integrity: Object.freeze({
      tokenizer: Object.freeze({ bytes: 6_367_257, sha256: VISION_TOKENIZER_SHA256 }),
      config: Object.freeze({ bytes: 801, sha256: VISION_CONFIG_SHA256 }),
    }),
  }),
])

interface ArtifactCacheEntry {
  readonly tokenizer?: DeepSeekV4TextTokenizer
  readonly failure?: string
}

const registryCache = new Map<DeepSeekTokenizerArtifactOrigin, ArtifactCacheEntry>()

function artifactForModel(modelId: string): TokenizerArtifact | undefined {
  return ARTIFACTS.find(artifact => (artifact.origin.modelIds as readonly string[]).includes(modelId))
}

/**
 * Resolve the shared offline tokenizer for one compatible API model.
 * Unknown models and a cached asset/runtime failure return `undefined`; callers
 * must report unavailable instead of manufacturing a character estimate.
 * @param modelId - exact DeepSeek API wire model id.
 * @returns the shared verified tokenizer, or undefined when unsupported/unavailable.
 */
export function deepSeekV4TokenizerForModel(modelId: string): DeepSeekV4TextTokenizer | undefined {
  const artifact = artifactForModel(modelId)
  if (artifact === undefined) return undefined
  const cached = registryCache.get(artifact.origin)
  if (cached !== undefined) return cached.tokenizer
  let entry: ArtifactCacheEntry
  try {
    const tokenizer = createDeepSeekV4TokenizerFromAssets(artifact.assetRoot, artifact.integrity, artifact.origin)
    entry = { tokenizer }
  } catch (error: unknown) {
    entry = { failure: error instanceof Error ? error.message : String(error) }
  }
  registryCache.set(artifact.origin, entry)
  return entry.tokenizer
}

/**
 * Read the cached initialization diagnostic for provider registration.
 * @param modelId - optional exact model id; defaults to the V4 Pro artifact.
 * @returns the first initialization failure for that artifact, or undefined.
 */
export function deepSeekV4TokenizerFailureReason(modelId?: string): string | undefined {
  const artifact = modelId === undefined ? ARTIFACTS[0] : artifactForModel(modelId)
  if (artifact === undefined) return undefined
  return registryCache.get(artifact.origin)?.failure
}

/** Complete pinned artifact inventory, in stable registration order. */
export function deepSeekTokenizerArtifacts(): readonly DeepSeekTokenizerArtifactOrigin[] {
  return ARTIFACTS.map(artifact => artifact.origin)
}

/**
 * Build a tokenizer from one local asset directory after byte/hash validation.
 * This provider-private seam exists so tests can prove every failure branch
 * without mutating the committed artifact.
 * @param assetRoot - local URL containing tokenizer.json and tokenizer_config.json.
 * @param integrity - expected byte length and SHA-256 for both files.
 * @param origin - auditable identity recorded on every returned count.
 * @returns a synchronous exact text counter.
 * @internal
 */
export function createDeepSeekV4TokenizerFromAssets(
  assetRoot: URL,
  integrity: DeepSeekV4TokenizerAssetIntegrity,
  origin: DeepSeekTokenizerArtifactOrigin = DEEPSEEK_V4_TOKENIZER_ARTIFACT,
): DeepSeekV4TextTokenizer {
  const tokenizerJson = readVerifiedJson(assetRoot, 'tokenizer.json', integrity.tokenizer)
  const tokenizerConfig = readVerifiedJson(assetRoot, 'tokenizer_config.json', integrity.config)
  const runtime = new Tokenizer(tokenizerJson, tokenizerConfig)
  return Object.freeze({
    countText(text: string): ExactTokenizerTokenCount {
      const tokens = runtime.encode(text, { add_special_tokens: false }).ids.length
      return Object.freeze({
        kind: 'exact-tokenizer',
        tokens,
        tokenizerId: origin.repository,
        tokenizerRevision: origin.revision,
      })
    },
  })
}

function readVerifiedJson(
  assetRoot: URL,
  name: string,
  descriptor: DeepSeekV4TokenizerAssetDescriptor,
): Record<string, unknown> {
  const bytes = readFileSync(new URL(name, assetRoot))
  if (bytes.byteLength !== descriptor.bytes) {
    throw new Error(
      `DeepSeek tokenizer asset ${name} has ${String(bytes.byteLength)} bytes; expected ${String(descriptor.bytes)}`,
    )
  }
  const actualSha256 = createHash('sha256').update(bytes).digest('hex')
  if (actualSha256 !== descriptor.sha256) {
    throw new Error(`DeepSeek tokenizer asset ${name} failed SHA-256 verification`)
  }
  const parsed: unknown = JSON.parse(bytes.toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`DeepSeek tokenizer asset ${name} must contain a JSON object`)
  }
  return parsed as Record<string, unknown>
}
