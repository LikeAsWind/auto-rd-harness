#!/usr/bin/env node
/**
 * test-recover — covers services/recover.ts
 *
 * What this suite guards:
 *   1. Orphan cleanup: stories whose moduleId is not in the live
 *      module set are deleted from storage on mount. This is the fix
 *      for issue #9 — without it, totals.stories in the panel model
 *      counts orphans and shows "1 个需求" against an empty module
 *      list.
 *   2. State recovery: stories in ACTIVE states are reset to 'pending'
 *      with retryCount=0 and a fresh updatedAt; terminal states are
 *      left untouched.
 *   3. Order: orphans are dropped before state recovery runs, so the
 *      recovery loop only ever sees live stories (a defensive choice
 *      — we don't want to "reset" a story we're about to drop).
 *   4. Trajectory events are recorded for both kinds of action.
 *
 * Usage:
 *   node scripts/test-recover.mjs
 */

import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const libBase = resolve(ROOT, 'packages/dsh-auto-rd/lib')

const results = []
function check(label, ok, detail) {
  results.push({ label, ok, detail })
}

function makeFixture() {
  const stories = new Map()
  const trajectories = []
  const storage = {
    stories: () => ({
      values: () => stories.values(),
      get: (id) => stories.get(id),
      put: async (id, s) => { stories.set(id, s); return s },
      delete: (id) => stories.delete(id),
      _dump: () => new Map(stories),
    }),
  }
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
  }
  const trajectory = {
    append: (ev) => { trajectories.push(ev); return Promise.resolve() },
  }
  async function put(id, s) { stories.set(id, s) }
  return { storage, logger, trajectory, trajectories, put }
}

const { recoverStories } = await import(
  (await import('node:url')).pathToFileURL(resolve(libBase, 'services/recover.js')).href
)

// ---- 1. Orphan cleanup ----------------------------------------------------

{
  const f = makeFixture()
  await f.put('orphan-1', { id: 'orphan-1', moduleId: 'gone', state: 'implementing', updatedAt: 'x', retryCount: 0 })
  await f.put('orphan-2', { id: 'orphan-2', moduleId: 'gone', state: 'completed', updatedAt: 'x', retryCount: 0 })
  await f.put('live-1', { id: 'live-1', moduleId: 'payment', state: 'pending', updatedAt: 'x', retryCount: 0 })

  const result = await recoverStories(f.storage, f.logger, new Set(['payment']), f.trajectory)

  check('orphan: drops orphan-1 from storage', !f.storage.stories()._dump().has('orphan-1'))
  check('orphan: drops orphan-2 from storage', !f.storage.stories()._dump().has('orphan-2'))
  check('orphan: keeps live-1 in storage', f.storage.stories()._dump().has('live-1'))
  check(
    'orphan: returns the dropped ids in the result',
    result.orphansDropped.length === 2 && result.orphansDropped.includes('orphan-1'),
    JSON.stringify(result.orphansDropped),
  )
  check(
    'orphan: trajectory records one event per dropped story',
    f.trajectories.filter((t) => t.label && t.label.startsWith('orphan')).length === 2,
    JSON.stringify(f.trajectories),
  )
}

// ---- 2. State recovery: ACTIVE -> pending ---------------------------------

{
  const f = makeFixture()
  await f.put('mid', { id: 'mid', moduleId: 'payment', state: 'implementing', updatedAt: 'old', retryCount: 3 })

  const before = Date.now()
  const result = await recoverStories(f.storage, f.logger, new Set(['payment']), f.trajectory)
  const after = Date.now()

  const mid = f.storage.stories().get('mid')
  check('recover: ACTIVE story reset to pending', mid.state === 'pending', JSON.stringify(mid))
  check('recover: retryCount cleared', mid.retryCount === 0, String(mid.retryCount))
  check(
    'recover: updatedAt advanced to within the call window',
    new Date(mid.updatedAt).getTime() >= before && new Date(mid.updatedAt).getTime() <= after,
    mid.updatedAt,
  )
  check(
    'recover: returns the recovered id',
    result.recovered.length === 1 && result.recovered[0] === 'mid',
    JSON.stringify(result.recovered),
  )
  check(
    'recover: trajectory records the previous -> pending transition',
    f.trajectories.some((t) => t.kind === 'recovery' && t.label === 'implementing → pending'),
  )
}

