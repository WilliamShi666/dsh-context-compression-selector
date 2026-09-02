/**
 * Current-session recovery tool for context-compression placeholders.
 *
 * It reads the immutable append-only event cited by a `session://.../event/N`
 * reference. The tool never reads the replacement surface as the source of
 * truth and never crosses into another Session.
 *
 * @module dsh-context-compression-selector-runtime/retrieve
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  parseTailTrimRef,
  validatePublishedTailTrim,
  type PublishedTailTrim,
} from './tail-trim.ts'
import { sessionEvents } from './session-events.ts'

export const name = 'context-compression-retrieve'
export const inject = ['tools', 'systemPrompt']

/** Maximum text returned by one recovery call. */
export interface Config {
  /** Hard response bound in Unicode code points. Defaults to 50000. */
  maxChars?: number
  /** Maximum source text inspected by one call. Defaults to 250000. */
  maxScanChars?: number
  /** Maximum query length in Unicode code points. Defaults to 256. */
  maxQueryChars?: number
}

/** Loader schema for the recovery tool's bounded runtime configuration. */
export const Config: z<Config> = z.object({
  maxChars: z.number().step(1).min(1).default(50_000),
  maxScanChars: z.number().step(1).min(1).default(250_000),
  maxQueryChars: z.number().step(1).min(1).default(256),
})

const REF_PATTERN = /^session:\/\/([^/]+)\/event\/(\d+)$/
const MAX_LINES = 1_000
const DEFAULT_MAX_CHARS = 50_000
const DEFAULT_MAX_SCAN_CHARS = 250_000
const DEFAULT_MAX_QUERY_CHARS = 256
const TRUNCATION_MARKER = '\n[context_compression_retrieve output truncated; reported lines describe the selected source range]\n'
const PROMPT = 'When a compacted tool result contains a session://<session-id>/event/<seq> reference, '
  + 'or TailTrim contains a session://<session-id>/tailtrim/<seq> reference, use context_compression_retrieve with that exact ref '
  + 'and a narrow line range or query if the omitted evidence is necessary. '
  + 'The returned event content comes from the append-only session log, which is the source of truth.'

const OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/**
 * Register the current-session recovery tool and its stable guidance.
 *
 * @param ctx Plugin context providing the tool registry and system prompt.
 * @param config Optional response, scan, and query bounds.
 */
