/** Checked-in DeepSeek official prices and fixed-point provider-usage accounting. */

export const DEEPSEEK_OFFICIAL_PRICE_CATALOG_VERSION = 'deepseek-official-2026-08-25' as const
/** Wall-clock time at which the checked-in official price pages were verified. */
export const DEEPSEEK_OFFICIAL_PRICE_CHECKED_AT = '2026-08-25T00:10:20+08:00' as const

/** Currencies published by the checked-in DeepSeek price catalog. */
export type DeepSeekPriceCurrency = 'USD' | 'CNY'
/** Official dynamic-price schedule bands. */
export type DeepSeekPriceBand = 'peak' | 'off-peak'
/** DeepSeek API surfaces with explicit prompt usage semantics. */
export type DeepSeekPriceApiRoute = 'chat-completions' | 'responses'
/** Exact official V4 model ids covered by this catalog version. */
export type OfficialDeepSeekModelId =
  | 'deepseek-v4-flash'
  | 'deepseek-v4-pro'
  | 'deepseek-v4-flash-vision-exp'

/** One immutable applicable official price tuple. */
export interface OfficialDeepSeekPriceRecord {
  readonly catalogVersion: typeof DEEPSEEK_OFFICIAL_PRICE_CATALOG_VERSION
  readonly checkedAt: typeof DEEPSEEK_OFFICIAL_PRICE_CHECKED_AT
  readonly provider: 'deepseek-official'
  readonly baseUrlClass: 'official-public'
  readonly apiRoute: DeepSeekPriceApiRoute
  readonly modelId: OfficialDeepSeekModelId
  readonly modelVersion: string
  readonly currency: DeepSeekPriceCurrency
  readonly unitTokens: 1_000_000
  readonly band: DeepSeekPriceBand
  readonly inputCacheHit: string
  readonly inputCacheMiss: string
  readonly output: string
  readonly sourceUrl: string
  readonly sourceLocale: 'en' | 'zh-CN'
  readonly peakRule: 'Asia/Shanghai Mon-Fri 09:00-12:00,14:00-18:00'
}

/** Applicable official price record or a fail-closed reason. */
export type OfficialDeepSeekPriceResolution =
  | { readonly kind: 'priced'; readonly record: OfficialDeepSeekPriceRecord }
  | { readonly kind: 'unpriced'; readonly reason: string }

interface ResolvePriceInput {
  readonly provider: string
  readonly baseUrlClass: string
  readonly apiRoute: string
  readonly modelId: string
  readonly currency: string
  readonly at: Date
}

interface ModelPrices {
  readonly version: string
  readonly USD: Readonly<Record<DeepSeekPriceBand, readonly [string, string, string]>>
  readonly CNY: Readonly<Record<DeepSeekPriceBand, readonly [string, string, string]>>
}

const PRICES: Readonly<Record<OfficialDeepSeekModelId, ModelPrices>> = Object.freeze({
  'deepseek-v4-flash': modelPrices(
    'DeepSeek-V4-Flash-0731',
    ['0.007', '0.22', '0.66'], ['0.014', '0.44', '1.32'],
    ['0.05', '1.5', '4.5'], ['0.10', '3.0', '9.0'],
  ),
  'deepseek-v4-pro': modelPrices(
    'DeepSeek-V4-Pro-0813',
    ['0.022', '0.66', '1.98'], ['0.044', '1.32', '3.96'],
    ['0.15', '4.5', '13.5'], ['0.30', '9.0', '27.0'],
  ),
  'deepseek-v4-flash-vision-exp': modelPrices(
    'DeepSeek-V4-Flash-Vision-Exp',
    ['0.007', '0.22', '0.66'], ['0.014', '0.44', '1.32'],
    ['0.05', '1.5', '4.5'], ['0.10', '3.0', '9.0'],
  ),
})

const PEAK_RULE = 'Asia/Shanghai Mon-Fri 09:00-12:00,14:00-18:00' as const
const USD_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing/'
const CNY_SOURCE = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'

/**
 * Resolve one immutable official price record; aliases and compatible gateways fail closed.
 * @param input - exact provider, endpoint, route, model, currency, and timestamp applicability.
 * @returns An immutable price record or an explicit unpriced reason.
 */
