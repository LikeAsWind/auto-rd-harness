// PanelRoute tests.
//
// The route is the transport between the host plugin and the future
// client UI, registered through DSH's verified `webServer` contract
// (`register({ kind, path, handler(req, res) })` with raw Node streams).
//
// Covers:
//   - registers kind:'exact' at the documented path
//   - returns false and logs (not throws) when webServer is absent,
//     which is the headless deployment case
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

// ---- registration ---------------------------------------------------

{
  const ws = fakeWebServer()
  const logger = silentLogger()
  const ok = registerPanelRoute(ctxWith(ws), { storage: fakeStorage(), logger })

  check('register: reports success', ok === true)
  check('register: exactly one route', ws.routes.length === 1, String(ws.routes.length))
  check('register: kind is exact', ws.routes[0]?.kind === 'exact', String(ws.routes[0]?.kind))
  check('register: path is the documented one', ws.routes[0]?.path === PANEL_ROUTE_PATH, String(ws.routes[0]?.path))
  check('register: path is /auto-rd/panel', PANEL_ROUTE_PATH === '/auto-rd/panel', PANEL_ROUTE_PATH)
  check('register: handler is a function', typeof ws.routes[0]?.handler === 'function')
  check('register: logs the route', logger.lines.some(([l, m]) => l === 'info' && m.includes(PANEL_ROUTE_PATH)))
}

{
  // Headless: no web server. Must degrade quietly.
  const logger = silentLogger()
  let threw = false
  let ok
  try {
    ok = registerPanelRoute(ctxWith(undefined), { storage: fakeStorage(), logger })
  } catch {
    threw = true
  }
  check('headless: does not throw', threw === false)
  check('headless: returns false', ok === false)
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
  let ok
  try {
    ok = registerPanelRoute(ctxWith(ws), { storage: fakeStorage(), logger })
  } catch {
    threw = true
  }
  check('duplicate: does not throw out of the mount', threw === false)
  check('duplicate: returns false', ok === false)
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
  const ws = fakeWebServer()
  registerPanelRoute(ctxWith(ws), {
    storage: fakeStorage({ stories: STORIES, modules: MODULES }),
    logger: silentLogger(),
  })
  const res = fakeRes()
  await ws.routes[0].handler({ method: 'GET' }, res)
  const raw = String(res.body)
  for (const needle of ['token', 'Token', 'password', 'secret', 'workspacePath', 'repoUrl']) {
    check(`payload omits '${needle}'`, !raw.includes(needle), needle)
  }
}

// ---- Summary --------------------------------------------------------

process.stdout.write(`\nPanelRoute tests: ${pass} pass, ${fail} fail\n`)
if (fail > 0) process.exitCode = 1
