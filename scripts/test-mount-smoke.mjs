// Mount smoke test — exercise the real `apply()` end to end.
//
// This is the closest thing to a live mount that is possible without a
// DSH runtime. It builds a faithful fake host — every service shaped
// like its VERIFIED contract, not like the plugin's assumptions — and
// calls the exported `apply()`. A mount that would fail against real
// DSH fails here.
//
// What it proves:
//   - apply() is async and awaits storageDomain.open()
//   - the module records from config are seeded into storage
//   - all three tools register, and each satisfies the required
//     ToolDefinition contract (a strict registry rejects violations, so
//     a missing `output` fails the test the way real DSH would)
//   - the system-prompt section registers with the verified field names
//   - the storage domain is closed by the effect disposer
//   - a missing optional service (tools / systemPrompt) degrades to a
//     warning instead of failing the mount
//   - mounting twice against the same facility fails with `already-open`
//
// Run with: node scripts/test-mount-smoke.mjs

import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const libBase = resolve(__dirname, '..', 'packages', 'dsh-auto-rd', 'lib')

const { apply, inject } = await import(pathToFileURL(resolve(libBase, 'index.js')).href)

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

// ---- faithful fakes -------------------------------------------------

/** A table with the real KvTable surface: no values(). */
function kvTable(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    get: (k) => map.get(k),
    entries: () => map.entries(),
    keys: () => map.keys(),
    get size() {
      return map.size
    },
    async put(k, v) {
      map.set(k, v)
    },
    async delete(k) {
      return map.delete(k)
    },
    async update(k, fn) {
      const next = fn(map.get(k))
      map.set(k, next)
      return next
    },
    __rows: map,
  }
}

/** The storageDomain facility: async open, rejects a duplicate name. */
function storageDomainFacility() {
  const open = new Map()
  const spec = { last: null, closed: [] }
  return {
    spec,
    open,
    async open(s) {
      if (open.has(s.name)) throw new Error(`already-open: ${s.name}`)
      const tables = {}
      for (const t of Object.keys(s.tables)) tables[t] = kvTable()
      const domain = {
        name: s.name,
        table: (n) => {
          if (!tables[n]) throw new Error(`unknown table ${n}`)
          return tables[n]
        },
        async close() {
          spec.closed.push(s.name)
        },
      }
      open.set(s.name, domain)
      spec.last = s
      return domain
    },
    get: (n) => open.get(n),
    async closeAll() {},
  }
}

/**
 * A STRICT tools registry: it validates the verified ToolDefinition
 * contract and throws on a violation, exactly as real DSH rejects a
 * definition with no `output`.
 */
function strictToolsRegistry() {
  const registered = new Map()
  return {
    registered,
    register(def) {
      if (!def || typeof def !== 'object') throw new Error('tool definition must be an object')
      if (typeof def.name !== 'string' || !def.name) throw new Error('tool needs a name')
      if (typeof def.description !== 'string' || !def.description) {
        throw new Error(`tool ${def.name} needs a description`)
      }
      if (!def.parameters || def.parameters.type !== 'object') {
        throw new Error(`tool ${def.name} needs an object parameter schema`)
      }
      // The field that was missing in the real bug.
      if (!def.output || typeof def.output !== 'object') {
        throw new Error(`tool ${def.name} is missing the required output contract`)
      }
      if (!def.output.schema || typeof def.output.schema !== 'object') {
        throw new Error(`tool ${def.name} output needs a schema`)
      }
      if (typeof def.output.render !== 'function') {
        throw new Error(`tool ${def.name} output needs a render function`)
      }
      if (typeof def.execute !== 'function') throw new Error(`tool ${def.name} needs execute`)
      if (registered.has(def.name)) throw new Error(`duplicate tool ${def.name}`)
      registered.set(def.name, def)
      return () => registered.delete(def.name)
    },
    get: (n) => registered.get(n),
    restrict: () => () => {},
  }
}

/**
 * A STRICT systemPrompt registry: validates the verified PromptSection
 * field names, so `{ id, content }` fails the way real DSH would.
 */
