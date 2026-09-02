/** Configuration resolution for the mixed deterministic context-compression selector. */

import z from '@deepseek-ai/schemastery'
import type {
  AutoCompactSettings,
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
import { deepFreeze } from './value.ts'

/** Settings namespace shared by the Host service and browser selector. */
export const CONTEXT_COMPRESSION_SETTINGS_NAMESPACE = 'context-compression'

/** Fixed native fallback marker. */
export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'

/**
 * The one Auto Compact threshold contract shared by the settings UI, the
 * persisted settings schema, and the runtime resolver. Every integer in the
 * range is valid and entered directly in the UI.
 */
export const AUTO_COMPACT_THRESHOLD_LIMITS = deepFreeze({
  min: 50,
  max: 90,
  step: 1,
  default: 80,
} as const)

/** Narrow one untrusted value to a valid Auto Compact threshold percent. */
export function isValidAutoCompactThresholdPercent(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= AUTO_COMPACT_THRESHOLD_LIMITS.min
    && value <= AUTO_COMPACT_THRESHOLD_LIMITS.max
}

const AUTO_COMPACT_DEFAULT: AutoCompactSettings = deepFreeze({ thresholdPercent: AUTO_COMPACT_THRESHOLD_LIMITS.default })

/** Accept JSON-object records while rejecting class instances and exotic prototypes. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === Object.prototype || prototype === null
}

/** Reject exotic prototypes anywhere in the JSON-like settings tree. */
function assertPlainDataTree(value: unknown, seen: WeakSet<object> = new WeakSet()): void {
  if (value === null || typeof value !== 'object') return
  if (seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const entry of value) assertPlainDataTree(entry, seen)
    return
  }
  if (!isPlainRecord(value)) {
    throw new TypeError('Context-compression settings must contain only plain objects')
  }
  for (const entry of Object.values(value)) assertPlainDataTree(entry, seen)
}

/**
 * Strictly parse the persisted autoCompact section. Schemastery object
 * defaults silently absorb null, empty, and extra-key sections, so this stays
 * hand-validated beside the top-level unknown-key check.
 */
function parseAutoCompactSettings(value: unknown): AutoCompactSettings {
  if (value === undefined) return AUTO_COMPACT_DEFAULT
  if (!isPlainRecord(value)) {
    throw new TypeError('Context-compression autoCompact must be a plain object')
  }
  const keys = Object.keys(value)
  if (keys.length !== 1 || keys[0] !== 'thresholdPercent') {
    throw new TypeError(`Context-compression autoCompact: expected exactly "thresholdPercent", got "${keys.join('", "')}"`)
  }
  const thresholdPercent = (value as Record<string, unknown>).thresholdPercent
  if (!isValidAutoCompactThresholdPercent(thresholdPercent)) {
    throw new TypeError(`Context-compression autoCompact.thresholdPercent (${String(thresholdPercent)}) must be an integer between ${String(AUTO_COMPACT_THRESHOLD_LIMITS.min)} and ${String(AUTO_COMPACT_THRESHOLD_LIMITS.max)}`)
  }
  return { thresholdPercent }
}

/** Settings schema used by the user-facing profile selector. */
const contextCompressionSettingsInputSchema = z.object({
  profile: z.union([...COMPRESSION_PROFILES]).default('balanced'),
  custom: CustomCompressionPolicySchema.default(DEFAULT_CUSTOM_COMPRESSION_POLICY),
})

/**
 * Reject a section that is PRESENT but not a usable value. Schemastery
 * `.default(...)` silently substitutes null and undefined, which would turn a
 * hand-corrupted store into the (lossy) default policy; only genuinely absent
 * keys may inherit defaults, and that distinction must be made before any
 * default can fire.
 */
function assertPresentSection(
  candidate: Record<string, unknown>,
  key: 'profile' | 'custom',
  valid: (value: unknown) => boolean,
): void {
  if (!Object.hasOwn(candidate, key)) return
  if (!valid(candidate[key])) {
    throw new TypeError(`Context-compression settings: "${key}" is present but invalid (${String(candidate[key])})`)
  }
}

const isSupportedProfile = (value: unknown): boolean =>
  typeof value === 'string' && (COMPRESSION_PROFILES as readonly string[]).includes(value)

const isUsableCustomDocument = (value: unknown): boolean =>
  isPlainRecord(value)

