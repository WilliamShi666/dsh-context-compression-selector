/** Package-owned invariants for standard-prune compression publications. */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-compaction'
import { validatePublishedTailTrim } from './tail-trim.ts'

const PACKAGE_NAME = 'dsh-context-compression-selector-runtime'

/** Cordis companion plugin name. */
export const name = 'context-compression-selector-runtime-invariant'
/** Services required before the companion can register. */
export const inject = ['invariants']

type PruneEvent = SessionEvent<'compaction/prune'>

/** Whether the next event claims the unresolved prune's replacement range. */
function resemblesCompanion(prune: PruneEvent, event: SessionEvent): boolean {
  if ((event.type !== 'tool/result' && event.type !== 'user/message')
    || typeof event.surfaceOp !== 'object') return false
  const sources = new Set(event.sourceEventSeqs ?? [])
  return (event.surfaceOp.start === prune.data.shadowedRange.start
      && event.surfaceOp.end === prune.data.shadowedRange.end)
    || prune.data.shadowedSeqs.some(seq => sources.has(seq))
}

/** Validate one standard prune's immediately adjacent surface replacement. */
function validateCompanion(
  session: Session,
  prune: PruneEvent,
  event: SessionEvent,
  fail: InvariantFailure,
): void {
  if ((event.type !== 'tool/result' && event.type !== 'user/message')
    || typeof event.surfaceOp !== 'object') {
    fail(`compaction/prune at seq ${prune.seq} must be immediately followed by a replacement surface event`)
  }
  const { shadowedRange, shadowedSeqs } = prune.data
  if (shadowedSeqs.length === 0
    || shadowedSeqs[0] !== shadowedRange.start
    || shadowedSeqs.at(-1) !== shadowedRange.end) {
    fail(`compaction/prune at seq ${prune.seq} has a shadowed range inconsistent with shadowedSeqs`)
  }
  if (event.surfaceOp.start !== shadowedRange.start || event.surfaceOp.end !== shadowedRange.end) {
    fail(`replacement at seq ${event.seq} does not replace compaction/prune range ${shadowedRange.start}-${shadowedRange.end}`)
  }
  const sources = new Set(event.sourceEventSeqs ?? [])
  const missing = shadowedSeqs.filter(seq => !sources.has(seq))
  if (missing.length > 0) {
    fail(`replacement at seq ${event.seq} omits shadowed source seqs ${missing.join(', ')}`)
  }
  if (event.type === 'user/message' && validatePublishedTailTrim(session, prune.seq) === null) {
    fail(`TailTrim publication at seq ${prune.seq} is invalid`)
  }
}

/** Validate a replayed log and return its only legal unresolved tail. */
function seedPending(session: Session, fail: InvariantFailure): PruneEvent | undefined {
  let pending: PruneEvent | undefined
  for (const event of session.events) {
    if (pending !== undefined) {
      // A prune whose synchronous companion never committed is an inert,
      // aborted publication. It must not brick a restored Session. A surface
      // replacement that claims the prune is still validated strictly.
      if (resemblesCompanion(pending, event)) validateCompanion(session, pending, event, fail)
      pending = undefined
    }
    if (event.type === 'compaction/prune') pending = event
  }
  return pending
}

/** Install adjacency checks with pre-commit staging. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const pending = new WeakMap<Session, PruneEvent | undefined>()
  const staged = new WeakMap<SessionEvent, { session: Session; next: PruneEvent | undefined }>()
  const seed = (session: Session): void => { pending.set(session, seedPending(session, fail)) }
  const current = (session: Session): PruneEvent | undefined => {
    if (!pending.has(session)) seed(session)
    return pending.get(session)
  }

  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', seed, { global: true })

  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    const open = current(session)
    if (open !== undefined && resemblesCompanion(open, event)) {
      validateCompanion(session, open, event, fail)
    }
    staged.set(event, {
      session,
      next: event.type === 'compaction/prune' ? event : undefined,
    })
  }, { global: true })

  ctx.on('session/event', (session, event) => {
    const candidate = staged.get(event)
    if (candidate === undefined || candidate.session !== session) {
      return fail('session/event reached publication without matching pre-commit validation')
    }
    staged.delete(event)
    pending.set(session, candidate.next)
  }, { global: true })
}, { inject: ['sessions'] })

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
