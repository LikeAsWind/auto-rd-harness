// UI panel model tests.
//
// The graphical sidebar panel is a client-side contribution (see
// services/ui-panel.ts), so what the host owns is the pure data
// projection and its text rendering. Both are tested here.
//
// Covers:
//   - buildPanelModel: grouping by module, ordering by updatedAt desc,
//     the per-module cap and its overflow count, in-flight counting, and
//     the global totals
//   - stateBadge: every 19-state value maps to a glyph
//   - renderPanelText: the no-modules and no-stories cases, the real
//     content, the MR link, and the overflow note
//   - the exported client slot coordinates
//
// Run with: node scripts/test-ui-panel.mjs

import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const libBase = resolve(__dirname, '..', 'packages', 'dsh-auto-rd', 'lib')

const {
  buildPanelModel,
  renderPanelText,
  stateBadge,
  PANEL_STORY_LIMIT,
  CLIENT_PANEL_SLOT,
  CLIENT_PANEL_ID,
  CLIENT_PANEL_ORDER,
} = await import(pathToFileURL(resolve(libBase, 'services', 'ui-panel.js')).href)

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

/** The panel only ever calls `.values()` on each table. */
function fakeStorage({ modules = [], stories = [] } = {}) {
  return {
    modules: () => ({ values: () => modules[Symbol.iterator]() }),
    stories: () => ({ values: () => stories[Symbol.iterator]() }),
  }
}

function story(over = {}) {
  return {
    id: 'S1',
    moduleId: 'm1',
    title: 'A story',
    state: 'pending',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...over,
  }
}

function mod(over = {}) {
  return {
    id: 'm1',
    title: 'Payment',
    repoUrl: 'https://x/y.git',
    defaultBranch: 'main',
    workspacePath: '/x/m1',
    createdAt: '2025-01-01T00:00:00.000Z',
    ...over,
  }
}

// ---- empty -----------------------------------------------------------

{
  const model = buildPanelModel(fakeStorage())
  check('empty: no modules', model.modules.length === 0)
  check('empty: totals all zero', model.totals.stories === 0 && model.totals.modules === 0)
  const text = renderPanelText(model)
  check('empty: text says no modules configured', text.includes('No modules configured'))
}

// ---- grouping + ordering --------------------------------------------

{
  const model = buildPanelModel(
    fakeStorage({
      modules: [mod()],
      stories: [
        story({ id: 'old', updatedAt: '2025-01-01T00:00:00.000Z' }),
        story({ id: 'new', updatedAt: '2025-06-01T00:00:00.000Z' }),
        story({ id: 'mid', updatedAt: '2025-03-01T00:00:00.000Z' }),
      ],
    }),
  )
  check('grouping: one module section', model.modules.length === 1)
  check('ordering: newest first', model.modules[0].stories[0].id === 'new', model.modules[0].stories.map((s) => s.id).join(','))
  check('ordering: oldest last', model.modules[0].stories[2].id === 'old')
  check('grouping: overflow is 0 under the cap', model.modules[0].overflow === 0)
}

{
  // Stories belonging to an unknown module must not leak into a section.
  const model = buildPanelModel(
    fakeStorage({
      modules: [mod({ id: 'm1' })],
      stories: [story({ id: 'orphan', moduleId: 'm-unknown' })],
    }),
  )
  check('grouping: orphan story excluded from the module section', model.modules[0].stories.length === 0)
  check('grouping: orphan still counted in totals', model.totals.stories === 1, String(model.totals.stories))
}

// ---- cap + overflow --------------------------------------------------

{
  const stories = Array.from({ length: PANEL_STORY_LIMIT + 3 }, (_, i) =>
    story({ id: `S${i}`, updatedAt: `2025-01-01T00:00:${String(i).padStart(2, '0')}.000Z` }),
  )
  const model = buildPanelModel(fakeStorage({ modules: [mod()], stories }))
  check('cap: visible stories capped at PANEL_STORY_LIMIT', model.modules[0].stories.length === PANEL_STORY_LIMIT, String(model.modules[0].stories.length))
  check('cap: overflow counts the rest', model.modules[0].overflow === 3, String(model.modules[0].overflow))
  const text = renderPanelText(model)
  check('cap: text reports the overflow', text.includes('+3 more'), text.split('\n').slice(-2).join(' | '))
}

// ---- totals ----------------------------------------------------------

{
  const model = buildPanelModel(
    fakeStorage({
      modules: [mod(), mod({ id: 'm2', title: 'Search' })],
      stories: [
        story({ id: 'a', moduleId: 'm1', state: 'pending' }),
        story({ id: 'b', moduleId: 'm1', state: 'implementing' }),
        story({ id: 'c', moduleId: 'm1', state: 'blocked' }),
        story({ id: 'd', moduleId: 'm2', state: 'completed' }),
        story({ id: 'e', moduleId: 'm2', state: 'failed' }),
      ],
    }),
  )
  check('totals: modules', model.totals.modules === 2, String(model.totals.modules))
  check('totals: stories', model.totals.stories === 5, String(model.totals.stories))
  check('totals: in-flight excludes completed/failed', model.totals.inFlight === 3, String(model.totals.inFlight))
  check('totals: blocked', model.totals.blocked === 1, String(model.totals.blocked))
  check('totals: completed', model.totals.completed === 1, String(model.totals.completed))
  check('totals: failed', model.totals.failed === 1, String(model.totals.failed))
  check(
    'totals: per-module inFlight',
    model.modules.find((m) => m.id === 'm1').inFlight === 3,
    String(model.modules.find((m) => m.id === 'm1').inFlight),
  )
}

// ---- stateBadge ------------------------------------------------------

