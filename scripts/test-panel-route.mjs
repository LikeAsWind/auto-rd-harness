// PanelRoute tests.
//
// The route is the transport between the host plugin and the future
// client UI, registered through DSH's verified `webServer` contract
// (`register({ kind, path, handler(req, res) })` with raw Node streams).
//
// Covers:
//   - registers kind:'exact' at the documented path
//   - returns the disposer from webServer.register on success; returns
//     null (and logs at info, not error) when webServer is absent, which
//     is the headless deployment case
//   - the returned disposer removes the route from the webserver
//   - GET -> 200, application/json, no-store, and the real panel model
//   - HEAD -> 200 with content-length and no body
//   - POST -> 405 with an allow header
//   - a duplicate-registration throw is caught and reported
//   - a storage failure -> 500 panel_unavailable (the server survives)
//   - the payload carries no credentials
//
// Run with: node scripts/test-panel-route.mjs

import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const libBase = resolve(__dirname, '..', 'packages', 'dsh-auto-rd', 'lib')

const { registerPanelRoute, PANEL_ROUTE_PATH } = await import(
  pathToFileURL(resolve(libBase, 'services', 'panel-route.js')).href
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

/** A webServer double that records registrations. */
function fakeWebServer({ throwOnRegister = null } = {}) {
  const routes = []
  return {
    routes,
    register(route) {
      if (throwOnRegister) throw new Error(throwOnRegister)
      routes.push(route)
      return () => {
        const i = routes.indexOf(route)
        if (i >= 0) routes.splice(i, 1)
      }
    },
  }
}

/** A ServerResponse double. */
function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(k, v) {
      this.headers[String(k).toLowerCase()] = v
    },
    end(b) {
      this.ended = true
      this.body = b
    },
  }
}

function fakeStorage({ stories = [], modules = [], tasks = [] } = {}) {
  const table = (rows) => ({
    *values() {
      for (const r of rows) yield r
    },
  })
  return { stories: () => table(stories), modules: () => table(modules), tasks: () => table(tasks) }
}

function silentLogger() {
  const lines = []
  return {
    lines,
    debug: (m) => lines.push(['debug', m]),
    info: (m) => lines.push(['info', m]),
    warn: (m) => lines.push(['warn', m]),
    error: (m) => lines.push(['error', m]),
  }
}

/** A ctx whose ctx.get('webServer') returns `ws`. */
function ctxWith(ws) {
  return { get: (k) => (k === 'webServer' ? ws : undefined) }
}

const MODULES = [
  { id: 'm1', title: 'Payment', repoUrl: 'https://x/y.git', defaultBranch: 'main', workspacePath: '/w/m1', createdAt: '2025-01-01T00:00:00Z' },
]
const STORIES = [
  { id: 'S1', moduleId: 'm1', tapdId: '1', title: 'Refund endpoint', description: 'd', state: 'implementing', branch: 'auto-rd/S1', updatedAt: '2025-06-01T00:00:00Z', artifacts: {}, retryCount: 0, createdAt: '2025-01-01T00:00:00Z' },
  { id: 'S2', moduleId: 'm1', tapdId: '2', title: 'Blocked thing', description: 'd', state: 'blocked', branch: 'auto-rd/S2', updatedAt: '2025-06-02T00:00:00Z', artifacts: {}, retryCount: 0, blockedReason: 'x', createdAt: '2025-01-01T00:00:00Z' },
]

// Module identity comes from the live config, not storage, so a route
// that should see MODULES has to be given the matching config too.
const CONFIG = {
  tapdApiToken: '',
  gitlabApiToken: '',
  workspaceRoot: '',
  modules: MODULES.map((m) => ({ id: m.id, title: m.title })),
}

// ---- registration ---------------------------------------------------

{
  const ws = fakeWebServer()
  const logger = silentLogger()
  const dispose = registerPanelRoute(ctxWith(ws), { storage: fakeStorage(), logger })

  check('register: reports success (disposer is a function)', typeof dispose === 'function')
  check('register: exactly one route', ws.routes.length === 1, String(ws.routes.length))
  check('register: kind is exact', ws.routes[0]?.kind === 'exact', String(ws.routes[0]?.kind))
  check('register: path is the documented one', ws.routes[0]?.path === PANEL_ROUTE_PATH, String(ws.routes[0]?.path))
  check('register: path is /auto-rd/panel', PANEL_ROUTE_PATH === '/auto-rd/panel', PANEL_ROUTE_PATH)
  check('register: handler is a function', typeof ws.routes[0]?.handler === 'function')
  check('register: logs the route', logger.lines.some(([l, m]) => l === 'info' && m.includes(PANEL_ROUTE_PATH)))

  // The disposer removes the route so the webserver can be torn down cleanly.
  if (typeof dispose === 'function') dispose()
  check('register: disposer removes the route', ws.routes.length === 0, String(ws.routes.length))
}