export function installContextCompressionRetrieve(ctx: Context, config: Config = {}): void {
  const maxChars = resolvePositiveInteger('maxChars', config.maxChars, DEFAULT_MAX_CHARS)
  const maxScanChars = resolvePositiveInteger(
    'maxScanChars', config.maxScanChars, DEFAULT_MAX_SCAN_CHARS,
  )
  const maxQueryChars = resolvePositiveInteger(
    'maxQueryChars', config.maxQueryChars, DEFAULT_MAX_QUERY_CHARS,
  )
  ctx.systemPrompt.section({ name: 'tool:context-compression-retrieve', order: 114, text: PROMPT })
  ctx.tools.register(defineTool({
    name: 'context_compression_retrieve',
    description: 'Recover exact content from one compacted tool result or TailTrim group using its current-session session:// reference.',
    parameters: {
      ref: { type: 'string', required: true, description: 'Exact session://<current-session-id>/event/<seq> or /tailtrim/<seq> reference from a placeholder.' },
      query: { type: 'string', description: 'Optional case-insensitive text to search for inside the original result.' },
      start_line: { type: 'integer', description: 'Optional 1-based first line for a direct slice. Defaults to 1.' },
      max_lines: { type: 'integer', description: 'Maximum lines to return. Defaults to 200; maximum 1000.' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    execute(args, exec) {
      if (exec.agent === undefined) throw new Error('context_compression_retrieve requires an agent session')
      const match = REF_PATTERN.exec(args.ref)
      const tailTrimRef = parseTailTrimRef(args.ref)
      if (match === null && tailTrimRef === null) {
        throw new Error('context_compression_retrieve: ref must be session://<session-id>/(event|tailtrim)/<seq>')
      }
      const sessionId = match?.[1] ?? tailTrimRef?.sessionId
      if (sessionId !== String(exec.agent.id)) {
        throw new Error('context_compression_retrieve: a compression reference may only read the caller\'s current session')
      }
      if (tailTrimRef !== null) {
        return Promise.resolve(recoverTailTrim(
          exec.agent.session,
          args.ref,
          tailTrimRef.manifestSeq,
          args.query,
          args.start_line,
          args.max_lines,
          { maxChars, maxScanChars, maxQueryChars },
        ))
      }
      const seq = Number(match?.[2])
      const event = sessionEvents(exec.agent.session)[seq]
      if (event?.type !== 'tool/result') {
        throw new Error(`context_compression_retrieve: event ${String(seq)} is not a tool/result in the current session`)
      }
      const maxLines = resolveMaxLines(args.max_lines)
      const scan = scanBlocks(event.data.message.content[0].content, maxScanChars)
      const scannedLines = splitScannedLines(scan)
      const lines = scannedLines.lines
      const query = args.query
      if (query !== undefined && exceedsCodePointLimit(query, maxQueryChars)) {
        throw new Error(
          `context_compression_retrieve: query must be at most ${String(maxQueryChars)} Unicode code points`,
        )
      }
      const selected = query === undefined || query === ''
        ? directSlice(lines, args.start_line ?? 1, maxLines, scan.complete, scannedLines.partialTail)
        : querySlice(lines, query, maxLines, scan.complete, scannedLines.partialTail)
      const total = scan.complete ? String(lines.length) : `at least ${String(lines.length)}`
      const header = [
        `source: ${args.ref}`,
        `tool_call_id: ${event.data.message.source.callId}`,
        `status: ${event.data.message.content[0].isError === true ? 'error' : 'completed'}`,
        `lines: ${String(selected.start)}-${String(selected.end)} of ${total}`,
        scan.complete ? '' : 'note: source scan limit reached; later lines were not inspected',
        selected.partialLine === undefined
          ? ''
          : `note: line ${String(selected.partialLine)} is a partial prefix ending at the source scan limit`,
        selected.omitted
          ? query === undefined || query === ''
            ? 'note: additional source lines were omitted'
            : 'note: additional matching or neighboring lines were omitted'
          : '',
        '--- original tool result ---',
      ].filter(Boolean).join('\n')
      const output = `${header}\n${selected.text}`
      return Promise.resolve(boundCodePoints(output, maxChars))
    },
  }))
}

function recoverTailTrim(
  session: Parameters<typeof validatePublishedTailTrim>[0],
  ref: string,
  manifestSeq: number,
  query: string | undefined,
  startLine: number | undefined,
  requestedMaxLines: number | undefined,
  bounds: { readonly maxChars: number; readonly maxScanChars: number; readonly maxQueryChars: number },
): string {
  const published = validatePublishedTailTrim(session, manifestSeq)
  if (published === null || published.ref !== ref) {
    throw new Error('context_compression_retrieve: ref is not a valid published TailTrim group')
  }
  if (query !== undefined && exceedsCodePointLimit(query, bounds.maxQueryChars)) {
    throw new Error(
      `context_compression_retrieve: query must be at most ${String(bounds.maxQueryChars)} Unicode code points`,
    )
  }
  const fixedHeader = [
    `source: ${ref}`,
    'kind: tailtrim-group',
    `records: ${String(published.roots.length)}`,
    '--- original tool group (jsonl) ---',
  ].join('\n')
  const scanBudget = Math.max(0, bounds.maxScanChars - codePointLength(`${fixedHeader}\n`))
  const scan = consumeChunks(renderGroupRecordChunks(published.roots), scanBudget)
  const scannedLines = splitScannedLines(scan)
  const maxLines = resolveMaxLines(requestedMaxLines)
  const selected = query === undefined || query === ''
    ? directSlice(
      scannedLines.lines,
      startLine ?? 1,
      maxLines,
      scan.complete,
      scannedLines.partialTail,
    )
    : querySlice(
      scannedLines.lines,
      query,
      maxLines,
      scan.complete,
      scannedLines.partialTail,
    )
  const header = [
    fixedHeader.split('\n').slice(0, 3).join('\n'),
    scan.complete ? '' : 'note: source scan limit reached; later records were not inspected',
    selected.omitted ? 'note: additional group records were omitted' : '',
    '--- original tool group (jsonl) ---',
  ].filter(Boolean).join('\n')
  return boundCodePoints(`${header}\n${selected.text}`, bounds.maxChars)
}

interface ScanResult {
  readonly text: string
  readonly complete: boolean
}

interface ScannedLines {
  readonly lines: readonly string[]
  readonly partialTail: boolean
}

interface Selection {
  readonly text: string
  readonly start: number
  readonly end: number
  readonly omitted: boolean
  readonly partialLine?: number
}

function resolvePositiveInteger(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`tool-context-retrieve: ${name} must be a positive safe integer`)
  }
  return resolved
}

function resolveMaxLines(value: number | undefined): number {
  const resolved = value ?? 200
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > MAX_LINES) {
    throw new Error(`context_compression_retrieve: max_lines must be an integer from 1 to ${String(MAX_LINES)}`)
  }
  return resolved
}

function scanBlocks(blocks: readonly ContentBlock[], maxChars: number): ScanResult {
  return consumeChunks(renderBlockChunks(blocks), maxChars)
}

function* renderBlockChunks(blocks: readonly ContentBlock[]): Generator<string> {
  let first = true
  for (const block of blocks) {
    if (!first) yield '\n'
    first = false
    if (block.type === 'text') yield block.text
    else yield* jsonTokens(block)
  }
}

function* renderGroupRecordChunks(roots: PublishedTailTrim['roots']): Generator<string> {
  let first = true
  for (const root of roots) {
    if (!first) yield '\n'
    first = false
    const message = root.data.message
    yield* jsonTokens({
      seq: root.seq,
      type: root.type,
      message: {
        id: message.id,
        role: message.role,
        content: message.content,
        source: message.source,
      },
    })
  }
}

