// Watch-panel tests — issues #5 / #6 / #7 / #8.
//
// All four issues touch the client bundle's behaviour. The tests below
// exercise the bundle through the same shim the existing client-half
// suite uses (see test-client-half.mjs for the loader setup), and pin
// the acceptance criteria from each issue so a regression on any one
// is loud rather than silent.
//
//   #5 — 19-state → 4-stage gauge; in-flight count uses the same
//        bucket as the gauge; user-facing labels never leak internal
//        state names.
//   #6 — per-workspace config issues travel with their row; global
//        issues (workspaceRoot / modules) sit at the top; the
//        contradictory "tokens configured elsewhere" legend is gone.
//   #7 — workspaces with blocked / failed stories auto-expand;
//        healthy ones collapse; completed stories fold into a single
//        summary line; the panel reports when the host truncated the
//        list at PANEL_STORY_LIMIT.
//   #8 — clicking a story opens a read-only detail view with branch,
//        MR, worktree, session, acceptance criteria, and artifacts;
//        the back button restores the list; Escape does the same.
//
// Run with: node scripts/test-watch-panel.mjs

import { pathToFileURL } from 'node:url'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

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

// ---- react shim ----------------------------------------------------

function makeRerenderableReact() {
  const calls = { useState: 0, useEffect: [], createElement: 0 }
  const slots = []
  let cursor = 0
  return {
    calls,
    slots,
    resetCursor() { cursor = 0 },
    react: {
      createElement(type, props, ...children) {
        calls.createElement += 1
        return { __el: true, type, props: props || {}, children: children.filter((c) => c != null && c !== false) }
      },
      useState(initial) {
        const i = cursor
        cursor += 1
        if (slots.length <= i) slots.push(typeof initial === 'function' ? initial() : initial)
        calls.useState += 1
        return [
          slots[i],
          (next) => { slots[i] = typeof next === 'function' ? next(slots[i]) : next },
        ]
      },
      useEffect(fn, deps) {
        calls.useEffect.push({ fn, deps })
      },
    },
  }
}

function makeReact() {
  const r = makeRerenderableReact()
  return {
    calls: r.calls,
    slots: r.slots,
    resetCursor: r.resetCursor,
    react: r.react,
  }
}

function walk(node, cb) {
  if (node == null || node === false || typeof node !== 'object') return
  if (Array.isArray(node)) { for (const n of node) walk(n, cb); return }
  if (!node.__el) return
  cb(node)
  for (const c of node.children) walk(c, cb)
}

function collectText(node) {
  const out = []
  walk(node, (el) => {
    for (const c of el.children) {
      if (typeof c === 'string' || typeof c === 'number') out.push(String(c))
    }
  })
  return out.join(' ')
}

function someElement(node, pred) {
  let found = false
  walk(node, (el) => { if (pred(el)) found = true })
  return found
}

function findElement(node, pred) {
  let found = null
  walk(node, (el) => { if (found == null && pred(el)) found = el })
  return found
}

function expandTree(node) {
  if (node == null || node === false) return node
  if (Array.isArray(node)) return node.map(expandTree).filter((n) => n != null && n !== false)
  if (typeof node !== 'object' || !node.__el) return node
  if (typeof node.type === 'function') {
    try {
      return {
        __el: true,
        type: node.type.name || 'fn',
        props: node.props,
        children: [expandTree(node.type(node.props))],
      }
    } catch {
      return node
    }
  }
  return { ...node, children: node.children.map(expandTree) }
}

function loadClient() {
  const code = readFileSync(resolve(libBase, 'client.js'), 'utf-8')
  let spec = null
  const sandboxWindow = { __ModuleLoader__: { load(s) { spec = s } } }
  new Function('window', code)(sandboxWindow)
  return spec
}

function makeRequire(react) {
  return (id) => {
    if (id === 'react') return react
    throw new Error('unexpected external: ' + id)
  }
}

const spec = loadClient()
check('client: bundle loader fires', spec !== null)
check('client: factory is a function', typeof spec.factory === 'function')

// ---- #5 — gauge + counters -----------------------------------------

