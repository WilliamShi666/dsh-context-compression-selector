/** Public Session event-log compatibility across Harness 0.1.x releases. */

import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Read one immutable Session event snapshot.
 *
 * Harness rc.2 exposed `events`; Alpha 5 replaced it with the public
 * `snapshotEvents()` method. Prefer the new API when present and retain the
 * old accessor as the compatibility fallback for already-supported hosts.
 */
export function sessionEvents(session: Session): readonly SessionEvent[] {
  const snapshot = (session as unknown as {
    snapshotEvents?: () => readonly SessionEvent[]
  }).snapshotEvents
  return typeof snapshot === 'function' ? snapshot.call(session) : session.events
}