function* jsonTokens(value: unknown): Generator<string> {
  if (value === null) {
    yield 'null'
    return
  }
  switch (typeof value) {
    case 'string':
      yield '"'
      for (const point of value) {
        const quoted = jsonScalar(point)
        yield quoted.slice(1, -1)
      }
      yield '"'
      return
    case 'number':
    case 'boolean':
      yield jsonScalar(value)
      return
    case 'object':
      if (Array.isArray(value)) {
        yield '['
        for (let index = 0; index < value.length; index++) {
          if (index > 0) yield ','
          yield* jsonTokens(value[index])
        }
        yield ']'
        return
      }
      yield '{'
      let first = true
      for (const key in value) {
        if (!Object.hasOwn(value, key)) continue
        if (!first) yield ','
        first = false
        yield* jsonTokens(key)
        yield ':'
        yield* jsonTokens((value as Record<string, unknown>)[key])
      }
      yield '}'
      return
    default:
    throw new TypeError('context_compression_retrieve: source content is not JSON-serializable')
  }
}

function jsonScalar(value: string | number | boolean): string {
  return JSON.stringify(value)
}

function consumeChunks(chunks: Iterable<string>, maxChars: number): ScanResult {
  const output: string[] = []
  let remaining = maxChars
  for (const chunk of chunks) {
    const prefix = codePointPrefix(chunk, remaining)
    output.push(prefix.text)
    remaining -= prefix.count
    if (!prefix.complete) return { text: output.join(''), complete: false }
  }
  return { text: output.join(''), complete: true }
}

function splitScannedLines(scan: ScanResult): ScannedLines {
  const lines = scan.text.split('\n')
  const partialTail = !scan.complete && !scan.text.endsWith('\n')
  if (scan.text.endsWith('\n')) lines.pop()
  return { lines, partialTail }
}

function directSlice(
  lines: readonly string[],
  startLine: number,
  maxLines: number,
  scanComplete: boolean,
  partialTail: boolean,
): Selection {
  if (!Number.isSafeInteger(startLine) || startLine < 1) {
    throw new Error('context_compression_retrieve: start_line must be a positive safe integer')
  }
  if (startLine > lines.length) {
    const reason = scanComplete ? 'outside the source line range' : 'beyond the source scan limit'
    throw new Error(`context_compression_retrieve: start_line ${String(startLine)} is ${reason}`)
  }
  const startIndex = startLine - 1
  const selected = lines.slice(startIndex, startIndex + maxLines)
  return {
    text: selected.join('\n'),
    start: startIndex + 1,
    end: startIndex + selected.length,
    omitted: startIndex > 0 || startIndex + selected.length < lines.length || !scanComplete,
    ...partialTail && startIndex + selected.length === lines.length
      ? { partialLine: lines.length }
      : {},
  }
}

function querySlice(
  lines: readonly string[],
  query: string,
  maxLines: number,
  scanComplete: boolean,
  partialTail: boolean,
): Selection {
  const needle = query.toLowerCase()
  const chosen = new Set<number>()
  let matched = false
  let omitted = !scanComplete
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line === undefined || !line.toLowerCase().includes(needle)) continue
    matched = true
    for (let row = Math.max(0, index - 2); row <= Math.min(lines.length - 1, index + 2); row++) {
      if (chosen.has(row)) continue
      if (chosen.size >= maxLines) {
        omitted = true
        continue
      }
      chosen.add(row)
    }
  }
  if (!matched) {
    return {
      text: scanComplete ? '[no matches]' : '[no matches within source scan limit]',
      start: 0,
      end: 0,
      omitted,
    }
  }
  const ordered = [...chosen].sort((a, b) => a - b)
  const rendered: string[] = []
  let previous = -2
  let start = 0
  let end = 0
  for (const index of ordered) {
    const line = lines[index]
    if (line === undefined) continue
    if (index > previous + 1) rendered.push('...')
    rendered.push(`${String(index + 1)}: ${line}`)
    if (start === 0) start = index + 1
    end = index + 1
    previous = index
  }
  return {
    text: rendered.join('\n'),
    start,
    end,
    omitted,
    ...partialTail && ordered.includes(lines.length - 1)
      ? { partialLine: lines.length }
      : {},
  }
}

function boundCodePoints(text: string, maxChars: number): string {
  const bounded = codePointPrefix(text, maxChars)
  if (bounded.complete) return text
  const marker = codePointPrefix(TRUNCATION_MARKER, maxChars)
  if (!marker.complete) return marker.text
  const body = codePointPrefix(text, maxChars - marker.count)
  return body.text + marker.text
}

function codePointPrefix(text: string, maxChars: number): {
  readonly text: string
  readonly count: number
  readonly complete: boolean
} {
  const output: string[] = []
  let count = 0
  for (const point of text) {
    if (count >= maxChars) return { text: output.join(''), count, complete: false }
    output.push(point)
    count++
  }
  return { text: output.join(''), count, complete: true }
}

function exceedsCodePointLimit(text: string, limit: number): boolean {
  let count = 0
  for (const _point of text) {
    count++
    if (count > limit) return true
  }
  return false
}

function codePointLength(text: string): number {
  let count = 0
  for (const _point of text) count++
  return count
}