const HEALTHY_NO_ISSUES = {
  ok: true,
  model: {
    modules: [
      {
        id: 'm1',
        title: 'Payment',
        defaultBranch: 'main',
        stories: [
          { id: 'S1', title: 'Coupon stacking', state: 'implementing', badge: '\u21BB', updatedAt: '2025-01-01T00:00:00Z' },
          { id: 'S2', title: 'Refund', state: 'spec', badge: '\u21BB', updatedAt: '2025-01-02T00:00:00Z' },
        ],
      },
    ],
    totals: { modules: 1, stories: 2, inFlight: 2, blocked: 0, completed: 0, failed: 0 },
    health: { setupRequired: false, issues: [], mountedForSec: 1, lastTapdPollAt: null, lastTapdError: null },
  },
  text: '',
}

function renderWithFetch(model) {
  const shim = makeReact()
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, async json() { return model } })
  try {
    const exports = spec.factory(makeRequire(shim.react))
    const panel = exports.__autoRd.components.AutoRdPanel
    panel() // first render — fetch resolves asynchronously
    return { shim, exports, panel }
  } finally {
    globalThis.fetch = realFetch
  }
}

async function renderAndReread(model) {
  const { shim, exports, panel } = renderWithFetch(model)
  await settleFetch()
  shim.resetCursor()
  return { tree: expandTree(panel()), shim, exports, panel }
}

async function settleFetch() {
  await new Promise((r) => setTimeout(r, 30))
}

{
  const { tree } = await renderAndReread(HEALTHY_NO_ISSUES)
  const texts = collectText(tree)

  // #5: in-flight counter reflects real running stories (was the bug
  // that the count matched nonexistent state names and stayed zero).
  check('#5: counter for "implementing" lands as in-flight',
    texts.includes('1 进行') || texts.includes('2 进行'),
    texts.slice(0, 200))

  // #5: gauge data-fill colours come from the StageView (live / halt /
  // done) — NOT the bare state name.
  check('#5: gauge stage renders data-fill="live"',
    someElement(tree, (el) => el.props && el.props['data-fill'] === 'live'),
    'no data-fill=live element')

  // #5: each gauge block has exactly 4 ticks (filter false-y kids
  // first so the children-count check matches what the user sees).
  check('#5: gauge block has 4 ticks',
    someElement(tree, (el) => {
      if (!el.props || el.props.className !== 'auto-rd-gauge-stage') return false
      // walk the tree to count tick <i> elements inside this stage
      var tickCount = 0
      walk(el, function (sub) {
        if (sub !== el && sub.props && sub.props.className === 'auto-rd-gauge-tick') tickCount += 1
      })
      return tickCount === 4
    }),
    'no 4-tick gauge block')
}

// ---- #6 — config issues per-workspace ------------------------------

const MIXED_ISSUES_MODEL = {
  ok: true,
  model: {
    modules: [
      {
        id: 'payment',
        title: 'Payment',
        defaultBranch: 'main',
        stories: [],
        tapdWorkspaceId: '',
        tapdTokenConfigured: true,
        gitlabTokenConfigured: false,
      },
      {
        id: 'order',
        title: 'Order',
        defaultBranch: 'main',
        stories: [],
        tapdWorkspaceId: '12345',
        tapdTokenConfigured: true,
        gitlabTokenConfigured: true,
      },
    ],
    totals: { modules: 2, stories: 0, inFlight: 0, blocked: 0, completed: 0, failed: 0 },
    health: {
      setupRequired: true,
      issues: [
        { key: 'workspace_root', message: 'workspaceRoot 未设置', remedy: '在 cordis.patch.yml 中设置 workspaceRoot。' },
        { key: 'gitlab_token', message: 'GitLab token 缺失', remedy: '设置 DSH_GITLAB_API_TOKEN。' },
      ],
      mountedForSec: 1,
      lastTapdPollAt: null,
      lastTapdError: null,
    },
  },
  text: '',
}

{
  const { tree } = await renderAndReread(MIXED_ISSUES_MODEL)
  const texts = collectText(tree)

  // #6: global issue banner appears at the top of the panel
  check('#6: global issues banner shows workspaceRoot issue',
    texts.includes('workspaceRoot 未设置'),
    texts.slice(0, 300))

  // #6: workspaceRoot banner has the .auto-rd-global-issues class
  check('#6: global banner uses auto-rd-global-issues class',
    someElement(tree, (el) => el.props && el.props.className === 'auto-rd-global-issues'))

  // #6: per-workspace GitLab token issue appears near the row
  check('#6: payment row mentions GitLab token',
    texts.includes('GitLab token'),
    texts.slice(0, 400))

  // #6: the legacy contradictory legend ("tokens are not configured
  // here") is gone — the new legend describes the dot colours instead.
  check('#6: legacy legend removed',
    !texts.includes('不在此处配置'),
    'old legend still present')

  // #6: the new legend mentions dot-colour meanings.
  check('#6: new legend describes status dots',
    texts.includes('正常') && texts.includes('有阻塞'),
    texts.slice(0, 400))
}

