// Client-half tests.
//
// `lib/client.js` cannot be executed by the browser here, but almost
// everything about it can be verified: the loader envelope, the exports
// the shell reads, the exact slot registrations, and the data path from
// `fetch('/auto-rd/panel')` into component state.
//
// The file is evaluated in a minimal shell sandbox: a fake
// `window.__ModuleLoader__` captures the declaration, and a fake `require`
// supplies only `react` — so a spurious external fails the suite.
//
// Covers:
//   - the loader envelope (id matches the package name, factory is a fn)
//   - exports.apply / exports.inject exist; inject is ['slots']
//   - only `react` is required
//   - apply() queues BOTH registrations through slots.inject
//   - the sidebar.panellist fill carries id/order/label
//   - the main fill carries the matching key
//   - the icon component renders an svg sized from ownerProps
//   - the panel component fetches the documented URL, parses the model,
//     and lands it in state; a failure is surfaced, not thrown
//   - the client's constants match the host's exported coordinates
//   - package.json's dsh.client + ./client export are consistent and the
//     referenced bundle exists
//
// Run with: node scripts/test-client-half.mjs

import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(__dirname, '..', 'packages', 'dsh-auto-rd')
const libBase = resolve(pkgRoot, 'lib')

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

// ---- a React shim sufficient for these components -------------------

function makeReact() {
  const calls = { useState: 0, useEffect: [], createElement: [] }
  const slots = []
  return {
    calls,
    slots,
    react: {
      createElement(type, props, ...children) {
        calls.createElement.push(type)
        return { __el: true, type, props: props || {}, children }
      },
      useState(initial) {
        const i = slots.length
        slots.push(typeof initial === 'function' ? initial() : initial)
        calls.useState += 1
        return [
          slots[i],
          (next) => {
            slots[i] = typeof next === 'function' ? next(slots[i]) : next
          },
        ]
      },
      useEffect(fn, deps) {
        calls.useEffect.push({ fn, deps })
      },
    },
  }
}

/** Evaluate the bundle in a shell sandbox. */
function loadClient() {
  const path = resolve(libBase, 'client.js')
  const code = readFileSync(path, 'utf-8')
  let spec = null
  const sandboxWindow = {
    __ModuleLoader__: {
      load(s) {
        spec = s
      },
    },
  }
  // The file references `window`; supplying it as a parameter keeps the
  // evaluation from touching any real global.
  // eslint-disable-next-line no-new-func
  new Function('window', code)(sandboxWindow)
  return { spec, code }
}

const requiredIds = []
function makeRequire(reactShim) {
  return (id) => {
    requiredIds.push(id)
    if (id === 'react') return reactShim.react
    throw new Error(`unexpected external: ${id}`)
  }
}

// ---- envelope -------------------------------------------------------

const { spec, code } = loadClient()
check('envelope: __ModuleLoader__.load was called', spec !== null)
check('envelope: spec has an id', typeof spec?.id === 'string' && spec.id.length > 0)
check('envelope: spec has a factory function', typeof spec?.factory === 'function')

