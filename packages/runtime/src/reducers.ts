/** Deterministic, evidence-backed reducers for fresh tool results. */

import { codePointLength } from './config.ts'

/** Input shared by every fresh-result reducer. */
export interface ReducerInput {
  readonly toolName: string
  readonly argumentsText: string
  readonly text: string
  readonly budgetChars: number
  readonly sourceRef: string
  readonly isError: boolean
}

/** One verified reducer candidate. */
export interface ReducerOutput {
  readonly text: string
  readonly reducer: string
  readonly lossy: boolean
}

const ANSI_PATTERN = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/gu
const IMPORTANT_PATTERN = new RegExp([
  String.raw`\b(?:error|failed|failure|fatal|panic|exception|warning|warn|conflict|denied|forbidden|`,
  String.raw`timeout|timed out|not found|cannot|unable|invalid|exit(?:ed)?\s+(?:code|status)|traceback|`,
  String.raw`assert(?:ion)?|segmentation fault|oom|out of memory)\b`,
].join(''), 'i')
const STATUS_PATTERN = new RegExp([
  String.raw`\b(?:success|succeeded|passed|installed|added|removed|updated|built|compiled|`,
  String.raw`tests?\s+(?:passed|failed)|exit(?:ed)?\s+(?:code|status))\b`,
].join(''), 'i')
const PATH_LINE_PATTERN = /^(.*?):(\d+)(?::\d+)?(?::|\s+-\s+)(.*)$/
const GIT_STATUS_PATTERN = new RegExp([
  String.raw`^(?:On branch|Your branch|HEAD detached|Changes |Untracked |Unmerged |\s*(?:modified|deleted|`,
  String.raw`new file|renamed|both modified):)`,
].join(''), 'i')

/**
 * Select a reducer from verified tool, command, and content evidence.
 * @param input - original result text, recovery source, and output budget.
 * @returns a verified candidate, or `null` when every reducer fails open.
 */
export function reduceFreshToolResult(input: ReducerInput): ReducerOutput | null {
  const normalized = normalizeTerminalText(input.text)
  const prepared = { ...input, text: normalized }
  const command = extractCommand(input.argumentsText)
  const name = input.toolName.toLowerCase()
  const candidates: Array<() => ReducerOutput | null> = []

  if (looksLikeJson(normalized)) candidates.push(() => reduceJson(prepared))
  if (isSearchTool(name, command)) candidates.push(() => reduceSearch(prepared))
  if (isReadTool(name)) candidates.push(() => reduceHead(prepared, 'pi-head'))
  if (isGitCommand(name, command)) candidates.push(() => reduceGit(prepared, command))
  if (isPackageCommand(command)) candidates.push(() => reducePatternLog(prepared, 'hypa-package', packagePattern()))
  if (isBuildOrTestCommand(command)) candidates.push(() => reducePatternLog(prepared, 'hypa-build-test', buildPattern()))
  if (isShellTool(name) || command !== '') candidates.push(() => reduceShell(prepared))
  candidates.push(() => reduceSalient(prepared, 'generic-salience'))

  for (const make of candidates) {
    const candidate = make()
    if (candidate !== null && verifyReduction(input, candidate)) return candidate
  }
  return null
}

/**
 * Build a recoverable placeholder for an old tool result.
 * @param input - tool identity, source reference, size, status, and retained evidence.
 * @returns a lossy placeholder that cites the immutable source event.
 */
export function historicalPlaceholder(input: {
  readonly toolName: string
  readonly sourceRef: string
  readonly charsBefore: number
  readonly isError: boolean
  readonly text: string
  readonly compact?: boolean
}): ReducerOutput {
  const anchor = input.compact ? '' : importantAnchor(input.text, 360)
  const lines = [
    '[Old tool result content cleared from active context]',
    `tool: ${input.toolName || 'unknown'}`,
    `status: ${input.isError ? 'error' : 'completed'}`,
    `original_chars: ${String(input.charsBefore)}`,
    `source: ${input.sourceRef}`,
    'retrieve: context_compression_retrieve({"ref":"' + input.sourceRef + '"})',
  ]
  if (anchor !== '') lines.push(`retained_anchor: ${anchor}`)
  return {
    text: lines.join('\n'),
    reducer: input.compact ? 'pair-preserving-tail-aging' : 'historical-tool-result-aging',
    lossy: true,
  }
}

/**
 * Validate shrinkage, budget, recovery, and error retention.
 * @param input - original reducer input and its safety requirements.
 * @param output - candidate reduced text and reducer metadata.
 * @returns whether the candidate is safe to land.
 */
