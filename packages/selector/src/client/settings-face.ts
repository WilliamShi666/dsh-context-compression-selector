/**
 * One settings-surface adapter over both Harness generations.
 *
 * Harness 0.1.x exposes browser settings state as a bound `settingsScope` over
 * a plugin-chosen namespace, carrying the complete document. Harness 0.2.0
 * replaces it with `configForms`, whose per-entry form is addressed by the Host
 * profile entry id and whose value is the projection of that entry's
 * **volatile** Config fields only.
 *
 * Both surfaces expose the same `getSnapshot()`/`subscribe()`/`set(field,
 * value)` triple over a snapshot with identical field names
 * (`status`/`value`/`base`/`user`/`revision`/`writable`/`mode`), so everything
 * above this module programs against one face over the UI-facing document
 * shape. Three per-generation differences are absorbed here:
 *
 * - `set` settles as `void` on 0.1.x and as `boolean` on 0.2.0, where `false`
 *   means the Host refused the write. A refusal is normalized into the
 *   rejection the selector's write-confirm contract expects.
 * - 0.2.0's volatile projection carries neither `custom` nor a composed
 *   `autoCompact` object, so a document is composed from its flat fields.
 * - Only fields the Host declared volatile are writable on 0.2.0, so the
 *   versioned Custom policy is reported as not editable there.
 */

import {
  AUTO_COMPACT_THRESHOLD_LIMITS,
  COMPRESSION_PROFILES,
  DEFAULT_CUSTOM_COMPRESSION_POLICY,
  isPlainRecord,
  isValidAutoCompactThresholdPercent,
  type CompressionProfile,
  type ContextCompressionSettings,
} from '../profiles.ts'

/** The three-way sync state both generations report for one settings section. */
export type SettingsStatus = 'loading' | 'ready' | 'unavailable'

/** One settings section's sync state, shared by both generations' snapshots. */
export interface SettingsSnapshot<T> {
  /** `loading` until the first accepted section, `ready` while one stands. */
  readonly status: SettingsStatus
  /** Last accepted schema-resolved section; undefined before the first acceptance. */
  readonly value: T | undefined
  /** Composition layer the Host resolved {@link value} over, when one is declared. */
  readonly base: unknown
  /** Raw user layer as stored, when one exists; presence marks a field overridden. */
  readonly user: unknown
  /** Revision fencing the next write; undefined before the first Host view. */
  readonly revision: number | undefined
  /** Whether the Host document accepts writes; memory mode never does. */
  readonly writable: boolean
  /** `host` syncs with the Host document; `memory` keeps a remote browser process-local. */
  readonly mode: 'host' | 'memory'
}

/**
 * The one settings face the selector programs against. Structurally this is
 * exactly `HostObservable<SettingsSnapshot<T>>` plus the write path, so the
 * slot framework's `hooks` compartment binds it to a `useCompression` selector
 * hook without any framework-specific type.
 *
 * `getSnapshot` MUST be idempotent between changes: it is read by
 * `useSyncExternalStore`, which compares consecutive snapshots **by reference**
 * and re-renders until they stop differing. An implementation that composes a
 * fresh object on every read therefore loops forever rather than rendering
 * once. Generations whose native snapshot is already stable can return it
 * directly; any adapter that derives a new shape has to memoize it.
 */
export interface SettingsFace<T> {
  /** @returns the current sync snapshot (stable reference until the next change). */
  getSnapshot(): SettingsSnapshot<T>
  /**
   * Observe snapshot replacements.
   * @param listener - invoked after each snapshot change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void
  /**
   * Queue one field write, rejecting when the Host refuses it.
   * @param field - scalar field inside the section.
   * @param value - JSON-shaped value selected by the user.
   * @returns settlement after the write and any latest-write recovery read.
   */
  set(field: string, value: unknown): Promise<void>
  /**
   * Whether this surface can persist the versioned Custom policy, and so
   * whether any surface may offer to edit or select it.
   */
  readonly customEditable: boolean
}

/** The 0.1.x `settingsScope` surface, as this adapter consumes it. */
export interface LegacySettingsScope {
  /** Bind one namespace's scope, narrowing its section through `spec.decode`. */
  bind<T>(spec: {
    namespace: string
    decode?: (section: unknown) => T | undefined
  }): LegacyBoundScope<T>
}

/** One bound 0.1.x namespace scope. */
export interface LegacyBoundScope<T> {
  getSnapshot(): SettingsSnapshot<T>
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
}

/** The 0.2.0 `configForms` surface, as this adapter consumes it. */
export interface ConfigFormsService {
  /** Get one Host profile entry's configuration form. */
  get<T>(entryId: string): ConfigFormFace<T>
  /**
   * Run `register` once any of `namespaces` appears in the describe mirror, and
   * dispose it when none does.
   * @param namespaces - settings namespaces the registration follows.
   * @param register - registers the contribution; returns its disposer.
   * @returns the disposer ending the watch and any live registration.
   */
  whileServed(
    namespaces: readonly string[],
    register: (served: ReadonlySet<string>) => () => void,
  ): () => void
}

/** One 0.2.0 per-entry configuration form. */
export interface ConfigFormFace<T> {
  getSnapshot(): SettingsSnapshot<T>
  subscribe(listener: () => void): () => void
  /** @returns whether the Host accepted the write. */
  set(field: string, value: unknown): Promise<boolean>
}

/**
 * The flat field projection a 0.2.0 form serves: exactly the Host entry's
 * volatile Config fields, each omitted entirely while unset.
 */