const DEFAULT_CONTEXT_COMPRESSION_SETTINGS: ContextCompressionSettings = {
  profile: 'balanced',
  custom: structuredClone(DEFAULT_CUSTOM_COMPRESSION_POLICY),
  autoCompact: { thresholdPercent: AUTO_COMPACT_THRESHOLD_LIMITS.default },
}

/**
 * Parse one settings document with the persisted-section semantics: `undefined`
 * inherits the defaults (an absent section), while `null` is an explicitly
 * invalid document and must never silently become the default policy.
 */
export function parseContextCompressionSettings(value: unknown): ContextCompressionSettings {
  if (!isPlainRecord(value)) {
    throw new TypeError('Context-compression settings must be a plain object')
  }
  const keys = Object.keys(value)
  // Documents surfaced by the settings service are always schema-resolved and
  // complete; anything thinner is a hand-edited store and must not silently
  // become a default (possibly lossy) policy.
  if (keys.length === 0 || !keys.includes('profile') || !keys.includes('custom')) {
    throw new TypeError('Context-compression settings document is missing its complete shape')
  }
  return ContextCompressionSettingsSchema(value as never)
}

/** Settings schema used by the user-facing profile selector. */
export const ContextCompressionSettingsSchema: z<ContextCompressionSettings> = z.transform(
  z.any().required(),
  (value: unknown): ContextCompressionSettings => {
    if (!isPlainRecord(value)) {
      throw new TypeError('Context-compression settings must be a plain object')
    }
    // Validate prototypes before cloning, then parse a detached mutable copy:
    // SettingsProvider returns frozen records, while structuredClone would
    // otherwise erase exotic prototypes before this boundary can reject them.
    assertPlainDataTree(value)
    const candidate = structuredClone(value)
    // Settings stored before the autoCompact section exist remain valid and
    // inherit the 80% default; the section itself stays strictly shaped.
    const unknown = Object.keys(candidate).find(key => key !== 'profile' && key !== 'custom' && key !== 'autoCompact')
    if (unknown !== undefined) {
      throw new TypeError(`Context-compression settings: unknown key "${unknown}"`)
    }
    // Present-but-invalid sections must never fall through to the Schemastery
    // defaults below: `profile: null` silently becoming the lossy `balanced`
    // default is exactly the corruption the lossless-off fallback exists for.
    // Only genuinely absent sections (internal partial fallbacks) may inherit.
    assertPresentSection(candidate, 'profile', isSupportedProfile)
    assertPresentSection(candidate, 'custom', isUsableCustomDocument)
    const autoCompact = parseAutoCompactSettings(candidate.autoCompact)
    return { ...contextCompressionSettingsInputSchema(candidate), autoCompact }
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
  'autoCompactThresholdPercent',
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
    ...config.autoCompactThresholdPercent === undefined ? {} : { autoCompactThresholdPercent: config.autoCompactThresholdPercent },
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
  if (resolved.autoCompactThresholdPercent !== undefined
    && !isValidAutoCompactThresholdPercent(resolved.autoCompactThresholdPercent)) {
    throw new Error(`ToolResultPruneConfig: autoCompactThresholdPercent (${String(resolved.autoCompactThresholdPercent)}) must be an integer between ${String(AUTO_COMPACT_THRESHOLD_LIMITS.min)} and ${String(AUTO_COMPACT_THRESHOLD_LIMITS.max)}`)
  }
  assertTargetBelowTrigger('native', resolved.nativeTargetTokens, resolved.nativeTriggerTokens)
  assertTargetBelowTrigger('fresh', resolved.freshTargetTokens, resolved.freshTriggerTokens)
  assertTargetBelowTrigger('aggregate', resolved.aggregateTargetTokens, resolved.aggregateTriggerTokens)
  return deepFreeze(structuredClone(resolved))
}

/** Per-profile History linkage ratios applied to the Auto Compact watermark. */
const AUTO_COMPACT_HISTORY_RATIOS: Readonly<Record<string, Readonly<{
  trigger: number
  minReclaim: number
  keepRecentTokens: number
}>>> = Object.freeze({
  balanced: Object.freeze({ trigger: 0.625, minReclaim: 0.12, keepRecentTokens: 0.08 }),
  savings: Object.freeze({ trigger: 0.50, minReclaim: 0.16, keepRecentTokens: 0.08 }),
  'cache-strict': Object.freeze({ trigger: 0.75, minReclaim: 0.16, keepRecentTokens: 0.08 }),
  adaptive: Object.freeze({ trigger: 0.625, minReclaim: 0.12, keepRecentTokens: 0.08 }),
})

/** Micro-compact last-chance ratio: `D = floor(A × 0.875)`. */
const MICRO_DEADLINE_RATIO = 0.875

/**
 * Resolve the Auto-Compact-linked History watermarks for one standard profile.
 *
 * `A = floor(C × a)` is the Auto Compact token watermark for the routed
 * context window `C` and the user threshold `a = p / 100`; the History
 * trigger, minimum reclaim, and recent-token tail scale with `A`, and the
 * micro-compact last-chance deadline is `D = floor(A × 0.875)`. At the shipped
 * defaults (`C = 1,000,000`, `p = 80`) the ratios reproduce the previous fixed
 * preset numbers exactly. Custom stays manual and Off/Native run no History,
 * so none of them link.
 */
function resolveAutoCompactLinkage(
  profile: CompressionProfile,
  options: CustomPolicyResolutionOptions,
): { autoCompactTokens: number, microDeadlineTokens: number, historyTriggerTokens: number,
  historyMinReclaimTokens: number, historyKeepRecentTokens: number } | undefined {
  const ratios = profile === 'custom' ? undefined : AUTO_COMPACT_HISTORY_RATIOS[profile]
  const contextWindow = options.contextWindowTokens
  const threshold = options.autoCompactThresholdPercent
  if (ratios === undefined) return undefined
  if (!isValidAutoCompactThresholdPercent(threshold)) return undefined
  if (!Number.isSafeInteger(contextWindow) || contextWindow === undefined || contextWindow <= 0) return undefined
  // Mirror compaction-basic's evaluation order exactly: it multiplies by the
  // generated ratio float (p / 100), and integer-first division differs by
  // one token on some window/percent pairs (200k x 57).
  const autoCompactTokens = Math.floor(contextWindow * (threshold / 100))
  if (!Number.isSafeInteger(autoCompactTokens) || autoCompactTokens <= 0) return undefined
  const linked = {
    autoCompactTokens,
    microDeadlineTokens: Math.floor(autoCompactTokens * MICRO_DEADLINE_RATIO),
    historyTriggerTokens: Math.floor(ratios.trigger * autoCompactTokens),
    historyMinReclaimTokens: Math.floor(ratios.minReclaim * autoCompactTokens),
    historyKeepRecentTokens: Math.floor(ratios.keepRecentTokens * autoCompactTokens),
  }
  for (const value of Object.values(linked)) {
    if (!Number.isSafeInteger(value) || value <= 0) return undefined
  }
  return linked
}

/**
 * Resolve one public profile into a complete mixed-strategy policy.
 * @param config - validated composition configuration.
 * @param profile - profile frozen for the target Session.
 * @param custom - versioned Custom document used only by the `custom` profile.
 * @param options - routed capacity and the frozen Auto Compact threshold used
 * to resolve context-percent Custom values and standard-profile linkage.
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
  const linkage = resolveAutoCompactLinkage(profile, options)
  const policy: CompressionPolicy = {
    profile,
    ...preset,
    nativeTriggerTokens: config.nativeTriggerTokens ?? preset.nativeTriggerTokens,
    nativeTargetTokens: config.nativeTargetTokens ?? preset.nativeTargetTokens,
    freshTriggerTokens: config.freshTriggerTokens ?? preset.freshTriggerTokens,
    freshTargetTokens: config.freshTargetTokens ?? preset.freshTargetTokens,
    aggregateTriggerTokens: config.aggregateTriggerTokens ?? preset.aggregateTriggerTokens,
    aggregateTargetTokens: config.aggregateTargetTokens ?? preset.aggregateTargetTokens,
    historyTriggerTokens: config.historyTriggerTokens
      ?? linkage?.historyTriggerTokens ?? preset.historyTriggerTokens,
    historyKeepRecentToolCalls: config.historyKeepRecentToolCalls ?? preset.historyKeepRecentToolCalls,
    historyKeepRecentTokens: config.historyKeepRecentTokens
      ?? linkage?.historyKeepRecentTokens ?? preset.historyKeepRecentTokens,
    historyMinReclaimTokens: config.historyMinReclaimTokens
      ?? linkage?.historyMinReclaimTokens ?? preset.historyMinReclaimTokens,
    ...linkage === undefined ? {} : {
      autoCompactTokens: linkage.autoCompactTokens,
      microDeadlineTokens: linkage.microDeadlineTokens,
    },
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