// ---- #7 — default expansion + completed fold + overflow ------------

const ATTENTION_MODEL = {
  ok: true,
  model: {
    modules: [
      {
        id: 'healthy',
        title: 'Healthy',
        defaultBranch: 'main',
        stories: [
          { id: 'H1', title: 'Done thing', state: 'completed', badge: '\u2713', updatedAt: '2025-01-01T00:00:00Z' },
        ],
      },
      {
        id: 'halted',
        title: 'Halted',
        defaultBranch: 'main',
        stories: [
          { id: 'B1', title: 'Stuck story', state: 'blocked', badge: '\u26A0', updatedAt: '2025-01-02T00:00:00Z', blockedReason: 'token' },
          { id: 'C1', title: 'Done', state: 'completed', badge: '\u2713', updatedAt: '2025-01-03T00:00:00Z' },
        ],
      },
    ],
    totals: { modules: 2, stories: 3, inFlight: 0, blocked: 1, completed: 2, failed: 0 },
    health: { setupRequired: false, issues: [], mountedForSec: 1, lastTapdPollAt: null, lastTapdError: null },
  },
  text: '',
}

{
  const { tree, panel, shim } = await renderAndReread(ATTENTION_MODEL)

  // #7: each workspace row is a <details> with an inline summary.
  const wsRows = []
  walk(tree, (el) => {
    if (el.props && el.props.className && el.props.className.indexOf('auto-rd-ws-row') === 0) {
      wsRows.push(el)
    }
  })
  check('#7: workspace rows are <details>-based', wsRows.length === 2, 'got ' + wsRows.length + ' rows')
  // The halted workspace carries the is-open modifier; the healthy one does not.
  const haltedOpen = wsRows.some((r) => (r.props.className || '').includes('is-open'))
  const healthyOpen = wsRows.filter((r) => (r.props.className || '').includes('is-open')).length > 1
  check('#7: blocked workspace auto-expands (is-open)', haltedOpen)
  check('#7: healthy workspace does NOT auto-expand', !healthyOpen)

  // #7 follow-up: the settings form is NOT auto-shown with the row.
  // It lives behind its own gear button next to the delete × so the
  // user can review or edit workspace config without flipping the
  // row's open state.
  const settingsButton = findElement(tree, (el) =>
    el.props && el.props.className === 'auto-rd-ws-settings',
  )
  check('#7: row carries a settings (gear) button', !!settingsButton)
  const settingsFormVisible = someElement(tree, (el) => {
    // WorkspaceSettingsForm renders a top-level "配置" heading inside
    // its container; if any element under the tree carries that text,
    // the form is currently shown. The default render should NOT.
    return el && el.children && Array.isArray(el.children)
      ? el.children.some((c) => typeof c === 'string' && c === '配置')
      : false
  })
  check('#7: settings form is NOT auto-opened by default', !settingsFormVisible)

  // #7 follow-up: clicking the gear button opens the settings form.
  // We invoke the React handler directly (the test shim's React just
  // runs onClick as a plain callback) and re-read the tree. The shim
  // re-uses state slots only when cursor is reset, so we have to
  // reset before re-rendering — the original `renderAndReread` does
  // the same thing after the fetch resolves.
  if (settingsButton && typeof settingsButton.props.onClick === 'function') {
    settingsButton.props.onClick({ preventDefault() {}, stopPropagation() {} })
    shim.resetCursor()
    const after = expandTree(panel())
    const settingsNowVisible = someElement(after, (el) => {
      return el && el.children && Array.isArray(el.children)
        ? el.children.some((c) => typeof c === 'string' && c === '配置')
        : false
    })
    check('#7: clicking the gear button opens the settings form', settingsNowVisible)
  } else {
    check('#7: clicking the gear button opens the settings form', false, 'no settingsButton.props.onClick')
  }

  // #7: completed stories fold into a <details> summary line; the
  // user can still expand them.
  check('#7: completed stories sit inside a <details> summary',
    someElement(tree, (el) => el.props && el.props.className === 'auto-rd-done-summary'),
    'no auto-rd-done-summary element')
  check('#7: done summary mentions the count',
    collectText(tree).includes('1 条已完成'),
    collectText(tree).slice(0, 400))
}