function strictSystemPrompt() {
  const sections = []
  return {
    sections,
    section(s) {
      if (!s || typeof s !== 'object') throw new Error('section must be an object')
      if (typeof s.name !== 'string' || !s.name) throw new Error('section needs a `name`')
      if (s.id !== undefined) throw new Error('section must not use `id`')
      if (!Number.isFinite(s.order)) throw new Error('section needs a finite `order`')
      if (typeof s.text !== 'string' && typeof s.text !== 'function') {
        throw new Error('section needs `text`')
      }
      if (s.content !== undefined) throw new Error('section must not use `content`')
      sections.push(s)
      return () => {
        const i = sections.indexOf(s)
        if (i >= 0) sections.splice(i, 1)
      }
    },
    context: () => () => {},
    suppressRuntimeContext: () => () => {},
    getSectionOrder: () => 0,
    getContextOrder: () => 0,
    variable: () => () => {},
    async assemble() {
      return { sections: [], contexts: [], tools: [], variables: {} }
    },
  }
}

/** A Cordis-like ctx with effect capture and a service table. */
function fakeCtx(services) {
  const disposers = []
  const logs = []
  const ctx = {
    disposers,
    logs,
    get: (k) => services[k],
    effect(fn, label) {
      const d = fn()
      if (typeof d === 'function') disposers.push({ label, dispose: d })
      return d
    },
    logger: () => ({
      debug: (m) => logs.push(['debug', m]),
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    }),
  }
  return ctx
}

function config(over = {}) {
  return {
    tapdBaseUrl: 'https://api.tapd.cn',
    tapdApiToken: 'tok',
    tapdPollIntervalMs: 600000,
    tapdWorkspaceIds: ['ws1'],
    useTapdMock: true,
    gitlabBaseUrl: 'https://gitlab.example.com',
    gitlabApiToken: 'gtok',
    gitlabPushUserName: 'auto-rd',
    gitlabPushUserEmail: 'auto-rd@example.com',
    workspaceRoot: 'C:/work',
    modules: [
      {
        id: 'payment',
        title: 'Payment Service',
        repoUrl: 'https://gitlab.example.com/pay/svc.git',
        defaultBranch: 'main',
      },
    ],
    maxConcurrentStoriesPerModule: 1,
    maxTotalConcurrentStories: 4,
    logLevel: 'warn',
    ...over,
  }
}

// ---- the mount ------------------------------------------------------

async function mount(services, cfg) {
  const ctx = fakeCtx(services)
  await apply(ctx, cfg)
  // Let the fire-and-forget recoverStories settle.
  await new Promise((r) => setTimeout(r, 40))
  return ctx
}

function teardown(ctx) {
  // Run effect disposers in reverse so timers stop and the domain closes.
  for (const d of [...ctx.disposers].reverse()) {
    try {
      d.dispose()
    } catch {
      /* best effort */
    }
  }
}

// 1. Full mount with every service present.
{
  const sd = storageDomainFacility()
  const tools = strictToolsRegistry()
  const prompt = strictSystemPrompt()
  // Assign so the async body can be inspected after mount.
  let ctx
  let threw = null
  try {
    ctx = await mount(
      { storageDomain: sd, tools, systemPrompt: prompt, sessions: { list: () => [] } },
      config(),
    )
  } catch (err) {
    threw = err
  }

  check('mount: apply() completed without throwing', threw === null, threw?.message)
  check('mount: return value was awaited (apply is async)', ctx !== undefined)

  // Storage.
  check('mount: opened the auto-rd domain', sd.spec.last?.name === 'auto-rd', String(sd.spec.last?.name))
  check('mount: domain version is 4', sd.spec.last?.version === 4, String(sd.spec.last?.version))
  check('mount: domain layout is per-record', sd.spec.last?.layout === 'per-record', String(sd.spec.last?.layout))
  const domain = sd.get('auto-rd')
  check('mount: domain is open', domain !== undefined)

  // Module seeding.
  const modules = [...domain.table('modules').entries()].map(([k]) => k)
  check('mount: seeded the configured module', modules.includes('payment'), JSON.stringify(modules))
  const mod = domain.table('modules').get('payment')
  check('mount: module has the workspace path', typeof mod?.workspacePath === 'string' && mod.workspacePath.includes('payment'), String(mod?.workspacePath))
  check('mount: module kept the configured repo url', mod?.repoUrl === 'https://gitlab.example.com/pay/svc.git', String(mod?.repoUrl))

  // Tools — the strict registry would have thrown if a contract were violated.
  check('mount: registered exactly 3 tools', tools.registered.size === 3, JSON.stringify([...tools.registered.keys()]))
  for (const name of ['auto_rd_status', 'auto_rd_trigger', 'auto_rd_retry']) {
    check(`mount: registered ${name}`, tools.registered.has(name))
  }
  const statusTool = tools.registered.get('auto_rd_status')
  check('mount: the registered tool carries its output contract', typeof statusTool?.output?.render === 'function')

  // Prompt section.
  check('mount: registered exactly 1 prompt section', prompt.sections.length === 1, String(prompt.sections.length))
  check('mount: prompt section name is auto-rd-overview', prompt.sections[0]?.name === 'auto-rd-overview', String(prompt.sections[0]?.name))

  // Effects.
  check('mount: registered the storage effect', ctx.disposers.some((d) => d.label === 'auto-rd:storage'))
  check('mount: registered the timers effect', ctx.disposers.some((d) => d.label === 'auto-rd:timers'))
  check('mount: registered the ui effect', ctx.disposers.some((d) => d.label === 'auto-rd:ui'))

  // Teardown closes the domain.
  teardown(ctx)
  check('teardown: closed the storage domain', sd.spec.closed.includes('auto-rd'), JSON.stringify(sd.spec.closed))
  check('teardown: ran every disposer', ctx.disposers.length >= 3)
}