export function verifyReduction(input: ReducerInput, output: ReducerOutput): boolean {
  const before = codePointLength(input.text)
  const after = codePointLength(output.text)
  if (after <= 0 || after >= before || after > input.budgetChars) return false
  if (output.lossy && !output.text.includes(input.sourceRef)) return false
  if ((input.isError || IMPORTANT_PATTERN.test(input.text))
    && !IMPORTANT_PATTERN.test(output.text) && !output.text.includes('status: error')) return false
  return true
}

/**
 * Strip ANSI, collapse carriage-return progress redraws, and fold exact repeats.
 * @param text - raw terminal output.
 * @returns normalized terminal text.
 */
export function normalizeTerminalText(text: string): string {
  const withoutAnsi = text.replace(ANSI_PATTERN, '')
  const logical = withoutAnsi.split('\n').map((line) => {
    const redraws = line.split('\r').filter(part => part !== '')
    return redraws.at(-1) ?? ''
  })
  const folded: string[] = []
  let previous: string | undefined
  let count = 0
  const flush = (): void => {
    if (previous === undefined) return
    folded.push(previous)
    if (count > 1) folded.push(`[previous line repeated ${String(count - 1)} more times]`)
  }
  for (const line of logical) {
    if (line === previous) {
      count++
      continue
    }
    flush()
    previous = line
    count = 1
  }
  flush()
  return folded.join('\n')
}

function reduceHead(input: ReducerInput, reducer: string): ReducerOutput | null {
  const marker = omissionMarker(input, reducer)
  const available = input.budgetChars - codePointLength(marker) - 1
  if (available <= 0) return null
  const head = takeWholeLinesFromHead(input.text, available)
  if (head === input.text || head === '') return null
  return { text: `${head}\n${marker}`, reducer, lossy: true }
}

function reduceTail(input: ReducerInput, reducer: string): ReducerOutput | null {
  const marker = omissionMarker(input, reducer)
  const available = input.budgetChars - codePointLength(marker) - 1
  if (available <= 0) return null
  const tail = takeWholeLinesFromTail(input.text, available)
  if (tail === input.text || tail === '') return null
  return { text: `${marker}\n${tail}`, reducer, lossy: true }
}

function reduceJson(input: ReducerInput): ReducerOutput | null {
  let value: unknown
  try {
    value = JSON.parse(input.text)
  } catch {
    return null
  }
  const minified = JSON.stringify(value)
  if (codePointLength(minified) < codePointLength(input.text)
    && codePointLength(minified) <= input.budgetChars) {
    return { text: minified, reducer: 'json-minify', lossy: false }
  }
  const envelope = {
    $dsh_compression: {
      kind: 'json-preview',
      source: input.sourceRef,
      original_chars: codePointLength(input.text),
    },
    value: shrinkJson(value, 0),
  }
  const text = JSON.stringify(envelope, null, 2)
  if (codePointLength(text) <= input.budgetChars) {
    return { text, reducer: 'json-structure-preview', lossy: true }
  }
  return null
}

function shrinkJson(value: unknown, depth: number): unknown {
  if (depth >= 5) {
    if (Array.isArray(value)) return `[array length=${String(value.length)} omitted]`
    if (typeof value === 'object' && value !== null) return '[object omitted]'
    return value
  }
  if (Array.isArray(value)) {
    if (value.length <= 8) return value.map(entry => shrinkJson(entry, depth + 1))
    return [
      ...value.slice(0, 3).map(entry => shrinkJson(entry, depth + 1)),
      { $dsh_omitted_items: value.length - 5 },
      ...value.slice(-2).map(entry => shrinkJson(entry, depth + 1)),
    ]
  }
  if (typeof value !== 'object' || value === null) {
    if (typeof value === 'string' && codePointLength(value) > 800) {
      return `${Array.from(value).slice(0, 500).join('')}…[${String(codePointLength(value) - 700)} chars omitted]…${Array.from(value).slice(-200).join('')}`
    }
    return value
  }
  const entries = Object.entries(value)
  const important = entries.filter(([key]) => /error|warn|status|code|message|path|file|line|summary/i.test(key))
  const selected = entries.length <= 18
    ? entries
    : [...entries.slice(0, 10), ...important.filter(entry => !entries.slice(0, 10).includes(entry)).slice(0, 6), ...entries.slice(-2)]
  const result: Record<string, unknown> = {}
  for (const [key, entry] of selected) result[key] = shrinkJson(entry, depth + 1)
  if (selected.length < entries.length) result.$dsh_omitted_keys = entries.length - selected.length
  return result
}

