// AutoRdStorage adapter tests against a REAL-shaped storageDomain.
//
// This suite exists because the plugin previously called
// `storage.stories().values()` everywhere, but DSH's real `KvTable` has
// no `values()` method — it exposes get/entries/keys/size/put/delete/
// update. It also called the async `storageDomain.open()` synchronously.
// Both would have failed at mount against the real runtime.
//
// So the fake domain here is deliberately modelled on the VERIFIED
// contract: async open(), and a table object with NO values(). If the
// adapter regresses, these tests fail.
//
// Covers:
//   - open() is awaited (the returned value is a real instance, not a Promise)
//   - the spec passed to open() has the right name/version/layout/tables
//   - values() works through the adapter even though the table lacks it
//   - get/put/delete/update/entries/keys/size delegate correctly
//   - values() is a fresh iterator each call (not consumed once)
//   - close() releases the domain
//   - a second open() of the same name is rejected by the facility
//
// Run with: node scripts/test-storage-adapter.mjs

import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const libBase = resolve(__dirname, '..', 'packages', 'dsh-auto-rd', 'lib')

const { AutoRdStorage } = await import(
  pathToFileURL(resolve(libBase, 'domain', 'storage.js')).href
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
 * A table shaped exactly like the real KvTable: NO values().
 */
function realShapedTable(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    get(key) {
      return map.get(key)
    },
    entries() {
      return map.entries()
    },
    keys() {
      return map.keys()
    },
    get size() {
      return map.size
    },
    async put(key, value) {
      map.set(key, value)
    },
    async delete(key) {
      return map.delete(key)
    },
    async update(key, fn) {
      const next = fn(map.get(key))
      map.set(key, next)
      return next
    },
    // Test-only escape hatch, prefixed so it cannot be mistaken for API.
    __raw: map,
  }
}

/** A storageDomain facility shaped like the real one. */
function realShapedFacility(tables = {}) {
  const opened = new Map()
  const spec = { last: null, closed: [] }
  return {
    spec,
    opened,
    async open(s) {
      if (opened.has(s.name)) {
        throw new Error(`already-open: ${s.name}`)
      }
      const domainTables = {}
      for (const name of Object.keys(s.tables)) {
        domainTables[name] = realShapedTable(tables[name] ?? {})
      }
      const domain = {
        name: s.name,
        table(n) {
          const t = domainTables[n]
          if (!t) throw new Error(`unknown table: ${n}`)
          return t
        },
        async close() {
          spec.closed.push(s.name)
        },
      }
      opened.set(s.name, domain)
      spec.last = s
      return domain
    },
    get(name) {
      return opened.get(name)
    },
    async closeAll() {
      for (const [, d] of opened) await d.close()
    },
  }
}

const CTX = {}

// ---- async open -----------------------------------------------------

{
  const facility = realShapedFacility()
  const storage = await AutoRdStorage.open(CTX, facility)

  check('open: returns an AutoRdStorage instance', storage instanceof AutoRdStorage)
  check(
    'open: result is not a Promise (awaited properly)',
    typeof storage.then !== 'function',
  )
  check('open: domain name is auto_rd (storage naming rule: ^[a-z][a-z0-9_]*$)', facility.spec.last.name === 'auto_rd', facility.spec.last.name)
  check('open: version is 4', facility.spec.last.version === 4, String(facility.spec.last.version))
  check(
    'open: layout is per-record (not single-file)',
    facility.spec.last.layout === 'per-record',
    String(facility.spec.last.layout),
  )
  check(
    'open: declares all four tables',
    ['modules', 'stories', 'tasks', 'trajectories'].every((t) => t in facility.spec.last.tables),
    JSON.stringify(Object.keys(facility.spec.last.tables)),
  )
  check(
    'open: every table spec carries a valueSchema',
    Object.values(facility.spec.last.tables).every((t) => t.valueSchema !== undefined),
  )
}

// ---- values() adapter over a table that has no values() -------------

{
  const facility = realShapedFacility({
    stories: {
      S1: { id: 'S1', title: 'first' },
      S2: { id: 'S2', title: 'second' },
    },
  })
  const storage = await AutoRdStorage.open(CTX, facility)
  const stories = storage.stories()

  check(
    'the underlying table really has no values() (fixture is faithful)',
    typeof facility.opened.get('auto_rd').table('stories').values === 'undefined',
  )
  check('adapter: provides values()', typeof stories.values === 'function')

  const values = [...stories.values()]
  check('adapter: values() yields every record', values.length === 2, String(values.length))
  check(
    'adapter: values() yields the records themselves, not [k,v] pairs',
    values.every((v) => v && typeof v === 'object' && 'title' in v),
    JSON.stringify(values),
  )

  // A generator must be re-iterable across calls.
  const again = [...stories.values()]
  check('adapter: values() is fresh on each call', again.length === 2, String(again.length))
}

// ---- delegation -----------------------------------------------------

{
  const facility = realShapedFacility()
  const storage = await AutoRdStorage.open(CTX, facility)
  const stories = storage.stories()

  check('adapter: size starts at 0', stories.size === 0)

  await stories.put('S1', { id: 'S1', title: 'x' })
  check('adapter: put() then size === 1', stories.size === 1, String(stories.size))
  check('adapter: get() returns the value', stories.get('S1')?.title === 'x')
  check('adapter: get() returns undefined for a missing key', stories.get('nope') === undefined)

  const keys = [...stories.keys()]
  check('adapter: keys() delegates', keys.length === 1 && keys[0] === 'S1', JSON.stringify(keys))

  const entries = [...stories.entries()]
  check(
    'adapter: entries() delegates and yields [key, value]',
    entries.length === 1 && entries[0][0] === 'S1' && entries[0][1].title === 'x',
    JSON.stringify(entries),
  )

  const updated = await stories.update('S1', (cur) => ({ ...cur, title: 'y' }))
  check('adapter: update() delegates and returns the new value', updated.title === 'y')
  check('adapter: update() persisted', stories.get('S1').title === 'y')

  const deleted = await stories.delete('S1')
  check('adapter: delete() returns a boolean', deleted === true, String(deleted))
  check('adapter: delete() removed the key', stories.get('S1') === undefined)
  check('adapter: size back to 0', stories.size === 0, String(stories.size))
}

// ---- all four accessors ---------------------------------------------

{
  const facility = realShapedFacility()
  const storage = await AutoRdStorage.open(CTX, facility)
  check('accessor: modules() works', typeof storage.modules().get === 'function')
  check('accessor: stories() works', typeof storage.stories().get === 'function')
  check('accessor: tasks() works', typeof storage.tasks().get === 'function')
  check('accessor: trajectories() works', typeof storage.trajectories().get === 'function')
}

// ---- close ----------------------------------------------------------

{
  const facility = realShapedFacility()
  const storage = await AutoRdStorage.open(CTX, facility)
  await storage.close()
  check('close: released the domain', facility.spec.closed.includes('auto_rd'), JSON.stringify(facility.spec.closed))
}

// ---- already-open guard --------------------------------------------

{
  const facility = realShapedFacility()
  await AutoRdStorage.open(CTX, facility)
  let threw = null
  try {
    await AutoRdStorage.open(CTX, facility)
  } catch (err) {
    threw = err
  }
  check('open: a second open of the same name rejects', threw !== null)
  check(
    'open: the rejection is the facility already-open error',
    threw !== null && /already-open/.test(threw.message),
    threw?.message,
  )
}

// ---- Summary --------------------------------------------------------

process.stdout.write(`\nStorageAdapter tests: ${pass} pass, ${fail} fail\n`)
if (fail > 0) process.exitCode = 1
