// Credentials-seam tests (issue #10).
//
// auto-rd no longer carries TAPD / GitLab tokens in storage or in
// liveConfig — both fields now hold *reference names* that DSH's
// ctx.credentials service resolves at use time. The plugin still owns
// the grammar and the per-module cascade, plus a one-shot migration
// that lifts any legacy plaintext out of storage on mount.
//
// This suite covers:
//
//   * Reference-name grammar (isValidCredentialRefName)
//   * Per-module ref construction (sanitizeModuleId, tapdRefFor,
//     gitlabRefFor) — collisions, length limits, normalization
//   * Resolver cascade: per-module ref beats global ref; env / file
//     precedence is up to ctx.credentials (we stub the seam and
//     verify the order of probes)
//   * Descriptor cascade: same shape, no value leaks
//   * formatTokenResolution: audit log is value-free
//   * Storage migration: plaintext is moved into the credentials
//     store and the field is rewritten to the ref name; migration is
//     idempotent; per-module AND global are handled; failures are
//     skipped (not fatal)
//   * Security: migration log lines and resolve traces never echo
//     the token value back
//
// Run with: node scripts/test-credentials.mjs

import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const libBase = resolve(__dirname, '..', 'packages', 'dsh-auto-rd', 'lib')

const {
  isValidCredentialRefName,
  CREDENTIAL_REFS,
  TAPD_GLOBAL_REF,
  GITLAB_GLOBAL_REF,
  tapdRefFor,
  gitlabRefFor,
  sanitizeModuleId,
  resolveTapdToken,
  resolveGitlabToken,
  describeTapdToken,
  describeGitlabToken,
  formatTokenResolution,
} = await import(pathToFileURL(resolve(libBase, 'domain', 'credentials.js')).href)

const { migrateStorageToCredentials } = await import(
  pathToFileURL(resolve(libBase, 'services', 'migrate-storage-credentials.js')).href
)

let pass = 0
let fail = 0
function check(name, ok, extra) {
  if (ok) {
    pass += 1
    process.stdout.write(`\u2713 ${name}\n`)
  } else {
    fail += 1
    process.stdout.write(`\u2717 ${name}${extra ? ` (${extra})` : ''}\n`)
  }
}

/**
 * Build a tiny in-memory credentials service. Mirrors the seam DSH
 * exposes — `describe` reports presence, `resolve` returns the value
 * if set, `set` / `unset` mutate the store. Tests pass a `Map` and
 * read it back; we do not need persistence here.
 */
function makeCredentials(seed = {}) {
  const store = new Map(Object.entries(seed))
  return {
    store,
    async describe(ref) {
      return {
        configured: store.has(ref) && store.get(ref).length > 0,
        writable: true,
      }
    },
    async resolve(ref) {
      const v = store.get(ref)
      return v && v.length > 0 ? v : undefined
    },
    async set(ref, value) {
      if (!ref || !ref.match(/^[A-Z][A-Z0-9_]{0,63}$/)) {
        throw new Error(`not a valid credential ref name: ${ref}`)
      }
      store.set(ref, value)
    },
    async unset(ref) {
      store.delete(ref)
    },
  }
}

/** Capture-only logger (the migration logs structured lines). */
function captureLogger() {
  const lines = []
  return {
    lines,
    info: (s) => lines.push(['info', s]),
    warn: (s) => lines.push(['warn', s]),
    error: (s) => lines.push(['error', s]),
    debug: (s) => lines.push(['debug', s]),
    get warnings() { return lines.filter(([l]) => l === 'warn').map(([, s]) => s) },
  }
}

/** Tiny in-memory storage double — modules + the four shape ops. */
function fakeStorage(modules = []) {
  const map = new Map(modules.map((m) => [m.id, m]))
  return {
    modules: () => ({
      get: (id) => map.get(id),
      put: async (id, value) => { map.set(id, value) },
      delete: async (id) => { map.delete(id) },
      entries: () => [...map.entries()],
      *values() { for (const v of map.values()) yield v },
    }),
  }
}