{
  // Headless: no web server. Must degrade quietly.
  const logger = silentLogger()
  let threw = false
  let dispose
  try {
    dispose = registerPanelRoute(ctxWith(undefined), { storage: fakeStorage(), logger })
  } catch {
    threw = true
  }
  check('headless: does not throw', threw === false)
  check('headless: returns null', dispose === null)
  check(
    'headless: explains itself at info level (not an error)',
    logger.lines.some(([l, m]) => l === 'info' && /headless/.test(m)),
    JSON.stringify(logger.lines),
  )
  check('headless: no error logged', !logger.lines.some(([l]) => l === 'error'))
}

{
  // A duplicate (kind, path) throws by contract.
  const ws = fakeWebServer({ throwOnRegister: 'duplicate route' })
  const logger = silentLogger()
  let threw = false
  let dispose
  try {
    dispose = registerPanelRoute(ctxWith(ws), { storage: fakeStorage(), logger })
  } catch {
    threw = true
  }
  check('duplicate: does not throw out of the mount', threw === false)
  check('duplicate: returns null', dispose === null)
  check(
    'duplicate: logs the reason',
    logger.lines.some(([l, m]) => l === 'error' && /duplicate route/.test(m)),
    JSON.stringify(logger.lines),
  )
}

// ---- GET ------------------------------------------------------------

{
  const ws = fakeWebServer()
  registerPanelRoute(ctxWith(ws), {
    storage: fakeStorage({ stories: STORIES, modules: MODULES }),
    logger: silentLogger(),
    getConfig: () => CONFIG,
  })
  const handler = ws.routes[0].handler

  const res = fakeRes()
  await handler({ method: 'GET' }, res)

  check('GET: status 200', res.statusCode === 200, String(res.statusCode))
  check('GET: content-type is JSON', String(res.headers['content-type']).includes('application/json'), res.headers['content-type'])
  check('GET: no-store cache header', res.headers['cache-control'] === 'no-store', res.headers['cache-control'])
  check('GET: response ended', res.ended === true)

  const body = JSON.parse(res.body)
  check('GET: ok flag', body.ok === true)
  check('GET: has generatedAt', typeof body.generatedAt === 'string' && body.generatedAt.length > 0)
  check('GET: includes the panel model', body.model !== undefined && Array.isArray(body.model.modules))
  check('GET: model has the module', body.model.modules[0].id === 'm1', JSON.stringify(body.model.modules.map((m) => m.id)))
  check('GET: model has both stories', body.model.modules[0].stories.length === 2, String(body.model.modules[0].stories.length))
  check('GET: totals populated', body.model.totals.stories === 2 && body.model.totals.blocked === 1, JSON.stringify(body.model.totals))
  check('GET: includes the text rendering', typeof body.text === 'string' && body.text.includes('Payment (m1)'), String(body.text).slice(0, 60))
  check('GET: story titles present', body.text.includes('Refund endpoint'))
}

// ---- HEAD -----------------------------------------------------------

{
  const ws = fakeWebServer()
  registerPanelRoute(ctxWith(ws), {
    storage: fakeStorage({ stories: STORIES, modules: MODULES }),
    logger: silentLogger(),
    getConfig: () => CONFIG,
  })
  const res = fakeRes()
  await ws.routes[0].handler({ method: 'HEAD' }, res)

  check('HEAD: status 200', res.statusCode === 200, String(res.statusCode))
  check('HEAD: sets content-length', typeof res.headers['content-length'] === 'number', String(res.headers['content-length']))
  check('HEAD: no body', res.body === undefined, JSON.stringify(res.body))
  check('HEAD: still no-store', res.headers['cache-control'] === 'no-store')
}

// ---- other methods --------------------------------------------------

for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
  const ws = fakeWebServer()
  registerPanelRoute(ctxWith(ws), { storage: fakeStorage(), logger: silentLogger() })
  const res = fakeRes()
  await ws.routes[0].handler({ method }, res)
  check(`${method}: 405`, res.statusCode === 405, String(res.statusCode))
  check(`${method}: advertises allow`, String(res.headers['allow']).includes('GET'), res.headers['allow'])
  check(`${method}: body says method_not_allowed`, JSON.parse(res.body).error === 'method_not_allowed')
}

// ---- storage failure ------------------------------------------------

