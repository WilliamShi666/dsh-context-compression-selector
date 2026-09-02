import { describe, expect, it, vi } from 'vitest'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { sessionEvents } from '../src/session-events.ts'

const EVENTS = Object.freeze([
  Object.freeze({ seq: 0, time: 1, type: 'turn/start', data: { turn: 1 } }),
]) as unknown as readonly SessionEvent[]

describe('sessionEvents', () => {
  it('retains the rc.2 events accessor fallback', () => {
    const session = { events: EVENTS } as Session
    expect(sessionEvents(session)).toBe(EVENTS)
  })

  it('prefers the Alpha 5 public snapshotEvents API and preserves its receiver', () => {
    const modern = {
      marker: EVENTS,
      events: undefined,
      snapshotEvents(this: { marker: readonly SessionEvent[] }) {
        return this.marker
      },
    }
    const snapshot = vi.spyOn(modern, 'snapshotEvents')
    expect(sessionEvents(modern as unknown as Session)).toBe(EVENTS)
    expect(snapshot).toHaveBeenCalledOnce()
  })
})