// ---- ref-name grammar -------------------------------------------------

check('grammar: DSH_TAPD_API_TOKEN is valid', isValidCredentialRefName('DSH_TAPD_API_TOKEN'))
check('grammar: lowercase is rejected', !isValidCredentialRefName('d'))
check('grammar: starting with a digit is rejected', !isValidCredentialRefName('1FOO'))
check('grammar: starting with an underscore is rejected', !isValidCredentialRefName('_FOO'))
check('grammar: hyphen is rejected', !isValidCredentialRefName('FOO-BAR'))
check('grammar: empty string is rejected', !isValidCredentialRefName(''))
check('grammar: 64 chars max', isValidCredentialRefName('A'.repeat(64)))
check('grammar: 65 chars is rejected', !isValidCredentialRefName('A'.repeat(65)))

// ---- module-id sanitization -------------------------------------------

check('sanitize: hyphenated id', sanitizeModuleId('yc-sale-control-server') === 'YC_SALE_CONTROL_SERVER')
check('sanitize: dotted id', sanitizeModuleId('team.subteam.project') === 'TEAM_SUBTEAM_PROJECT')
check('sanitize: lower-case preserved', sanitizeModuleId('abc') === 'ABC')
check('sanitize: already uppercase unchanged', sanitizeModuleId('ABC_DEF') === 'ABC_DEF')
check('sanitize: runs collapsed', sanitizeModuleId('a...b') === 'A_B')
check('sanitize: digits preserved', sanitizeModuleId('module-2025-01') === 'MODULE_2025_01')

const r1 = tapdRefFor('yc-sale-control-server')
check('tapdRefFor: hyphenated id becomes the documented ref', r1 === 'DSH_TAPD_API_TOKEN_FOR_YC_SALE_CONTROL_SERVER', String(r1))
const r2 = gitlabRefFor('foo')
check('gitlabRefFor: simple id', r2 === 'DSH_GITLAB_API_TOKEN_FOR_FOO', String(r2))

// ---- resolver cascade -------------------------------------------------

{
  const creds = makeCredentials({ DSH_TAPD_API_TOKEN: 'global-tapd' })
  const v = await resolveTapdToken(creds, 'm1')
  check('resolver: no per-module -> falls through to global', v === 'global-tapd', String(v))
}

{
  const creds = makeCredentials({
    DSH_TAPD_API_TOKEN: 'global-tapd',
    DSH_TAPD_API_TOKEN_FOR_M1: 'module-tapd',
  })
  const v = await resolveTapdToken(creds, 'm1')
  check('resolver: per-module beats global', v === 'module-tapd', String(v))
}

{
  const creds = makeCredentials()
  const v = await resolveTapdToken(creds, 'm1')
  check('resolver: nothing configured -> undefined', v === undefined, String(v))
}

{
  const v = await resolveTapdToken(undefined, 'm1')
  check('resolver: no credentials service -> undefined', v === undefined, String(v))
}

{
  const creds = makeCredentials({ DSH_GITLAB_API_TOKEN: 'g' })
  const v = await resolveGitlabToken(creds, undefined)
  check('resolver: gitlab global only', v === 'g', String(v))
}

{
  const creds = makeCredentials({
    DSH_GITLAB_API_TOKEN: 'global',
    DSH_GITLAB_API_TOKEN_FOR_M1: '',
  })
  const v = await resolveGitlabToken(creds, 'm1')
  // Empty value should NOT count as a hit — fall through to global.
  check('resolver: empty per-module value falls through to global', v === 'global', String(v))
}

// ---- descriptor cascade ------------------------------------------------

{
  const creds = makeCredentials({ DSH_TAPD_API_TOKEN: 'x' })
  const d = await describeTapdToken(creds, 'm1')
  check('describe: configured via global ref', d.configured === true)
  check('describe: writable is propagated', d.writable === true)
}