export interface VolatileProjection {
  /** Selected compression profile, absent while the entry declares none. */
  profile?: unknown
  /** Auto Compact threshold percent, absent while the entry declares none. */
  autoCompactThresholdPercent?: unknown
}

/** The two 0.2.0 volatile field names this plugin declares on its Host entry. */
const VOLATILE_PROFILE = 'profile'
const VOLATILE_AUTO_COMPACT = 'autoCompactThresholdPercent'

function isSupportedProfile(value: unknown): value is CompressionProfile {
  return typeof value === 'string'
    && (COMPRESSION_PROFILES as readonly string[]).includes(value)
}

/**
 * Wrap a 0.1.x bound scope over the complete document. Its `set` already
 * settles with `void` and rejects on a failed or conflicted write, so the face
 * passes straight through.
 * @param scope - one bound 0.1.x namespace scope.
 * @returns the shared settings face.
 */
export function settingsFaceFromScope(
  scope: LegacyBoundScope<ContextCompressionSettings>,
): SettingsFace<ContextCompressionSettings> {
  return {
    getSnapshot: () => scope.getSnapshot(),
    subscribe: listener => scope.subscribe(listener),
    set: (field, value) => scope.set(field, value),
    customEditable: true,
  }
}

/**
 * Compose the UI-facing document from one 0.2.0 volatile projection.
 *
 * Both declared fields are optional on the Host entry, so an unset field
 * inherits exactly the default the runtime schema would apply. A present but
 * unusable field makes the whole projection unreadable, which keeps the section
 * reporting the document as unavailable rather than silently disagreeing with
 * the runtime.
 *
 * The versioned Custom policy has no volatile Host field, so the default stands
 * in; {@link SettingsFace.customEditable} stays false there, which is what
 * stops any surface from offering to edit or select it.
 * @param raw - the form's projected value.
 * @returns the composed document, or undefined when the projection is unusable.
 */
export function decodeVolatileProjection(raw: unknown): ContextCompressionSettings | undefined {
  if (!isPlainRecord(raw)) return undefined
  const profile = raw[VOLATILE_PROFILE] ?? 'balanced'
  const thresholdPercent = raw[VOLATILE_AUTO_COMPACT] ?? AUTO_COMPACT_THRESHOLD_LIMITS.default
  if (!isSupportedProfile(profile)) return undefined
  if (!isValidAutoCompactThresholdPercent(thresholdPercent)) return undefined
  return {
    profile,
    custom: structuredClone(DEFAULT_CUSTOM_COMPRESSION_POLICY),
    autoCompact: { thresholdPercent },
  }
}

/**
 * Map one UI-facing document field onto the flat 0.2.0 volatile field carrying
 * it. `custom` has no Host field, so writing it is refused loudly rather than
 * silently dropped.
 * @param field - the document field being written.
 * @param value - the value selected by the user.
 * @returns the flat field name and its JSON-shaped value.
 */
export function toVolatileWrite(field: string, value: unknown): { field: string, value: unknown } {
  if (field === VOLATILE_PROFILE) return { field: VOLATILE_PROFILE, value }
  if (field === 'autoCompact') {
    const thresholdPercent = isPlainRecord(value) ? value.thresholdPercent : undefined
    if (!isValidAutoCompactThresholdPercent(thresholdPercent)) {
      throw new TypeError('Context compression autoCompact requires a valid thresholdPercent')
    }
    return { field: VOLATILE_AUTO_COMPACT, value: thresholdPercent }
  }
  throw new TypeError(`Context compression settings field "${field}" is not editable on this Harness`)
}

/**
 * Wrap a 0.2.0 per-entry form over its volatile projection as the shared
 * settings face. A refused write resolves `false` there instead of rejecting,
 * so the settlement is normalized into the rejection the selector's
 * write-confirm contract expects.
 * @param form - one 0.2.0 Host profile entry's configuration form.
 * @returns the shared settings face over the composed document.
 */
export function settingsFaceFromConfigForm(
  form: ConfigFormFace<VolatileProjection>,
): SettingsFace<ContextCompressionSettings> {
  // The composed document must be memoized against the form's own snapshot:
  // `getSnapshot` is read by `useSyncExternalStore`, which compares snapshots by
  // reference and re-renders forever if each read returns a fresh object. The
  // form's snapshot reference is the cache key, so a new document is composed
  // only when the projection actually changed.
  let cachedFrom: SettingsSnapshot<VolatileProjection> | undefined
  let cached: SettingsSnapshot<ContextCompressionSettings> | undefined
  return {
    getSnapshot: () => {
      const snapshot = form.getSnapshot()
      if (cached !== undefined && cachedFrom === snapshot) return cached
      const value = decodeVolatileProjection(snapshot.value)
      // A `ready` snapshot whose projection is unusable must not keep serving
      // the previously accepted document.
      const usable = snapshot.status !== 'ready' || value !== undefined
      const composed: SettingsSnapshot<ContextCompressionSettings> = {
        status: usable ? snapshot.status : 'unavailable',
        value: usable ? value : undefined,
        base: snapshot.base,
        user: snapshot.user,
        revision: snapshot.revision,
        writable: snapshot.writable,
        mode: snapshot.mode,
      }
      cachedFrom = snapshot
      cached = composed
      return composed
    },
    subscribe: listener => form.subscribe(listener),
    set: async (field, value) => {
      const write = toVolatileWrite(field, value)
      if (!await form.set(write.field, write.value)) {
        throw new Error('Context compression settings were not saved.')
      }
    },
    customEditable: false,
  }
}