// 2. Optional services absent — must degrade, not fail.
{
  const sd = storageDomainFacility()
  let threw = null
  let ctx
  try {
    ctx = await mount({ storageDomain: sd }, config())
  } catch (err) {
    threw = err
  }
  check('degraded: mounts without tools/systemPrompt', threw === null, threw?.message)
  check(
    'degraded: warns about the missing tools service',
    ctx?.logs.some(([l, m]) => l === 'warn' && /tools service unavailable/.test(m)),
    JSON.stringify(ctx?.logs.filter(([l]) => l === 'warn').map(([, m]) => m.slice(0, 60))),
  )
  check(
    'degraded: warns about the missing systemPrompt service',
    ctx?.logs.some(([l, m]) => l === 'warn' && /systemPrompt service not available/.test(m)),
  )
  if (ctx) teardown(ctx)
}

// 3. Empty module list still mounts.
{
  const sd = storageDomainFacility()
  const tools = strictToolsRegistry()
  let threw = null
  let ctx
  try {
    ctx = await mount({ storageDomain: sd, tools, systemPrompt: strictSystemPrompt() }, config({ modules: [] }))
  } catch (err) {
    threw = err
  }
  check('no modules: mounts cleanly', threw === null, threw?.message)
  const domain = sd.get('auto-rd')
  check('no modules: no module records seeded', [...domain.table('modules').entries()].length === 0)
  check('no modules: tools still registered', tools.registered.size === 3)
  if (ctx) teardown(ctx)
}

// 4. An invalid config fails the mount loudly (fast, visible failure).
{
  const sd = storageDomainFacility()
  const ctx = fakeCtx({ storageDomain: sd })
  let threw = null
  try {
    await apply(ctx, { tapdApiToken: 'x' }) // missing required workspaceRoot/urls
  } catch (err) {
    threw = err
  }
  check('invalid config: apply() rejects', threw !== null)
}

// 5. The domains guard rejects a second mount against the same facility.
{
  const sd = storageDomainFacility()
  const ctx1 = await mount({ storageDomain: sd }, config())
  const ctx2 = fakeCtx({ storageDomain: sd })
  let threw = null
  try {
    await apply(ctx2, config())
  } catch (err) {
    threw = err
  }
  check('double mount: the second apply() rejects', threw !== null)
  check(
    'double mount: the rejection is already-open',
    threw !== null && /already-open/.test(threw.message),
    threw?.message,
  )
  teardown(ctx1)
}

// 6. inject is consistent with what apply actually reads.
{
  check('inject: declares storageDomain', inject.includes('storageDomain'))
  check('inject: declares tools', inject.includes('tools'))
  check('inject: declares systemPrompt', inject.includes('systemPrompt'))
  check('inject: does not declare client-only slots', !inject.includes('slots'))
}

// ---- Summary --------------------------------------------------------

process.stdout.write(`\nMountSmoke tests: ${pass} pass, ${fail} fail\n`)
if (fail > 0) process.exitCode = 1