{
  const ws = fakeWebServer()
  const logger = silentLogger()
  registerPanelRoute(ctxWith(ws), {
    storage: {
      stories: () => ({
        *values() {
          throw new Error('storage exploded')
        },
      }),
      modules: () => ({ *values() {} }),
      tasks: () => ({ *values() {} }),
    },
    logger,
  })
  const res = fakeRes()
  let threw = false
  try {
    await ws.routes[0].handler({ method: 'GET' }, res)
  } catch {
    threw = true
  }
  check('storage failure: handler does not throw', threw === false)
  check('storage failure: status 500', res.statusCode === 500, String(res.statusCode))
  check('storage failure: body says panel_unavailable', JSON.parse(res.body).error === 'panel_unavailable')
  check(
    'storage failure: logged',
    logger.lines.some(([l, m]) => l === 'error' && /storage exploded/.test(m)),
    JSON.stringify(logger.lines),
  )
}

// ---- no secrets leak ------------------------------------------------

{
  // The payload's health section deliberately names missing tokens in
  // its issue messages ("TAPD token is empty — …"), so the word appears
  // by design. What must never appear is a token VALUE: the needles are
  // the real secret-material keys, and any hit means a field leaked.
  const ws = fakeWebServer()
  registerPanelRoute(ctxWith(ws), {
    storage: fakeStorage({ stories: STORIES, modules: MODULES }),
    logger: silentLogger(),
    getConfig: () => CONFIG,
  })
  const res = fakeRes()
  await ws.routes[0].handler({ method: 'GET' }, res)
  const raw = String(res.body)
  for (const needle of ['tapdApiToken', 'gitlabApiToken', 'password', 'secret', 'workspacePath', 'repoUrl']) {
    check(`payload omits '${needle}'`, !raw.includes(needle), needle)
  }
}

// ---- getConfig() reads live config on every request -----------------

{
  // Simulate the reconfigure flow: the panel route is bound once, but
  // `getConfig` returns a different value on each request. The route
  // must read the live config (not the snapshot taken at registration)
  // so that after a /auto-rd/reconfigure call the very next fetch sees
  // the new state.
  const ws = fakeWebServer()
  let currentConfig = { tapdApiToken: '', gitlabApiToken: '', workspaceRoot: '', modules: [] }
  registerPanelRoute(ctxWith(ws), {
    storage: fakeStorage({ stories: STORIES, modules: MODULES }),
    logger: silentLogger(),
    getConfig: () => currentConfig,
  })

  // Empty config: setupRequired must be true.
  const res1 = fakeRes()
  await ws.routes[0].handler({ method: 'GET' }, res1)
  const body1 = JSON.parse(res1.body)
  check('getConfig: setupRequired reflects current empty config', body1.model.health.setupRequired === true)

  // Flip the live config: full setup. The next fetch must report
  // setupRequired=false WITHOUT re-binding the route.
  currentConfig = {
    tapdApiToken: 'tok',
    gitlabApiToken: 'gtok',
    useTapdMock: true,
    workspaceRoot: '/w',
    modules: [{ id: 'm', title: 'M', repoUrl: 'https://x/y.git', defaultBranch: 'main' }],
  }
  const res2 = fakeRes()
  await ws.routes[0].handler({ method: 'GET' }, res2)
  const body2 = JSON.parse(res2.body)
  check('getConfig: setupRequired reflects the flipped live config', body2.model.health.setupRequired === false)
  check('getConfig: issues array empty when flipped to full config', body2.model.health.issues.length === 0)
}

// ---- ReconfigureRoute end-to-end ------------------------------------

// Quick test of the reconfigure-route module. We exercise the bare
// helper (no cordis context, just a fake webServer) against a real
// storageDomain-shaped double.
const { registerReconfigureRoute, RECONFIGURE_ROUTE_PATH } = await import(
  pathToFileURL(resolve(libBase, 'services', 'reconfigure-route.js')).href
)

// fakeStorage that respects put / get / update against an in-memory
// map (so the reconfigure handler's "re-seed module records" step
// actually mutates state).
function liveStorage() {
  const modules = new Map()
  return {
    modules: () => ({
      get: (k) => modules.get(k),
      put: async (k, v) => { modules.set(k, v) },
      delete: async (k) => modules.delete(k),
      update: async (k, fn) => { const v = fn(modules.get(k)); modules.set(k, v); return v },
      entries: () => modules.entries(),
      keys: () => modules.keys(),
      get size() { return modules.size },
      *values() { for (const v of modules.values()) yield v },
    }),
    stories: () => ({ get: () => undefined, put: async () => {}, delete: async () => true, update: async () => ({}), entries: () => [].entries(), keys: () => [].keys(), get size() { return 0 }, *values() {} }),
    tasks: () => ({ get: () => undefined, put: async () => {}, delete: async () => true, update: async () => ({}), entries: () => [].entries(), keys: () => [].keys(), get size() { return 0 }, *values() {} }),
  }
}

