/**
 * auto-rd client half — the sidebar entry and its main-column body.
 *
 * This file is NOT bundled or transpiled. It is copied verbatim to
 * `lib/client.js` and loaded by the shell's module loader, which is why
 * it is written in the shell's own envelope rather than as an ES module.
 *
 * The envelope, the `require` externals, the `apply`/`inject` exports and
 * the slot API below were all read off the shipped DSH client plugins
 * (`@deepseek-ai/dsh-client-ui-sidebar` and
 * `@deepseek-ai/dsh-client-ui-layout`) rather than inferred.
 *
 * Data reaches this component over HTTP from the host half's
 * `GET /auto-rd/panel` route (see services/panel-route.ts), because the
 * browser cannot read the host's storageDomain.
 *
 * Visual language: every colour, surface and radius below is taken from
 * the DSH shell's own CSS variables (`--dsw-alias-*`, `--ds-font-family-*`).
 * The plugin does not introduce its own palette — it sits inside the
 * shell as a first-class card, not as a styled island.
 */
// __STAGE_DATA_INJECTION_POINT__
window.__ModuleLoader__.load({
  id: '@yangzhitong/dsh-auto-rd',
  factory: function (require) {
    var React = require('react')
    var h = React.createElement

    /** Slot ids. Kept in sync with services/ui-panel.ts by a test. */
    var PANEL_SLOT = 'sidebar.panellist'
    var MAIN_SLOT = 'main'
    var PANEL_ID = 'auto-rd-modules'
    var PANEL_ORDER = 100
    var PANEL_LABEL = 'Auto-RD'
    var DATA_URL = '/auto-rd/panel'
    var RECONFIGURE_URL = '/auto-rd/reconfigure'
    var PICK_DIRECTORY_URL = '/auto-rd/pick-directory'
    var TRAJECTORY_URL_PREFIX = '/auto-rd/story/'
    var POLL_MS = 5000

    // ---- sidebar icon ----------------------------------------------------
    // 3 short rails + handoff arrows — the shape language of a pipeline.
    // Same stroke weight as the shell's other sidebar icons so this entry
    // does not look like a foreign object.

    function AutoRdIcon(props) {
      var size = (props && props.size) || 16
      var active = !!(props && props.active)
      var color = 'currentColor'
      var opacity = active ? 1 : 0.75
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          opacity: opacity,
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h(
          'path',
          {
            d: 'M2.5 5h7M2.5 8h7M2.5 11h7',
            stroke: color,
            strokeWidth: 1.25,
            strokeLinecap: 'round',
          },
        ),
        h(
          'path',
          {
            d: 'M10 4.5l1.5.5-1.5.5M10 7.5l1.5.5-1.5.5M10 10.5l1.5.5-1.5.5',
            stroke: color,
            strokeWidth: 1.25,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          },
        ),
      )
    }

    // ---- shared style fragments ------------------------------------------
    // One place to read; every component below consumes them. They resolve
    // against the shell's CSS variables so the card inherits the active
    // theme (light or dark) without any extra plumbing.

    var styles = {
      // surfaces
      panelBg: 'var(--dsw-alias-surface-primary, #ffffff)',
      panelBgSubtle: 'var(--dsw-alias-surface-secondary, rgba(0,0,0,0.02))',
      dangerSubtle: 'var(--dsw-alias-surface-danger-subtle, rgba(217,83,79,0.05))',
      // text
      labelPrimary: 'var(--dsw-alias-label-primary, #111111)',
      labelSecondary: 'var(--dsw-alias-label-secondary, #555555)',
      labelTertiary: 'var(--dsw-alias-label-tertiary, #888888)',
      // lines
      borderL3: 'var(--dsw-alias-border-l3, rgba(0,0,0,0.10))',
      borderL2: 'var(--dsw-alias-border-l2, rgba(0,0,0,0.14))',
      borderError: 'var(--dsw-alias-border-error, #d9534f)',
      // status
      statusSuccess: 'var(--dsw-alias-status-success, #2a7f5f)',
      statusWarning: 'var(--dsw-alias-status-warning, #d19a3f)',
      statusError: 'var(--dsw-alias-status-error, #d9534f)',
      statusInfo: 'var(--dsw-alias-status-info, #3a6fbe)',
      // accent
      accent: 'var(--dsw-alias-accent-primary, #3a6fbe)',
      accentSoft: 'var(--dsw-alias-accent-soft, rgba(58,111,190,0.12))',
      // type
      fontCode: 'var(--ds-font-family-code, ui-monospace, monospace)',
    }

    // ---- injected stylesheet ---------------------------------------------
    // Inline style objects cannot express @media / @container or
    // pseudo-classes, and the panel has no CSS file or build step — so
    // the one thing the bundle ships that needs those rules is a
    // stylesheet it appends to the host document on mount.
    //
    // Contract (pinned by scripts/test-client-half.mjs):
    //   - every selector mentions `.auto-rd-` — nothing can reach the
    //     shell's own elements
    //   - no hex/rgb literals — colours stay with the shell's
    //     `--dsw-alias-*` variables so light/dark follow the host
    //   - width adaptation uses @container on the panel root, because
    //     the shell's main slot width is unknowable at build time
    //   - motion respects prefers-reduced-motion
    //   - injection is idempotent and tolerates a missing document

    var STYLE_ELEMENT_ID = 'auto-rd-panel-styles'

    var PANEL_CSS = [
      // The panel root opts into container sizing. It doubles as the
      // fallback scope: every rule below is written against
      // `.auto-rd-panel` descendants.
      '.auto-rd-panel { container: auto-rd-panel / inline-size; }',
      // Story rows switch from a side-by-side layout to stacked when
      // the host slot gets narrow. Inline styles cover the wide case;
      // this one rule is what inline styles cannot say.
      '@container auto-rd-panel (max-width: 480px) {',
      '  .auto-rd-story-line { flex-direction: column; align-items: flex-start; }',
      '}',
      // Skeleton bars. The mockup (docs/ui-mockup-watch.html scene 3)
      // uses short/mid/long widths so the placeholder reads as three
      // upcoming workspace rows, not as decoration.
      '.auto-rd-skel { padding: 14px; display: grid; gap: 15px; }',
      '.auto-rd-skel-row { display: grid; gap: 6px; }',
      '.auto-rd-skel-bar {',
      '  height: 11px;',
      '  border-radius: 2px;',
      '  background: var(--dsw-alias-surface-secondary, rgba(0,0,0,0.04));',
      '}',
      '.auto-rd-skel-bar.auto-rd-skel-s { width: 22%; }',
      '.auto-rd-skel-bar.auto-rd-skel-m { width: 46%; }',
      '.auto-rd-skel-bar.auto-rd-skel-l { width: 64%; }',
      // ---- 4-stage gauge (issue #5) -----------------------------------
      // The gauge is 4 stages × 4 ticks, separated by a 5px gap so the
      // stage boundaries read at a glance. Tick colours come from the
      // status data attribute on each stage block; the status attribute
      // drives the colour, not a separate class, so the bar can be
      // re-rendered without swapping classes. The data-on tick is the
      // "lit" half; the rest stay inert.
      '.auto-rd-gauge { display: flex; gap: 5px; align-items: center; }',
      '.auto-rd-gauge-stage { display: flex; gap: 1.5px; }',
      '.auto-rd-gauge-tick {',
      '  width: 7px; height: 11px;',
      '  border-radius: 1px;',
      '  background: var(--dsw-alias-border-l3, rgba(0,0,0,0.10));',
      '}',
      '.auto-rd-gauge-stage[data-fill=done] .auto-rd-gauge-tick { background: var(--dsw-alias-label-tertiary, #888); }',
      '.auto-rd-gauge-stage[data-fill=live] .auto-rd-gauge-tick[data-on] { background: var(--dsw-alias-status-info, #3a6fbe); }',
      '.auto-rd-gauge-stage[data-fill=halt] .auto-rd-gauge-tick[data-on] { background: var(--dsw-alias-status-warning, #d19a3f); }',
      '.auto-rd-gauge-legend {',
      '  display: flex; gap: 5px; margin-top: 4px;',
      '  font: 400 9.5px/1 var(--ds-font-family-code, ui-monospace, monospace);',
      '  color: var(--dsw-alias-label-tertiary, #888);',
      '}',
      '.auto-rd-gauge-legend span { width: 35px; }',
      '@container auto-rd-panel (max-width: 420px) {',
      '  .auto-rd-gauge-tick { width: 5px; }',
      '  .auto-rd-gauge-legend span { width: 27px; }',
      '}',
      // ---- native <details> for workspace rows (issue #7) ------------
      // The legacy click-anywhere-to-expand behavior forced us to
      // manage state inside React. <details>/<summary> gets us the
      // keyboard and screen-reader semantics for free, including the
      // summary's `aria-expanded` reflection. The caret rotates on
      // `[open]`.
      '.auto-rd-ws-row summary {',
      '  display: flex;',
      '  align-items: center;',
      '  gap: 12px;',
      '  padding: 14px 16px;',
      '  border: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.10));',
      '  border-radius: 7px;',
      '  margin-bottom: 8px;',
      '  cursor: pointer;',
      '  background: var(--dsw-alias-surface-primary, #ffffff);',
      '  list-style: none;',
      '  min-width: 0;',
      '}',
      '.auto-rd-ws-row .auto-rd-ws-text {',
      '  flex: 1 1 auto;',
      '  min-width: 0;',
      '  overflow: hidden;',
      '}',
      '.auto-rd-ws-row .auto-rd-ws-progress {',
      '  flex: 0 0 auto;',
      '  max-width: 40%;',
      '  overflow: hidden;',
      '  text-overflow: ellipsis;',
      '  white-space: nowrap;',
      '}',
      '.auto-rd-ws-row .auto-rd-ws-actions {',
      '  flex: 0 0 auto;',
      '  display: flex;',
      '  gap: 4px;',
      '  align-items: center;',
      '}',
      '.auto-rd-ws-row summary::-webkit-details-marker { display: none; }',
      '.auto-rd-ws-row summary::marker { content: ""; }',
      '.auto-rd-ws-row summary:focus-visible {',
      '  outline: 2px solid var(--dsw-alias-status-info, #3a6fbe);',
      '  outline-offset: 1px;',
      '}',
      '.auto-rd-ws-caret {',
      '  display: inline-block;',
      '  width: 14px;',
      '  color: var(--dsw-alias-label-tertiary, #888);',
      '  font-size: 9px;',
      '  line-height: 1.9;',
      '  transition: transform .14s ease;',
      '  user-select: none;',
      '}',
      '.auto-rd-ws-row[open] > summary .auto-rd-ws-caret { transform: rotate(90deg); }',
      '@media (prefers-reduced-motion: reduce) {',
      '  .auto-rd-ws-caret { transition: none; }',
      '}',
      // ---- workspace-level setup issues (issue #6) -------------------
      // Per-workspace config issues appear inline with the row, right
      // below the summary, so the user never has to scroll to find
      // what is missing.
      '.auto-rd-ws-issue {',
      '  display: flex; flex-wrap: wrap; gap: 3px 8px; align-items: baseline;',
      '  font-size: 12px;',
      '  color: var(--dsw-alias-status-error, #d9534f);',
      '  margin: -4px 0 8px 30px;',
      '  padding: 6px 10px;',
      '  border-left: 2px solid var(--dsw-alias-status-error, #d9534f);',
      '}',
      '.auto-rd-ws-issue .fix { color: var(--dsw-alias-label-secondary, #555); }',
      // ---- global issue banner (issue #6) ----------------------------
      // Only config problems that touch every workspace (workspaceRoot,
      // module list) appear here. Per-workspace issues stay with the
      // row.
      '.auto-rd-global-issues {',
      '  display: flex; gap: 10px;',
      '  padding: 11px 20px;',
      '  border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.10));',
      '  background: var(--dsw-alias-surface-danger-subtle, rgba(217,83,79,0.05));',
      '}',
      '.auto-rd-global-issues-mark { color: var(--dsw-alias-status-error, #d9534f); font-family: var(--ds-font-family-code, monospace); flex: none; font-size: 12px; }',
      '.auto-rd-global-issues-msg { font-size: 12px; line-height: 1.45; }',
      '.auto-rd-global-issues-fix { color: var(--dsw-alias-label-secondary, #555); }',
      // ---- truncated / overflow (issue #7) ----------------------------
      '.auto-rd-truncated {',
      '  color: var(--dsw-alias-label-tertiary, #888);',
      '  font-style: normal;',
      '  font-size: 11px;',
      '}',
      // ---- detail view (issue #8) ------------------------------------
      // The detail view is full-page. The back button is the only
      // affordance — no other actions live here.
      '.auto-rd-back {',
      '  display: inline-flex; align-items: baseline; gap: 7px;',
      '  border: 0; background: none;',
      '  padding: 11px 20px; cursor: pointer;',
      '  font: 400 11px/1.5 var(--ds-font-family-code, monospace);',
      '  color: var(--dsw-alias-label-secondary, #555);',
      '}',
      '.auto-rd-back:hover { color: var(--dsw-alias-label-primary, #111); }',
      '.auto-rd-back:focus-visible {',
      '  outline: 2px solid var(--dsw-alias-status-info, #3a6fbe);',
      '  outline-offset: -2px;',
      '}',
      '.auto-rd-detail { padding: 0 20px 22px; max-width: 720px; }',
      '.auto-rd-detail-title { font: 600 18px/1.25 inherit; margin: 2px 0 0; letter-spacing: -0.015em; }',
      '.auto-rd-detail-sub {',
      '  display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline;',
      '  margin-top: 5px; font: 400 11px/1.5 var(--ds-font-family-code, monospace);',
      '  color: var(--dsw-alias-label-secondary, #555);',
      '}',
      '.auto-rd-detail-state { font-weight: 500; }',
      '.auto-rd-detail-state[data-state=blocked] { color: var(--dsw-alias-status-warning, #d19a3f); }',
      '.auto-rd-detail-state[data-state=failed] { color: var(--dsw-alias-status-error, #d9534f); }',
      '.auto-rd-detail-state[data-state=completed] { color: var(--dsw-alias-status-success, #2a7f5f); }',
      '.auto-rd-detail-gauge { margin: 18px 0 0; }',
      '.auto-rd-cause {',
      '  margin: 20px 0 0; padding: 13px 14px;',
      '  background: var(--dsw-alias-surface-danger-subtle, rgba(217,83,79,0.05));',
      '  border-left: 2px solid var(--dsw-alias-status-error, #d9534f);',
      '  border-radius: 0 5px 5px 0;',
      '}',
      '.auto-rd-cause-stage { font: 500 12px/1.4 inherit; color: var(--dsw-alias-status-error, #d9534f); margin: 0; }',
      '.auto-rd-cause-msg { font: 400 12.5px/1.5 var(--ds-font-family-code, monospace); margin: 5px 0 0; word-break: break-word; }',
      '.auto-rd-cause-fix { font-size: 12.5px; color: var(--dsw-alias-label-secondary, #555); margin: 7px 0 0; }',
      '.auto-rd-facts {',
      '  display: grid; grid-template-columns: auto 1fr; gap: 8px 18px;',
      '  margin: 22px 0 0; font-size: 12.5px;',
      '}',
      '@container auto-rd-panel (max-width: 400px) {',
      '  .auto-rd-facts { grid-template-columns: 1fr; gap: 2px; }',
      '  .auto-rd-facts dt { margin-top: 9px; }',
      '}',
      '.auto-rd-facts dt { font: 400 11px/1.6 var(--ds-font-family-code, monospace); color: var(--dsw-alias-label-tertiary, #888); }',
      '.auto-rd-facts dd { margin: 0; font-family: var(--ds-font-family-code, monospace); font-size: 12px; word-break: break-all; }',
      '.auto-rd-facts dd.empty { color: var(--dsw-alias-label-tertiary, #888); font-style: normal; }',
      '.auto-rd-facts a { color: var(--dsw-alias-status-info, #3a6fbe); text-decoration: none; }',
      '.auto-rd-facts a:hover { text-decoration: underline; }',
      '.auto-rd-detail-section { margin-top: 22px; }',
      '.auto-rd-detail-section h3 { font: 500 12px/1.4 inherit; color: var(--dsw-alias-label-secondary, #555); margin: 0 0 8px; letter-spacing: 0; }',
      '.auto-rd-detail-section .empty { color: var(--dsw-alias-label-tertiary, #888); }',
      '.auto-rd-criteria { list-style: none; margin: 0; padding: 0; }',
      '.auto-rd-criteria li {',
      '  position: relative;',
      '  padding-left: 16px;',
      '  margin-bottom: 4px;',
      '  font-size: 13px;',
      '}',
      '.auto-rd-criteria li::before {',
      '  content: "";',
      '  position: absolute;',
      '  left: 2px; top: 0.6em;',
      '  width: 6px; height: 6px;',
      '  border: 1.5px solid var(--dsw-alias-label-tertiary, #888);',
      '  border-radius: 50%;',
      '}',
      '.auto-rd-trail { list-style: none; margin: 0; padding: 0; display: grid; gap: 5px; }',
      '.auto-rd-trail li {',
      '  display: grid; grid-template-columns: 14px 1fr auto; gap: 9px; align-items: baseline;',
      '  font-size: 12.5px; color: var(--dsw-alias-label-secondary, #555);',
      '  padding: 4px 0;',
      '  border-bottom: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.10));',
      '}',
      '.auto-rd-trail li:last-child { border-bottom: none; }',
      '.auto-rd-trail .m { font: 400 11px/1.5 var(--ds-font-family-code, monospace); }',
      '.auto-rd-trail .t { font: 400 10.5px/1.6 var(--ds-font-family-code, monospace); color: var(--dsw-alias-label-tertiary, #888); }',
      '.auto-rd-trail [data-ok] .m { color: var(--dsw-alias-status-success, #2a7f5f); }',
      '.auto-rd-trail [data-bad] .m, .auto-rd-trail [data-bad] { color: var(--dsw-alias-status-error, #d9534f); }',
      '.auto-rd-story-button {',
      '  border: 0; background: none; padding: 0; cursor: pointer; font: inherit; color: inherit; text-align: left;',
      '}',
      '.auto-rd-story-button:hover { text-decoration: underline; }',
      '.auto-rd-story-button:focus-visible {',
      '  outline: 2px solid var(--dsw-alias-status-info, #3a6fbe);',
      '  outline-offset: 2px;',
      '  border-radius: 2px;',
      '}',
      // ---- completed-section <details> summary (issue #7) ------------
      '.auto-rd-done-summary {',
      '  margin: 6px 0 12px 30px;',
      '  padding-top: 6px;',
      '  border-top: 1px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.10));',
      '  cursor: pointer;',
      '  font: 400 11px/1.5 var(--ds-font-family-code, monospace);',
      '  color: var(--dsw-alias-label-tertiary, #888);',
      '  list-style: none;',
      '}',
      '.auto-rd-done-summary::-webkit-details-marker { display: none; }',
      '.auto-rd-done-summary::marker { content: ""; }',
      '.auto-rd-done-summary:hover { color: var(--dsw-alias-label-secondary, #555); }',
      '.auto-rd-done-summary:focus-visible {',
      '  outline: 2px solid var(--dsw-alias-status-info, #3a6fbe);',
      '  outline-offset: 1px;',
      '}',
      '.auto-rd-pending-tag {',
      '  border: 1px dashed var(--dsw-alias-border-l3, rgba(0,0,0,0.10));',
      '  border-radius: 4px;',
      '  padding: 1px 6px;',
      '  font: 400 10px/1.5 var(--ds-font-family-code, monospace);',
      '  color: var(--dsw-alias-label-tertiary, #888);',
      '}',
      // ---- focus ring for keyboard users (issue #7/8) -----------------
      '.auto-rd-panel button:focus-visible, .auto-rd-panel a:focus-visible {',
      '  outline: 2px solid var(--dsw-alias-status-info, rgba(58,111,190,1));',
      '  outline-offset: 1px;',
      '}',
      '@media (prefers-reduced-motion: reduce) {',
      '  .auto-rd-panel * { transition: none !important; animation: none !important; }',
      '}',
    ].join('\n')

    function injectStyles(doc) {
      try {
        var d = doc || (typeof document !== 'undefined' ? document : null)
        if (!d || !d.head) return
        if (d.getElementById && d.getElementById(STYLE_ELEMENT_ID)) return
        var el = d.createElement('style')
        el.id = STYLE_ELEMENT_ID
        el.textContent = PANEL_CSS
        d.head.appendChild(el)
      } catch (e) {
        // No DOM (SSR, non-browser host): styling degrades to the inline
        // styles, which already carry the full layout.
      }
    }

    // ---- panel data hook -------------------------------------------------
    //
    // State shape (the sync pulse reads the last two fields):
    //   status: 'loading' | 'ok' | 'error'
    //   model / text: the latest successful payload (cached across
    //     failures so the screen keeps its content)
    //   error: the last failure message, '' when healthy
    //   lastSyncedAt: Date.now() of the last successful fetch — null
    //     until then, and NOT advanced by failures. The pulse uses it
    //     to say "已同步 · N 秒前" or, on error-with-cache,
    //     "重连中 · 数据停在 <时刻>".

    function usePanelData() {
      var state = React.useState({
        status: 'loading',
        model: null,
        text: '',
        error: '',
        lastSyncedAt: null,
      })
      var value = state[0]
      var setValue = state[1]

      function applyBody(body) {
        setValue({
          status: 'ok',
          model: body.model,
          text: body.text || '',
          error: '',
          lastSyncedAt: Date.now(),
        })
      }

      function load() {
        return fetch(DATA_URL, { headers: { accept: 'application/json' } })
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status)
            return res.json()
          })
          .then(function (body) {
            if (!body || body.ok !== true) throw new Error('panel_unavailable')
            setValue({
              status: 'ok',
              model: body.model,
              text: body.text || '',
              error: '',
              lastSyncedAt: Date.now(),
            })
          })
          .catch(function (err) {
            setValue(function (prev) {
              return {
                status: 'error',
                model: prev.model,
                text: prev.text,
                error: String((err && err.message) || err),
                lastSyncedAt: prev.lastSyncedAt,
              }
            })
          })
      }

      React.useEffect(function () {
        var alive = true
        var timer = setInterval(function () {
          if (alive) load()
        }, POLL_MS)
        return function () {
          alive = false
          clearInterval(timer)
        }
      }, [])

      load()

      return { panel: value, applyBody: applyBody, resync: load }
    }

    // Fetch one story's execution log on demand. The trajectory is
    // static between polls (recover resets it, the runner appends), so
    // the detail view fetches once on open instead of riding the 5s
    // panel poll.
    function useStoryTrajectory(storyId) {
      var state = React.useState({ status: 'loading', events: [] })
      var value = state[0]
      var setValue = state[1]
      React.useEffect(function () {
        if (!storyId) { setValue({ status: 'idle', events: [] }); return }
        var alive = true
        setValue({ status: 'loading', events: [] })
        fetch(TRAJECTORY_URL_PREFIX + encodeURIComponent(storyId), { headers: { accept: 'application/json' } })
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status)
            return res.json()
          })
          .then(function (body) {
            if (!alive) return
            if (!body || body.ok !== true) throw new Error('trajectory_unavailable')
            setValue({ status: 'ok', events: body.events || [] })
          })
          .catch(function () {
            if (!alive) return
            setValue({ status: 'error', events: [] })
          })
        return function () { alive = false }
      }, [storyId])
      return value
    }

    // ---- add-workspace form ----------------------------------------------
    // The user picks a local path (with the Browse button) OR pastes a
    // Git URL. We extract the workspace name from the path's last segment
    // so the user never has to type it — the name IS the TAPD module id.

    function AddWorkspaceForm(props) {
      var onCancel = props.onCancel
      var onAdded = props.onAdded
      var source = React.useState('local') // 'local' | 'git'
      var path = React.useState('')
      // Error surfaced from the native directory picker (e.g. the pick
      // failed or the host did not register the route). Shown inline
      // under the path field, same as any other form error.
      var pickError = React.useState(null)
      // Per-workspace credentials. Empty string means "fall back to the
      // shell env var" — the host treats an empty value as "use the
      // inherited DSH_TAPD_API_TOKEN / DSH_GITLAB_API_TOKEN from the
      // launching shell". Values typed here are persisted in storage;
      // the user has explicitly opted into storing them in plaintext
      // (see docs/ui-mockup-workspaces.html).
      var tapdToken = React.useState('')
      var tapdWorkspaceId = React.useState('')
      var gitlabToken = React.useState('')
      // Name is pre-filled from the path/URL but the user can override
      // it freely. We only re-derive from the path when the user has
      // not touched the field — a `nameTouched` flag tracks that.
      var name = React.useState('')
      var nameTouched = React.useState(false)
      var busy = React.useState(false)
      var err = React.useState(null)

      var sourceValue = source[0]
      var setSource = source[1]
      var pathValue = path[0]
      var setPath = path[1]
      var pickErrorValue = pickError[0]
      var setPickError = pickError[1]
      var tapdTokenValue = tapdToken[0]
      var setTapdToken = tapdToken[1]
      var tapdWorkspaceIdValue = tapdWorkspaceId[0]
      var setTapdWorkspaceId = tapdWorkspaceId[1]
      var gitlabTokenValue = gitlabToken[0]
      var setGitlabToken = gitlabToken[1]
      var nameValue = name[0]
      var setName = name[1]
      var nameTouchedValue = nameTouched[0]
      var setNameTouched = nameTouched[1]
      var busyValue = busy[0]
      var setBusy = busy[1]
      var errValue = err[0]
      var setErr = err[1]

      // Derive the workspace name from the path the user typed. Local:
      // the last non-empty segment. Git: the repo name (last segment of
      // the URL with the optional `.git` suffix stripped).
      var derivedName = computeWorkspaceName(sourceValue, pathValue)

      // Keep the Name field in sync with the path until the user edits
      // it. We only overwrite when the field still equals the previous
      // derived value — that way, once the user types anything, the
      // field is theirs and the path stays out.
      React.useEffect(function () {
        if (!nameTouchedValue) {
          setName(derivedName)
        }
      }, [derivedName, nameTouchedValue])

      function submit() {
        if (!pathValue || !nameValue) {
          setErr(sourceValue === 'local' ? '请选择一个目录' : '请粘贴 Git URL')
          return
        }
        setBusy(true)
        setErr(null)
        fetch(RECONFIGURE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'add_workspace',
            name: nameValue,
            source: sourceValue,
            path: pathValue,
            tapdWorkspaceId: tapdWorkspaceIdValue,
            tapdToken: tapdTokenValue,
            gitlabToken: gitlabTokenValue,
          }),
        })
          .then(function (res) {
            return res.json().then(function (body) {
              return { ok: res.ok, body: body }
            })
          })
          .then(function (result) {
            setBusy(false)
            if (result.ok && result.body && result.body.ok) {
              if (typeof onAdded === 'function') onAdded(result.body)
              setPath('')
              setName('')
              setNameTouched(false)
              setTapdToken('')
              setGitlabToken('')
            } else {
              setErr(
                (result.body && (result.body.message || result.body.error)) ||
                  ('HTTP ' + result.status),
              )
            }
          })
          .catch(function (e) {
            setBusy(false)
            setErr(String((e && e.message) || e))
          })
      }

      return h(
        'div',
        {
          className: 'auto-rd-add',
          style: {
            background: styles.panelBg,
            border: '1px solid ' + styles.borderL2,
            borderRadius: 8,
            padding: 20,
            maxWidth: 580,
          },
        },
        h(
          'div',
          { style: { fontSize: 13, fontWeight: 500, color: styles.labelPrimary, marginBottom: 16 } },
          '添加工作空间',
        ),
        h(
          'div',
          { style: { marginBottom: 14 } },
          h(
            'label',
            { style: { display: 'block', fontSize: 11, color: styles.labelSecondary, marginBottom: 6, fontWeight: 500 } },
            '来源',
          ),
          h(
            'div',
            {
              style: {
                display: 'flex',
                border: '1px solid ' + styles.borderL2,
                borderRadius: 5,
                overflow: 'hidden',
                background: styles.panelBg,
              },
            },
            h(
              'label',
              {
                style: {
                  flex: 1,
                  padding: '7px 10px',
                  textAlign: 'center',
                  cursor: 'pointer',
                  fontSize: 12,
                  color: sourceValue === 'local' ? styles.labelPrimary : styles.labelSecondary,
                  background: sourceValue === 'local' ? styles.panelBgSubtle : styles.panelBg,
                  fontWeight: sourceValue === 'local' ? 500 : 400,
                  borderRight: '1px solid ' + styles.borderL3,
                  userSelect: 'none',
                },
                onClick: function () { setSource('local') },
              },
              '本地目录',
            ),
            h(
              'label',
              {
                style: {
                  flex: 1,
                  padding: '7px 10px',
                  textAlign: 'center',
                  cursor: 'pointer',
                  fontSize: 12,
                  color: sourceValue === 'git' ? styles.labelPrimary : styles.labelSecondary,
                  background: sourceValue === 'git' ? styles.panelBgSubtle : styles.panelBg,
                  fontWeight: sourceValue === 'git' ? 500 : 400,
                  userSelect: 'none',
                },
                onClick: function () { setSource('git') },
              },
              'Git URL',
            ),
          ),
        ),
        h(
          'div',
          { style: { marginBottom: 14 } },
          h(
            'label',
            {
              style: {
                display: 'block',
                fontSize: 11,
                color: styles.labelSecondary,
                marginBottom: 6,
                fontWeight: 500,
              },
            },
            '路径',
          ),
          // Path row: input takes most of the width, "Browse" button sits
// at the right. The button calls the host-side pick-directory route
// which opens a native OS folder chooser (Win32 COM on Windows via
// koffi, osascript on macOS, zenity on Linux). When the host-side
// directoryPicker service is unavailable the button stays disabled
// and shows an honest tooltip.
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              },
            },
            h('input', {
              type: 'text',
              value: pathValue,
              onChange: function (e) { setPath(e.target.value); setErr(null) },
              disabled: busyValue,
              placeholder:
                sourceValue === 'local'
                  ? 'D:\\repos\\payment-service'
                  : 'git@gitlab.com:org/payment-svc.git',
              style: {
                flex: 1,
                background: styles.panelBg,
                border: '1px solid ' + styles.borderL2,
                borderRadius: 5,
                padding: '8px 10px',
                color: styles.labelPrimary,
                fontFamily: styles.fontCode,
                fontSize: 12,
                boxSizing: 'border-box',
              },
            }),
            h(
              'button',
              {
                type: 'button',
                disabled: busyValue || sourceValue !== 'local',
                title:
                  sourceValue === 'local'
                    ? '浏览本地目录'
                    : '切换到「本地目录」才能浏览',
                onClick: function () {
                  setPickError(null)
                  fetch(PICK_DIRECTORY_URL, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({}),
                  })
                    .then(function (res) {
                      if (res.status === 204) return null
                      return res.json().then(function (j) { return { ok: res.ok, body: j } })
                    })
                    .then(function (result) {
                      if (!result) return // user cancelled
                      if (result.ok && result.body && result.body.path) {
                        setPath(result.body.path)
                        setErr(null)
                      } else if (result.body && result.body.error) {
                        setPickError('目录选择失败:' + result.body.error)
                      }
                    })
                    .catch(function (e) {
                      setPickError(
                        '目录选择请求失败:' +
                          ((e && e.message) || String(e)),
                      )
                    })
                },
                style: (function () {
                  var enabled = sourceValue === 'local' && !busyValue
                  return {
                    padding: '7px 12px',
                    background: styles.panelBg,
                    border: '1px solid ' + (enabled ? styles.borderL2 : styles.borderL3),
                    borderRadius: 5,
                    color: enabled ? styles.labelSecondary : styles.labelTertiary,
                    fontSize: 11,
                    cursor: enabled ? 'pointer' : 'not-allowed',
                    fontFamily: 'inherit',
                    whiteSpace: 'nowrap',
                  }
                })(),
              },
              '浏览…',
            ),
          ),
        ),
        h(
          'div',
          { style: { marginBottom: 14 } },
          h(
            'label',
            {
              style: {
                display: 'block',
                fontSize: 11,
                color: styles.labelSecondary,
                marginBottom: 6,
                fontWeight: 500,
              },
            },
            '名称',
            h(
              'span',
              { style: { color: styles.labelTertiary, fontWeight: 400, marginLeft: 6 } },
              '— 自动从路径/URL 提取,作为 TAPD 模块标识,可手动修改',
            ),
          ),
          h('input', {
            type: 'text',
            value: nameValue,
            onChange: function (e) {
              setName(e.target.value)
              // Mark the field as touched so the auto-derive stops
              // overwriting the user's edit as they keep typing.
              if (!nameTouchedValue) setNameTouched(true)
            },
            disabled: busyValue,
            placeholder: derivedName || '—',
            style: {
                width: '100%',
                background: nameTouchedValue ? styles.panelBg : styles.panelBgSubtle,
                border: '1px solid ' + styles.borderL2,
                borderRadius: 5,
                padding: '8px 10px',
                color: nameValue ? styles.labelPrimary : styles.labelTertiary,
                fontFamily: styles.fontCode,
                fontSize: 12,
                boxSizing: 'border-box',
              },
          }),
        ),
        h(
          'div',
          { style: { marginBottom: 14 } },
          h(
            'label',
            {
              style: {
                display: 'block',
                fontSize: 11,
                color: styles.labelSecondary,
                marginBottom: 6,
                fontWeight: 500,
              },
            },
            'TAPD 工作空间 ID',
            h(
              'span',
              { style: { color: styles.labelTertiary, fontWeight: 400, marginLeft: 6 } },
              '— 留空 = 不会拉取需求。TAPD 项目页 URL 末尾的数字。',
            ),
          ),
          h('input', {
            type: 'text',
            value: tapdWorkspaceIdValue,
            onChange: function (e) { setTapdWorkspaceId(e.target.value); setErr(null) },
            disabled: busyValue,
            placeholder: '例: 69280376',
            style: {
              width: '100%',
              background: styles.panelBg,
              border: '1px solid ' + styles.borderL2,
              borderRadius: 5,
              padding: '8px 10px',
              color: tapdWorkspaceIdValue ? styles.labelPrimary : styles.labelTertiary,
              fontFamily: styles.fontCode,
              fontSize: 12,
              boxSizing: 'border-box',
            },
          }),
        ),
        h(tokenField, {
          label: 'TAPD API token',
          hint: '留空使用 shell 中的 DSH_TAPD_API_TOKEN',
          value: tapdTokenValue,
          onChange: function (v) { setTapdToken(v); setErr(null) },
          disabled: busyValue,
        }),
        h(tokenField, {
          label: 'GitLab API token',
          hint: '留空使用 shell 中的 DSH_GITLAB_API_TOKEN',
          value: gitlabTokenValue,
          onChange: function (v) { setGitlabToken(v); setErr(null) },
          disabled: busyValue,
        }),
        errValue || pickErrorValue
          ? h(
              'div',
              {
                style: {
                  fontSize: 11,
                  color: styles.statusError,
                  marginBottom: 10,
                  fontFamily: styles.fontCode,
                },
              },
              errValue || pickErrorValue,
            )
          : null,
        h(
          'div',
          {
            style: {
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 8,
              marginTop: 18,
              paddingTop: 14,
              borderTop: '1px solid ' + styles.borderL3,
            },
          },
          h(
            'button',
            {
              type: 'button',
              disabled: busyValue,
              onClick: onCancel,
              style: btnStyle(false),
            },
            '取消',
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: submit,
              disabled: busyValue || !nameValue,
              style: btnStyle(true),
            },
            busyValue ? '添加中…' : '添加',
          ),
        ),
      )

      function btnStyle(primary) {
        return {
          background: primary ? styles.accent : styles.panelBg,
          border: '1px solid ' + (primary ? styles.accent : styles.borderL2),
          color: primary ? '#ffffff' : styles.labelSecondary,
          padding: '7px 14px',
          borderRadius: 5,
          fontSize: 12,
          cursor: primary && (!nameValue || busyValue) ? 'not-allowed' : 'pointer',
          opacity: primary && (!nameValue || busyValue) ? 0.6 : 1,
        }
      }
    }

    /**
     * Extract a workspace name from a local path or git URL.
     * Local: last non-empty segment after trimming trailing separators.
     * Git: last segment of the URL, with the optional `.git` suffix
     * stripped. Empty string when the input is not parseable.
     */
    function computeWorkspaceName(source, value) {
      if (!value) return ''
      if (source === 'git') {
        // strip protocol prefix if any
        var url = value.replace(/^.*:\/\//, '').replace(/:/g, '/')
        var last = url.split('/').filter(Boolean).pop() || ''
        return last.replace(/\.git$/, '')
      }
      // local path: handle both / and \ separators
      var parts = value.split(/[\\/]/).filter(Boolean)
      return parts.length ? parts[parts.length - 1] : ''
    }

    /**
     * One password-shaped text field for a workspace credential. Plain
     * `<input type="password">` so the browser masks the value in the UI
     * itself; the host then persists whatever string the user typed
     * (empty == fall back to shell env, non-empty == plaintext override).
     */
    function tokenField(props) {
      return h(
        'div',
        { style: { marginBottom: 14 } },
        h(
          'label',
          {
            style: {
              display: 'block',
              fontSize: 11,
              color: styles.labelSecondary,
              marginBottom: 6,
              fontWeight: 500,
            },
          },
          props.label,
          h(
            'span',
            { style: { color: styles.labelTertiary, fontWeight: 400, marginLeft: 6 } },
            '— ' + props.hint,
          ),
        ),
        h('input', {
          type: 'password',
          value: props.value,
          onChange: function (e) { props.onChange(e.target.value) },
          disabled: props.disabled,
          autoComplete: 'off',
          spellCheck: false,
          placeholder: '留空 = 使用 shell 中的环境变量',
          style: {
            width: '100%',
            background: styles.panelBg,
            border: '1px solid ' + styles.borderL2,
            borderRadius: 5,
            padding: '8px 10px',
            color: styles.labelPrimary,
            fontFamily: styles.fontCode,
            fontSize: 12,
            boxSizing: 'border-box',
          },
        }),
      )
    }

    // ---- workspace row ---------------------------------------------------

    /**
     * One workspace card. The header summary carries the name, path,
     * counters, and the per-workspace setup issues (issue #6). The body
     * is a <details> block — open by default when the workspace has any
     * blocked / failed story, closed otherwise (issue #7). Native
     * <details>/<summary> gives the keyboard and screen-reader behaviour
     * for free.
     */
    function PollStatBadge(props) {
      var s = props.pollStat
      if (!s) return h('span', { style: { fontFamily: styles.fontCode, fontSize: 11, color: styles.labelTertiary } }, '尚未同步')
      if (s.lastError) {
        return h('span', { className: 'auto-rd-poll-error', title: s.lastError, style: { fontFamily: styles.fontCode, fontSize: 11, color: styles.statusError } }, '⚠ 同步失败')
      }
      if (s.lastSuccessAt) {
        var time = String(s.lastSuccessAt).slice(11, 16)
        return h('span', { className: 'auto-rd-poll-ok', style: { fontFamily: styles.fontCode, fontSize: 11, color: styles.statusSuccess } }, '✓ ' + time + (s.lastNewCount ? ' · +' + s.lastNewCount : ''))
      }
      return h('span', { style: { fontFamily: styles.fontCode, fontSize: 11, color: styles.labelTertiary } }, '尚未同步')
    }

    function Pager(props) {
      var page = props.page
      var totalPages = props.totalPages
      var onPage = props.onPage
      return h(
        'div',
        { className: 'auto-rd-pager', style: { display: 'flex', alignItems: 'center', gap: 10, padding: '6px 20px 14px', justifyContent: 'center', fontFamily: styles.fontCode, fontSize: 11, color: styles.labelSecondary } },
        h('button', { type: 'button', onClick: function () { if (page > 0) onPage(page - 1) }, disabled: page === 0, style: { border: '1px solid ' + styles.borderL3, background: 'transparent', color: styles.labelPrimary, borderRadius: 4, padding: '3px 8px', cursor: page === 0 ? 'default' : 'pointer' } }, '‹ 上一页'),
        h('span', null, (page + 1) + ' / ' + totalPages),
        h('button', { type: 'button', onClick: function () { if (page < totalPages - 1) onPage(page + 1) }, disabled: page >= totalPages - 1, style: { border: '1px solid ' + styles.borderL3, background: 'transparent', color: styles.labelPrimary, borderRadius: 4, padding: '3px 8px', cursor: page >= totalPages - 1 ? 'default' : 'pointer' } }, '下一页 ›'),
      )
    }

    function WorkspaceRow(props) {
      var ws = props.workspace
      var onOpen = props.onOpen
      var onRemove = props.onRemove

      var dotStyle = {
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: statusColor(ws.status),
        marginLeft: 4,
        flexShrink: 0,
      }

      var progress = []
      if (ws.inFlight) progress.push({ label: ws.inFlight + ' 进行', color: styles.statusInfo })
      if (ws.blocked) progress.push({ label: ws.blocked + ' 阻塞', color: styles.statusWarning })
      if (ws.completed) progress.push({ label: ws.completed + ' 完成', color: styles.statusSuccess })
      if (ws.failed) progress.push({ label: ws.failed + ' 失败', color: styles.statusError })

      return h(
        'li',
        {
          className: 'auto-rd-ws-row',
          onClick: function () { if (typeof onOpen === 'function') onOpen() },
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 16px',
            border: '1px solid ' + styles.borderL3,
            borderRadius: 7,
            marginBottom: 8,
            cursor: 'pointer',
          },
        },
        h('div', { style: dotStyle, 'aria-hidden': 'true' }),
        h(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0 } },
          h(
            'div',
            { style: { fontSize: 13, color: styles.labelPrimary, fontWeight: 500, marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            ws.name,
          ),
          h(
            'div',
            { style: { fontSize: 11, color: styles.labelSecondary, fontFamily: styles.fontCode, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            ws.path,
          ),
        ),
        h(
          'div',
          { style: { fontFamily: styles.fontCode, fontSize: 11, color: styles.labelSecondary, textAlign: 'right', whiteSpace: 'nowrap' } },
          progress.length
            ? progress.map(function (p) {
                return h('span', { key: p.label, style: { marginLeft: 8, color: p.color } }, p.label)
              })
            : h('span', null, ws.status === 'idle' && ws.storyCount === 0 ? '尚未拉取需求' : '—'),
        ),
        h(PollStatBadge, { pollStat: ws.pollStat }),
        h(
          'button',
          {
            type: 'button',
            className: 'auto-rd-ws-remove',
            title: '删除工作空间(不删除本地代码)',
            'aria-label': '删除工作空间',
            onClick: function (e) {
              e.preventDefault()
              e.stopPropagation()
              if (typeof onRemove === 'function') onRemove(ws.id)
            },
            style: {
              width: 22,
              height: 22,
              padding: 0,
              background: 'transparent',
              border: '1px solid ' + styles.borderL3,
              borderRadius: 4,
              color: styles.labelTertiary,
              fontSize: 14,
              lineHeight: '20px',
              cursor: 'pointer',
              fontFamily: 'inherit',
            },
          },
          '×',
        ),
      )

      function statusColor(status) {
        if (status === 'error') return styles.statusError
        if (status === 'cloning' || status === 'blocked' || status === 'halt') return styles.statusWarning
        if (status === 'idle') return styles.labelTertiary
        return styles.statusSuccess
      }
    }

    // ---- stage gauge (issue #5) -------------------------------------------
    //
    // The 4-stage gauge shows how far a story has progressed: each stage
    // is a row of 4 ticks; the row's data-fill attribute drives the
    // colour, data-on marks the lit ticks. Inline styles cannot express
    // the four colour variants, so the rules live in PANEL_CSS.

    function StageGauge(props) {
      var state = props.state
      var gauge = (typeof buildGauge === 'function') ? buildGauge(state) : { blocks: [], status: 'idle' }
      var blocks = gauge.blocks
      var legend = (typeof STAGE_LABELS === 'object') ? STAGE_LABELS : { spec: '规格', plan: '计划', implement: '实现', verify: '验证' }
      var keys = (typeof STAGE_KEYS !== 'undefined') ? STAGE_KEYS : ['spec', 'plan', 'implement', 'verify']

      return [
        h(
          'div',
          { key: 'gauge', className: 'auto-rd-gauge', 'aria-label': '阶段进度' },
          blocks.map(function (block, i) {
            return h(
              'span',
              {
                key: keys[i] || i,
                className: 'auto-rd-gauge-stage',
                'data-fill': block.status,
                role: 'presentation',
              },
              [0, 1, 2, 3].map(function (tickIdx) {
                return h('i', {
                  key: tickIdx,
                  className: 'auto-rd-gauge-tick',
                  ...(tickIdx < block.ticks ? { 'data-on': 'true' } : {}),
                })
              }),
            )
          }),
        ),
        h(
          'div',
          { key: 'legend', className: 'auto-rd-gauge-legend', role: 'presentation' },
          keys.map(function (k) {
            return h('span', { key: k }, legend[k] || k)
          }),
        ),
      ]
    }

    // ---- story detail view (issue #8) -----------------------------------
    //
    // Read-only, full-page replacement of the workspace list. The user
    // gets here by clicking a story id / title in the workspace detail
    // panel; the back button returns to the list. Nothing on this page
    // mutates pipeline state — there are no rerun / cancel / edit
    // controls, by design.

    function StoryDetail(props) {
      var story = props.story
      var workspace = props.workspace
      var onBack = props.onBack
      var sessions = props.sessions

      var bucket = (typeof STATE_TO_BUCKET === 'object') ? STATE_TO_BUCKET[story.state] : null
      var phaseLabel = (typeof currentPhaseLabel === 'function') ? currentPhaseLabel(story.state) : null
      var showCause = bucket === 'blocked' || bucket === 'failed'

      function fact(term, value, opts) {
        opts = opts || {}
        var empty = value === '' || value == null
        return h(
          'div',
          { key: term, style: { display: 'contents' } },
          h('dt', null, term),
          empty
            ? h('dd', { className: 'empty' }, opts.placeholder || '尚未提供')
            : h('dd', null, opts.render ? opts.render(value) : value),
        )
      }

      function pendingTag(label) {
        return h('span', { className: 'auto-rd-pending-tag', style: { marginLeft: 6 } }, label || '待对接')
      }

      function artifactRow(art) {
        var ok = (bucket === 'completed') || (art && art.kind && art.kind !== 'fix')
        return h(
          'li',
          { key: (art && art.filename) || Math.random(), 'data-ok': ok ? 'true' : null, 'data-bad': !ok ? 'true' : null },
          h('span', { className: 'm', 'aria-hidden': 'true' }, ok ? '\u2713' : '\u2717'),
          h('span', null, (art && art.summary) || (art && art.filename) || '产物'),
          h('span', { className: 't' }, (art && art.createdAt) ? String(art.createdAt).slice(11, 16) : ''),
        )
      }

      return h(
        'div',
        { className: 'auto-rd-detail', role: 'article', 'aria-label': '任务详情' },
        h(
          'button',
          {
            type: 'button',
            className: 'auto-rd-back',
            onClick: onBack,
            'aria-label': '返回任务列表',
          },
          h('span', { 'aria-hidden': 'true' }, '\u2190'),
          h('span', null, workspace ? workspace.name : '返回'),
        ),
        h('h2', { className: 'auto-rd-detail-title' }, story.title || story.id),
        h(
          'p',
          { className: 'auto-rd-detail-sub' },
          h('span', null, story.id),
          h('span', { style: { color: styles.labelTertiary, opacity: 0.5 } }, '\u00b7'),
          h('span', { className: 'auto-rd-detail-state', 'data-state': bucket || 'idle' }, phaseLabel || bucket || story.state || '—'),
          story.updatedAt
            ? h('span', { style: { color: styles.labelTertiary, opacity: 0.5 } }, '\u00b7')
            : null,
          story.updatedAt ? h('span', null, '更新于 ' + String(story.updatedAt).slice(11, 16)) : null,
        ),
        h(
          'div',
          { className: 'auto-rd-detail-gauge' },
          h(StageGauge, { state: story.state }),
        ),
        showCause
          ? h(
              'div',
              { className: 'auto-rd-cause', role: 'alert' },
              h('p', { className: 'auto-rd-cause-stage' }, (phaseLabel || bucket || '当前') + ' 阶段中断'),
              h('p', { className: 'auto-rd-cause-msg' }, story.blockedReason || '(无错误信息)'),
              h(
                'p',
                { className: 'auto-rd-cause-fix' },
                bucket === 'blocked'
                  ? '在该工作空间的设置里补全缺失的配置,下一轮轮询会自动重试。'
                  : '查看终端日志或 MR 评论获取详细错误。',
              ),
            )
          : null,
        h(
          'dl',
          { className: 'auto-rd-facts' },
          fact('分支', story.branch, { render: function (v) { return h('span', null, v, pendingTag()) } }),
          fact(
            '合并请求',
            story.mrUrl,
            {
              placeholder: '尚未创建',
              render: function (v) {
                return h('a', { href: v, target: '_blank', rel: 'noreferrer' }, v + ' \u2192')
              },
            },
          ),
          fact('工作树', story.worktreePath, { render: function (v) { return h('span', null, v, pendingTag()) } }),
          fact('会话', story.mainSessionId, {
            placeholder: '尚未创建',
            render: function (v) {
              if (sessions && typeof sessions.open === 'function') {
                return h('button', {
                  type: 'button',
                  onClick: function () { sessions.open(v) },
                  style: { border: 'none', background: 'none', color: styles.accent, cursor: 'pointer', fontSize: 'inherit', fontFamily: 'inherit', padding: 0, textDecoration: 'underline' },
                }, v + ' →')
              }
              return h('span', null, v)
            },
          }),
          fact('所属工作空间', workspace ? workspace.name : '', { placeholder: '—' }),
          fact('TAPD ID', story.tapdId || story.id, { placeholder: '—' }),
          fact('重试次数', story.retryCount != null ? String(story.retryCount) : '0', { placeholder: '0' }),
          story.createdAt ? fact('创建时间', String(story.createdAt).slice(0, 16).replace('T', ' '), { placeholder: '—' }) : null,
          story.pushedSha ? fact('推送 SHA', story.pushedSha, { placeholder: '—' }) : null,
          story.mrIid != null ? fact('MR IID', String(story.mrIid), { placeholder: '—' }) : null,
        ),
        h(
          'section',
          { className: 'auto-rd-detail-section' },
          h('h3', null, '验收标准'),
          story.acceptanceCriteria && String(story.acceptanceCriteria).trim()
            ? h(
                'ul',
                { className: 'auto-rd-criteria' },
                String(story.acceptanceCriteria)
                  .split('\n')
                  .map(function (line) { return line.replace(/^[\s\-\*]+/, '').trim() })
                  .filter(Boolean)
                  .map(function (line, i) { return h('li', { key: i }, line) }),
              )
            : h('p', { className: 'empty' }, '尚未写入验收标准'),
        ),
        h(
          'section',
          { className: 'auto-rd-detail-section' },
          h('h3', null, '产物'),
          Array.isArray(story.artifacts) && story.artifacts.length
            ? h('ul', { className: 'auto-rd-trail' }, story.artifacts.map(artifactRow))
            : h('p', { className: 'empty' }, '还没有产物记录'),
        ),
        h(TrajectoryTimeline, { storyId: story.id }),
      )
    }

    function TrajectoryTimeline(props) {
      var storyId = props.storyId
      var traj = useStoryTrajectory(storyId)
      var kindLabel = {
        state_transition: '状态转移',
        agent_dispatch: '派发 agent',
        agent_result: 'agent 结果',
        checkpoint_write: '检查点',
        external_side_effect: '外部副作用',
        recovery: '恢复',
        note: '笔记',
      }
      return h(
        'section',
        { className: 'auto-rd-detail-section' },
        h('h3', null, '轨迹'),
        traj.status === 'loading'
          ? h('p', { className: 'empty' }, '加载中…')
          : traj.status === 'error'
            ? h('p', { className: 'empty' }, '轨迹加载失败')
            : traj.events.length === 0
              ? h('p', { className: 'empty' }, '暂无轨迹记录')
              : h(
                  'ul',
                  { className: 'auto-rd-trajectory', style: { listStyle: 'none', margin: 0, padding: 0 } },
                  traj.events.map(function (ev, i) {
                    return h(
                      'li',
                      { key: ev.id || i, style: { display: 'flex', gap: 9, padding: '4px 0', fontSize: 12, fontFamily: styles.fontCode, color: styles.labelSecondary, borderTop: i === 0 ? 'none' : '1px solid ' + styles.borderL3 } },
                      h('span', { style: { color: styles.labelTertiary, flex: 'none' } }, String(ev.at).slice(11, 19)),
                      h('span', { style: { color: styles.accent, flex: 'none' } }, kindLabel[ev.kind] || ev.kind),
                      h('span', { style: { flex: '1 1 auto' } }, ev.label),
                    )
                  }),
                ),
      )
    }

    /**
     * Split the host's setup checklist into per-workspace vs global
     * buckets (issue #6). Global issues touch every workspace
     * (workspaceRoot, modules list); per-workspace issues attach to a
     * single row.
     *
     * The mapping mirrors how the host attaches a config key to a
     * workspace — `modules` and `workspace_root` are infra-level and
     * do not attach to any one workspace; the rest inherit the
     * per-workspace check that the host performs when it knows the
     * workspace id.
     */
    function splitSetupIssues(issues, workspace) {
      // Truly global issues — no single workspace owns them. The host
      // only emits these when no module has overridden the missing
      // setting, so showing them at the top banner is the right place.
      var globalKeys = {
        workspace_root: 1,
        modules: 1,
        tapd_token: 1,
        gitlab_token: 1,
      }
      var globalIssues = []
      var wsIssues = []
      for (var i = 0; i < (issues || []).length; i++) {
        var iss = issues[i]
        if (globalKeys[iss.key]) globalIssues.push(iss)
        else wsIssues.push(iss)
      }
      // Per-workspace additions: empty TAPD workspace id, no token when
      // none is configured for this workspace. We DO NOT flag a missing
      // TAPD token on a single workspace when the host has a global
      // token — that would be a duplicate of the global issue.
      var hasTapdTokenConfigured = !!(workspace && workspace.tapdTokenConfigured)
      if (workspace && !workspace.tapdWorkspaceId && workspace.stories && workspace.stories.length === 0) {
        wsIssues.push({
          key: 'tapd_workspace_id',
          message: '未设置 TAPD 工作空间 ID',
          remedy: '留空 = 不会拉取需求。在该工作空间的设置里填入 TAPD 项目 ID。',
        })
      }
      // Only flag a per-workspace TAPD token absence when the host has
      // NOT already emitted a global tapd_token issue (we just filtered
      // those out into `globalIssues` above). When the global is
      // already showing it, listing it again under every row is just
      // noise.
      var hasGlobalTapdIssue = globalIssues.some(function (g) { return g.key === 'tapd_token' })
      if (workspace && !hasTapdTokenConfigured && !hasGlobalTapdIssue) {
        wsIssues.push({
          key: 'tapd_token',
          message: '未配置 TAPD token',
          remedy: '填入后才能从 TAPD 拉取需求。在该工作空间的设置里粘贴 TAPD token,留空则继承全局。',
        })
      }
      if (workspace && workspace.gitlabTokenConfigured === false) {
        wsIssues.push({
          key: 'gitlab_token',
          message: 'GitLab token 未配置',
          remedy: '填入后才能创建合并请求。在该工作空间的设置里粘贴 GitLab token,留空则继承全局。',
        })
      }
      return { globalIssues: globalIssues, wsIssues: wsIssues }
    }

    // ---- workspace detail (expanded stories) -----------------------------

    /**
     * The detail panel revealed when the user expands a workspace row.
     * Lists the workspace's TAPD stories in two sections:
     *   - unfinished (pending / in-flight / blocked / failed) at the top,
     *     each with its 4-stage gauge and a click-to-open detail action
     *   - a folded <details> summary listing completed (and failed)
     *     stories; the user expands it once they want to scan history
     *
     * Per-workspace config issues (issue #6) appear in their own block
     * right above the story list, so the fix is always one click away
     * from the row it concerns.
     *
     * The list stays read-only — there are no rerun / edit / cancel
     * controls here. To act on a story, the user opens its detail view
     * (issue #8) or jumps to the MR.
     */
    function WorkspaceDetail(props) {
      var ws = props.workspace
      var stories = (ws && ws.stories) || []
      var onUpdate = props.onUpdate
      var onStoryClick = props.onStoryClick
      var onBack = props.onBack
      var issues = (ws && ws.issues) || []

      var open = []
      var done = []
      for (var i = 0; i < stories.length; i++) {
        var bucket = (typeof STATE_TO_BUCKET === 'object') ? STATE_TO_BUCKET[stories[i].state] : null
        if (bucket === 'completed' || bucket === 'failed') done.push(stories[i])
        else open.push(stories[i])
      }

      function storyButton(story, label, titleAttr) {
        return h(
          'button',
          {
            key: story.id + ':' + label,
            type: 'button',
            className: 'auto-rd-story-button',
            title: titleAttr,
            onClick: function () {
              if (typeof onStoryClick === 'function') onStoryClick(story.id)
            },
          },
          story[label] || '',
        )
      }

      function renderOpenStory(story) {
        var gaugeStatus = (typeof buildGauge === 'function') ? buildGauge(story.state).status : 'idle'
        var lineColor =
          gaugeStatus === 'halt'
            ? styles.statusError
            : gaugeStatus === 'live'
              ? styles.statusInfo
              : styles.labelTertiary
        var why = story.blockedReason || ''
        return h(
          'li',
          {
            key: story.id,
            className: 'auto-rd-story-line',
            'data-state': gaugeStatus,
            style: {
              padding: '9px 0',
              borderTop: '1px solid ' + styles.borderL3,
              display: 'grid',
              gridTemplateColumns: '14px 1fr',
              gap: '2px 9px',
            },
          },
          h(
            'span',
            {
              style: {
                fontFamily: styles.fontCode,
                fontSize: 12,
                color: lineColor,
                lineHeight: 1.5,
              },
              'aria-hidden': 'true',
            },
            story.badge || '·',
          ),
          h(
            'div',
            { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '2px 9px' } },
            storyButton(story, 'id', '查看任务详情'),
            storyButton(story, 'title', '查看任务详情'),
          ),
          why
            ? h(
                'div',
                {
                  style: {
                    gridColumn: '2',
                    fontSize: 12,
                    color: styles.statusError,
                  },
                },
                currentPhaseLabel(story.state)
                  ? currentPhaseLabel(story.state) + ' 阶段: ' + why
                  : why,
              )
            : null,
          h(
            'div',
            { style: { gridColumn: '2', marginTop: 3 } },
            h(StageGauge, { state: story.state }),
          ),
          story.mrUrl
            ? h(
                'a',
                {
                  href: story.mrUrl,
                  target: '_blank',
                  rel: 'noreferrer',
                  style: {
                    gridColumn: '2',
                    fontFamily: styles.fontCode,
                    fontSize: 11,
                    color: styles.accent,
                    textDecoration: 'none',
                  },
                },
                'MR →',
              )
            : null,
        )
      }

      function renderDoneRow(story) {
        return h(
          'span',
          {
            key: story.id,
            className: 'auto-rd-done-row',
            style: {
              display: 'flex',
              gap: 9,
              alignItems: 'baseline',
              fontSize: 12,
              color: styles.labelSecondary,
            },
          },
          h(
            'span',
            { style: { fontFamily: styles.fontCode, color: styles.labelTertiary } },
            (story.badge || '·') + ' ',
          ),
          storyButton(story, 'id', '查看任务详情'),
          ' ',
          story.title,
          story.mrUrl
            ? h(
                'a',
                {
                  href: story.mrUrl,
                  target: '_blank',
                  rel: 'noreferrer',
                  style: {
                    fontFamily: styles.fontCode,
                    fontSize: 11,
                    color: styles.accent,
                    textDecoration: 'none',
                  },
                },
                'MR →',
              )
            : null,
        )
      }

      function issueLine(issue) {
        return h(
          'div',
          { key: issue.key, className: 'auto-rd-ws-issue', role: 'note' },
          h('strong', { style: { marginRight: 6 } }, issue.message),
          h('span', { className: 'fix' }, issue.remedy),
        )
      }

      function back() {
        if (typeof onBack === 'function') onBack()
      }

      return h(
        'div',
        {
          style: {
            padding: '0 20px 20px',
            color: styles.labelSecondary,
            fontSize: 12,
            lineHeight: 1.7,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 } },
          h(
            'button',
            {
              type: 'button',
              className: 'auto-rd-back',
              onClick: back,
              'aria-label': '返回工作空间列表',
              style: { border: 'none', background: 'none', color: styles.accent, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', padding: 0 },
            },
            '← 返回',
          ),
          h('span', { style: { fontSize: 14, fontWeight: 600, color: styles.labelPrimary } }, ws.name),
          h(PollStatBadge, { pollStat: ws.pollStat }),
        ),
        issues.length
          ? h(
              'div',
              { 'aria-label': '配置问题', style: { marginBottom: 10 } },
              issues.map(issueLine),
            )
          : null,
        open.length + done.length > 0
          ? h(
              'div',
              { style: { fontSize: 13, fontWeight: 500, color: styles.labelPrimary, margin: '6px 0 4px' } },
              '任务',
            )
          : null,
        // No "还没有需求" placeholder here — the row summary already
        // says "尚未拉取需求" and "<n> 个需求" at the top, so showing
        // the same message again under the "任务" header is just
        // duplication when the user expands an empty workspace.
        // Per-workspace setup issues (issue #6) are still surfaced
        // independently when they exist (see the issues block above).
        open.length
          ? h(
              'ul',
              { style: { listStyle: 'none', margin: 0, padding: 0 } },
              open.map(renderOpenStory),
            )
          : null,
        done.length
          ? h(
              'details',
              { className: 'auto-rd-done' },
              h(
                'summary',
                { className: 'auto-rd-done-summary' },
                done.length + ' 条已完成',
              ),
              h(
                'div',
                { style: { display: 'grid', gap: 4, padding: '6px 0 0' } },
                done.map(renderDoneRow),
              ),
            )
          : null,
        ws.overflow > 0
          ? h(
              'div',
              {
                className: 'auto-rd-truncated',
                style: { marginTop: 8 },
              },
              '服务端每空间只回传 ' + (open.length + done.length) + ' 条,还有 ' + ws.overflow + ' 条未列出 ',
              h(
                'span',
                { className: 'auto-rd-pending-tag' },
                '需按 id 查询',
              ),
            )
          : null,
        h(WorkspaceSettingsForm, { workspace: ws, onUpdate: onUpdate }),
      )
    }

    // ---- workspace settings form (expanded panel) ------------------------

    /**
     * Per-workspace settings editor, shown inside the expanded detail.
     * Fields: TAPD workspace id, TAPD token, GitLab token, and per-role
     * model selection. Each field starts from the workspace's current
     * value (empty = inherit global). POSTs `update_workspace` on Apply.
     */
    function WorkspaceSettingsForm(props) {
      var ws = props.workspace
      var onUpdate = props.onUpdate
      // Tokens never travel back from the host — only whether one is
      // configured. The inputs therefore start empty; leaving them
      // empty on save means "keep the stored token" (update_workspace
      // treats '' as no-change), same convention as the shell's own
      // model-key settings.
      var tapdWorkspaceId = React.useState(ws.tapdWorkspaceId || '')
      var tapdToken = React.useState('')
      var gitlabToken = React.useState('')
      var busy = React.useState(false)
      var status = React.useState(null)

      var tapdWorkspaceIdValue = tapdWorkspaceId[0]
      var setTapdWorkspaceId = tapdWorkspaceId[1]
      var tapdTokenValue = tapdToken[0]
      var setTapdToken = tapdToken[1]
      var gitlabTokenValue = gitlabToken[0]
      var setGitlabToken = gitlabToken[1]
      var busyValue = busy[0]
      var setBusy = busy[1]
      var statusValue = status[0]
      var setStatus = status[1]

      function submit() {
        setBusy(true)
        setStatus(null)
        // Tokens never travel back from the host, so the inputs start
        // empty. An empty input means "leave the stored token alone" —
        // omit the field entirely so the host's update_workspace keeps
        // the existing value. Sending an empty string would be read as
        // "clear the token" and wipe a credential the user never meant
        // to touch.
        var body = {
          action: 'update_workspace',
          name: ws.id,
          tapdWorkspaceId: tapdWorkspaceIdValue,
        }
        if (tapdTokenValue !== '') body.tapdToken = tapdTokenValue
        if (gitlabTokenValue !== '') body.gitlabToken = gitlabTokenValue
        fetch(RECONFIGURE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function (res) {
            return res.json().then(function (body) { return { ok: res.ok, body: body } })
          })
          .then(function (result) {
            setBusy(false)
            if (result.ok && result.body && result.body.ok) {
              setStatus({ kind: 'success', message: '已保存' })
              if (typeof onUpdate === 'function') onUpdate(result.body)
            } else {
              setStatus({
                kind: 'error',
                message:
                  '保存失败:' +
                  ((result.body && (result.body.message || result.body.error)) || 'HTTP ' + result.status),
              })
            }
          })
          .catch(function (e) {
            setBusy(false)
            setStatus({ kind: 'error', message: '保存失败:' + ((e && e.message) || String(e)) })
          })
      }

      var fieldStyle = {
        width: '100%',
        background: styles.panelBg,
        border: '1px solid ' + styles.borderL2,
        borderRadius: 5,
        padding: '6px 10px',
        color: styles.labelPrimary,
        fontFamily: styles.fontCode,
        fontSize: 11,
        boxSizing: 'border-box',
      }
      var labelStyle = {
        display: 'block',
        fontSize: 11,
        color: styles.labelSecondary,
        marginBottom: 4,
        fontWeight: 500,
      }

      return h(
        'div',
        {
          style: {
            marginTop: 14,
            paddingTop: 14,
            borderTop: '1px solid ' + styles.borderL3,
          },
        },
        h(
          'div',
          { style: { fontSize: 13, fontWeight: 500, color: styles.labelPrimary, marginBottom: 10 } },
          '配置',
        ),
        h(
          'div',
          { style: { marginBottom: 10 } },
          h('label', { style: labelStyle }, 'TAPD 工作空间 ID', h('span', { style: { color: styles.labelTertiary, fontWeight: 400, marginLeft: 6 } }, '留空 = 不拉取')),
          h('input', { type: 'text', value: tapdWorkspaceIdValue, onChange: function (e) { setTapdWorkspaceId(e.target.value) }, disabled: busyValue, placeholder: '例: 123456', style: fieldStyle }),
        ),
        h(
          'div',
          { style: { marginBottom: 10 } },
          h('label', { style: labelStyle }, 'TAPD API token', h('span', { style: { color: styles.labelTertiary, fontWeight: 400, marginLeft: 6 } }, '留空 = 保持不变')),
          h('input', { type: 'password', value: tapdTokenValue, onChange: function (e) { setTapdToken(e.target.value) }, disabled: busyValue, autoComplete: 'off', placeholder: ws.tapdTokenConfigured ? '已配置——输入新值可替换' : '(继承全局)', style: fieldStyle }),
        ),
        h(
          'div',
          { style: { marginBottom: 10 } },
          h('label', { style: labelStyle }, 'GitLab API token', h('span', { style: { color: styles.labelTertiary, fontWeight: 400, marginLeft: 6 } }, '留空 = 保持不变')),
          h('input', { type: 'password', value: gitlabTokenValue, onChange: function (e) { setGitlabToken(e.target.value) }, disabled: busyValue, autoComplete: 'off', placeholder: ws.gitlabTokenConfigured ? '已配置——输入新值可替换' : '(继承全局)', style: fieldStyle }),
        ),
        statusValue
          ? h(
              'div',
              {
                style: {
                  fontSize: 11,
                  marginTop: 4,
                  color: statusValue.kind === 'success' ? styles.statusSuccess : styles.statusError,
                },
              },
              statusValue.message,
            )
          : null,
        h(
          'div',
          { style: { marginTop: 12, display: 'flex', justifyContent: 'flex-end', gap: 8 } },
          h(
            'button',
            {
              type: 'button',
              onClick: submit,
              disabled: busyValue,
              style: {
                background: styles.accent,
                color: '#ffffff',
                border: 'none',
                padding: '6px 14px',
                borderRadius: 5,
                fontSize: 12,
                cursor: busyValue ? 'wait' : 'pointer',
                fontFamily: 'inherit',
              },
            },
            busyValue ? '保存中…' : '保存',
          ),
        ),
      )
    }

    // ---- modal dialog ---------------------------------------------------

    /**
     * A minimal modal that sits over the rest of the panel. We render
     * it ourselves (rather than relying on `window.confirm` /
     * `window.alert`) because:
     *
     *   1. The shell-provided modals don't exist; `window.confirm` /
     *      `window.alert` look like 1996 and don't follow DSH styling.
     *   2. The "delete a workspace" flow needs to surface both the
     *      warning AND the workspace name, with prose around it. A
     *      single-string native confirm can't carry that context.
     *
     * Behaviour:
     *   - The overlay is a fixed-positioned div covering the panel
     *     area (we don't know the rest of the shell, but we can dim
     *     our own region).
     *   - Two actions: a primary (default focus) and a ghost. Pressing
     *     Escape cancels.
     */
    function ConfirmModal(props) {
      var onConfirm = props.onConfirm
      var onCancel = props.onCancel
      var title = props.title
      var body = props.body
      var confirmLabel = props.confirmLabel || '确定'
      var cancelLabel = props.cancelLabel || '取消'
      var danger = !!props.danger

      function onKey(e) {
        if (e.key === 'Escape') onCancel()
        else if (e.key === 'Enter') onConfirm()
      }
      React.useEffect(function () {
        if (typeof window !== 'undefined') {
          window.addEventListener('keydown', onKey)
          return function () { window.removeEventListener('keydown', onKey) }
        }
      }, [])

      return h(
        'div',
        {
          className: 'auto-rd-modal-backdrop',
          onClick: onCancel,
          style: {
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.40)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          },
        },
        h(
          'div',
          {
            className: 'auto-rd-modal',
            onClick: function (e) { e.stopPropagation() },
            style: {
              background: styles.panelBg,
              border: '1px solid ' + styles.borderL2,
              borderRadius: 8,
              padding: '20px 22px',
              minWidth: 320,
              maxWidth: 420,
              boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
            },
          },
          h(
            'div',
            { style: { fontSize: 14, fontWeight: 500, color: styles.labelPrimary, marginBottom: 10 } },
            title,
          ),
          h(
            'div',
            {
              style: {
                fontSize: 12,
                lineHeight: 1.6,
                color: styles.labelSecondary,
                marginBottom: 18,
                whiteSpace: 'pre-wrap',
              },
            },
            body,
          ),
          h(
            'div',
            {
              style: {
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 8,
              },
            },
            h(
              'button',
              {
                type: 'button',
                onClick: onCancel,
                style: {
                  background: styles.panelBg,
                  border: '1px solid ' + styles.borderL2,
                  color: styles.labelSecondary,
                  padding: '6px 14px',
                  borderRadius: 5,
                  fontSize: 12,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                },
              },
              cancelLabel,
            ),
            h(
              'button',
              {
                type: 'button',
                autoFocus: true,
                onClick: onConfirm,
                style: {
                  background: danger ? styles.statusError : styles.accent,
                  border: '1px solid ' + (danger ? styles.statusError : styles.accent),
                  color: '#ffffff',
                  padding: '6px 14px',
                  borderRadius: 5,
                  fontSize: 12,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontWeight: 500,
                },
              },
              confirmLabel,
            ),
          ),
        ),
      )
    }

    // ---- first-frame skeleton -------------------------------------------
    //
    // The fetch starts on mount and takes at least one round trip.
    // Until it settles there is no honest answer to "what is on this
    // screen" — least of all "还没有工作空间", which is what the panel
    // used to say. The skeleton stands in for content that is known to
    // be coming: three placeholder rows shaped like the workspace rows
    // that replace them. Styling (bar widths, surfaces) lives in the
    // injected stylesheet so it follows the shell theme.

    function PanelSkeleton() {
      var widths = [
        ['s', 'l'],
        ['s', 'm'],
        ['s', 'l'],
      ]
      return h(
        'div',
        {
          className: 'auto-rd-skel',
          role: 'status',
          'aria-busy': 'true',
          'aria-label': '正在载入',
        },
        widths.map(function (row, i) {
          return h(
            'div',
            { key: i, className: 'auto-rd-skel-row' },
            row.map(function (w, j) {
              return h('div', {
                key: j,
                className: 'auto-rd-skel-bar auto-rd-skel-' + w,
              })
            }),
          )
        }),
      )
    }

    // ---- workspace list / empty state -----------------------------------

    function WorkspaceList(props) {
      var workspaces = props.workspaces
      var onAdd = props.onAdd
      var onRefresh = props.onRefresh
      var onRemove = props.onRemove
      var onUpdate = props.onUpdate
      var onOpenWorkspace = props.onOpenWorkspace

      var PAGE_SIZE = 5
      var page = React.useState(0)
      var pageValue = page[0]
      var setPage = page[1]

      if (!workspaces || workspaces.length === 0) {
        return h(
          'div',
          null,
          h(
            'div',
            { style: { fontSize: 16, fontWeight: 500, color: styles.labelPrimary, marginBottom: 4 } },
            '还没有工作空间',
          ),
          h(
            'div',
            { style: { color: styles.labelSecondary, marginBottom: 22, fontSize: 12 } },
            '添加一个项目,开始拉取 TAPD 需求并自动出 GitLab MR。',
          ),
          h(AddWorkspaceForm, { onAdded: onRefresh }),
          legend(),
        )
      }

      var totalPages = Math.max(1, Math.ceil(workspaces.length / PAGE_SIZE))
      var currentPage = pageValue >= totalPages ? totalPages - 1 : pageValue
      var start = currentPage * PAGE_SIZE
      var pageItems = workspaces.slice(start, start + PAGE_SIZE)

      return h(
        'div',
        null,
        h(
          'ul',
          { className: 'auto-rd-ws-list', style: { listStyle: 'none', margin: 0, padding: '0 14px' } },
          pageItems.map(function (ws) {
            return h(WorkspaceRow, {
              key: ws.id,
              workspace: ws,
              onOpen: function () {
                if (typeof onOpenWorkspace === 'function') onOpenWorkspace(ws.id)
              },
              onRemove: function (id) {
                if (typeof onRemove === 'function') onRemove(id)
              },
              onUpdate: function (body) {
                if (typeof onUpdate === 'function') onUpdate(body)
              },
            })
          }),
        ),
        totalPages > 1
          ? h(Pager, {
              page: currentPage,
              totalPages: totalPages,
              onPage: function (p) { setPage(p) },
            })
          : null,
        legend(),
      )
    }

    function legend() {
      // Issue #6: the previous version of this legend said "tokens are
      // not configured here", while the panel itself renders token
      // input fields. That contradiction is removed: tokens ARE
      // configured here when a per-workspace value is needed; the host
      // env var is the fallback when the field is empty. The legend
      // now describes what the dot colours mean — useful guidance, no
      // misinformation.
      return h(
        'div',
        {
          style: {
            margin: '14px 20px 22px',
            paddingTop: 12,
            borderTop: '1px solid ' + styles.borderL3,
            fontSize: 11,
            color: styles.labelTertiary,
            lineHeight: 1.7,
          },
        },
        h(
          'div',
          { style: { marginBottom: 4 } },
          h(
            'span',
            {
              style: {
                display: 'inline-block',
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: styles.statusSuccess,
                marginRight: 6,
                verticalAlign: 'middle',
              },
            },
          ),
          '正常 · 正在跑需求或等待轮询',
        ),
        h(
          'div',
          { style: { marginBottom: 4 } },
          h(
            'span',
            {
              style: {
                display: 'inline-block',
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: styles.statusWarning,
                marginRight: 6,
                verticalAlign: 'middle',
              },
            },
          ),
          '有阻塞或失败的需求,需要看一眼',
        ),
        h('div', null,
          h(
            'span',
            {
              style: {
                display: 'inline-block',
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: styles.labelTertiary,
                marginRight: 6,
                verticalAlign: 'middle',
              },
            },
          ),
          '暂无需求,等待下次轮询',
        ),
        h(
          'div',
          { style: { marginTop: 6 } },
          '每个工作空间可填入独立的 token(留空 = 使用 shell 中的环境变量)。',
        ),
      )
    }

    // ---- sync pulse (always-on freshness line) ---------------------------
    //
    // The one element that always tells the truth about how fresh the
    // screen is: "已同步 · N 秒前" while the poll succeeds, and
    // "重连中 · 数据停在 HH:MM" once fetches fail but the cached
    // model is still on screen. Without it a stalled poll looks
    // exactly like a quiet pipeline.
    //
    // `now` is passed in so the re-render that the poll interval can't
    // trigger on its own (the pulse text only changes with time, not
    // with state) is driven by the same 5s tick as the data itself —
    // one clock, one heartbeat.

    function SyncPulse(props) {
      var status = props.status
      var lastSyncedAt = props.lastSyncedAt
      var onResync = props.onResync
      var now = props.now

      // Normal state renders nothing — "已同步 · 刚刚" is a sentence that
      // is always true (the snapshot refreshes every 5s), so it said
      // nothing. The pulse only speaks when the panel can't reach the
      // host: with a cache it owns up to its age, without one it says
      // 重连中.
      if (status === 'ok') return null
      var stale = status === 'error' && lastSyncedAt != null
      var label = stale
        ? '面板连接失败 · 数据停在 ' + clockLabel(lastSyncedAt)
        : status === 'loading'
          ? '首次同步中…'
          : '面板连接失败 · 重连中…'

      return h(
        'div',
        {
          className: 'auto-rd-pulse',
          'aria-live': 'polite',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            padding: '7px 20px',
            background: styles.panelBgSubtle,
            borderBottom: '1px solid ' + styles.borderL3,
            fontFamily: styles.fontCode,
            fontSize: 11,
            color: styles.statusError,
          },
        },
        h('span', {
          className: 'auto-rd-pulse-dot',
          style: {
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: styles.statusError,
            display: 'inline-block',
            flex: 'none',
          },
        }),
        h('span', null, label),
        h(
          'button',
          {
            type: 'button',
            onClick: function () { if (onResync) onResync() },
            'aria-label': '重试',
            title: '重试',
            style: {
              marginLeft: 'auto',
              border: 'none',
              background: 'none',
              padding: '3px 6px',
              margin: '-3px -6px -3px auto',
              color: styles.labelTertiary,
              cursor: 'pointer',
              fontSize: 12,
              lineHeight: 1,
              borderRadius: 4,
            },
          },
          '↻',
        ),
      )
    }

    function agoLabel(ms) {
      if (ms < 0) ms = 0
      var sec = Math.floor(ms / 1000)
      if (sec < 5) return '刚刚'
      if (sec < 60) return sec + ' 秒前'
      var min = Math.floor(sec / 60)
      if (min < 60) return min + ' 分钟前'
      return Math.floor(min / 60) + ' 小时前'
    }

    function clockLabel(epochMs) {
      var d = new Date(epochMs)
      function pad(n) { return (n < 10 ? '0' : '') + n }
      return pad(d.getHours()) + ':' + pad(d.getMinutes())
    }

    // ---- status bar (one row, three stats) -------------------------------

    function StatusBar(props) {
      var workspaces = props.workspaces
      var totals = props.totals
      var lastPollAt = props.lastPollAt

      var totalStories = totals ? totals.stories : 0
      var running =
        (totals && (totals.inFlight || 0)) +
        (totals && (totals.blocked || 0)) +
        (totals && (totals.completed || 0)) +
        (totals && (totals.failed || 0))
      var wsCount = workspaces ? workspaces.length : 0

      var hasError = workspaces && workspaces.some(function (w) { return w.status === 'error' })

      var statusLabel = hasError
        ? '出错'
        : lastPollAt
          ? '上次采集 ' + clockLabel(Date.parse(lastPollAt))
          : '尚未采集'
      var statusColor = hasError
        ? styles.statusError
        : lastPollAt
          ? styles.statusSuccess
          : styles.labelTertiary

      return h(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '8px 20px',
            background: styles.panelBgSubtle,
            borderBottom: '1px solid ' + styles.borderL3,
            fontFamily: styles.fontCode,
            fontSize: 11,
            color: styles.labelSecondary,
          },
        },
        h(
          'span',
          {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
            },
          },
          h('span', {
            style: {
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: statusColor,
              marginRight: 5,
              display: 'inline-block',
            },
          }),
          statusLabel,
        ),
        h('span', { style: { color: styles.labelTertiary, opacity: 0.5 } }, '·'),
        h('span', null, wsCount + ' 个工作空间'),
        totalStories > 0
          ? h(
              'span',
              null,
              h('span', { style: { color: styles.labelTertiary, opacity: 0.5 } }, '·'),
              h(
                'span',
                null,
                totalStories + ' 个需求 · ' +
                  (totals.inFlight || 0) + ' 进行 · ' +
                  (totals.blocked || 0) + ' 阻塞 · ' +
                  (totals.completed || 0) + ' 完成 · ' +
                  (totals.failed || 0) + ' 失败',
              ),
            )
          : null,
      )
    }

    // ---- main-column panel body -----------------------------------------

    function AutoRdPanel() {
      var data = usePanelData()
      var panel = data.panel
      var applyBody = data.applyBody
      // resync trigger for tests: routes the panel's resync (which lives
      // in a hook closure) to the outside world once the panel renders.
      var resync = data.resync
      module.__autoRd.resync = resync

      // Drives the pulse's "N 秒前" text on the same cadence as the
      // poll, without an extra timer.
      var now = React.useState(Date.now())
      var nowValue = now[0]
      var setNow = now[1]

      // The responsive/focus rules live in the injected stylesheet
      // (see PANEL_CSS). Mounted once, kept for the panel's lifetime.
      React.useEffect(function () {
        injectStyles(null)
      }, [])

      React.useEffect(function () {
        function tick() { setNow(Date.now()) }
        var timer = setInterval(tick, POLL_MS)
        return function () { clearInterval(timer) }
      }, [])

      // The model content re-renders only when data changes; the pulse
      // text depends on `now` too, so refresh it whenever the tick
      // fires (React skips the work if nothing changed).
      var model = panel.model
      var modules = (model && model.modules) || []
      var totals = (model && model.totals) || { stories: 0, inFlight: 0, blocked: 0, completed: 0, failed: 0 }
      var health = (model && model.health) || null

      var addOpen = React.useState(false)
      // Three-level navigation: 'list' → 'workspace' → 'story'.
      // activeWorkspaceId and selectedStoryId together locate the detail
      // view; a back button pops one level at a time.
      var view = React.useState('list')
      var activeWorkspaceId = React.useState(null)
      // Selected story drives the detail view (issue #8). When set, the
      // main panel renders StoryDetail instead of WorkspaceList.
      var selectedStoryId = React.useState(null)
      // Workspace-removal modal state. `confirmRemove` holds the id of
      // the workspace the user is being asked to confirm; `removeError`
      // holds the host's error message after a failed remove so we can
      // surface it in a second modal instead of an ugly `window.alert`.
      var confirmRemove = React.useState(null)
      var removeError = React.useState(null)
      var confirmRemoveValue = confirmRemove[0]
      var setConfirmRemove = confirmRemove[1]
      var removeErrorValue = removeError[0]
      var setRemoveError = removeError[1]

      var addOpenValue = addOpen[0]
      var setAddOpen = addOpen[1]
      var viewValue = view[0]
      var setView = view[1]
      var activeWorkspaceIdValue = activeWorkspaceId[0]
      var setActiveWorkspaceId = activeWorkspaceId[1]
      var selectedStoryIdValue = selectedStoryId[0]
      var setSelectedStoryId = selectedStoryId[1]

      // Escape closes the detail view (keyboard reachability, issue #8).
      React.useEffect(function () {
        if (!selectedStoryIdValue || typeof window === 'undefined') return undefined
        function onKey(e) {
          if (e.key === 'Escape') setSelectedStoryId(null)
        }
        window.addEventListener('keydown', onKey)
        return function () { window.removeEventListener('keydown', onKey) }
      }, [selectedStoryIdValue])

      // Derive the workspaces[] shape that the UI consumes from the host's
      // modules[] shape. Until the host exposes per-workspace errors /
      // status, we synthesise: a workspace with stories in flight is
      // "polling"; without stories it is "idle". The host will replace
      // this with real per-workspace health once the reconfigure route
      // gains workspace-level fields (see services/reconfigure-route.ts).
      //
      // Counters are computed from the SAME bucket view the gauge uses,
      // so the bar and the tally agree (issue #5 acceptance: "工作空间摘
      // 要的进行中计数反映真实在跑的需求数"). The legacy code matched
      // state names that do not exist in the 19-state machine
      // ('in_progress', 'in_flight'), which is why the in-flight count
      // was always zero.
      var workspaces = modules.map(function (m) {
        var inFlight = 0
        var blocked = 0
        var completed = 0
        var failed = 0
        var pending = 0
        if (Array.isArray(m.stories)) {
          for (var i = 0; i < m.stories.length; i++) {
            var s = m.stories[i].state
            var bucket = (typeof STATE_TO_BUCKET === 'object') ? STATE_TO_BUCKET[s] : null
            if (bucket === 'blocked') blocked++
            else if (bucket === 'completed') completed++
            else if (bucket === 'failed') failed++
            else if (bucket === 'pending') pending++
            else if (bucket === 'spec' || bucket === 'plan' || bucket === 'implement' || bucket === 'verify') inFlight++
          }
        }
        var hasStories = m.stories && m.stories.length > 0
        var status = blocked > 0 || failed > 0
          ? 'halt'
          : inFlight > 0
            ? 'polling'
            : hasStories
              ? 'idle'
              : 'idle'
        var split = splitSetupIssues(
          (health && health.issues) || [],
          Object.assign({ stories: m.stories || [] }, m),
        )
        return {
          id: m.id,
          name: m.title || m.id,
          path: m.repoUrl || (m.id + ' (local)'),
          storyCount: m.stories ? m.stories.length : 0,
          overflow: m.overflow || 0,
          stories: m.stories || [],
          inFlight: inFlight,
          blocked: blocked,
          completed: completed,
          failed: failed,
          pending: pending,
          status: status,
          error: null,
          remedy: null,
          // Per-workspace setup issues (issue #6): empty when the host
          // has nothing to flag for this row.
          issues: split.wsIssues,
          // Per-workspace settings (empty = inherit global). Token
          // values never arrive; only their configured flags do.
          tapdWorkspaceId: m.tapdWorkspaceId || '',
          tapdTokenConfigured: !!m.tapdTokenConfigured,
          gitlabTokenConfigured: !!m.gitlabTokenConfigured,
          modelSelection: m.modelSelection || {},
          pollStat: m.pollStat || null,
        }
      })

      // One workspace row may inherit the host-level lastTapdError. This
      // is a placeholder: the real per-workspace error attribution will
      // come from services/reconfigure-route.ts when it grows a
      // workspace-aware error field.
      if (health && health.lastTapdError && workspaces.length > 0) {
        // attribute to the first workspace that lacks stories as a
        // stand-in heuristic — good enough for the UI smoke test.
        workspaces[workspaces.length - 1].status = 'error'
        workspaces[workspaces.length - 1].error = health.lastTapdError
        workspaces[workspaces.length - 1].remedy =
          '重启 DSH 之前先在启动 shell 中导出 DSH_TAPD_API_TOKEN,然后重新打开此面板。'
      }

      var isPolling = health && health.lastTapdPollAt != null

      // Body dispatcher (three-level navigation). Branches on the panel's
      // view state: loading skeleton, error fallback, add-form mode,
      // story detail, workspace detail, or the paginated list.
      function renderMain() {
        if (!model) {
          return panel.status === 'loading' ? h(PanelSkeleton) : null
        }
        if (addOpenValue) {
          return h(AddWorkspaceForm, {
            onCancel: function () { setAddOpen(false) },
            onAdded: function (body) { setAddOpen(false); refresh(body) },
          })
        }
        if (viewValue === 'story' && selectedStoryIdValue) {
          var found = null
          for (var wi = 0; wi < workspaces.length; wi++) {
            var stories = workspaces[wi].stories || []
            for (var si = 0; si < stories.length; si++) {
              if (stories[si].id === selectedStoryIdValue) {
                found = { story: stories[si], workspace: workspaces[wi] }
                break
              }
            }
            if (found) break
          }
          if (found) {
            return h(StoryDetail, {
              story: found.story,
              workspace: found.workspace,
              sessions: module.__autoRd.sessions,
              onBack: function () {
                setSelectedStoryId(null)
                setView('workspace')
              },
            })
          }
          setSelectedStoryId(null)
          setView('list')
        }
        if (viewValue === 'workspace' && activeWorkspaceIdValue) {
          var ws = null
          for (var wj = 0; wj < workspaces.length; wj++) {
            if (workspaces[wj].id === activeWorkspaceIdValue) { ws = workspaces[wj]; break }
          }
          if (ws) {
            return h(WorkspaceDetail, {
              workspace: ws,
              onBack: function () { setActiveWorkspaceId(null); setView('list') },
              onStoryClick: function (id) { setSelectedStoryId(id); setView('story') },
              onUpdate: refresh,
            })
          }
          setActiveWorkspaceId(null)
          setView('list')
        }
        return h(WorkspaceList, {
          workspaces: workspaces,
          onOpenWorkspace: function (id) { setActiveWorkspaceId(id); setView('workspace') },
          onRefresh: refresh,
          onRemove: removeWorkspace,
          onUpdate: refresh,
        })
      }

      /**
       * Apply a mutation response in place — no page reload.
       *
       * Every mutating host action (add / remove / update workspace)
       * returns the freshly-built panel model in its response, so the
       * client can render the new state directly instead of reloading
       * the page and losing scroll position and expansion state. The
       * 5-second poll still reconciles anything a concurrent change
       * did on the host side.
       */
      function refresh(body) {
        if (body && body.model) {
          applyBody(body)
        }
      }

      /**
       * Remove a workspace from the live config + storage. Confirms
       * with the user first because the action is destructive (the
       * workspace record is gone; only the local git checkout, if any,
       * survives on disk).
       */
      function removeWorkspace(id) {
        // The × button only arms the modal. The actual fetch runs from
        // the modal's "确定" button so we never silently call fetch
        // without an explicit user gesture.
        setConfirmRemove(id)
      }

      /**
       * Called by ConfirmModal's "确定" button. Fires the host-side
       * remove_workspace action and refreshes on success. Failure
       * surfaces a second modal with the host's message instead of
       * an ugly `window.alert`.
       */
      function doRemove(id) {
        fetch(RECONFIGURE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'remove_workspace', name: id }),
        })
          .then(function (res) {
            return res.json().then(function (body) {
              return { ok: res.ok, body: body }
            })
          })
          .then(function (result) {
            setConfirmRemove(null)
            if (result.ok && result.body && result.body.ok) {
              // Drop the user's remembered open/closed preference for
              // the removed workspace; otherwise the override hangs
              // around in state pointing at a workspace that no longer
              // exists. `refresh` then rebuilds the list from the
              // host's response.
              setExpandedOverrides(function (prev) {
                if (!prev || !Object.prototype.hasOwnProperty.call(prev, id)) return prev
                var next = Object.assign({}, prev)
                delete next[id]
                return next
              })
              // Same for the settings panel — if it was open for this
              // workspace, the panel is now dangling. The render path
              // would already short-circuit (the workspace is gone), but
              // we clear the state so reopening another workspace does
              // not see a stale id.
              setSettingsOpen(function (cur) { return cur === id ? null : cur })
              refresh(result.body)
            } else {
              setRemoveError(
                (result.body && (result.body.message || result.body.error)) ||
                  ('HTTP ' + result.status),
              )
            }
          })
          .catch(function (e) {
            setConfirmRemove(null)
            setRemoveError((e && e.message) || String(e))
          })
      }

      return h(
        'div',
        {
          className: 'auto-rd-panel',
          style: {
            padding: 0,
            fontSize: 13,
            color: styles.labelPrimary,
            overflow: 'auto',
            height: '100%',
            boxSizing: 'border-box',
            background: styles.panelBg,
          },
        },
        h(
          'div',
          {
            style: {
              padding: '14px 20px 10px',
              borderBottom: '1px solid ' + styles.borderL3,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
            },
          },
          h(
            'h2',
            {
              style: {
                margin: 0,
                fontSize: 14,
                fontWeight: 500,
                color: styles.labelPrimary,
                letterSpacing: '-0.01em',
              },
            },
            'TAPD ',
            h(
              'span',
              { style: { fontWeight: 400, opacity: 0.55, margin: '0 2px' } },
              '→',
            ),
            ' GitLab 流水线',
          ),
          workspaces.length > 0
            ? h(
                'button',
                {
                  type: 'button',
                  onClick: function () { setAddOpen(!addOpenValue) },
                  style: {
                    marginLeft: 'auto',
                    background: styles.accent,
                    color: '#ffffff',
                    border: 'none',
                    padding: '5px 12px',
                    borderRadius: 5,
                    fontSize: 12,
                    cursor: 'pointer',
                  },
                },
                addOpenValue ? '取消' : '+ 添加工作空间',
              )
            : null,
          h(
            'span',
            {
              style: {
                fontFamily: styles.fontCode,
                fontSize: 10,
                color: styles.labelTertiary,
                padding: '2px 6px',
                border: '1px solid ' + styles.borderL3,
                borderRadius: 3,
              },
            },
            'v0.1.0',
          ),
        ),
        h(SyncPulse, {
          status: panel.status,
          lastSyncedAt: panel.lastSyncedAt,
          onResync: resync,
          now: nowValue,
        }),
        h(StatusBar, {
          workspaces: workspaces,
          totals: totals,
          lastPollAt: health ? health.lastTapdPollAt : null,
        }),
        // Global setup issues (issue #6) — workspaceRoot config that
        // touches every workspace. Per-workspace issues travel with
        // their row; only the truly cross-cutting ones belong here.
        (function () {
          var globalIssues = (health && health.issues && health.issues.length)
            ? health.issues.filter(function (iss) { return iss.key === 'workspace_root' })
            : []
          if (globalIssues.length === 0) return null
          return h(
            'div',
            { className: 'auto-rd-global-issues', role: 'region', 'aria-label': '全局配置问题' },
            globalIssues.map(function (iss) {
              return h(
                'span',
                { key: iss.key, style: { display: 'contents' } },
                h('span', { className: 'auto-rd-global-issues-mark', 'aria-hidden': 'true' }, '\u2717'),
                h(
                  'span',
                  null,
                  h('span', { className: 'auto-rd-global-issues-msg' }, iss.message),
                  h('br'),
                  h('span', { className: 'auto-rd-global-issues-fix' }, iss.remedy),
                ),
              )
            }),
          )
        })(),
        h(
          'div',
          {
            style: { padding: '18px 20px', flex: 1 },
          },
          // The body branches on (status, model):
          // The body branches on (status, model); see renderMain()
          // above for the dispatch logic. The detail view (issue #8)
          // takes the WHOLE main panel; the sync pulse + status bar
          // stay visible so the user always knows how fresh the
          // screen is, even while reading a story's history.
          renderMain(),
          panel.status === 'error' && !model
            ? h(
                'div',
                {
                  style: {
                    marginTop: 16,
                    color: styles.statusError,
                    fontSize: 12,
                  },
                },
                '面板数据不可用:' + panel.error,
              )
            : null,
          // Remove-confirmation modal — sits over the panel content
          // when `confirmRemove` holds an id. The modal is rendered
          // here (inside AutoRdPanel) so it inherits the React tree
          // and uses the same styles object as everything else.
          confirmRemoveValue
            ? h(ConfirmModal, {
                title: '删除工作空间',
                body:
                  '确定要从 auto-rd 中移除工作空间 "' +
                  confirmRemoveValue +
                  '" 吗?\n\n' +
                  '本地代码不会被删除;只是 auto-rd 不再拉取这个项目的需求。\n' +
                  '需要时可以通过 "添加工作空间" 重新挂上。',
                confirmLabel: '删除',
                cancelLabel: '取消',
                danger: true,
                onCancel: function () { setConfirmRemove(null) },
                onConfirm: function () { doRemove(confirmRemoveValue) },
              })
            : null,
          removeErrorValue
            ? h(ConfirmModal, {
                title: '删除失败',
                body: removeErrorValue,
                confirmLabel: '关闭',
                cancelLabel: null,
                danger: true,
                onCancel: function () { setRemoveError(null) },
                onConfirm: function () { setRemoveError(null) },
              })
            : null,
        ),
      )
    }

    // ---- plugin lifecycle ---------------------------------------------

    function apply(ctx) {
      var slots = ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
      if (!slots) {
        if (ctx.logger) ctx.logger('auto-rd').warn('client slots service unavailable; panel not registered')
        return
      }

      // Session jump (story detail "会话" → clickable). The host exposes
      // ctx.sessions.open(id) (see @deepseek-ai/dsh-api-session-controller);
      // absent in fixtures / headless, in which case the session button
      // degrades to a plain id string.
      var sessions = ctx.sessions || (typeof ctx.get === 'function' ? ctx.get('sessions') : undefined)
      module.__autoRd.sessions = sessions

      ctx.slots.inject(PANEL_SLOT, function () {
        return slots.register(
          {
            name: PANEL_SLOT,
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: PANEL_LABEL,
          },
          AutoRdIcon,
        )
      })

      ctx.slots.inject(MAIN_SLOT, function () {
        return slots.register(
          {
            name: MAIN_SLOT,
            key: PANEL_ID,
          },
          AutoRdPanel,
        )
      })
    }

    var inject = ['slots', 'sessions']

    var module = {
      apply: apply,
      inject: inject,
    }

    module.__autoRd = {
      PANEL_SLOT: PANEL_SLOT,
      MAIN_SLOT: MAIN_SLOT,
      PANEL_ID: PANEL_ID,
      PANEL_ORDER: PANEL_ORDER,
      PANEL_LABEL: PANEL_LABEL,
      DATA_URL: DATA_URL,
      RECONFIGURE_URL: RECONFIGURE_URL,
      PICK_DIRECTORY_URL: PICK_DIRECTORY_URL,
      POLL_MS: POLL_MS,
      STYLE_ELEMENT_ID: STYLE_ELEMENT_ID,
      PANEL_CSS: PANEL_CSS,
      injectStyles: injectStyles,
      // Populated by apply(): the live ctx.sessions service (or undefined
      // in headless / fixtures).
      sessions: null,
      // Set to the live resync function once AutoRdPanel renders; tests
      // use it to drive a poll without waiting for the interval.
      // Test seam: direct component handles so the client-half suite can
      // render the icon and panel without a full shell.
      components: {
        AutoRdIcon: AutoRdIcon,
        AutoRdPanel: AutoRdPanel,
        SyncPulse: SyncPulse,
        PanelSkeleton: PanelSkeleton,
        StageGauge: StageGauge,
        StoryDetail: StoryDetail,
        WorkspaceDetail: WorkspaceDetail,
        useStoryTrajectory: useStoryTrajectory,
      },
    }

    return module
  },
})