export function resolveOfficialDeepSeekPrice(input: ResolvePriceInput): OfficialDeepSeekPriceResolution {
  if (input.provider !== 'deepseek-official') return unpriced('unknown provider route')
  if (input.baseUrlClass !== 'official-public') return unpriced('unknown base-url applicability')
  if (input.apiRoute !== 'chat-completions' && input.apiRoute !== 'responses') {
    return unpriced('unknown API route')
  }
  if (!isOfficialModel(input.modelId)) return unpriced('unknown model id')
  if (input.currency !== 'USD' && input.currency !== 'CNY') return unpriced('unknown currency')
  const band = priceBandAt(input.at)
  if (band === undefined) return unpriced('invalid price timestamp')
  const model = PRICES[input.modelId]
  const [inputCacheHit, inputCacheMiss, output] = model[input.currency][band]
  return {
    kind: 'priced',
    record: Object.freeze({
      catalogVersion: DEEPSEEK_OFFICIAL_PRICE_CATALOG_VERSION,
      checkedAt: DEEPSEEK_OFFICIAL_PRICE_CHECKED_AT,
      provider: 'deepseek-official',
      baseUrlClass: 'official-public',
      apiRoute: input.apiRoute,
      modelId: input.modelId,
      modelVersion: model.version,
      currency: input.currency,
      unitTokens: 1_000_000,
      band,
      inputCacheHit,
      inputCacheMiss,
      output,
      sourceUrl: input.currency === 'USD' ? USD_SOURCE : CNY_SOURCE,
      sourceLocale: input.currency === 'USD' ? 'en' : 'zh-CN',
      peakRule: PEAK_RULE,
    }),
  }
}

/**
 * Classify a timestamp under the published Beijing peak schedule.
 * @param at - absolute request time to interpret in Asia/Shanghai.
 * @returns Peak/off-peak, or undefined for an invalid timestamp.
 */
export function priceBandAt(at: Date): DeepSeekPriceBand | undefined {
  if (!Number.isFinite(at.getTime())) return undefined
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  const weekday = values.weekday
  const hour = Number(values.hour)
  const minute = Number(values.minute)
  const second = Number(values.second)
  if (weekday === undefined || !Number.isInteger(hour)
    || !Number.isInteger(minute) || !Number.isInteger(second)) return undefined
  const workday = weekday !== 'Sat' && weekday !== 'Sun'
  const seconds = hour * 3_600 + minute * 60 + second
  const peak = workday && (
    (seconds >= 9 * 3_600 && seconds < 12 * 3_600)
    || (seconds >= 14 * 3_600 && seconds < 18 * 3_600)
  )
  return peak ? 'peak' : 'off-peak'
}

interface PriceUsageInput extends Omit<ResolvePriceInput, 'at'> {
  readonly startedAt: Date
  readonly completedAt: Date
  readonly usage: {
    readonly cacheReadTokens: number
    readonly cacheMissTokens: number
    readonly outputTokens: number
  }
}

interface MoneyAmount {
  readonly femtoUnits: string
  readonly decimal: string
}

/** Exact fixed-point provider cost, a cross-band range, or an unpriced reason. */
export type OfficialDeepSeekUsageCost =
  | ({ readonly kind: 'exact'; readonly currency: DeepSeekPriceCurrency; readonly band: DeepSeekPriceBand } & MoneyAmount)
  | {
    readonly kind: 'range'
    readonly currency: DeepSeekPriceCurrency
    readonly bands: readonly [DeepSeekPriceBand, DeepSeekPriceBand]
    readonly minimum: MoneyAmount
    readonly maximum: MoneyAmount
  }
  | { readonly kind: 'unpriced'; readonly reason: string }

/**
 * Price one completed request, returning a range when it spans a published band boundary.
 * @param input - exact applicability, request interval, and complete disjoint usage buckets.
 * @returns Fixed-point exact/range cost or an explicit unpriced reason.
 */