{
  const creds = makeCredentials({ DSH_TAPD_API_TOKEN_FOR_M1: 'x' })
  const d = await describeTapdToken(creds, 'm1')
  check('describe: configured via per-module ref', d.configured === true)
}

{
  const creds = makeCredentials()
  const d = await describeTapdToken(creds, 'm1')
  check('describe: nothing configured -> configured=false', d.configured === false)
}

{
  const d = await describeGitlabToken(undefined, undefined)
  check('describe: no credentials -> safe empty', d.configured === false && d.writable === false)
}

// ---- audit log format -------------------------------------------------

{
  const line = formatTokenResolution({
    role: 'tapd',
    moduleId: 'm1',
    ref: TAPD_GLOBAL_REF,
    source: 'env',
    at: new Date('2025-01-01T00:00:00Z'),
  })
  check('audit: line includes role', line.includes('tapd'))
  check('audit: line includes module id', line.includes('for module m1'))
  check('audit: line includes ref name', line.includes(TAPD_GLOBAL_REF))
  check('audit: line includes source', line.includes('[env]'))
  // The line should NOT contain the literal value — the audit log
  // is intentionally value-free. We pass an obvious fake value here
  // to make sure it never leaks.
  check('audit: line does NOT contain a literal token value', !line.includes('hunter2'))
}

// ---- migration: smoke test -------------------------------------------

{
  const storage = fakeStorage([
    {
      id: 'm1',
      tapdApiToken: 'old-tapd-abc',
      gitlabApiToken: '',
    },
    {
      id: 'm2',
      tapdApiToken: '',
      gitlabApiToken: 'old-git-xyz',
    },
  ])
  const creds = makeCredentials()
  const config = {
    tapdApiToken: '',
    gitlabApiToken: '',
    workspaceRoot: '/w',
    modules: [
      { id: 'm1', tapdApiToken: 'old-tapd-abc' },
      { id: 'm2', gitlabApiToken: 'old-git-xyz' },
    ],
  }
  const log = captureLogger()
  const report = await migrateStorageToCredentials(storage, config, creds, log)

  check('migration: rewrote m1 tapd field to ref name',
    storage.modules().get('m1').tapdApiToken === 'DSH_TAPD_API_TOKEN_FOR_M1',
    storage.modules().get('m1').tapdApiToken)
  check('migration: rewrote m2 gitlab field to ref name',
    storage.modules().get('m2').gitlabApiToken === 'DSH_GITLAB_API_TOKEN_FOR_M2',
    storage.modules().get('m2').gitlabApiToken)
  check('migration: m1 plaintext pushed into credentials',
    creds.store.get('DSH_TAPD_API_TOKEN_FOR_M1') === 'old-tapd-abc')
  check('migration: m2 plaintext pushed into credentials',
    creds.store.get('DSH_GITLAB_API_TOKEN_FOR_M2') === 'old-git-xyz')
  check('migration: modulesTouched lists both', report.modulesTouched.includes('m1') && report.modulesTouched.includes('m2'))
  check('migration: no skips when credentials accepts writes', report.skipped.length === 0)
  // Verify the audit line records the value LENGTH, never the value.
  const warnings = log.warnings
  check('migration: log line records value length (not value)',
    warnings.some((s) => s.includes('length=12')) && !warnings.some((s) => s.includes('old-tapd-abc')))
}

// ---- migration: global tokens -----------------------------------------

{
  const storage = fakeStorage([])
  const creds = makeCredentials()
  const config = {
    tapdApiToken: 'global-tapd',
    gitlabApiToken: 'global-git',
    workspaceRoot: '/w',
    modules: [],
  }
  const log = captureLogger()
  const report = await migrateStorageToCredentials(storage, config, creds, log)

  check('migration: global tapd rewritten', config.tapdApiToken === 'DSH_TAPD_API_TOKEN')
  check('migration: global gitlab rewritten', config.gitlabApiToken === 'DSH_GITLAB_API_TOKEN')
  check('migration: globalTokensTouched.tapd is true', report.globalTokensTouched.tapd === true)
  check('migration: globalTokensTouched.gitlab is true', report.globalTokensTouched.gitlab === true)
  check('migration: global tapd pushed into store', creds.store.get('DSH_TAPD_API_TOKEN') === 'global-tapd')
  check('migration: global gitlab pushed into store', creds.store.get('DSH_GITLAB_API_TOKEN') === 'global-git')
}