const silentLog = silentLogger()

{
  // Happy path: POST a valid config, get a new health snapshot.
  const ws = fakeWebServer()
  const liveConfig = { current: { tapdApiToken: '', gitlabApiToken: '', workspaceRoot: '', modules: [] } }
  const runtime = { mountedAt: new Date(), lastTapdPollAt: null, lastTapdError: null }
  let newSvcsStartCount = 0
  let stopCount = 0

  // minimal services fake
  const oldSvcs = {
    queue: { start: () => {}, stop: () => { stopCount += 1 } },
    poller: { start: () => {}, stop: () => {} },
    notifier: { start: () => {}, stop: () => {} },
  }
  const newSvcs = {
    queue: { start: () => { newSvcsStartCount += 1 }, stop: () => {} },
    poller: { start: () => {}, stop: () => {} },
    notifier: { start: () => {}, stop: () => {} },
  }

  let currentServices = oldSvcs
  registerReconfigureRoute(ctxWith(ws), {
    storage: liveStorage(),
    logger: silentLog,
    liveConfig,
    runtime,
    startServices: (cfg) => {
      // Pretend a successful build.
      return newSvcs
    },
    stopServices: (svcs) => svcs.queue.stop(),
    currentServices,
  })

  check('reconfigure: route is bound', ws.routes.length === 1, String(ws.routes.length))
  check('reconfigure: route path is /auto-rd/reconfigure', ws.routes[0]?.path === RECONFIGURE_ROUTE_PATH, String(ws.routes[0]?.path))
  check('reconfigure: route kind is exact', ws.routes[0]?.kind === 'exact')

  // POST a valid config.
  const req = await makeJsonReq('POST', {
    config: {
      tapdApiToken: 'new-tok',
      gitlabApiToken: 'new-gtok',
      workspaceRoot: 'C:/work',
      useTapdMock: true,
      modules: [{ id: 'payment', title: 'Payment', repoUrl: 'https://gitlab.example.com/pay.git' }],
    },
  })
  const res = fakeRes()
  await ws.routes[0].handler(req, res)
  check('reconfigure: POST returns 200', res.statusCode === 200, String(res.statusCode))
  check('reconfigure: POST body is application/json', (res.headers['content-type'] ?? '').includes('application/json'))
  const body = JSON.parse(res.body)
  check('reconfigure: body.ok is true', body.ok === true)
  check('reconfigure: liveConfig was swapped', liveConfig.current.tapdApiToken === 'new-tok')
  check('reconfigure: setupRequired is now false', body.model.health.setupRequired === false)
  check('reconfigure: stopServices was called on the old services', stopCount === 1)
  check('reconfigure: new services were started', newSvcsStartCount === 1)
  check('reconfigure: newModules records which modules were seeded', Array.isArray(body.newModules) && body.newModules.some((m) => m.id === 'payment'))
}

{
  // Validation: POST an invalid config — host returns 400 with zod issues.
  const ws = fakeWebServer()
  const liveConfig = { current: { tapdApiToken: '', gitlabApiToken: '', workspaceRoot: '', modules: [] } }
  const runtime = { mountedAt: new Date(), lastTapdPollAt: null, lastTapdError: null }
  let stopCount = 0
  registerReconfigureRoute(ctxWith(ws), {
    storage: liveStorage(),
    logger: silentLog,
    liveConfig,
    runtime,
    startServices: () => ({ queue: { start: () => {}, stop: () => {} }, poller: { start: () => {}, stop: () => {} }, notifier: { start: () => {}, stop: () => {} } }),
    stopServices: () => { stopCount += 1 },
    currentServices: { queue: { start: () => {}, stop: () => {} }, poller: { start: () => {}, stop: () => {} }, notifier: { start: () => {}, stop: () => {} } },
  })

  // tapdBaseUrl is not a valid URL — zod should reject.
  const req = await makeJsonReq('POST', { config: { tapdApiToken: 'x', tapdBaseUrl: 'not-a-url' } })
  const res = fakeRes()
  await ws.routes[0].handler(req, res)
  check('reconfigure invalid: returns 400', res.statusCode === 400, String(res.statusCode))
  const body = JSON.parse(res.body)
  check('reconfigure invalid: error is invalid_config', body.error === 'invalid_config', body.error)
  check('reconfigure invalid: issues array is present', Array.isArray(body.issues))
  check('reconfigure invalid: liveConfig was NOT swapped', liveConfig.current.tapdApiToken === '')
  check('reconfigure invalid: old services were NOT stopped', stopCount === 0)
}

