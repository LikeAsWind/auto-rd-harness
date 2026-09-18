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
  emptyTokenState,
  PANEL_STORY_LIMIT,
  CLIENT_PANEL_SLOT,
  CLIENT_PANEL_ID,
  CLIENT_PANEL_ORDER,
} = await import(pathToFileURL(resolve(libBase, 'services', 'ui-panel.js')).href)

let pass = 0
let fail = 0
function check(name, ok, extra) {
  // `ok` is allowed to be a Promise — sections that hit the (async)
  // credentials seam now use `await (async () => …)()` to pre-resolve
  // their inputs, but we keep this helper sync-friendly so most
  // sections don't have to thread `await` through every assertion.
  // A bare Promise evaluates truthy at the call site, so we collapse
  // it to a "pending" sentinel here and rely on the section wrapper
  // to await before the summary line.
  if (ok instanceof Promise) {
    fail += 1
    process.stdout.write(`\u2717 ${name} (unresolved Promise — wrap with await)\n`)
    return
  }
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

// Module identity comes from the live config, not storage: DSH restarts
// wipe the config but leave storage, so storage can carry orphans the
// user never expects to see again (see buildPanelModel). Storage still
// supplies the stories and the richer module record.
//
// `panelModel` keeps the two in lock-step the way the host does, so a
// test states its modules once and gets the same view the UI sees.
function configFor(modules) {
  return { modules: modules.map((m) => ({ id: m.id, title: m.title })) }
}

function panelModel({ modules = [], stories = [] } = {}, runtime, tokenState) {
  const cfg = configFor(modules)
  return buildPanelModel(
    fakeStorage({ modules, stories }),
    cfg,
    runtime,
    tokenState ?? tokenStateFromConfig(cfg),
  )
}

/**
 * Construct a TokenState from a parsed config, mirroring the
 * post-#10 semantics: a module is "configured" if its
 * `tapdApiToken` / `gitlabApiToken` is non-empty (this preserves
 * the pre-#10 behaviour tests assert). The host path goes through
 * `resolveTokenStates(credentials, modules)`; the tests do not
 * mount a credentials service, so this shim encodes the legacy
 * presence check.
 */
function tokenStateFromConfig(cfg) {
  const tapd = new Map()
  const gitlab = new Map()
  for (const m of cfg?.modules ?? []) {
    tapd.set(m.id, !!(m.tapdApiToken && m.tapdApiToken.length > 0))
    gitlab.set(m.id, !!(m.gitlabApiToken && m.gitlabApiToken.length > 0))
  }
  return {
    tapd,
    gitlab,
    tapdGlobal: !!(cfg?.tapdApiToken && cfg.tapdApiToken.length > 0),
    gitlabGlobal: !!(cfg?.gitlabApiToken && cfg.gitlabApiToken.length > 0),
  }
}

function story(over = {}) {
  return {
    id: 'S1',
    moduleId: 'm1',
    title: 'A story',
    state: 'pending',
    updatedAt: '2025-01-01T00:00:00.000Z',
    artifacts: {},
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

await (async () => {
  // No config at all: the checklist is skipped entirely, so the text
  // renderer reports the plain empty state rather than a setup warning.
  const model = buildPanelModel(fakeStorage(), undefined, undefined, emptyTokenState())
  check('empty: no modules', model.modules.length === 0)
  check('empty: totals all zero', model.totals.stories === 0 && model.totals.modules === 0)
  const text = renderPanelText(model)
  check('empty: text says no modules configured', text.includes('No modules configured'))
})()

// ---- grouping + ordering --------------------------------------------

{
  const model = panelModel({
    modules: [mod()],
    stories: [
      story({ id: 'old', updatedAt: '2025-01-01T00:00:00.000Z' }),
      story({ id: 'new', updatedAt: '2025-06-01T00:00:00.000Z' }),
      story({ id: 'mid', updatedAt: '2025-03-01T00:00:00.000Z' }),
    ],
  })
  check('grouping: one module section', model.modules.length === 1)
  check('ordering: newest first', model.modules[0].stories[0].id === 'new', model.modules[0].stories.map((s) => s.id).join(','))
  check('ordering: oldest last', model.modules[0].stories[2].id === 'old')
  check('grouping: overflow is 0 under the cap', model.modules[0].overflow === 0)
}

{
  // Stories belonging to an unknown module must not leak into a section.
  // The remove_workspace route deletes a module's stories along
  // with it; recover.ts drops any orphans that escape that path.
  // Totals therefore align with what the module sections can place —
  // orphans do NOT inflate the count.
  const model = panelModel({
    modules: [mod({ id: 'm1' })],
    stories: [story({ id: 'orphan', moduleId: 'm-unknown' })],
  })
  check('grouping: orphan story excluded from the module section', model.modules[0].stories.length === 0)
  check(
    'grouping: orphan not counted in totals (aligns with sections)',
    model.totals.stories === 0,
    String(model.totals.stories),
  )
  check('totals: per-module stories stay exact', model.modules[0].stories.length + model.modules[0].overflow === 0)
}

// ---- cap + overflow --------------------------------------------------

{
  const stories = Array.from({ length: PANEL_STORY_LIMIT + 3 }, (_, i) =>
    story({ id: `S${i}`, updatedAt: `2025-01-01T00:00:${String(i).padStart(2, '0')}.000Z` }),
  )
  const model = panelModel({ modules: [mod()], stories })
  check('cap: visible stories capped at PANEL_STORY_LIMIT', model.modules[0].stories.length === PANEL_STORY_LIMIT, String(model.modules[0].stories.length))
  check('cap: overflow counts the rest', model.modules[0].overflow === 3, String(model.modules[0].overflow))
  const text = renderPanelText(model)
  check('cap: text reports the overflow', text.includes('+3 more'), text.split('\n').slice(-2).join(' | '))
}

// ---- totals ----------------------------------------------------------

{
  const model = panelModel({
    modules: [mod(), mod({ id: 'm2', title: 'Search' })],
    stories: [
      story({ id: 'a', moduleId: 'm1', state: 'pending' }),
      story({ id: 'b', moduleId: 'm1', state: 'implementing' }),
      story({ id: 'c', moduleId: 'm1', state: 'blocked' }),
      story({ id: 'd', moduleId: 'm2', state: 'completed' }),
      story({ id: 'e', moduleId: 'm2', state: 'failed' }),
    ],
  })
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
    delivery_ready: '\u2713',
    mr_opened: '\u2197',
    failed: '\u2717',
    blocked: '\u26A0',
    pending: '\u00B7',
    implementing: '\u21BB',
    final_verifying: '\u21BB',
  }
  for (const [state, glyph] of Object.entries(distinct)) {
    check(`stateBadge: ${state}`, stateBadge(state) === glyph, stateBadge(state))
  }
  // Every state in the 19-state machine returns something.
  const all = [
    'pending', 'context', 'clarification', 'brainstorm', 'critic', 'decision',
    'spec', 'planning', 'implementing', 'testing', 'fixing', 'verifying',
    'reviewing', 'final_verifying', 'delivery_ready', 'mr_opened',
    'completed', 'failed', 'blocked',
  ]
  check('stateBadge: defined for all 19 states', all.every((s) => typeof stateBadge(s) === 'string' && stateBadge(s).length > 0))
}

// ---- renderPanelText -------------------------------------------------

{
  const model = panelModel({
    modules: [mod()],
    stories: [
      story({ id: 'S1', title: 'Refund endpoint', state: 'implementing', mrUrl: 'https://gitlab/mr/1' }),
    ],
  })
  const text = renderPanelText(model)
  check('text: header carries the modules/stories totals', text.includes('Modules: 1') && text.includes('stories: 1'))
  check('text: header carries the uptime + last poll', text.includes('mounted for') && text.includes('last TAPD poll'))
  check('text: module line has id and target branch', text.includes('Payment (m1)') && text.includes('target: main'))
  check('text: story line has id, title, state', text.includes('S1: Refund endpoint') && text.includes('[implementing]'))
  check('text: MR link rendered', text.includes('[MR](https://gitlab/mr/1)'))
}

// ---- detail fields: branch / acceptance / artifacts / session -----------

{
  // Everything the story detail view needs must survive the projection
  // from StoryRecord to PanelStory — a missing field in the panel model
  // is a field the UI can never render.
  const model = panelModel({
    modules: [mod()],
    stories: [
      story({
        id: 'S9',
        title: 'Coupon stacking',
        state: 'blocked',
        branch: 'auto-rd/TAPD-8821',
        worktreePath: 'D:/repos/payment/.auto-rd/8821',
        mainSessionId: 'ses_4f2a',
        acceptanceCriteria: '- 支持部分退款\n- 幂等',
        blockedReason: 'TAPD 接口返回 401 Unauthorized',
        artifacts: {
          spec: { kind: 'spec', filename: '06-spec.md', summary: '规格', createdAt: '2026-09-17T10:22:00Z' },
          plan: { kind: 'plan', filename: '07-plan.md', summary: '计划', createdAt: '2026-09-17T10:31:00Z' },
        },
      }),
    ],
  })
  const s = model.modules[0].stories[0]
  check('detail: branch carried through', s.branch === 'auto-rd/TAPD-8821', String(s.branch))
  check('detail: worktree path carried through', s.worktreePath === 'D:/repos/payment/.auto-rd/8821', String(s.worktreePath))
  check('detail: session id carried through', s.mainSessionId === 'ses_4f2a', String(s.mainSessionId))
  check('detail: acceptance criteria carried through', s.acceptanceCriteria === '- 支持部分退款\n- 幂等', String(s.acceptanceCriteria))
  check('detail: blocked reason carried through', s.blockedReason === 'TAPD 接口返回 401 Unauthorized', String(s.blockedReason))
  check(
    'detail: artifacts carried as ordered refs',
    Array.isArray(s.artifacts) && s.artifacts.length === 2 && s.artifacts[0].filename === '06-spec.md',
    JSON.stringify(s.artifacts),
  )

  const text = renderPanelText(model)
  check('detail: text renders the branch', text.includes('branch: auto-rd/TAPD-8821'), text.split('\n').find((l) => l.includes('8821')))
}

{
  // A story created before the pipeline filled anything in — every
  // optional field is absent. The projection must yield explicit empty
  // values, never crash and never silently drop keys.
  const model = panelModel({
    modules: [mod()],
    stories: [story({ id: 'S0', title: 'Fresh from TAPD', state: 'pending' })],
  })
  const s = model.modules[0].stories[0]
  check('detail: branch absent → empty string', s.branch === '', String(s.branch))
  check('detail: worktree absent → empty string', s.worktreePath === '', String(s.worktreePath))
  check('detail: session absent → empty string', s.mainSessionId === '', String(s.mainSessionId))
  check('detail: acceptance absent → empty string', s.acceptanceCriteria === '', String(s.acceptanceCriteria))
  check('detail: blocked reason absent → empty string', s.blockedReason === '', String(s.blockedReason))
  check('detail: artifacts absent → empty array', Array.isArray(s.artifacts) && s.artifacts.length === 0, JSON.stringify(s.artifacts))
}

{
  const model = panelModel({ modules: [mod()], stories: [] })
  const text = renderPanelText(model)
  check('text: empty module says "no stories"', text.includes('no stories'))
}

// ---- health block + setup checklist ----------------------------------

await (async () => {
  // Empty config: every required-looking field is missing. The health
  // block must enumerate each missing piece in plain text.
  const { ConfigSchema } = await import(
    (await import('node:url')).pathToFileURL(resolve(libBase, 'config.js')).href
  )
  const emptyConfig = ConfigSchema.parse({})
  const model = buildPanelModel(
    fakeStorage({ modules: [], stories: [] }),
    emptyConfig,
    { mountedAt: new Date(Date.now() - 30_000), lastTapdPollAt: null, lastTapdError: null },
    tokenStateFromConfig(emptyConfig),
  )
  check('health: setupRequired is true on empty config', model.health.setupRequired === true)
  check('health: emits a tapd_token issue', model.health.issues.some((i) => i.key === 'tapd_token'))
  check('health: emits a gitlab_token issue', model.health.issues.some((i) => i.key === 'gitlab_token'))
  check('health: emits a workspace_root issue', model.health.issues.some((i) => i.key === 'workspace_root'))
  // The "modules is empty" issue is intentionally removed — an empty
  // workspace list is the expected initial state, not a misconfiguration.
  check('health: does NOT emit a modules issue', !model.health.issues.some((i) => i.key === 'modules'))
  check('health: mountedForSec reflects the runtime gap', model.health.mountedForSec >= 30)
  check(
    'health: any module with tapdApiToken suppresses the global tapd_token issue',
    (() => {
      const cfg2 = ConfigSchema.parse({
        tapdApiToken: '',
        tapdWorkspaceIds: [],
        workspaceRoot: '/w',
        modules: [{ id: 'm', title: 'M', repoUrl: 'https://x/y.git', tapdApiToken: 'tk' }],
      })
      const m2 = buildPanelModel(
        fakeStorage({ modules: [], stories: [] }),
        cfg2,
        { mountedAt: new Date(), lastTapdPollAt: null, lastTapdError: null },
        tokenStateFromConfig(cfg2),
      )
      return !m2.health.issues.some((i) => i.key === 'tapd_token')
    })(),
  )
  check(
    'health: any module with gitlabApiToken suppresses the global gitlab_token issue',
    (() => {
      const cfg2 = ConfigSchema.parse({
        tapdApiToken: '',
        tapdWorkspaceIds: [],
        workspaceRoot: '/w',
        modules: [{ id: 'm', title: 'M', repoUrl: 'https://x/y.git', gitlabApiToken: 'tk' }],
      })
      const m2 = buildPanelModel(
        fakeStorage({ modules: [], stories: [] }),
        cfg2,
        { mountedAt: new Date(), lastTapdPollAt: null, lastTapdError: null },
        tokenStateFromConfig(cfg2),
      )
      return !m2.health.issues.some((i) => i.key === 'gitlab_token')
    })(),
  )
  // Render text surfaces the setup checklist.
  const text = renderPanelText(model)
  check('health text: setup section header', text.includes('Setup required'))
  check('health text: tapd_token line', text.includes('[tapd_token]'))
  check('health text: workspace_root line', text.includes('[workspace_root]'))
})()

await (async () => {
  // Fully configured: no setup issues.
  const { ConfigSchema } = await import(
    (await import('node:url')).pathToFileURL(resolve(libBase, 'config.js')).href
  )
  const cfg = ConfigSchema.parse({
    tapdApiToken: 'tok',
    gitlabApiToken: 'gtok',
    workspaceRoot: '/w',
    modules: [{ id: 'm', title: 'M', repoUrl: 'https://x/y.git' }],
  })
  const model = buildPanelModel(
    fakeStorage({ modules: [], stories: [] }),
    cfg,
    { mountedAt: new Date(), lastTapdPollAt: new Date(), lastTapdError: null },
    tokenStateFromConfig(cfg),
  )
  check('health: setupRequired is false when fully configured', model.health.setupRequired === false)
  check('health: issues array is empty when fully configured', model.health.issues.length === 0)
  check('health: lastTapdPollAt propagates', model.health.lastTapdPollAt !== null)
  check('health: lastTapdError propagates', model.health.lastTapdError === null)
})()

// ---- client coordinates ---------------------------------------------

{
  check('client: slot is the documented sidebar.panellist', CLIENT_PANEL_SLOT === 'sidebar.panellist', CLIENT_PANEL_SLOT)
  check('client: panel id is stable', CLIENT_PANEL_ID === 'auto-rd-modules', CLIENT_PANEL_ID)
  check('client: order is a number', typeof CLIENT_PANEL_ORDER === 'number')
}

// ---- per-workspace poll stat --------------------------------------

{
  // buildPanelModel surfaces runtime.pollStats per module, serialising
  // Dates to ISO strings, and omits the field when absent.
  const m1 = mod({ id: 'm1' })
  const m2 = mod({ id: 'm2', title: 'Search' })
  const runtimeWithStats = {
    mountedAt: new Date('2025-01-01T00:00:00.000Z'),
    lastTapdPollAt: null,
    lastTapdError: null,
    pollStats: new Map([
      ['m1', {
        moduleId: 'm1',
        lastAttemptAt: new Date('2025-01-01T00:01:00.000Z'),
        lastSuccessAt: new Date('2025-01-01T00:01:00.000Z'),
        lastError: null,
        lastNewCount: 2,
        intervalMs: 60000,
      }],
      ['m2', {
        moduleId: 'm2',
        lastAttemptAt: new Date('2025-01-01T00:02:00.000Z'),
        lastSuccessAt: null,
        lastError: '401 Unauthorized',
        lastNewCount: 0,
        intervalMs: 60000,
      }],
    ]),
  }
  const model = buildPanelModel(
    fakeStorage({ modules: [m1, m2], stories: [] }),
    configFor([m1, m2]),
    runtimeWithStats,
    tokenStateFromConfig(configFor([m1, m2])),
  )
  const p1 = model.modules.find((x) => x.id === 'm1')
  const p2 = model.modules.find((x) => x.id === 'm2')
  check('pollStat: success module carries ISO successAt', p1.pollStat.lastSuccessAt === '2025-01-01T00:01:00.000Z', JSON.stringify(p1.pollStat))
  check('pollStat: success module has lastNewCount', p1.pollStat.lastNewCount === 2, String(p1.pollStat.lastNewCount))
  check('pollStat: carries intervalMs', p1.pollStat.intervalMs === 60000, String(p1.pollStat.intervalMs))
  check('pollStat: failing module carries the error', p2.pollStat.lastError === '401 Unauthorized', String(p2.pollStat.lastError))
  check('pollStat: failing module keeps successAt null', p2.pollStat.lastSuccessAt === null, String(p2.pollStat.lastSuccessAt))
}

{
  // No runtime (legacy callers): the field is simply absent, never null.
  const m1 = mod({ id: 'm1' })
  const model = buildPanelModel(fakeStorage({ modules: [m1], stories: [] }), configFor([m1]), undefined, tokenStateFromConfig(configFor([m1])))
  check('pollStat: absent runtime omits the field', model.modules[0].pollStat === undefined, JSON.stringify(model.modules[0].pollStat))
}

// ---- Summary --------------------------------------------------------

process.stdout.write(`\nUiPanel tests: ${pass} pass, ${fail} fail\n`)
process.exit(fail > 0 ? 1 : 0)
