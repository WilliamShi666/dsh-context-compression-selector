/** Configuration resolution for the mixed deterministic context-compression selector. */

import { deepFreeze } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import type {
  CompressionPolicy,
  CompressionProfile,
  CustomCompressionPolicy,
  ContextCompressionSettings,
  ResolvedConfig,
  ToolResultPruneConfig,
} from './types.ts'
import { COMPRESSION_PROFILES } from './types.ts'
import {
  CustomCompressionPolicySchema,
  DEFAULT_CUSTOM_COMPRESSION_POLICY,
  resolveCustomPolicy,
  type CustomPolicyResolutionOptions,
} from './custom-policy.ts'

/** Settings namespace shared by the Host service and browser selector. */
export const CONTEXT_COMPRESSION_SETTINGS_NAMESPACE = 'context-compression'

/** Fixed native fallback marker. */
export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'

/** Settings schema used by the user-facing profile selector. */
const contextCompressionSettingsInputSchema = z.object({
  profile: z.union([...COMPRESSION_PROFILES]).default('balanced'),
  custom: CustomCompressionPolicySchema.default(DEFAULT_CUSTOM_COMPRESSION_POLICY),
})

const DEFAULT_CONTEXT_COMPRESSION_SETTINGS: ContextCompressionSettings = {
  profile: 'balanced',
  custom: structuredClone(DEFAULT_CUSTOM_COMPRESSION_POLICY),
}

/** Settings schema used by the user-facing profile selector. */
export const ContextCompressionSettingsSchema: z<ContextCompressionSettings> = z.transform(
  z.any().required(),
  (value: unknown): ContextCompressionSettings => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('Context-compression settings must be a plain object')
    }
    const candidate = value as Record<string, unknown>
    const unknown = Object.keys(candidate).find(key => key !== 'profile' && key !== 'custom')
    if (unknown !== undefined) {
      throw new TypeError(`Context-compression settings: unknown key "${unknown}"`)
    }
    return contextCompressionSettingsInputSchema(candidate)
  },
).default(DEFAULT_CONTEXT_COMPRESSION_SETTINGS) as z<ContextCompressionSettings>

/** Low-friction defaults; token budgets live in resolved profile policy. */
export const DEFAULTS: ResolvedConfig = deepFreeze({
  profile: 'balanced',
  headChars: 4096,
  tailChars: 1024,
})

const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'profile',
  'headChars',
  'tailChars',
  'nativeTriggerTokens',
  'nativeTargetTokens',
  'freshTriggerTokens',
  'freshTargetTokens',
  'aggregateTriggerTokens',
  'aggregateTargetTokens',
  'historyTriggerTokens',
  'historyKeepRecentToolCalls',
  'historyKeepRecentTokens',
  'historyMinReclaimTokens',
])

const LEGACY_GATE_REPLACEMENTS: Readonly<Record<string, string>> = Object.freeze({
  thresholdChars: 'nativeTriggerTokens',
  freshThresholdChars: 'freshTriggerTokens',
  freshTargetChars: 'freshTargetTokens',
  freshBatchTriggerChars: 'aggregateTriggerTokens',
  freshBatchTargetChars: 'aggregateTargetTokens',
  historyTriggerChars: 'historyTriggerTokens',
  historyKeepRecentChars: 'historyKeepRecentTokens',
  historyMinReclaimChars: 'historyMinReclaimTokens',
  historyKeepRecentTurns: 'historyKeepRecentToolCalls',
})

/**
 * Count Unicode code points without splitting surrogate pairs.
 * @param text - text whose code points are counted.
 * @returns the number of Unicode code points.
 */
export function codePointLength(text: string): number {
  let length = 0
  for (const _point of text) length++
  return length
}

/**
 * Test whether a settings value names a supported compression profile.
 * @param value - untrusted settings value.
 * @returns whether the value is a supported compression profile.
 */
export function isCompressionProfile(value: unknown): value is CompressionProfile {
  return typeof value === 'string' && (COMPRESSION_PROFILES as readonly string[]).includes(value)
}

/**
 * Resolve and validate plugin configuration.
 * @param config - optional composition overrides.
 * @returns a detached, deeply immutable configuration snapshot.
 */
