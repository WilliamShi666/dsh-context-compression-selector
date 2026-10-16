/**
 * Read the current Session's agent preset across both Harness generations.
 *
 * The field moved and the selection moved with it:
 *
 * - 0.1.x carries the preset as a top-level `agentPreset` on each list row, and
 *   names the current Session as `list.current`.
 * - 0.2.0 drops both. The preset became the `agentPreset` Session projection
 *   (`string | null`, null when the deployment composes no presets), and the
 *   current Session is the single row the main view retains — the same
 *   `retainedBy.mainView` test the 0.2.0 workspace and agent-preset pages use.
 *
 * Both generations deliver this list through the `useSessions` standard hook
 * and both expose `byId`, so one structural reader covers them. A Session whose
 * preset is not yet known reads `undefined`, which callers treat as "do not
 * block": a cold Session must not be mistaken for one that chose Minimal.
 */

/** The selection and preset fields this reader consumes. */
export interface SessionPresetRow {
  /** 0.1.x top-level preset field. */
  readonly agentPreset?: unknown
  /** 0.2.0 Host-computed projection values. */
  readonly projectionValues?: unknown
  /** 0.2.0 local ownership counts; the main view's retention marks the current Session. */
  readonly retainedBy?: unknown
}

/** The session-list snapshot fields this reader consumes. */
export interface SessionPresetList {
  /** 0.1.x persisted selection. */
  readonly current?: unknown
  readonly byId?: unknown
}

/**
 * Read one list's rows, tolerating either generation's field shapes.
 *
 * Both generations' `byId` is a map of branded-id string keys to rows, but the
 * ROW types differ by generation and neither is assignable to the other, so
 * the map is narrowed structurally here rather than declared as a concrete
 * record. An unrecognized snapshot yields no row, which callers already treat
 * as "do not block". Absent entries stay in the result rather than being
 * filtered: an indexed read may legitimately miss, and every consumer already
 * skips undefined.
 * @param list - the `useSessions` list snapshot.
 * @returns the rows, with absent entries preserved as undefined.
 */
function rowsOf(list: SessionPresetList): readonly (SessionPresetRow | undefined)[] {
  const byId = list.byId
  if (byId === null || typeof byId !== 'object') return []
  return Object.values(byId as Record<string, SessionPresetRow | undefined>)
}

/**
 * Select the current Session's agent preset from one session-list snapshot.
 *
 * Reads the preset string only; every other projected shape is ignored so the
 * caller never has to know which generation produced the snapshot.
 * @param list - the `useSessions` list snapshot.
 * @returns the preset id, or undefined when no current Session or no known preset.
 */
export function currentAgentPreset(list: SessionPresetList): string | undefined {
  const row = currentRow(list)
  return presetOf(row)
}

function currentRow(list: SessionPresetList): SessionPresetRow | undefined {
  const rows = rowsOf(list)
  // 0.2.0: the main view's retained row is the current Session.
  for (const row of rows) {
    if (row !== undefined && retentionOf(row) > 0) return row
  }
  // 0.1.x: the persisted selection names it directly.
  return typeof list.current === 'string' ? rowById(list, list.current) : undefined
}

/** Read one branded-id-keyed row without asserting the key's brand. */
function rowById(list: SessionPresetList, id: string): SessionPresetRow | undefined {
  const byId = list.byId
  if (byId === null || typeof byId !== 'object') return undefined
  return (byId as Record<string, SessionPresetRow | undefined>)[id]
}

/** Count the main view's retention on one row, whatever shape carries it. */
function retentionOf(row: SessionPresetRow): number {
  const retained = row.retainedBy
  if (retained === null || typeof retained !== 'object') return 0
  const mainView = (retained as Record<string, unknown>).mainView
  return typeof mainView === 'number' ? mainView : 0
}

function presetOf(row: SessionPresetRow | undefined): string | undefined {
  const projections = row?.projectionValues
  if (projections !== null && typeof projections === 'object') {
    const projected = (projections as Record<string, unknown>).agentPreset
    if (typeof projected === 'string') return projected
  }
  return typeof row?.agentPreset === 'string' ? row.agentPreset : undefined
}