const OVERFLOW_MODEL = {
  ok: true,
  model: {
    modules: [
      {
        id: 'big',
        title: 'Big',
        defaultBranch: 'main',
        overflow: 25,
        stories: [
          { id: 'S1', title: 'one', state: 'completed', badge: '\u2713', updatedAt: '2025-01-01T00:00:00Z' },
        ],
      },
    ],
    totals: { modules: 1, stories: 26, inFlight: 0, blocked: 0, completed: 1, failed: 0 },
    health: { setupRequired: false, issues: [], mountedForSec: 1, lastTapdPollAt: null, lastTapdError: null },
  },
  text: '',
}

{
  const { tree } = await renderAndReread(OVERFLOW_MODEL)
  const texts = collectText(tree)

  // #7: when the host truncates the list, the UI says so honestly.
  check('#7: overflow tag rendered when host truncated the list',
    texts.includes('还有') && texts.includes('条未列出'),
    texts.slice(0, 400))
  check('#7: overflow tag uses the truncated class',
    someElement(tree, (el) => el.props && el.props.className === 'auto-rd-truncated'))
}

// ---- #8 — story detail view ---------------------------------------

const STORY_MODEL = {
  ok: true,
  model: {
    modules: [
      {
        id: 'payment',
        title: 'Payment',
        defaultBranch: 'main',
        stories: [
          {
            id: 'S1',
            title: 'Coupon stacking',
            state: 'blocked',
            branch: 'auto-rd/S1',
            worktreePath: 'D:/repos/payment/.auto-rd/S1',
            mainSessionId: 'ses_abc',
            acceptanceCriteria: '- 叠券按升序结算\n- 幂等',
            blockedReason: 'TAPD 接口返回 401',
            mrUrl: null,
            badge: '\u26A0',
            updatedAt: '2025-01-02T00:00:00Z',
            artifacts: [
              { kind: 'spec', filename: '06-spec.md', summary: '规格', createdAt: '2025-01-01T00:22:00Z' },
              { kind: 'plan', filename: '07-plan.md', summary: '计划', createdAt: '2025-01-01T00:31:00Z' },
            ],
          },
        ],
      },
    ],
    totals: { modules: 1, stories: 1, inFlight: 0, blocked: 1, completed: 0, failed: 0 },
    health: { setupRequired: false, issues: [], mountedForSec: 1, lastTapdPollAt: null, lastTapdError: null },
  },
  text: '',
}

