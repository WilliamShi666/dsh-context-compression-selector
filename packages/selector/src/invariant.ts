/**
 * Package-owned invariant companion for
 * `dsh-context-compression-selector`.
 * @module dsh-context-compression-selector/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-context-compression-selector'

/** Cordis companion plugin name. */
export const name = 'client-ui-context-compression-selector-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the settings service validates and owns the durable
 * profile registration, while the slot registry already rejects or removes
 * invalid browser contributions with their owning fiber.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
