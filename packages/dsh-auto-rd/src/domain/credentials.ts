/**
 * Credential reference conventions for auto-rd.
 *
 * ## Why references, not values
 *
 * Storing literal secrets in `cordis.patch.yml` (or in the storage
 * domain) puts them on disk in plaintext, ships them through git,
 * and makes rotation a manual edit. DSH solves this with the
 * `ctx.credentials` seam: the patch tree carries *names* (env-var
 * identifiers such as `DSH_TAPD_API_TOKEN_FOR_YC_SALE_CONTROL_SERVER`),
 * the actual values live in `~/.dsh/.credentials.yaml` managed by the
 * `dsh-credentials-local` provider, and the launching shell can
 * override either with `DSH_*` env vars at startup.
 *
 * auto-rd's `tapdApiToken` / `gitlabApiToken` fields (both global and
 * per-module) hold reference names, NOT values. The TapdPoller,
 * StoryRunner, and WorkspaceManager resolve them through
 * `ctx.credentials.resolve(ref)` at use time. The UI never sees a
 * literal token.
 *
 * ## Reference name grammar
 *
 * DSH's `isCredentialRefName` requires a POSIX shell identifier:
 *   - uppercase letters, digits, underscores
 *   - starts with a letter
 *   - no leading underscore is allowed
 *
 * We follow that grammar strictly so the names are also valid as
 * process-env overrides — that lets a power user `export
 * DSH_TAPD_API_TOKEN_FOR_<MODULE>=…` and shadow the file value
 * without restarting DSH (resolve reads env first).
 */
import type { CredentialsService, CredentialRef, ResolvedCredential, CredentialDescriptor } from '../types/dsh-services.js'

/**
 * Reject names that would slip past DSH's `isCredentialRefName`
 * guard and produce a confusing "invalid ref" error at runtime.
 *
 * Allows uppercase letters, digits, and underscores; must start with
 * a letter; max 64 chars (matches DSH's CredentialRef spec).
 */
const REF_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/

export function isValidCredentialRefName(name: string): boolean {
  return REF_NAME_PATTERN.test(name)
}

function brand(name: string): CredentialRef {
  if (!isValidCredentialRefName(name)) {
    throw new Error(
      `invalid credential reference name: "${name}" ` +
        `(expected ^[A-Z][A-Z0-9_]{0,63}$ per isCredentialRefName)`,
    )
  }
  return name as CredentialRef
}

/**
 * Names for the credentials auto-rd looks up. Each entry pairs the
 * logical role with the env-var-style identifier we use everywhere
 * (config fields, credentials file, env override). Keep these
 * constants stable — renaming a reference is a one-way trip that
 * silently invalidates stored credentials.
 */
export const CREDENTIAL_REFS = {
  /** Global TAPD API token (used when a module has no override). */
  TAPD_GLOBAL: 'DSH_TAPD_API_TOKEN',
  /** Global GitLab API token (used for MR creation when a module has no override). */
  GITLAB_GLOBAL: 'DSH_GITLAB_API_TOKEN',
} as const

/** Branded versions of the global refs (issue #10 ref-name brand). */
export const TAPD_GLOBAL_REF: CredentialRef = brand(CREDENTIAL_REFS.TAPD_GLOBAL)
export const GITLAB_GLOBAL_REF: CredentialRef = brand(CREDENTIAL_REFS.GITLAB_GLOBAL)

/**
 * Per-module credential reference names.
 *
 * We uppercase the module id and replace any non-conforming character
 * with an underscore, so `yc-sale-control-server` becomes
 * `DSH_TAPD_API_TOKEN_FOR_YC_SALE_CONTROL_SERVER`. The inverse map
 * (ref → moduleId) would not be unique for some pathological ids,
 * which is why we look up *forward* (module id → ref) only.
 */
export function tapdRefFor(moduleId: string): CredentialRef {
  return brand('DSH_TAPD_API_TOKEN_FOR_' + sanitizeModuleId(moduleId))
}