// ---- 3. State recovery: terminal states untouched ------------------------

{
  const f = makeFixture()
  await f.put('done', { id: 'done', moduleId: 'payment', state: 'completed', updatedAt: 'old', retryCount: 0 })
  await f.put('dead', { id: 'dead', moduleId: 'payment', state: 'failed', updatedAt: 'old', retryCount: 0 })
  await f.put('halted', { id: 'halted', moduleId: 'payment', state: 'blocked', updatedAt: 'old', retryCount: 0 })
  await f.put('queued', { id: 'queued', moduleId: 'payment', state: 'pending', updatedAt: 'old', retryCount: 5 })

  const result = await recoverStories(f.storage, f.logger, new Set(['payment']), f.trajectory)

  const dump = f.storage.stories()._dump()
  check('recover: completed left alone', dump.get('done').state === 'completed')
  check('recover: failed left alone', dump.get('dead').state === 'failed')
  check('recover: blocked left alone', dump.get('halted').state === 'blocked')
  check(
    'recover: pending left alone (already in queue)',
    dump.get('queued').state === 'pending',
  )
  check(
    'recover: pending not double-reset (retryCount preserved)',
    dump.get('queued').retryCount === 5,
    String(dump.get('queued').retryCount),
  )
  check('recover: nothing reported as recovered', result.recovered.length === 0)
}

// ---- 4. Combined: orphan + recovery in the same storage snapshot ----------

{
  const f = makeFixture()
  await f.put('orphan-active', { id: 'orphan-active', moduleId: 'gone', state: 'implementing', updatedAt: 'old', retryCount: 0 })
  await f.put('live-active', { id: 'live-active', moduleId: 'payment', state: 'verifying', updatedAt: 'old', retryCount: 0 })

  const result = await recoverStories(f.storage, f.logger, new Set(['payment']), f.trajectory)

  check('combined: orphan dropped', !f.storage.stories()._dump().has('orphan-active'))
  check('combined: live story reset', f.storage.stories().get('live-active').state === 'pending')
  check(
    'combined: orphan not in recovered list (defensive — drop happens first)',
    !result.recovered.includes('orphan-active'),
    JSON.stringify(result.recovered),
  )
  check(
    'combined: only live story in recovered list',
    result.recovered.length === 1 && result.recovered[0] === 'live-active',
  )
}

// ---- 5. Empty storage is a no-op ------------------------------------------

{
  const f = makeFixture()
  const result = await recoverStories(f.storage, f.logger, new Set(), f.trajectory)
  check('empty: no orphans dropped', result.orphansDropped.length === 0)
  check('empty: nothing recovered', result.recovered.length === 0)
}

// ---- 6. Empty live set means drop everything in storage ------------------

{
  const f = makeFixture()
  await f.put('a', { id: 'a', moduleId: 'payment', state: 'implementing', updatedAt: 'x', retryCount: 0 })
  await f.put('b', { id: 'b', moduleId: 'order', state: 'pending', updatedAt: 'x', retryCount: 0 })

  const result = await recoverStories(f.storage, f.logger, new Set(), f.trajectory)

  check(
    'empty-live: drops everything in storage',
    f.storage.stories()._dump().size === 0,
    'still has ' + f.storage.stories()._dump().size,
  )
  check(
    'empty-live: reports both as orphans',
    result.orphansDropped.length === 2,
    JSON.stringify(result.orphansDropped),
  )
}

// ---- Report ---------------------------------------------------------------

let pass = 0, fail = 0
for (const r of results) {
  if (r.ok) pass++
  else { fail++; console.error(`✗ ${r.label}${r.detail ? ' :: ' + r.detail : ''}`) }
}
console.log(`Recover tests: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