{
  const distinct = {
    completed: '\u2713',
    failed: '\u2717',
    blocked: '\u26A0',
    pending: '\u00B7',
    implementing: '\u21BB',
    tapd_syncing: '\u21BB',
  }
  for (const [state, glyph] of Object.entries(distinct)) {
    check(`stateBadge: ${state}`, stateBadge(state) === glyph, stateBadge(state))
  }
  // Every state in the 19-state machine returns something.
  const all = [
    'pending', 'context', 'clarification', 'brainstorm', 'critic', 'decision',
    'spec', 'planning', 'implementing', 'testing', 'fixing', 'verifying',
    'reviewing', 'final_verifying', 'mr_creating', 'tapd_syncing',
    'completed', 'failed', 'blocked',
  ]
  check('stateBadge: defined for all 19 states', all.every((s) => typeof stateBadge(s) === 'string' && stateBadge(s).length > 0))
}

// ---- renderPanelText -------------------------------------------------

{
  const model = buildPanelModel(
    fakeStorage({
      modules: [mod()],
      stories: [
        story({ id: 'S1', title: 'Refund endpoint', state: 'implementing', mrUrl: 'https://gitlab/mr/1' }),
      ],
    }),
  )
  const text = renderPanelText(model)
  check('text: header carries the modules/stories totals', text.includes('Modules: 1') && text.includes('stories: 1'))
  check('text: header carries the uptime + last poll', text.includes('mounted for') && text.includes('last TAPD poll'))
  check('text: module line has id and target branch', text.includes('Payment (m1)') && text.includes('target: main'))
  check('text: story line has id, title, state', text.includes('S1: Refund endpoint') && text.includes('[implementing]'))
  check('text: MR link rendered', text.includes('[MR](https://gitlab/mr/1)'))
}

{
  const model = buildPanelModel(fakeStorage({ modules: [mod()], stories: [] }))
  const text = renderPanelText(model)
  check('text: empty module says "no stories"', text.includes('no stories'))
}

// ---- health block + setup checklist ----------------------------------

{
  // Empty config: every required-looking field is missing. The health
  // block must enumerate each missing piece in plain text.
  const { ConfigSchema } = await import(
    (await import('node:url')).pathToFileURL(resolve(libBase, 'config.js')).href
  )
  const emptyConfig = ConfigSchema.parse({})
  const model = buildPanelModel(fakeStorage({ modules: [], stories: [] }), emptyConfig, {
    mountedAt: new Date(Date.now() - 30_000),
    lastTapdPollAt: null,
    lastTapdError: null,
  })
  check('health: setupRequired is true on empty config', model.health.setupRequired === true)
  check('health: emits a tapd_token issue', model.health.issues.some((i) => i.key === 'tapd_token'))
  check('health: emits a gitlab_token issue', model.health.issues.some((i) => i.key === 'gitlab_token'))
  check('health: emits a workspace_root issue', model.health.issues.some((i) => i.key === 'workspace_root'))
  check('health: emits a modules issue', model.health.issues.some((i) => i.key === 'modules'))
  check('health: mountedForSec reflects the runtime gap', model.health.mountedForSec >= 30)
  check(
    'health: tapd_workspaces issue appears when token is set but workspace ids empty',
    (() => {
      const cfg2 = ConfigSchema.parse({
        tapdApiToken: 'x',
        tapdWorkspaceIds: [],
        useTapdMock: false,
        workspaceRoot: '/w',
        modules: [{ id: 'm', title: 'M', repoUrl: 'https://x/y.git' }],
      })
      const m2 = buildPanelModel(fakeStorage({ modules: [], stories: [] }), cfg2, {
        mountedAt: new Date(),
        lastTapdPollAt: null,
        lastTapdError: null,
      })
      return m2.health.issues.some((i) => i.key === 'tapd_workspaces')
    })(),
  )
  // Render text surfaces the setup checklist.
  const text = renderPanelText(model)
  check('health text: setup section header', text.includes('Setup required'))
  check('health text: tapd_token line', text.includes('[tapd_token]'))
  check('health text: workspace_root line', text.includes('[workspace_root]'))
}

{
  // Fully configured: no setup issues; mock mode hides the workspaces issue.
  const { ConfigSchema } = await import(
    (await import('node:url')).pathToFileURL(resolve(libBase, 'config.js')).href
  )
  const cfg = ConfigSchema.parse({
    tapdApiToken: 'tok',
    gitlabApiToken: 'gtok',
    useTapdMock: true,
    workspaceRoot: '/w',
    modules: [{ id: 'm', title: 'M', repoUrl: 'https://x/y.git' }],
  })
  const model = buildPanelModel(fakeStorage({ modules: [], stories: [] }), cfg, {
    mountedAt: new Date(),
    lastTapdPollAt: new Date(),
    lastTapdError: null,
  })
  check('health: setupRequired is false when fully configured', model.health.setupRequired === false)
  check('health: issues array is empty when fully configured', model.health.issues.length === 0)
  check('health: lastTapdPollAt propagates', model.health.lastTapdPollAt !== null)
  check('health: lastTapdError propagates', model.health.lastTapdError === null)
}

// ---- client coordinates ---------------------------------------------

{
  check('client: slot is the documented sidebar.panellist', CLIENT_PANEL_SLOT === 'sidebar.panellist', CLIENT_PANEL_SLOT)
  check('client: panel id is stable', CLIENT_PANEL_ID === 'auto-rd-modules', CLIENT_PANEL_ID)
  check('client: order is a number', typeof CLIENT_PANEL_ORDER === 'number')
}

// ---- Summary --------------------------------------------------------

process.stdout.write(`\nUiPanel tests: ${pass} pass, ${fail} fail\n`)
process.exit(fail > 0 ? 1 : 0)