export function resolveConfig(config: ToolResultPruneConfig = {}): ResolvedConfig {
  for (const key of Object.keys(config)) {
    const replacement = LEGACY_GATE_REPLACEMENTS[key]
    if (replacement !== undefined) {
      throw new Error(
        `ToolResultPruneConfig: legacy gate "${key}" is no longer accepted; `
        + `choose "${replacement}" manually in tokens (no character conversion is applied)`,
      )
    }
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`ToolResultPruneConfig: unknown key "${key}"`)
    }
  }
  const resolved: ResolvedConfig = {
    profile: config.profile ?? DEFAULTS.profile,
    headChars: config.headChars ?? DEFAULTS.headChars,
    tailChars: config.tailChars ?? DEFAULTS.tailChars,
    ...config.nativeTriggerTokens === undefined ? {} : { nativeTriggerTokens: config.nativeTriggerTokens },
    ...config.nativeTargetTokens === undefined ? {} : { nativeTargetTokens: config.nativeTargetTokens },
    ...config.freshTriggerTokens === undefined ? {} : { freshTriggerTokens: config.freshTriggerTokens },
    ...config.freshTargetTokens === undefined ? {} : { freshTargetTokens: config.freshTargetTokens },
    ...config.aggregateTriggerTokens === undefined ? {} : { aggregateTriggerTokens: config.aggregateTriggerTokens },
    ...config.aggregateTargetTokens === undefined ? {} : { aggregateTargetTokens: config.aggregateTargetTokens },
    ...config.historyTriggerTokens === undefined ? {} : { historyTriggerTokens: config.historyTriggerTokens },
    ...config.historyKeepRecentToolCalls === undefined ? {} : { historyKeepRecentToolCalls: config.historyKeepRecentToolCalls },
    ...config.historyKeepRecentTokens === undefined ? {} : { historyKeepRecentTokens: config.historyKeepRecentTokens },
    ...config.historyMinReclaimTokens === undefined ? {} : { historyMinReclaimTokens: config.historyMinReclaimTokens },
  }
  if (!isCompressionProfile(resolved.profile)) {
    throw new Error(`ToolResultPruneConfig: unsupported profile "${String(resolved.profile)}"`)
  }
  assertNonNegativeInteger('headChars', resolved.headChars)
  assertNonNegativeInteger('tailChars', resolved.tailChars)
  for (const key of [
    'nativeTriggerTokens', 'nativeTargetTokens', 'freshTriggerTokens', 'freshTargetTokens',
    'aggregateTriggerTokens', 'aggregateTargetTokens', 'historyTriggerTokens',
    'historyMinReclaimTokens',
  ] as const) {
    const value = resolved[key]
    if (value !== undefined) assertPositiveInteger(key, value)
  }
  if (resolved.historyKeepRecentToolCalls !== undefined) {
    assertNonNegativeInteger('historyKeepRecentToolCalls', resolved.historyKeepRecentToolCalls)
  }
  if (resolved.historyKeepRecentTokens !== undefined) {
    assertNonNegativeInteger('historyKeepRecentTokens', resolved.historyKeepRecentTokens)
  }
  assertTargetBelowTrigger('native', resolved.nativeTargetTokens, resolved.nativeTriggerTokens)
  assertTargetBelowTrigger('fresh', resolved.freshTargetTokens, resolved.freshTriggerTokens)
  assertTargetBelowTrigger('aggregate', resolved.aggregateTargetTokens, resolved.aggregateTriggerTokens)
  return deepFreeze(structuredClone(resolved))
}

/**
 * Resolve one public profile into a complete mixed-strategy policy.
 * @param config - validated composition configuration.
 * @param profile - profile frozen for the target Session.
 * @param custom - versioned Custom document used only by the `custom` profile.
 * @param options - routed capacity needed to resolve context-percent Custom values.
 * @returns the effective deterministic compression policy.
 */
