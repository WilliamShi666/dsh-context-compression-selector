/** Browser-safe settings decoding shared by the client entry and node tests. */

import {
  canonicalizeCustomPolicy,
  COMPRESSION_PROFILES,
  decodeAutoCompactSettings,
  isCustomCompressionPolicy,
  isPlainRecord,
  type CompressionProfile,
  type ContextCompressionSettings,
} from '../profiles.ts'

/**
 * Decode one stored context-compression settings document with exactly the
 * runtime schema's strictness: a plain object with only `profile`, `custom`,
 * and `autoCompact` keys, a supported profile, a valid Custom document
 * canonicalized to v3 exactly as the runtime resolver would, and a
 * strictly-shaped autoCompact section (absent inherits the 80% default).
 * Anything else decodes to `undefined` so the UI reports the document as
 * unreadable instead of silently disagreeing with the runtime.
 */
export function decodeSettings(value: unknown): ContextCompressionSettings | undefined {
  if (!isPlainRecord(value)) return undefined
  const keys = Object.keys(value)
  if (keys.some(key => key !== 'profile' && key !== 'custom' && key !== 'autoCompact')) return undefined
  const profile = (value as { profile?: unknown }).profile
  const custom = (value as { custom?: unknown }).custom
  const autoCompact = decodeAutoCompactSettings((value as { autoCompact?: unknown }).autoCompact)
  return typeof profile === 'string'
    && (COMPRESSION_PROFILES as readonly string[]).includes(profile)
    && isCustomCompressionPolicy(custom)
    && autoCompact !== undefined
    ? {
        profile: profile as CompressionProfile,
        custom: canonicalizeCustomPolicy(custom),
        autoCompact,
      }
    : undefined
}
