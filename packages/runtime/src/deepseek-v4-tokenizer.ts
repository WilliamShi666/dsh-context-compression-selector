/** Offline DeepSeek V4 tokenizer backed by pinned official Hugging Face assets. */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Tokenizer } from '@huggingface/tokenizers'
import type { ExactTokenizerTokenCount } from './token-count.ts'

const TOKENIZER_ID = 'deepseek-ai/DeepSeek-V4-Pro'
const TOKENIZER_REVISION = '0e1a0e5e52aea73055f50fef6f2423db370265b6'
const TOKENIZER_SHA256 = '8f9f37ca37fdc4f5fd36d5cf4d3b0e8392edb4e894fd10cc0d70b4957c8633cf'
const CONFIG_SHA256 = '6ac8c8dc065ed118161d02dd532749ae3f52c243deac27872134fae2f50d8547'
const ASSET_ROOT = new URL('../assets/deepseek-v4/', import.meta.url)
const MODEL_IDS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
] as const

/** Auditable origin and compatibility mapping for the bundled tokenizer. */
export const DEEPSEEK_V4_TOKENIZER_ARTIFACT = Object.freeze({
  repository: TOKENIZER_ID,
  revision: TOKENIZER_REVISION,
  license: 'MIT',
  tokenizerSha256: TOKENIZER_SHA256,
  tokenizerConfigSha256: CONFIG_SHA256,
  modelIds: Object.freeze([...MODEL_IDS]),
})

/** Synchronous exact counter backed only by the verified local V4 artifact. */
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

const DEFAULT_INTEGRITY: DeepSeekV4TokenizerAssetIntegrity = Object.freeze({
  tokenizer: Object.freeze({ bytes: 6_367_146, sha256: TOKENIZER_SHA256 }),
  config: Object.freeze({ bytes: 801, sha256: CONFIG_SHA256 }),
})

let tokenizer: DeepSeekV4TextTokenizer | undefined
let initializationAttempted = false
let initializationFailure: string | undefined

/**
 * Resolve the shared offline tokenizer for one compatible API model.
 * Unknown models and a cached asset/runtime failure return `undefined`; callers
 * must report unavailable instead of manufacturing a character estimate.
 * @param modelId - exact DeepSeek API wire model id.
 * @returns the shared verified tokenizer, or undefined when unsupported/unavailable.
 */
export function deepSeekV4TokenizerForModel(modelId: string): DeepSeekV4TextTokenizer | undefined {
  if (!(MODEL_IDS as readonly string[]).includes(modelId)) return undefined
  if (tokenizer !== undefined) return tokenizer
  if (initializationAttempted) return undefined
  initializationAttempted = true
  try {
    tokenizer = createDeepSeekV4TokenizerFromAssets(ASSET_ROOT)
    return tokenizer
  } catch (error: unknown) {
    initializationFailure = error instanceof Error ? error.message : String(error)
    return undefined
  }
}

/**
 * Read the cached initialization diagnostic for provider registration.
 * @returns the first initialization failure, or undefined before/since success.
 */
export function deepSeekV4TokenizerFailureReason(): string | undefined {
  return initializationFailure
}

/**
 * Build a tokenizer from one local asset directory after byte/hash validation.
 * This provider-private seam exists so tests can prove every failure branch
 * without mutating the committed artifact.
 * @param assetRoot - local URL containing tokenizer.json and tokenizer_config.json.
 * @param integrity - expected byte length and SHA-256 for both files.
 * @returns a synchronous exact text counter.
 * @internal
 */
export function createDeepSeekV4TokenizerFromAssets(
  assetRoot: URL,
  integrity: DeepSeekV4TokenizerAssetIntegrity = DEFAULT_INTEGRITY,
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
        tokenizerId: TOKENIZER_ID,
        tokenizerRevision: TOKENIZER_REVISION,
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