{
  // Method gate: GET on the reconfigure route must be 405.
  const ws = fakeWebServer()
  registerReconfigureRoute(ctxWith(ws), {
    storage: liveStorage(),
    logger: silentLog,
    liveConfig: { current: { tapdApiToken: '', gitlabApiToken: '', workspaceRoot: '', modules: [] } },
    runtime: { mountedAt: new Date(), lastTapdPollAt: null, lastTapdError: null },
    startServices: () => ({ queue: { start: () => {}, stop: () => {} }, poller: { start: () => {}, stop: () => {} }, notifier: { start: () => {}, stop: () => {} } }),
    stopServices: () => {},
    currentServices: { queue: { start: () => {}, stop: () => {} }, poller: { start: () => {}, stop: () => {} }, notifier: { start: () => {}, stop: () => {} } },
  })
  const res = fakeRes()
  await ws.routes[0].handler({ method: 'GET' }, res)
  check('reconfigure method gate: GET -> 405', res.statusCode === 405, String(res.statusCode))
  check('reconfigure method gate: allow header advertises POST', res.headers.allow === 'POST', res.headers.allow)
}

{
  // Body parser: malformed JSON body -> 400 bad_request.
  const ws = fakeWebServer()
  registerReconfigureRoute(ctxWith(ws), {
    storage: liveStorage(),
    logger: silentLog,
    liveConfig: { current: { tapdApiToken: '', gitlabApiToken: '', workspaceRoot: '', modules: [] } },
    runtime: { mountedAt: new Date(), lastTapdPollAt: null, lastTapdError: null },
    startServices: () => ({ queue: { start: () => {}, stop: () => {} }, poller: { start: () => {}, stop: () => {} }, notifier: { start: () => {}, stop: () => {} } }),
    stopServices: () => {},
    currentServices: { queue: { start: () => {}, stop: () => {} }, poller: { start: () => {}, stop: () => {} }, notifier: { start: () => {}, stop: () => {} } },
  })
  const req = await makeJsonReq('POST', '{this is not valid json')
  const res = fakeRes()
  await ws.routes[0].handler(req, res)
  check('reconfigure bad body: returns 400', res.statusCode === 400, String(res.statusCode))
  const body = JSON.parse(res.body)
  check('reconfigure bad body: error is bad_request', body.error === 'bad_request', body.error)
}

{
  // Missing config field in payload -> 400 missing_config_field.
  const ws = fakeWebServer()
  registerReconfigureRoute(ctxWith(ws), {
    storage: liveStorage(),
    logger: silentLog,
    liveConfig: { current: { tapdApiToken: '', gitlabApiToken: '', workspaceRoot: '', modules: [] } },
    runtime: { mountedAt: new Date(), lastTapdPollAt: null, lastTapdError: null },
    startServices: () => ({ queue: { start: () => {}, stop: () => {} }, poller: { start: () => {}, stop: () => {} }, notifier: { start: () => {}, stop: () => {} } }),
    stopServices: () => {},
    currentServices: { queue: { start: () => {}, stop: () => {} }, poller: { start: () => {}, stop: () => {} }, notifier: { start: () => {}, stop: () => {} } },
  })
  const req = await makeJsonReq('POST', { foo: 'bar' })
  const res = fakeRes()
  await ws.routes[0].handler(req, res)
  check('reconfigure missing field: returns 400', res.statusCode === 400, String(res.statusCode))
  const body = JSON.parse(res.body)
  check('reconfigure missing field: error is missing_config_field', body.error === 'missing_config_field', body.error)
}

// ---- helpers used by the reconfigure block ---------------------------

async function makeJsonReq(method, body) {
  // Returns a real-ish IncomingMessage-like object with a node Stream
  // interface so the handler's `on('data')` / `on('end')` listeners
  // run. Most of the surface stays unused; we only need `method` and
  // a `Readable` stream that emits the body once.
  const { Readable } = await import('node:stream')
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  const stream = Readable.from([Buffer.from(raw, 'utf8')])
  stream.method = method
  stream.headers = { 'content-type': 'application/json' }
  stream.url = RECONFIGURE_ROUTE_PATH
  return stream
}

// ---- Summary --------------------------------------------------------

process.stdout.write(`\nPanelRoute tests: ${pass} pass, ${fail} fail\n`)
process.exit(fail > 0 ? 1 : 0)
