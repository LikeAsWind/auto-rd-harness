/**
 * One-shot migration: pull legacy plaintext tokens out of the storage
 * domain and write them into the DSH credentials store.
 *
 * ## Why this exists
 *
 * Pre-issue-#10, `add_workspace` / `update_workspace` wrote the user's
 * token directly into the module record's `tapdApiToken` /
 * `gitlabApiToken` fields. With the credentials-service refactor,
 * those fields now hold a *reference name* (a `DSH_*` env-var-style
 * identifier). Anything still stored as plaintext is:
 *
 *   - correct value, but in the wrong field shape — the poller would
 *     try to `credentials.resolve('81b6d...')` and fail;
 *   - a security liability — plaintext tokens on disk in storage
 *     when the rest of the system has moved to the credentials file.
 *
 * We migrate on plugin mount, before the poller starts. For each
 * module with a plaintext token, we:
 *
 *   1. Write the value into the credentials store under the
 *      module's ref (`DSH_TAPD_API_TOKEN_FOR_<ID>` /
 *      `DSH_GITLAB_API_TOKEN_FOR_<ID>`).
 *   2. Rewrite the module record's token field to that reference
 *      name, so subsequent reads go through the normal resolver.
 *   3. If the global `config.tapdApiToken` is also a plaintext value
 *      (not a reference name), do the same for it under the global
 *      ref.
 *
 * The migration is best-effort: any single failure is logged and
 * skipped, so a missing credential service or a write rejection
 * (env-var shadow) does not stop plugin mount. Each successful
 * migration is logged for audit, with the ref name and the source
 * field but NOT the value.
 *
 * ## Idempotency
 *
 * Re-running the migration is safe:
 *
 *   - `credentials.set` overwrites the same key — no duplicate
 *     ref entries appear.
 *   - A module that has already been migrated has its token field
 *     equal to the ref name, so the `isPlaintextToken` check skips
 *     it.
 *
 * The legacy plaintext is removed from storage as soon as the
 * module record is rewritten, so subsequent reads see only the ref
 * name.
 */
import type { AutoRdStorage } from '../domain/storage.js'
import type { Config } from '../config.js'
import type { Logger } from '../utils/logger.js'
import type { CredentialsService, CredentialRef } from '../types/dsh-services.js'
import {
  tapdRefFor,
  gitlabRefFor,
  TAPD_GLOBAL_REF,
  GITLAB_GLOBAL_REF,
  isValidCredentialRefName,
} from '../domain/credentials.js'

export interface MigrationReport {
  modulesTouched: string[]
  globalTokensTouched: { tapd: boolean; gitlab: boolean }
  skipped: { ref: string; reason: string }[]
}

export async function migrateStorageToCredentials(
  storage: AutoRdStorage,
  config: Config,
  credentials: CredentialsService | undefined,
  logger: Logger,
): Promise<MigrationReport> {
  const report: MigrationReport = {
    modulesTouched: [],
    globalTokensTouched: { tapd: false, gitlab: false },
    skipped: [],
  }
  if (!credentials) {
    logger.info('[migrate] no credentials service mounted — leaving storage tokens as-is')
    return report
  }

  // ---- 1. Module-level tokens ------------------------------------------

  const modules = storage.modules()
  for (const mod of [...modules.values()]) {
    const tapdField = mod.tapdApiToken ?? ''
    const gitlabField = mod.gitlabApiToken ?? ''

    if (isPlaintextToken(tapdField)) {
      const ref = tapdRefFor(mod.id)
      try {
        await credentials.set(ref, tapdField)
        modules.put(mod.id, { ...mod, tapdApiToken: ref })
        report.modulesTouched.push(mod.id)
        logger.warn(
          `[migrate] module ${mod.id}: tapdApiToken migrated plaintext -> ${ref} ` +
            `(value length=${tapdField.length})`,
        )
      } catch (err) {
        const reason = `tapd set failed: ${(err as Error).message}`
        report.skipped.push({ ref, reason })
        logger.error(`[migrate] module ${mod.id}: ${reason}`)
      }
    }

    if (isPlaintextToken(gitlabField)) {
      const ref = gitlabRefFor(mod.id)
      try {
        await credentials.set(ref, gitlabField)
        modules.put(mod.id, { ...mod, gitlabApiToken: ref })
        if (!report.modulesTouched.includes(mod.id)) report.modulesTouched.push(mod.id)
        logger.warn(
          `[migrate] module ${mod.id}: gitlabApiToken migrated plaintext -> ${ref} ` +
            `(value length=${gitlabField.length})`,
        )
      } catch (err) {
        const reason = `gitlab set failed: ${(err as Error).message}`
        report.skipped.push({ ref, reason })
        logger.error(`[migrate] module ${mod.id}: ${reason}`)
      }
    }
  }

  // ---- 2. Global tokens on the in-memory config ------------------------
  //
  // The global fields live on `config` (not storage). The poller reads
  // them straight off the config; we update the live config in place
  // so the next resolveTapdToken() call hits the credentials store.

  if (isPlaintextToken(config.tapdApiToken ?? '')) {
    try {
      await credentials.set(TAPD_GLOBAL_REF, config.tapdApiToken as string)
      config.tapdApiToken = TAPD_GLOBAL_REF
      report.globalTokensTouched.tapd = true
      logger.warn(
        `[migrate] global tapdApiToken migrated plaintext -> ${TAPD_GLOBAL_REF}`,
      )
    } catch (err) {
      report.skipped.push({
        ref: TAPD_GLOBAL_REF,
        reason: `global tapd set failed: ${(err as Error).message}`,
      })
      logger.error(`[migrate] global tapdApiToken: ${(err as Error).message}`)
    }
  }

  if (isPlaintextToken(config.gitlabApiToken ?? '')) {
    try {
      await credentials.set(GITLAB_GLOBAL_REF, config.gitlabApiToken as string)
      config.gitlabApiToken = GITLAB_GLOBAL_REF
      report.globalTokensTouched.gitlab = true
      logger.warn(
        `[migrate] global gitlabApiToken migrated plaintext -> ${GITLAB_GLOBAL_REF}`,
      )
    } catch (err) {
      report.skipped.push({
        ref: GITLAB_GLOBAL_REF,
        reason: `global gitlab set failed: ${(err as Error).message}`,
      })
      logger.error(`[migrate] global gitlabApiToken: ${(err as Error).message}`)
    }
  }

  return report
}

/**
 * "Is this a plaintext value that should be migrated, rather than a
 * reference name?" — anything that does NOT pass
 * `isValidCredentialRefName` is treated as plaintext.
 *
 * Empty strings are NOT plaintext (they would be a no-op write), and
 * they are also not a reference, so the caller leaves them alone.
 */
function isPlaintextToken(value: string): boolean {
  if (!value || value.trim() === '') return false
  return !isValidCredentialRefName(value)
}