export function resolvePolicy(
  config: ResolvedConfig,
  profile: CompressionProfile,
  custom: CustomCompressionPolicy = DEFAULT_CUSTOM_COMPRESSION_POLICY,
  options: CustomPolicyResolutionOptions = {},
): CompressionPolicy {
  if (profile === 'custom') return resolveCustomPolicy(custom, options)
  const presets: Record<Exclude<CompressionProfile, 'custom'>, Omit<CompressionPolicy, 'profile'>> = {
    off: {
      nativeToolResultEnabled: false, freshEnabled: false, aggregateEnabled: false, historyMode: 'disabled',
      nativeTriggerTokens: Number.MAX_SAFE_INTEGER, nativeTargetTokens: Number.MAX_SAFE_INTEGER,
      freshTriggerTokens: Number.MAX_SAFE_INTEGER, freshTargetTokens: Number.MAX_SAFE_INTEGER,
      aggregateTriggerTokens: Number.MAX_SAFE_INTEGER, aggregateTargetTokens: Number.MAX_SAFE_INTEGER,
      historyTriggerTokens: Number.MAX_SAFE_INTEGER, historyKeepRecentToolCalls: 10,
      historyKeepRecentTokens: 64_000, historyMinReclaimTokens: Number.MAX_SAFE_INTEGER,
    },
    native: {
      nativeToolResultEnabled: true, freshEnabled: false, aggregateEnabled: false, historyMode: 'disabled',
      nativeTriggerTokens: 4_096, nativeTargetTokens: 2_048,
      freshTriggerTokens: Number.MAX_SAFE_INTEGER, freshTargetTokens: Number.MAX_SAFE_INTEGER,
      aggregateTriggerTokens: Number.MAX_SAFE_INTEGER, aggregateTargetTokens: Number.MAX_SAFE_INTEGER,
      historyTriggerTokens: Number.MAX_SAFE_INTEGER, historyKeepRecentToolCalls: 10,
      historyKeepRecentTokens: 64_000, historyMinReclaimTokens: Number.MAX_SAFE_INTEGER,
    },
    balanced: {
      nativeToolResultEnabled: false, freshEnabled: true, aggregateEnabled: true, historyMode: 'routine',
      nativeTriggerTokens: Number.MAX_SAFE_INTEGER, nativeTargetTokens: Number.MAX_SAFE_INTEGER,
      freshTriggerTokens: 8_192, freshTargetTokens: 3_072,
      aggregateTriggerTokens: 32_768, aggregateTargetTokens: 12_288,
      historyTriggerTokens: 500_000, historyKeepRecentToolCalls: 10,
      historyKeepRecentTokens: 64_000, historyMinReclaimTokens: 96_000,
    },
    'cache-strict': {
      nativeToolResultEnabled: false, freshEnabled: true, aggregateEnabled: true, historyMode: 'capacity-pressure',
      nativeTriggerTokens: Number.MAX_SAFE_INTEGER, nativeTargetTokens: Number.MAX_SAFE_INTEGER,
      freshTriggerTokens: 8_192, freshTargetTokens: 3_072,
      aggregateTriggerTokens: 32_768, aggregateTargetTokens: 12_288,
      historyTriggerTokens: 600_000, historyKeepRecentToolCalls: 10,
      historyKeepRecentTokens: 64_000, historyMinReclaimTokens: 128_000,
    },
    savings: {
      nativeToolResultEnabled: false, freshEnabled: true, aggregateEnabled: true, historyMode: 'routine',
      nativeTriggerTokens: Number.MAX_SAFE_INTEGER, nativeTargetTokens: Number.MAX_SAFE_INTEGER,
      freshTriggerTokens: 4_096, freshTargetTokens: 1_536,
      aggregateTriggerTokens: 16_384, aggregateTargetTokens: 4_096,
      historyTriggerTokens: 400_000, historyKeepRecentToolCalls: 10,
      historyKeepRecentTokens: 64_000, historyMinReclaimTokens: 128_000,
    },
    adaptive: {
      nativeToolResultEnabled: false, freshEnabled: true, aggregateEnabled: true, historyMode: 'adaptive',
      nativeTriggerTokens: Number.MAX_SAFE_INTEGER, nativeTargetTokens: Number.MAX_SAFE_INTEGER,
      freshTriggerTokens: 8_192, freshTargetTokens: 3_072,
      aggregateTriggerTokens: 32_768, aggregateTargetTokens: 12_288,
      historyTriggerTokens: 500_000, historyKeepRecentToolCalls: 10,
      historyKeepRecentTokens: 64_000, historyMinReclaimTokens: 96_000,
    },
  }
  const preset = presets[profile]
  const policy: CompressionPolicy = {
    profile,
    ...preset,
    nativeTriggerTokens: config.nativeTriggerTokens ?? preset.nativeTriggerTokens,
    nativeTargetTokens: config.nativeTargetTokens ?? preset.nativeTargetTokens,
    freshTriggerTokens: config.freshTriggerTokens ?? preset.freshTriggerTokens,
    freshTargetTokens: config.freshTargetTokens ?? preset.freshTargetTokens,
    aggregateTriggerTokens: config.aggregateTriggerTokens ?? preset.aggregateTriggerTokens,
    aggregateTargetTokens: config.aggregateTargetTokens ?? preset.aggregateTargetTokens,
    historyTriggerTokens: config.historyTriggerTokens ?? preset.historyTriggerTokens,
    historyKeepRecentToolCalls: config.historyKeepRecentToolCalls ?? preset.historyKeepRecentToolCalls,
    historyKeepRecentTokens: config.historyKeepRecentTokens ?? preset.historyKeepRecentTokens,
    historyMinReclaimTokens: config.historyMinReclaimTokens ?? preset.historyMinReclaimTokens,
  }
  if (policy.nativeTargetTokens >= policy.nativeTriggerTokens && profile === 'native') {
    throw new Error('context compression policy: native target must be below trigger')
  }
  if (policy.freshTargetTokens >= policy.freshTriggerTokens && policy.freshEnabled) {
    throw new Error('context compression policy: fresh target must be below trigger')
  }
  if (policy.aggregateTargetTokens >= policy.aggregateTriggerTokens && policy.freshEnabled) {
    throw new Error('context compression policy: aggregate target must be below trigger')
  }
  return deepFreeze(policy)
}

function assertTargetBelowTrigger(
  label: string,
  target: number | undefined,
  trigger: number | undefined,
): void {
  if ((target === undefined) !== (trigger === undefined)) {
    throw new Error(`ToolResultPruneConfig: ${label} target and trigger tokens must be provided together`)
  }
  if (target !== undefined && trigger !== undefined && target >= trigger) {
    throw new Error(`ToolResultPruneConfig: ${label} target tokens must be below trigger tokens`)
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`ToolResultPruneConfig: ${name} (${String(value)}) must be a positive safe integer`)
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`ToolResultPruneConfig: ${name} (${String(value)}) must be a non-negative safe integer`)
  }
}