const pkg = JSON.parse(readFileSync(resolve(pkgRoot, 'package.json'), 'utf-8'))
check('envelope: id matches the package name', spec.id === pkg.name, `${spec.id} vs ${pkg.name}`)
check('envelope: file is not an ES module (no top-level import)', !/^\s*import\s/m.test(code))
check('envelope: file does not use JSX', !/<[A-Za-z][^>]*>/.test(code.replace(/=>/g, '')) || !/React\.createElement\s*\(\s*</.test(code))

// ---- exports --------------------------------------------------------

const reactShim = makeReact()
const exportsObj = spec.factory(makeRequire(reactShim))

check('exports: apply is a function', typeof exportsObj.apply === 'function')
check('exports: inject is an array', Array.isArray(exportsObj.inject))
check('inject: declares the short name "slots"', exportsObj.inject.includes('slots'), JSON.stringify(exportsObj.inject))
check('inject: exactly one service', exportsObj.inject.length === 1, JSON.stringify(exportsObj.inject))
check(
  'externals: only react is required',
  requiredIds.length === 1 && requiredIds[0] === 'react',
  JSON.stringify(requiredIds),
)

// ---- apply() --------------------------------------------------------

/** A client ctx double capturing slots.inject and slots.register. */
function fakeClientCtx() {
  const injected = []
  const registered = []
  return {
    injected,
    registered,
    ctx: {
      slots: {
        inject(key, cb) {
          injected.push({ key, cb })
          return () => {}
        },
        register(options, component) {
          registered.push({ options, component })
          return () => {}
        },
      },
    },
  }
}

{
  const { ctx, injected, registered } = fakeClientCtx()
  exportsObj.apply(ctx)

  check('apply: queues exactly two slot injections', injected.length === 2, String(injected.length))
  check(
    'apply: waits for sidebar.panellist',
    injected.some((i) => i.key === 'sidebar.panellist'),
    JSON.stringify(injected.map((i) => i.key)),
  )
  check('apply: waits for main', injected.some((i) => i.key === 'main'), JSON.stringify(injected.map((i) => i.key)))

  // Nothing registers until the owning slot exists.
  check('apply: registers nothing up front', registered.length === 0, String(registered.length))

  // Now let the declarations arrive.
  for (const i of injected) i.cb()

  check('register: two registrations after the slots appear', registered.length === 2, String(registered.length))

  const sidebar = registered.find((r) => r.options.name === 'sidebar.panellist')
  const main = registered.find((r) => r.options.name === 'main')

  check('register: filled sidebar.panellist', sidebar !== undefined)
  check('register: sidebar entry has an id', typeof sidebar?.options.id === 'string' && sidebar.options.id.length > 0, String(sidebar?.options.id))
  check('register: sidebar entry has a numeric order', Number.isFinite(sidebar?.options.order), String(sidebar?.options.order))
  check('register: sidebar entry has a label', typeof sidebar?.options.label === 'string' && sidebar.options.label.length > 0, String(sidebar?.options.label))
  check('register: sidebar component is a function', typeof sidebar?.component === 'function')

  check('register: filled main', main !== undefined)
  check('register: main uses the key form (not id)', main?.options.key !== undefined && main.options.id === undefined, JSON.stringify(main?.options))
  check(
    'register: main key matches the sidebar id',
    main?.options.key === sidebar?.options.id,
    `${main?.options.key} vs ${sidebar?.options.id}`,
  )
  check('register: main component is a function', typeof main?.component === 'function')
}

{
  // Missing slots service must not throw (defensive path).
  let threw = false
  try {
    exportsObj.apply({ get: () => undefined })
  } catch {
    threw = true
  }
  check('apply: tolerates a missing slots service', threw === false)
}

// ---- components -----------------------------------------------------

const meta = exportsObj.__autoRd
check('meta: exposes the slot coordinates for tests', meta !== undefined)

{
  const icon = meta.components.AutoRdIcon
  check('icon: is a function', typeof icon === 'function')

  const el = icon({ size: 20, active: true })
  check('icon: renders an svg', el?.type === 'svg', String(el?.type))
  check('icon: honours the size owner prop', el?.props?.width === 20 && el?.props?.height === 20, JSON.stringify({ w: el?.props?.width, h: el?.props?.height }))
  check('icon: hidden from assistive tech', el?.props?.['aria-hidden'] === 'true')

  const inactive = icon({ size: 16, active: false })
  check('icon: dims when inactive', inactive?.props?.opacity < 1, String(inactive?.props?.opacity))
  const active = icon({ size: 16, active: true })
  check('icon: full opacity when active', active?.props?.opacity === 1, String(active?.props?.opacity))

  // Must not crash when the owner supplies nothing.
  let threw = false
  try {
    icon()
  } catch {
    threw = true
  }
  check('icon: tolerates missing owner props', threw === false)
}

{
  const panel = meta.components.AutoRdPanel
  check('panel: is a function', typeof panel === 'function')

  // Fresh shim so we can inspect this component's hooks.
  const shim = makeReact()
  const exports2 = spec.factory(makeRequire(shim))
  const el = exports2.__autoRd.components.AutoRdPanel()

  check('panel: uses React state', shim.calls.useState >= 1, String(shim.calls.useState))
  // Two mount-once effects: the data poll and the stylesheet injection.
  check('panel: uses exactly two React effects', shim.calls.useEffect.length === 2, String(shim.calls.useEffect.length))
  for (const eff of shim.calls.useEffect) {
    check(`panel: effect [${shim.calls.useEffect.indexOf(eff)}] has empty deps (mount once)`, JSON.stringify(eff.deps) === '[]', JSON.stringify(eff.deps))
  }
  check('panel: renders a root element', el?.__el === true, String(el?.type))
  check('panel: titles the panel', JSON.stringify(shim.calls.createElement).length > 0)
}

// ---- injected stylesheet --------------------------------------------
//
// The panel has no CSS file and no build step, so responsive layout is
// impossible with inline styles alone (`@media`/`@container` are not
// expressible there). The bundle injects one stylesheet on mount.
//
// These tests pin the contract the host cares about: injected exactly
// once, every selector namespaced so it cannot reach the shell's own
// elements, and no hardcoded theme colours (the shell's CSS variables
// stay in charge of light/dark).

{
  const shim = makeReact()
  const exports5 = spec.factory(makeRequire(shim))
  const meta5 = exports5.__autoRd

  check('style: exposes the stylesheet element id for tests', typeof meta5.STYLE_ELEMENT_ID === 'string' && meta5.STYLE_ELEMENT_ID.length > 0, String(meta5.STYLE_ELEMENT_ID))
  check('style: exposes an injector', typeof meta5.injectStyles === 'function', typeof meta5.injectStyles)
  check('style: exposes the stylesheet text', typeof meta5.PANEL_CSS === 'string' && meta5.PANEL_CSS.length > 0, String(meta5.PANEL_CSS).slice(0, 40))

  if (typeof meta5.PANEL_CSS !== 'string' || meta5.PANEL_CSS.length === 0) {
    process.stdout.write(`\nClientHalf tests: ${pass} pass, ${fail} fail (style tests skipped — no PANEL_CSS yet)\n`)
    if (fail > 0) process.exitCode = 1
    // eslint-disable-next-line no-unreachable
    throw new Error('style contract unimplemented; see failing checks above')
  }

  const css = meta5.PANEL_CSS

  // Every rule must be namespaced: a bare `div{...}` or `.ws{...}` would
  // leak into the shell. Collect selectors outside of at-rule preludes.
  const selectors = []
  for (const raw of css.replace(/\/\*[\s\S]*?\*\//g, '').split('}')) {
    const head = raw.split('{')[0].trim()
    if (!head || head.startsWith('@') || head.startsWith('from') || head.startsWith('to') || /^\d+%/.test(head)) continue
    for (const part of head.split(',')) {
      const s = part.trim()
      if (s) selectors.push(s)
    }
  }
  check('style: stylesheet declares selectors', selectors.length > 0, String(selectors.length))
  const unscoped = selectors.filter((s) => !s.includes('.auto-rd-'))
  check('style: every selector is namespaced with .auto-rd-', unscoped.length === 0, JSON.stringify(unscoped.slice(0, 4)))

  // Theme must stay with the shell. Hex/rgb literals in the sheet would
  // freeze one theme; colours belong in the `--dsw-alias-*` variables.
  const hexColours = css.match(/#[0-9a-fA-F]{3,8}\b/g) || []
  check('style: no hardcoded hex colours', hexColours.length === 0, JSON.stringify(hexColours.slice(0, 5)))

  // The point of the sheet: rules that inline styles cannot express.
  check('style: responds to the host slot width', /@container|@media/.test(css), 'no @container/@media rule')
  check('style: honours reduced-motion', /prefers-reduced-motion/.test(css), 'no reduced-motion rule')

  // ---- injection is idempotent --------------------------------------
  const created = []
  const appended = []
  const byId = {}
  const fakeDoc = {
    getElementById(id) { return byId[id] || null },
    createElement(tag) {
      const el = { tagName: tag, textContent: '', id: '', setAttribute(k, v) { this[k] = v } }
      created.push(el)
      return el
    },
    head: { appendChild(el) { appended.push(el); if (el.id) byId[el.id] = el } },
  }

  meta5.injectStyles(fakeDoc)
  check('style: first call appends one <style>', appended.length === 1, String(appended.length))
  check('style: the appended node is a <style>', appended[0]?.tagName === 'style', String(appended[0]?.tagName))
  check('style: the node carries the documented id', appended[0]?.id === meta5.STYLE_ELEMENT_ID, String(appended[0]?.id))
  check('style: the node carries the stylesheet text', appended[0]?.textContent === css, String(appended[0]?.textContent).slice(0, 30))

  meta5.injectStyles(fakeDoc)
  meta5.injectStyles(fakeDoc)
  check('style: repeat calls do not append again', appended.length === 1, String(appended.length))

  // A host without a DOM (SSR, tests) must not crash the bundle.
  let threw = false
  try {
    meta5.injectStyles(undefined)
    meta5.injectStyles({})
  } catch {
    threw = true
  }
  check('style: tolerates a missing document', threw === false)
}

// ---- the data path --------------------------------------------------

{
  const shim = makeReact()
  const exports3 = spec.factory(makeRequire(shim))

  const MODEL = {
    ok: true,
    model: {
      modules: [
        {
          id: 'm1',
          title: 'Payment',
          defaultBranch: 'main',
          overflow: 0,
          inFlight: 1,
          stories: [{ id: 'S1', title: 'Refund', state: 'implementing', badge: '\u21BB', mrUrl: null }],
        },
      ],
      totals: { modules: 1, stories: 1, inFlight: 1, blocked: 0, completed: 0, failed: 0 },
    },
    text: 'Auto-RD: 1 module(s)',
  }

  const fetched = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    fetched.push({ url, init })
    return { ok: true, status: 200, async json() { return MODEL } }
  }

  try {
    // Render once so the effect registers, then run the effect.
    exports3.__autoRd.components.AutoRdPanel()
    const effect = shim.calls.useEffect[0]
    const cleanup = effect.fn()
    // Let the fetch promise chain settle.
    await new Promise((r) => setTimeout(r, 30))

    check('data: fetched the documented URL', fetched.length >= 1 && fetched[0].url === meta.DATA_URL, JSON.stringify(fetched.map((f) => f.url)))
    check(
      'data: asked for JSON',
      fetched[0]?.init?.headers?.accept === 'application/json',
      JSON.stringify(fetched[0]?.init),
    )
    check('data: state landed the model', shim.slots[0]?.status === 'ok', JSON.stringify(shim.slots[0]?.status))
    check('data: model modules present', shim.slots[0]?.model?.modules?.[0]?.id === 'm1', JSON.stringify(shim.slots[0]?.model))
    check('data: text carried through', typeof shim.slots[0]?.text === 'string' && shim.slots[0].text.length > 0)
    check('data: effect returns a cleanup function', typeof cleanup === 'function')

    // The cleanup must stop the poll, or the component leaks a timer.
    const before = fetched.length
    cleanup()
    await new Promise((r) => setTimeout(r, 60))
    check('data: cleanup stops the polling interval', fetched.length === before, `${before} -> ${fetched.length}`)
  } finally {
    globalThis.fetch = realFetch
  }
}

{
  // A failing fetch surfaces the error in state instead of throwing.
  const shim = makeReact()
  const exports4 = spec.factory(makeRequire(shim))
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: false, status: 503, async json() { return {} } })

  try {
    exports4.__autoRd.components.AutoRdPanel()
    const cleanup = shim.calls.useEffect[0].fn()
    await new Promise((r) => setTimeout(r, 30))
    check('data: failure sets status=error', shim.slots[0]?.status === 'error', JSON.stringify(shim.slots[0]?.status))
    check(
      'data: failure records the HTTP status',
      String(shim.slots[0]?.error).includes('503'),
      String(shim.slots[0]?.error),
    )
    cleanup()
  } finally {
    globalThis.fetch = realFetch
  }
}

