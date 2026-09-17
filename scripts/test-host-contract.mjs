// Host-surface contract tests.
//
// The plugin talks to DSH through a small number of host services whose
// shapes were verified against the live service catalog. These tests pin
// the two remaining invariants that are easy to break silently:
//
//   1. The system-prompt section uses the verified field names
//      `{ name, order, text }`. An earlier revision passed
//      `{ id, order, content }` and the service received an undefined
//      name/body.
//
//   2. The exported `inject` list contains only services that actually
//      exist on the host. `inject` is a hard-dependency list — Cordis
//      holds the plugin until each named service appears — so a service
//      the host never provides means the plugin never mounts. `slots`
//      was in that list and is a client-only concern.
//
// Run with: node scripts/test-host-contract.mjs

import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const libBase = resolve(__dirname, '..', 'packages', 'dsh-auto-rd', 'lib')

const { registerAutoRdPromptSection } = await import(
  pathToFileURL(resolve(libBase, 'services', 'system-prompt-section.js')).href
)
const index = await import(pathToFileURL(resolve(libBase, 'index.js')).href)

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

/** A ctx whose ctx.get() returns `service` for `key`. */
function ctxWith(key, service) {
  const logs = []
  return {
    logs,
    get: (k) => (k === key ? service : undefined),
    logger: () => ({
      debug: (m) => logs.push(['debug', m]),
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    }),
  }
}

// ---- system-prompt section ------------------------------------------

{
  const captured = []
  const ctx = ctxWith('systemPrompt', {
    section: (s) => {
      captured.push(s)
      return () => {}
    },
  })

  const ok = registerAutoRdPromptSection(ctx)
  check('prompt: registration reports success', ok === true)
  check('prompt: section() was called once', captured.length === 1, String(captured.length))

  const s = captured[0] ?? {}
  // The verified field names.
  check('prompt: uses `name` (not `id`)', typeof s.name === 'string' && s.name.length > 0, JSON.stringify(Object.keys(s)))
  check('prompt: does NOT use `id`', s.id === undefined, JSON.stringify(s.id))
  check('prompt: uses `text` (not `content`)', typeof s.text === 'string' && s.text.length > 0, JSON.stringify(Object.keys(s)))
  check('prompt: does NOT use `content`', s.content === undefined, JSON.stringify(s.content))
  check('prompt: order is a finite number', Number.isFinite(s.order), String(s.order))
  check('prompt: name is the documented id', s.name === 'auto-rd-overview', String(s.name))
  check('prompt: body mentions the pipeline', /Auto-RD Pipeline/.test(s.text), s.text.slice(0, 40))
  check('prompt: body names the status tool', s.text.includes('auto_rd_status'))
  check('prompt: body names the retry tool', s.text.includes('auto_rd_retry'))
}

{
  // A missing service must be a logged no-op, not a throw.
  const ctx = ctxWith('systemPrompt', undefined)
  let ok
  let threw = false
  try {
    ok = registerAutoRdPromptSection(ctx)
  } catch {
    threw = true
  }
  check('prompt: missing service does not throw', threw === false)
  check('prompt: missing service returns false', ok === false)
  check('prompt: missing service is logged as a warning', ctx.logs.some(([l]) => l === 'warn'))
}

{
  // A rejecting section() must be caught and reported.
  const ctx = ctxWith('systemPrompt', {
    section: () => {
      throw new Error('duplicate section name')
    },
  })
  let ok
  let threw = false
  try {
    ok = registerAutoRdPromptSection(ctx)
  } catch {
    threw = true
  }
  check('prompt: a rejecting section() does not throw', threw === false)
  check('prompt: a rejecting section() returns false', ok === false)
  check(
    'prompt: the rejection reason is logged',
    ctx.logs.some(([l, m]) => l === 'error' && /duplicate section name/.test(m)),
    JSON.stringify(ctx.logs),
  )
}

// ---- inject list ----------------------------------------------------

{
  const inject = index.inject
  check('inject: is exported as an array', Array.isArray(inject), typeof inject)

  // Verified-present host services the plugin actually uses.
  // `sessionTitle` and `workspaceController` are optional at runtime —
  // apply() degrades when the shell withholds them — but they must still
  // be declared here, or the shell never offers them at all.
  const required = [
    'storageDomain',
    'subagents',
    'tools',
    'systemPrompt',
    'sessions',
    'sessionTitle',
    'workspaceController',
  ]
  for (const k of required) {
    check(`inject: declares the used service '${k}'`, inject.includes(k))
  }

  // The client-only pseudo-service that would have blocked the mount.
  check('inject: does NOT declare client-only `slots`', !inject.includes('slots'))

  // Services nothing in the plugin reads; declaring them is a dead
  // wait-condition on every mount.
  for (const k of ['workspaceRegistry', 'timer', 'fs', 'shell', 'subprocess', 'agents', 'sessionPersistence', 'web']) {
    check(`inject: does not declare unused '${k}'`, !inject.includes(k))
  }

  check('inject: has no duplicates', new Set(inject).size === inject.length, JSON.stringify(inject))
  check(
    'inject: declares exactly the services it reads',
    inject.length === required.length,
    JSON.stringify(inject),
  )
}

// ---- apply shape ----------------------------------------------------

{
  check('apply: is exported', typeof index.apply === 'function')
  check(
    'apply: is async (storageDomain.open is async)',
    index.apply.constructor.name === 'AsyncFunction',
    index.apply.constructor.name,
  )
  check('apply: ConfigSchema is exported', index.ConfigSchema !== undefined)
}

// ---- Summary --------------------------------------------------------

process.stdout.write(`\nHostContract tests: ${pass} pass, ${fail} fail\n`)
if (fail > 0) process.exitCode = 1