function reduceSearch(input: ReducerInput): ReducerOutput | null {
  const lines = splitLines(input.text)
  const groups = new Map<string, Array<{ line: string; important: boolean }>>()
  const ungrouped: Array<{ line: string; important: boolean }> = []
  for (const line of lines) {
    const match = PATH_LINE_PATTERN.exec(line)
    const row = { line, important: IMPORTANT_PATTERN.test(line) }
    if (match === null) {
      ungrouped.push(row)
      continue
    }
    const path = match[1] ?? '<unknown>'
    const bucket = groups.get(path) ?? []
    bucket.push(row)
    groups.set(path, bucket)
  }
  if (groups.size === 0) return reduceSalient(input, 'search-salience')
  const selected: string[] = []
  let omitted = 0
  for (const [path, rows] of groups) {
    const keep = new Set<number>([0, rows.length - 1])
    rows.forEach((row, index) => { if (row.important) keep.add(index) })
    for (let index = 0; index < rows.length && keep.size < 5; index++) keep.add(index)
    const indexes = [...keep].filter(index => index >= 0).sort((a, b) => a - b)
    selected.push(`## ${path} (${String(rows.length)} matches)`)
    for (const index of indexes) {
      const row = rows[index]
      if (row !== undefined) selected.push(row.line)
    }
    omitted += rows.length - indexes.length
  }
  for (const row of ungrouped.filter(row => row.important).slice(0, 12)) selected.push(row.line)
  const header = `[search results compressed; ${String(omitted)} matches omitted; source: ${input.sourceRef}]`
  const text = fitLines([header, ...selected], input.budgetChars, input.sourceRef)
  return text === null ? null : { text, reducer: 'search-by-file', lossy: true }
}

function reduceGit(input: ReducerInput, command: string): ReducerOutput | null {
  const lines = splitLines(input.text)
  const lower = command.toLowerCase()
  let keep: string[]
  let reducer: string
  if (/\bgit\s+(?:diff|show)\b/.test(lower)) {
    reducer = 'hypa-git-diff'
    keep = lines.filter(line => /^(?:diff --git|index |--- |\+\+\+ |@@ |[+-](?![+-]))/.test(line)
      || IMPORTANT_PATTERN.test(line))
  } else if (/\bgit\s+(?:status|switch|checkout|merge|rebase|cherry-pick)\b/.test(lower)) {
    reducer = 'hypa-git-status'
    keep = lines.filter(line => GIT_STATUS_PATTERN.test(line)
      || IMPORTANT_PATTERN.test(line))
  } else {
    reducer = 'hypa-git-log'
    keep = lines.filter(line => /^(?:commit\s+[0-9a-f]+|Author:|Date:|[0-9a-f]{7,}\s)/i.test(line)
      || IMPORTANT_PATTERN.test(line))
  }
  if (keep.length === 0) return reduceSalient(input, reducer)
  const header = `[git output compressed; source: ${input.sourceRef}]`
  const text = fitLines([header, ...keep, ...lines.slice(-8)], input.budgetChars, input.sourceRef)
  return text === null ? null : { text, reducer, lossy: true }
}

function reducePatternLog(input: ReducerInput, reducer: string, pattern: RegExp): ReducerOutput | null {
  const lines = splitLines(input.text)
  const important = lines.filter(line => pattern.test(line) || IMPORTANT_PATTERN.test(line) || STATUS_PATTERN.test(line))
  const header = `[command output compressed by ${reducer}; source: ${input.sourceRef}]`
  const text = fitLines([header, ...important, ...lines.slice(-20)], input.budgetChars, input.sourceRef)
  return text === null ? null : { text, reducer, lossy: true }
}

function reduceShell(input: ReducerInput): ReducerOutput | null {
  const lines = splitLines(input.text)
  const important = lines.filter(line => IMPORTANT_PATTERN.test(line))
  if (important.length === 0) return reduceTail(input, 'pi-tail')
  const header = `[shell/log output compressed; source: ${input.sourceRef}]`
  const text = fitLines([header, ...important, '--- final output ---', ...lines.slice(-40)], input.budgetChars, input.sourceRef)
  return text === null ? null : { text, reducer: 'shell-salience-tail', lossy: true }
}

function reduceSalient(input: ReducerInput, reducer: string): ReducerOutput | null {
  const lines = splitLines(input.text)
  if (lines.length < 3) return reduceHead(input, reducer)
  const marker = omissionMarker(input, reducer)
  const headBudget = Math.max(1, Math.floor((input.budgetChars - codePointLength(marker)) * 0.34))
  const tailBudget = headBudget
  const head = takeWholeLinesFromHead(input.text, headBudget)
  const tail = takeWholeLinesFromTail(input.text, tailBudget)
  const salient = lines.filter(line => IMPORTANT_PATTERN.test(line) || STATUS_PATTERN.test(line)).slice(0, 24)
  const text = fitLines([head, ...salient, marker, tail], input.budgetChars, input.sourceRef)
  return text === null ? null : { text, reducer, lossy: true }
}