export function priceOfficialDeepSeekUsage(input: PriceUsageInput): OfficialDeepSeekUsageCost {
  for (const [name, value] of Object.entries(input.usage)) {
    if (!Number.isSafeInteger(value) || value < 0) return unpriced(`invalid ${name}`)
  }
  if (input.completedAt.getTime() < input.startedAt.getTime()) {
    return unpriced('completion timestamp precedes request start')
  }
  const start = resolveOfficialDeepSeekPrice({ ...input, at: input.startedAt })
  if (start.kind === 'unpriced') return start
  const end = resolveOfficialDeepSeekPrice({ ...input, at: input.completedAt })
  if (end.kind === 'unpriced') return end
  const startAmount = amountFor(start.record, input.usage)
  if (startAmount === undefined) return unpriced('invalid decimal price record')
  const crossesBoundary = spansPublishedPriceBoundary(input.startedAt, input.completedAt)
  if (start.record.band === end.record.band && !crossesBoundary) {
    return { kind: 'exact', currency: start.record.currency, band: start.record.band, ...startAmount }
  }
  const comparisonRecord = start.record.band === end.record.band
    ? priceRecordInBand(start.record, start.record.band === 'peak' ? 'off-peak' : 'peak')
    : end.record
  const endAmount = amountFor(comparisonRecord, input.usage)
  if (endAmount === undefined) return unpriced('invalid decimal price record')
  const startFemto = BigInt(startAmount.femtoUnits)
  const endFemto = BigInt(endAmount.femtoUnits)
  return {
    kind: 'range',
    currency: start.record.currency,
    bands: [start.record.band, comparisonRecord.band],
    minimum: startFemto <= endFemto ? startAmount : endAmount,
    maximum: startFemto <= endFemto ? endAmount : startAmount,
  }
}

/** Detect any published UTC band boundary, even when both endpoints share a band. */
function spansPublishedPriceBoundary(startedAt: Date, completedAt: Date): boolean {
  const start = startedAt.getTime()
  const end = completedAt.getTime()
  if (end <= start) return false
  const dayMs = 24 * 60 * 60 * 1_000
  if (end - start >= 7 * dayMs) return true
  const firstDay = Math.floor(start / dayMs) * dayMs
  for (let day = firstDay; day <= end; day += dayMs) {
    const weekday = new Date(day).getUTCDay()
    if (weekday === 0 || weekday === 6) continue
    for (const hour of [1, 4, 6, 10]) {
      const boundary = day + hour * 60 * 60 * 1_000
      if (boundary > start && boundary <= end) return true
    }
  }
  return false
}

function priceRecordInBand(
  record: OfficialDeepSeekPriceRecord,
  band: DeepSeekPriceBand,
): OfficialDeepSeekPriceRecord {
  const [inputCacheHit, inputCacheMiss, output] = PRICES[record.modelId][record.currency][band]
  return Object.freeze({ ...record, band, inputCacheHit, inputCacheMiss, output })
}

/**
 * Parse a non-negative decimal rate into nano-currency units, without Number arithmetic.
 * @param value - canonical non-negative decimal with at most nine fractional digits.
 * @returns Integer nano-units, or undefined when the decimal is invalid.
 */
export function decimalRateNanoUnits(value: string): bigint | undefined {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,9}))?$/u.exec(value)
  if (match === null) return undefined
  const whole = match[1] ?? '0'
  const fraction = (match[2] ?? '').padEnd(9, '0')
  return BigInt(whole) * 1_000_000_000n + BigInt(fraction || '0')
}

function amountFor(
  record: OfficialDeepSeekPriceRecord,
  usage: PriceUsageInput['usage'],
): MoneyAmount | undefined {
  const hit = decimalRateNanoUnits(record.inputCacheHit)
  const miss = decimalRateNanoUnits(record.inputCacheMiss)
  const output = decimalRateNanoUnits(record.output)
  if (hit === undefined || miss === undefined || output === undefined) return undefined
  const femtoUnits = BigInt(usage.cacheReadTokens) * hit
    + BigInt(usage.cacheMissTokens) * miss
    + BigInt(usage.outputTokens) * output
  return { femtoUnits: femtoUnits.toString(), decimal: formatFemto(femtoUnits) }
}

function formatFemto(value: bigint): string {
  const digits = value.toString().padStart(16, '0')
  const whole = digits.slice(0, -15)
  const fraction = digits.slice(-15).replace(/0+$/u, '')
  return fraction.length === 0 ? whole : `${whole}.${fraction}`
}

function modelPrices(
  version: string,
  usdOffPeak: readonly [string, string, string],
  usdPeak: readonly [string, string, string],
  cnyOffPeak: readonly [string, string, string],
  cnyPeak: readonly [string, string, string],
): ModelPrices {
  return Object.freeze({
    version,
    USD: Object.freeze({ 'off-peak': usdOffPeak, peak: usdPeak }),
    CNY: Object.freeze({ 'off-peak': cnyOffPeak, peak: cnyPeak }),
  })
}

function isOfficialModel(value: string): value is OfficialDeepSeekModelId {
  return Object.prototype.hasOwnProperty.call(PRICES, value)
}

function unpriced(reason: string): { readonly kind: 'unpriced'; readonly reason: string } {
  return { kind: 'unpriced', reason }
}