// Verify StoryDetail renders the expected fields when invoked directly
// — easier than reaching through the full AutoRdPanel tree, where the
// selection state is internal.
{
  const shim = makeReact()
  const exports = spec.factory(makeRequire(shim.react))
  const StoryDetail = exports.__autoRd.components.StoryDetail
  check('#8: StoryDetail component is exposed for tests', typeof StoryDetail === 'function')

  const story = STORY_MODEL.model.modules[0].stories[0]
  const tree = expandTree(StoryDetail({ story, workspace: STORY_MODEL.model.modules[0], onBack: () => {} }))
  const texts = collectText(tree)

  // #8: blocked stories show the cause banner pinned to the top.
  check('#8: blocked story has cause banner', texts.includes('阶段中断'))
  check('#8: cause banner surfaces blocked reason', texts.includes('TAPD 接口返回 401'))

  // #8: facts table lists branch, MR, worktree, session.
  check('#8: branch field is present', texts.includes('分支'))
  check('#8: worktree field is present', texts.includes('工作树'))
  check('#8: session field is present', texts.includes('会话'))

  // #8: acceptance criteria surface as a list, with the bullet glyph
  // (CSS-provided). The data lives on each <li>.
  check('#8: acceptance criteria list rendered',
    someElement(tree, (el) => el.props && el.props.className === 'auto-rd-criteria'),
    'no auto-rd-criteria')

  // #8: artifacts trail renders a <ul.auto-rd-trail> with one row per artifact.
  const trail = []
  walk(tree, (el) => {
    if (el.props && el.props.className === 'auto-rd-trail') trail.push(el)
  })
  check('#8: artifacts trail rendered', trail.length === 1, 'trail count ' + trail.length)
  // `el.children` for a <ul> rendered by React.createElement can be
  // either a single array (from `.map`) or a nested array (from the
  // .map result passed as a spread). Normalise by flattening.
  function flatKids(el) {
    var out = []
    for (var i = 0; i < (el.children || []).length; i++) {
      var c = el.children[i]
      if (c == null || c === false) continue
      if (Array.isArray(c)) {
        for (var j = 0; j < c.length; j++) {
          if (c[j] != null && c[j] !== false) out.push(c[j])
        }
      } else {
        out.push(c)
      }
    }
    return out
  }
  check('#8: trail carries the expected row count',
    trail[0] && flatKids(trail[0]).length === 2,
    'rows ' + JSON.stringify(trail[0] && trail[0].children && trail[0].children.map(function (c) { return c && c.length })))

  // #8: the back button exists and is the only mutation affordance.
  const backButtons = []
  walk(tree, (el) => {
    if (el.props && el.props.className === 'auto-rd-back') backButtons.push(el)
  })
  check('#8: back button present', backButtons.length === 1)

  // #8: no rerun / cancel / save buttons live inside the detail view.
  check('#8: no rerun button in the detail view',
    !someElement(tree, (el) => el.props && typeof el.props.onClick === 'function' && el.props.children && String(el.props.children).includes('重跑')))
  check('#8: no save button in the detail view',
    !someElement(tree, (el) => el.props && typeof el.props.onClick === 'function' && el.props.children && String(el.props.children).includes('保存')))
}

// ---- #5/#6/#7 follow-up: empty workspace does not duplicate state ----
//
// The row summary already says "尚未拉取需求" or "<n> 个需求". Showing
// the same fact again under the "任务" heading inside an expanded
// empty workspace was pure noise — the user sees the count in the
// header, the placeholder underneath just repeated it.
const EMPTY_WORKSPACE_MODEL = {
  ok: true,
  model: {
    modules: [
      {
        id: 'empty',
        title: 'yc-sale-control-server',
        defaultBranch: 'main',
        stories: [],
        tapdWorkspaceId: '69280376',
        tapdTokenConfigured: true,
        gitlabTokenConfigured: true,
      },
    ],
    totals: { modules: 1, stories: 0, inFlight: 0, blocked: 0, completed: 0, failed: 0 },
    health: { setupRequired: false, issues: [], mountedForSec: 1, lastTapdPollAt: null, lastTapdError: null },
  },
  text: '',
}

{
  const { tree, panel: panelFn, shim: shimFn } = await renderAndReread(EMPTY_WORKSPACE_MODEL)
  // The empty workspace must render — find its row.
  const wsRow = findElement(tree, (el) => el.props && (el.props.className || '').startsWith('auto-rd-ws-row'))
  check('empty: workspace row present', !!wsRow)

  // Force the row open so the "任务" branch would render if it could.
  // The WorkspaceList computes defaultOpen from workspaceNeedsAttention
  // — for an empty / non-blocked / non-failed workspace that returns
  // false. We toggle via the row's caret onClick handler.
  const caret = findElement(tree, (el) => el.props && el.props.className === 'auto-rd-ws-caret')
  // Caret itself is not a button — toggle goes through the summary's
  // onClick. We grab the summary instead.
  const summary = findElement(tree, (el) => el.props && el.props.onClick && Array.isArray(el.children))
  if (summary && typeof summary.props.onClick === 'function') {
    summary.props.onClick({ preventDefault() {}, stopPropagation() {} })
    shimFn.resetCursor()
  }
  const after = expandTree(panelFn())
  const text = collectText(after)

  check(
    'empty: expanded empty workspace does NOT show "还没有需求" placeholder',
    !text.includes('还没有需求'),
    text.slice(0, 200),
  )
  check(
    'empty: expanded empty workspace does NOT show the "任务" heading',
    !text.match(/\b任务\b/),
    text.slice(0, 200),
  )
}

// ---- Summary --------------------------------------------------------

process.stdout.write(`\nWatchPanel tests: ${pass} pass, ${fail} fail\n`)
process.exit(fail > 0 ? 1 : 0)