export function gitlabRefFor(moduleId: string): CredentialRef {
  return brand('DSH_GITLAB_API_TOKEN_FOR_' + sanitizeModuleId(moduleId))
}

/**
 * DSH's reference-name grammar does not allow lowercase letters or
 * hyphens. Map any disallowed character to an underscore and collapse
 * runs so the result is stable across the same input.
 */
export function sanitizeModuleId(moduleId: string): string {
  return moduleId.toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/_+/g, '_')
}

/**
 * Resolve a TAPD token. Resolution order:
 *   1. Module-level ref (per-workspace override)
 *   2. Global ref (`DSH_TAPD_API_TOKEN`)
 *
 * The poller / runner should always call this — never read
 * `module.tapdApiToken` directly.
 *
 * Returns `undefined` when no source resolves, which is a *signal*
 * (not an error) for the caller to fall through to mock mode if
 * configured.
 */
export async function resolveTapdToken(
  credentials: Pick<CredentialsService, 'resolve'> | undefined,
  moduleId: string | undefined,
): Promise<ResolvedCredential | undefined> {
  if (!credentials) return undefined
  if (moduleId) {
    const hit = await credentials.resolve(tapdRefFor(moduleId))
    if (hit) return hit
  }
  return await credentials.resolve(TAPD_GLOBAL_REF)
}

export async function resolveGitlabToken(
  credentials: Pick<CredentialsService, 'resolve'> | undefined,
  moduleId: string | undefined,
): Promise<ResolvedCredential | undefined> {
  if (!credentials) return undefined
  if (moduleId) {
    const hit = await credentials.resolve(gitlabRefFor(moduleId))
    if (hit) return hit
  }
  return await credentials.resolve(GITLAB_GLOBAL_REF)
}

/**
 * Cheap "is this token set?" probe. Used by the panel to render the
 * configured indicator without ever surfacing the token to the
 * browser.
 *
 * Resolves through the same fallback chain as `resolveTapdToken`.
 */
export async function describeTapdToken(
  credentials: Pick<CredentialsService, 'describe'> | undefined,
  moduleId: string | undefined,
): Promise<CredentialDescriptor> {
  return describeAny(credentials, [
    moduleId ? tapdRefFor(moduleId) : undefined,
    TAPD_GLOBAL_REF,
  ])
}

export async function describeGitlabToken(
  credentials: Pick<CredentialsService, 'describe'> | undefined,
  moduleId: string | undefined,
): Promise<CredentialDescriptor> {
  return describeAny(credentials, [
    moduleId ? gitlabRefFor(moduleId) : undefined,
    GITLAB_GLOBAL_REF,
  ])
}

async function describeAny(
  credentials: Pick<CredentialsService, 'describe'> | undefined,
  refs: (CredentialRef | undefined)[],
): Promise<CredentialDescriptor> {
  const empty: CredentialDescriptor = { configured: false, writable: false }
  if (!credentials) return empty
  for (const ref of refs) {
    if (!ref) continue
    const d = await credentials.describe(ref)
    if (d.configured) return d
  }
  return empty
}

/**
 * Audit log helper. The poller / runner should pass the resolution
 * outcome (source + ref name) to the logger, never the value. The
 * value is kept out of the log line by design — disk logs are not
 * the right place to keep secrets, and `source` is enough for an
 * operator to figure out where the value came from.
 */
export interface TokenResolutionLog {
  role: 'tapd' | 'gitlab'
  moduleId?: string
  ref: CredentialRef
  source: ResolvedCredential['source'] | 'unset'
  at: Date
}

export function formatTokenResolution(entry: TokenResolutionLog): string {
  const who = entry.moduleId ? ` for module ${entry.moduleId}` : ' (global)'
  return `${entry.role}${who} via ${entry.ref} [${entry.source}] at ${entry.at.toISOString()}`
}