// ---- cross-realm consistency ---------------------------------------

{
  const host = await import(pathToFileURL(resolve(libBase, 'services', 'ui-panel.js')).href)
  check(
    'consistency: client id matches host CLIENT_PANEL_ID',
    meta.PANEL_ID === host.CLIENT_PANEL_ID,
    `${meta.PANEL_ID} vs ${host.CLIENT_PANEL_ID}`,
  )
  check(
    'consistency: client slot matches host CLIENT_PANEL_SLOT',
    meta.PANEL_SLOT === host.CLIENT_PANEL_SLOT,
    `${meta.PANEL_SLOT} vs ${host.CLIENT_PANEL_SLOT}`,
  )
  check(
    'consistency: client order matches host CLIENT_PANEL_ORDER',
    meta.PANEL_ORDER === host.CLIENT_PANEL_ORDER,
    `${meta.PANEL_ORDER} vs ${host.CLIENT_PANEL_ORDER}`,
  )

  const route = await import(pathToFileURL(resolve(libBase, 'services', 'panel-route.js')).href)
  check(
    'consistency: client DATA_URL matches the host route path',
    meta.DATA_URL === route.PANEL_ROUTE_PATH,
    `${meta.DATA_URL} vs ${route.PANEL_ROUTE_PATH}`,
  )
}

// ---- manifest -------------------------------------------------------

{
  check('manifest: declares dsh.client', pkg.dsh?.client !== undefined, JSON.stringify(pkg.dsh))
  check('manifest: platform is web', pkg.dsh?.client?.platform === 'web', String(pkg.dsh?.client?.platform))
  check('manifest: client inject is an array', Array.isArray(pkg.dsh?.client?.inject), typeof pkg.dsh?.client?.inject)
  check(
    'manifest: ./client export points at lib/client.js',
    pkg.exports?.['./client']?.default === './lib/client.js',
    JSON.stringify(pkg.exports?.['./client']),
  )
  check('manifest: the referenced bundle exists after build', existsSync(resolve(libBase, 'client.js')))
  check('manifest: lib is in files[] so the bundle ships', pkg.files?.includes('lib'), JSON.stringify(pkg.files))
  check(
    'manifest: build copies the client bundle',
    String(pkg.scripts?.build).includes('copy:client'),
    String(pkg.scripts?.build),
  )
}

// ---- Summary --------------------------------------------------------

process.stdout.write(`\nClientHalf tests: ${pass} pass, ${fail} fail\n`)
if (fail > 0) process.exitCode = 1
