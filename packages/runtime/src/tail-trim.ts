/** Plugin-owned TailTrim publication protocol over official Session events. */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

const TAIL_TRIM_REF_PATTERN = /^session:\/\/([^/]+)\/tailtrim\/(\d+)$/
const MAX_ROOTS = 64
const MAX_STUB_CODE_POINTS = 1_024

/** A standard prune plus adjacent user-message replacement that validates. */
export interface PublishedTailTrim {
  readonly manifest: SessionEvent<'compaction/prune'>
  readonly replacement: SessionEvent<'user/message'>
  readonly roots: readonly (
    SessionEvent<'assistant/message'> | SessionEvent<'tool/result'>
  )[]
  readonly toolNames: readonly string[]
  readonly ref: string
  readonly stub: string
}

/** Build a same-session reference keyed by the standard prune event. */
export function tailTrimRef(sessionId: string, manifestSeq: number): string {
  return `session://${sessionId}/tailtrim/${String(manifestSeq)}`
}

/** Parse one exact TailTrim reference. */
export function parseTailTrimRef(ref: string): { sessionId: string; manifestSeq: number } | null {
  const match = TAIL_TRIM_REF_PATTERN.exec(ref)
  if (match === null) return null
  const manifestSeq = Number(match[2])
  if (!Number.isSafeInteger(manifestSeq) || manifestSeq < 0) return null
  return { sessionId: match[1] ?? '', manifestSeq }
}

/** Build the fixed bounded model-visible TailTrim stub. */
export function tailTrimStub(
  ref: string,
  toolNames: readonly string[],
  sourceEventSeqs: readonly number[],
): string | null {
  const stub = [
    '[TailTrim: completed tool-call group]',
    `ref: ${ref}`,
    `tools: ${toolNames.join(', ')}`,
    `source_event_seqs: ${sourceEventSeqs.join(', ')}`,
    'use context_compression_retrieve with this TailTrim ref if needed',
  ].join('\n')
  return Array.from(stub).length <= MAX_STUB_CODE_POINTS ? stub : null
}

/** Wrap a TailTrim stub in the one user message used for range replacement. */
export function tailTrimMessage(stub: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: stub }],
    source: { kind: 'plugin', plugin: 'dsh-context-compression-selector-runtime' },
  })
}

/** Validate the standard prune, adjacent replacement, append roots and stub. */
export function validatePublishedTailTrim(
  session: Session,
  manifestSeq: number,
): PublishedTailTrim | null {
  const manifest = session.events[manifestSeq]
  if (manifest?.type !== 'compaction/prune'
    || manifest.data.shadowedSeqs.length < 2
    || manifest.data.shadowedSeqs.length > MAX_ROOTS
    || manifest.data.shadowedSeqs[0] !== manifest.data.shadowedRange.start
    || manifest.data.shadowedSeqs.at(-1) !== manifest.data.shadowedRange.end
    || new Set(manifest.data.shadowedSeqs).size !== manifest.data.shadowedSeqs.length) return null
  const replacement = session.events[manifestSeq + 1]
  if (replacement?.type !== 'user/message'
    || replacement.seq !== manifest.seq + 1
    || replacement.data.source.kind !== 'plugin'
    || replacement.data.source.plugin !== 'dsh-context-compression-selector-runtime'
    || replacement.surfaceOp === undefined
    || replacement.surfaceOp === 'append'
    || replacement.surfaceOp.start !== manifest.data.shadowedRange.start
    || replacement.surfaceOp.end !== manifest.data.shadowedRange.end
    || !sameNumbers(
      replacement.sourceEventSeqs,
      [manifest.seq, ...manifest.data.shadowedSeqs],
    )
    || replacement.data.content.length !== 1
    || replacement.data.content[0]?.type !== 'text') return null

  const tracedRoots = manifest.data.shadowedSeqs.map(seq => uniqueAppendRoot(session, seq, manifestSeq))
  if (tracedRoots.some(root => root === null)) return null
  const sourceEventSeqs = tracedRoots as number[]
  if (new Set(sourceEventSeqs).size !== sourceEventSeqs.length) return null
  const roots = sourceEventSeqs.map(seq => session.events[seq])
  if (roots.some((event): event is undefined => event === undefined)) return null
  const typedRoots = roots as SessionEvent[]
  if (!validRootGroup(typedRoots, manifestSeq)) return null
  const assistant = typedRoots[0]
  if (assistant?.type !== 'assistant/message') return null
  const toolNames = assistant.data.message.content.map((block) => {
    if (block.type !== 'tool-call') throw new Error('unreachable')
    return block.name
  })
  const ref = tailTrimRef(String(session.id), manifestSeq)
  const stub = tailTrimStub(ref, toolNames, sourceEventSeqs)
  if (stub === null || replacement.data.content[0].text !== stub) return null
  return {
    manifest,
    replacement,
    roots: typedRoots as PublishedTailTrim['roots'],
    toolNames,
    ref,
    stub,
  }
}

function uniqueAppendRoot(session: Session, seq: number, beforeSeq: number): number | null {
  const pending: Array<{ readonly seq: number; readonly depth: number }> = [{ seq, depth: 0 }]
  const visited = new Set<number>()
  const roots = new Set<number>()
  while (pending.length > 0) {
    const next = pending.pop()
    if (next === undefined || next.depth > MAX_ROOTS || visited.has(next.seq)) continue
    if (!Number.isSafeInteger(next.seq) || next.seq < 0 || next.seq >= beforeSeq) return null
    visited.add(next.seq)
    if (visited.size > MAX_ROOTS) return null
    const event = session.events[next.seq]
    if (event === undefined || (event.type !== 'assistant/message' && event.type !== 'tool/result')) return null
    if (event.surfaceOp === 'append') roots.add(event.seq)
    else if (typeof event.surfaceOp === 'object') {
      const sources = event.sourceEventSeqs
      if (sources === undefined || sources.length === 0) return null
      for (const source of sources) pending.push({ seq: source, depth: next.depth + 1 })
    } else return null
    if (roots.size > 1) return null
  }
  return roots.size === 1 ? [...roots][0] ?? null : null
}

function validRootGroup(roots: readonly SessionEvent[], manifestSeq: number): boolean {
  const assistant = roots[0]
  if (assistant?.type !== 'assistant/message' || assistant.seq >= manifestSeq
    || assistant.surfaceOp !== 'append' || assistant.data.interrupted === true
    || assistant.data.message.content.length === 0
    || assistant.data.message.content.some(block => block.type !== 'tool-call')) return false
  const calls = assistant.data.message.content as Extract<ContentBlock, { type: 'tool-call' }>[]
  const callIds = calls.map(call => call.id)
  if (new Set(callIds).size !== callIds.length || roots.length !== callIds.length + 1) return false
  for (const [index, root] of roots.slice(1).entries()) {
    if (root.type !== 'tool/result' || root.seq >= manifestSeq || root.surfaceOp !== 'append') return false
    const result = root.data.message.content[0]
    if (result.isError === true
      || root.data.error !== undefined
      || root.data.turn !== assistant.data.turn
      || root.data.step !== assistant.data.step
      || String(root.data.message.source.callId) !== String(callIds[index])) return false
  }
  return true
}

function sameNumbers(left: readonly number[] | undefined, right: readonly number[]): boolean {
  return left !== undefined && left.length === right.length
    && left.every((value, index) => value === right[index])
}