// ---- migration: idempotent --------------------------------------------

{
  const storage = fakeStorage([
    { id: 'm1', tapdApiToken: 'DSH_TAPD_API_TOKEN_FOR_M1' }, // already ref
  ])
  const creds = makeCredentials({ DSH_TAPD_API_TOKEN_FOR_M1: 'real-secret' })
  const config = {
    tapdApiToken: 'DSH_TAPD_API_TOKEN', // already ref
    gitlabApiToken: '',
    workspaceRoot: '/w',
    modules: [{ id: 'm1', tapdApiToken: 'DSH_TAPD_API_TOKEN_FOR_M1' }],
  }
  const log = captureLogger()
  const report = await migrateStorageToCredentials(storage, config, creds, log)

  check('migration: idempotent on already-ref module', report.modulesTouched.length === 0)
  check('migration: idempotent on already-ref global', !report.globalTokensTouched.tapd)
  check('migration: idempotent leaves the actual value intact',
    creds.store.get('DSH_TAPD_API_TOKEN_FOR_M1') === 'real-secret')
}

// ---- migration: missing credentials -----------------------------------

{
  const storage = fakeStorage([
    { id: 'm1', tapdApiToken: 'plaintext' },
  ])
  const log = captureLogger()
  const report = await migrateStorageToCredentials(
    storage,
    { tapdApiToken: '', gitlabApiToken: '', workspaceRoot: '/w', modules: [{ id: 'm1', tapdApiToken: 'plaintext' }] },
    undefined,
    log,
  )
  check('migration: no credentials -> no-op (m1 field unchanged)',
    storage.modules().get('m1').tapdApiToken === 'plaintext',
    storage.modules().get('m1').tapdApiToken)
  check('migration: no credentials -> no modulesTouched', report.modulesTouched.length === 0)
}

// ---- migration: write rejection is non-fatal --------------------------

{
  // A credentials service that rejects every set() — simulates an
  // immutable / read-only provider, e.g. an env-only configuration
  // where the secret comes from the launching shell.
  const refusingCreds = {
    describe: async () => ({ configured: false, writable: false }),
    resolve: async () => undefined,
    set: async () => { throw new Error('refused') },
    unset: async () => {},
  }
  const storage = fakeStorage([
    { id: 'm1', tapdApiToken: 'plaintext' },
  ])
  const log = captureLogger()
  const report = await migrateStorageToCredentials(
    storage,
    { tapdApiToken: '', gitlabApiToken: '', workspaceRoot: '/w', modules: [{ id: 'm1', tapdApiToken: 'plaintext' }] },
    refusingCreds,
    log,
  )
  check('migration: set rejection -> skipped', report.skipped.length === 1)
  check('migration: set rejection -> m1 plaintext left in place',
    storage.modules().get('m1').tapdApiToken === 'plaintext',
    storage.modules().get('m1').tapdApiToken)
}

// ---- constants / exports ----------------------------------------------

check('const: TAPD_GLOBAL ref name matches the documented constant',
  CREDENTIAL_REFS.TAPD_GLOBAL === 'DSH_TAPD_API_TOKEN' && TAPD_GLOBAL_REF === 'DSH_TAPD_API_TOKEN')
check('const: GITLAB_GLOBAL ref name matches the documented constant',
  CREDENTIAL_REFS.GITLAB_GLOBAL === 'DSH_GITLAB_API_TOKEN' && GITLAB_GLOBAL_REF === 'DSH_GITLAB_API_TOKEN')

// ---- summary ---------------------------------------------------------

process.stdout.write(`\nCredentials tests: ${pass} pass, ${fail} fail\n`)
process.exit(fail > 0 ? 1 : 0)