function omissionMarker(input: ReducerInput, reducer: string): string {
  return `[... ${reducer} omitted content; original_chars=${String(codePointLength(input.text))}; source=${input.sourceRef}; retrieve with context_compression_retrieve ...]`
}

function importantAnchor(text: string, maxChars: number): string {
  const lines = splitLines(normalizeTerminalText(text))
  const chosen = lines.find(line => IMPORTANT_PATTERN.test(line)) ?? lines.at(-1) ?? ''
  return Array.from(chosen.trim()).slice(0, maxChars).join('')
}

function fitLines(lines: readonly string[], budgetChars: number, requiredRef: string): string | null {
  const unique: string[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    if (line === '' || seen.has(line)) continue
    seen.add(line)
    unique.push(line)
  }
  const output: string[] = []
  let used = 0
  for (const line of unique) {
    const cost = codePointLength(line) + (output.length === 0 ? 0 : 1)
    if (used + cost > budgetChars) continue
    output.push(line)
    used += cost
  }
  const text = output.join('\n')
  return text.includes(requiredRef) ? text : null
}

function takeWholeLinesFromHead(text: string, budgetChars: number): string {
  const output: string[] = []
  let used = 0
  for (const line of splitLines(text)) {
    const cost = codePointLength(line) + (output.length === 0 ? 0 : 1)
    if (used + cost > budgetChars) break
    output.push(line)
    used += cost
  }
  if (output.length === 0) return Array.from(text).slice(0, budgetChars).join('')
  return output.join('\n')
}

function takeWholeLinesFromTail(text: string, budgetChars: number): string {
  const lines = splitLines(text)
  const output: string[] = []
  let used = 0
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (line === undefined) continue
    const cost = codePointLength(line) + (output.length === 0 ? 0 : 1)
    if (used + cost > budgetChars) break
    output.unshift(line)
    used += cost
  }
  if (output.length === 0) return Array.from(text).slice(-budgetChars).join('')
  return output.join('\n')
}

function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  return lines
}

function extractCommand(argumentsText: string): string {
  try {
    const parsed = JSON.parse(argumentsText) as unknown
    if (typeof parsed !== 'object' || parsed === null) return ''
    const record = parsed as Record<string, unknown>
    for (const key of ['command', 'cmd', 'script', 'input']) {
      const value = record[key]
      if (typeof value === 'string') return value
    }
  } catch {
    return ''
  }
  return ''
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trim()
  return (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'))
}

function isReadTool(name: string): boolean {
  return /(?:^|[-_/])(?:read|cat|view|open_file)(?:$|[-_/])/.test(name)
}

function isSearchTool(name: string, command: string): boolean {
  return /(?:grep|search|glob|find|ripgrep|rg)/.test(name)
    || /(?:^|\s)(?:rg|grep|find|fd)\s/.test(command)
}

function isShellTool(name: string): boolean {
  return /(?:bash|shell|terminal|powershell|pwsh|exec|command)/.test(name)
}

function isGitCommand(name: string, command: string): boolean {
  return name.includes('git') || /(?:^|\s)git\s/.test(command)
}

function isPackageCommand(command: string): boolean {
  return /(?:^|\s)(?:npm|pnpm|yarn|bun|pip|pip3|uv|poetry)\s/.test(command)
}

function isBuildOrTestCommand(command: string): boolean {
  const pattern = new RegExp([
    String.raw`(?:^|\s)(?:tsc|dotnet\s+(?:build|test)|pytest|cargo\s+(?:build|test|check)|go\s+test|mvn\s+test|`,
    String.raw`gradle|npm\s+(?:test|run\s+build)|pnpm\s+(?:test|build|lint)|yarn\s+(?:test|build|lint))\b`,
  ].join(''))
  return pattern.test(command)
}

function packagePattern(): RegExp {
  return new RegExp([
    String.raw`(?:ERR!|WARN|warning|error|failed|conflict|peer dep|added\s+\d+|removed\s+\d+|installed|success|`,
    String.raw`up to date|packages?\s+(?:added|removed|changed)|resolution|No matching distribution|Could not find a version)`,
  ].join(''), 'i')
}

function buildPattern(): RegExp {
  return new RegExp([
    String.raw`(?:error\s+TS\d+|warning\s+TS\d+|FAILED|FAIL\b|AssertionError|expected|actual|`,
    String.raw`tests?\s+(?:run|passed|failed|skipped)|Build\s+(?:succeeded|FAILED)|\d+\s+Error\(s\)|`,
    String.raw`\d+\s+Warning\(s\)|Finished\s+test|compilation failed)`,
  ].join(''), 'i')
}
