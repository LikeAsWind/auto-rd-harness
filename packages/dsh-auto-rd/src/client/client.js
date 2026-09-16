/**
 * auto-rd client half — the sidebar entry and its main-column body.
 *
 * This file is NOT bundled or transpiled. It is copied verbatim to
 * `lib/client.js` and loaded by the shell's module loader, which is why
 * it is written in the shell's own envelope rather than as an ES module:
 *
 *   window.__ModuleLoader__.load({ id, factory })
 *
 * The envelope, the `require` externals, the `apply`/`inject` exports and
 * the slot API below were all read off the shipped DSH client plugins
 * (`@deepseek-ai/dsh-client-ui-sidebar` and
 * `@deepseek-ai/dsh-client-ui-layout`) rather than inferred:
 *
 *   - the shell calls `exports.apply(ctx)` and reads `exports.inject`
 *   - `inject` uses SHORT service names ("slots"), not package names
 *   - `ctx.slots` is a Cordis service (SlotRegistry) in the browser realm —
 *     the host half has no equivalent
 *   - the sidebar's `sidebar.panellist` is a list slot (kind: 'list'):
 *     each cell is a React component, addressed by `id`, ordered by `order`
 *   - the central column's `main` slot is a keyed slot (kind: 'keyed'):
 *     a cell is selected by `key`, which must equal the sidebar cell's `id`
 *   - `ctx.slots.inject(key, cb)` waits for a slot's declaration; the
 *     callback returns a disposer (or iterable of disposers) that the
 *     registry ties to the caller's fiber
 *
 * Only `react` is required as an external. JSX is deliberately avoided so
 * the file needs no build step and `react/jsx-runtime` is not a second
 * external to get wrong.
 *
 * Data reaches this component over HTTP from the host half's
 * `GET /auto-rd/panel` route (see services/panel-route.ts), because the
 * browser cannot read the host's storageDomain.
 */
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
    var POLL_MS = 5000

    // ---- sidebar icon (cell for the panellist list slot) ------------
    //
    // Owner props come straight from the sidebar package's
    // SidebarPanelIconOwnerProps declaration on `sidebar.panellist`:
    //   { size: number; active: boolean }

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
        h('rect', {
          x: 1.5,
          y: 1.5,
          width: 13,
          height: 13,
          rx: 3,
          stroke: color,
          strokeWidth: 1.25,
        }),
        // A small downward arrow: the pipeline moves work forward.
        h('path', {
          d: 'M8 4.5v5.2M5.8 7.9 8 10.1l2.2-2.2',
          stroke: color,
          strokeWidth: 1.25,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    // ---- panel body ---------------------------------------------------

    function usePanelData() {
      var state = React.useState({ status: 'loading', model: null, text: '', error: '' })
      var value = state[0]
      var setValue = state[1]
      var lastResult = React.useState(null)
      var lastResultValue = lastResult[0]
      var setLastResult = lastResult[1]

      function applyBody(body) {
        // Update local panel state with what the host just sent back
        // from /auto-rd/reconfigure. We treat it as the new authoritative
        // snapshot; the next 5-second poll will reconcile any drift.
        setValue({ status: 'ok', model: body.model, text: body.text || '', error: '' })
        setLastResult(body)
      }

      React.useEffect(function () {
        var alive = true
        function load() {
          fetch(DATA_URL, { headers: { accept: 'application/json' } })
            .then(function (res) {
              if (!res.ok) throw new Error('HTTP ' + res.status)
              return res.json()
            })
            .then(function (body) {
              if (!alive) return
              if (!body || body.ok !== true) throw new Error('panel_unavailable')
              setValue({ status: 'ok', model: body.model, text: body.text || '', error: '' })
            })
            .catch(function (err) {
              if (!alive) return
              setValue(function (prev) {
                return {
                  status: 'error',
                  model: prev.model,
                  text: prev.text,
                  error: String((err && err.message) || err),
                }
              })
            })
        }
        load()
        var timer = setInterval(load, POLL_MS)
        return function () {
          alive = false
          clearInterval(timer)
        }
      }, [])

      return { panel: value, applyBody: applyBody, lastResult: lastResultValue }
    }

    /** One story row. */
    function StoryRow(story) {
      var badgeColor =
        story.state === 'completed'
          ? 'var(--dsw-alias-label-primary)'
          : story.state === 'failed'
            ? '#d9534f'
            : story.state === 'blocked'
              ? '#d19a3f'
              : 'var(--dsw-alias-label-secondary)'
      return h(
        'li',
        { key: story.id, style: { margin: '2px 0', lineHeight: '1.6' } },
        h('span', { style: { color: badgeColor, marginRight: 6 } }, story.badge),
        h('span', { style: { fontFamily: 'var(--ds-font-family-code, monospace)' } }, story.id),
        h('span', { style: { marginLeft: 6 } }, story.title),
        h(
          'span',
          { style: { marginLeft: 6, opacity: 0.65 } },
          '[' + story.state + ']',
        ),
        story.mrUrl
          ? h(
              'a',
              {
                href: story.mrUrl,
                target: '_blank',
                rel: 'noreferrer',
                style: { marginLeft: 6 },
              },
              '[MR]',
            )
          : null,
      )
    }

    function ModuleSection(mod) {
      return h(
        'section',
        { key: mod.id, style: { marginBottom: 16 } },
        h(
          'h4',
          { style: { margin: '0 0 4px', fontSize: 13 } },
          mod.title + ' ',
          h('span', { style: { opacity: 0.6, fontWeight: 400 } }, '(' + mod.id + ')'),
        ),
        mod.stories.length === 0
          ? h('div', { style: { opacity: 0.6, fontSize: 12 } }, 'No stories.')
          : h(
              'ul',
              { style: { margin: '0 0 4px', paddingLeft: 18, fontSize: 12 } },
              mod.stories.map(StoryRow),
            ),
        h(
          'div',
          { style: { opacity: 0.6, fontSize: 11 } },
          mod.overflow > 0
            ? '+' + mod.overflow + ' more (use auto_rd_status to query)'
            : 'target: ' + mod.defaultBranch,
        ),
      )
    }

    /**
     * Setup checklist rendered when the host reports `health.setupRequired`.
     * Each row is the host's diagnosis with a concrete remedy; the UI just
     * pretty-prints it. This is the "missing config" affordance the
     * plugin uses instead of failing the mount.
     *
     * Below the checklist sits a small "live apply" form: the user can
     * edit the missing fields in a textarea and POST to
     * `/auto-rd/reconfigure` to take effect WITHOUT restarting DSH. The
     * route swaps the live config, rebuilds the poller / queue / notifier,
     * and re-seeds module records in one round-trip.
     */
    function SetupChecklist(props) {
      var issues = props.issues
      var onApplied = props.onApplied
      var lastResult = props.lastResult
      if (!issues || issues.length === 0) return null
      return h(
        'section',
        {
          className: 'auto-rd-setup',
          style: {
            marginBottom: 16,
            padding: 12,
            background: 'var(--dsw-alias-surface-warning-subtle, rgba(209,154,63,0.10))',
            border: '1px solid var(--dsw-alias-border-warning, rgba(209,154,63,0.40))',
            borderRadius: 4,
          },
        },
        h(
          'h3',
          { style: { margin: '0 0 4px', fontSize: 13, color: '#d19a3f' } },
          'Setup required',
        ),
        h(
          'div',
          { style: { opacity: 0.7, fontSize: 11, marginBottom: 8 } },
          'The plugin is mounted but not fully configured. Resolve the items below to start polling real work.',
        ),
        h(
          'ol',
          { style: { margin: 0, paddingLeft: 18, fontSize: 12 } },
          issues.map(function (issue) {
            return h(
              'li',
              { key: issue.key, style: { marginBottom: 8 } },
              h(
                'div',
                { style: { marginBottom: 2 } },
                issue.message,
              ),
              h(
                'pre',
                {
                  style: {
                    margin: 0,
                    padding: 8,
                    background: 'rgba(0,0,0,0.05)',
                    borderRadius: 3,
                    fontFamily: 'var(--ds-font-family-code, monospace)',
                    fontSize: 11,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  },
                },
                issue.remedy,
              ),
            )
          }),
        ),
        ReconfigureForm({ issues: issues, onApplied: onApplied, lastResult: lastResult }),
      )
    }

    /**
     * Minimal JSON-config editor that POSTs to /auto-rd/reconfigure.
     *
     * The form is intentionally low-friction:
     *   - a textarea pre-filled with the keys the host diagnosed as missing
     *   - an Apply button that POSTs `{ config: <parsed> }` and re-renders
     *     the panel from the host's response
     *   - a "Copy example" button that drops in a known-good shape so a
     *     first-time user can see what fields exist
     *
     * Tokens never leave the page over the wire in a way that is visible
     * in the browser address bar — they live in the launch shell's env
     * and reach the plugin as `process.env.DSH_TAPD_API_TOKEN` etc. The
     * user is expected to leave those tokens OUT of the textarea and
     * configure them via the launching shell. We do still accept them
     * in the textarea (the host treats any non-empty string as valid);
     * the textarea simply documents this is a debug / unit-test path.
     */
    function ReconfigureForm(props) {
      var lastResult = props.lastResult
      var issues = props.issues

      // Pre-fill with the keys that the host flagged. The user only needs
      // to fill values; we keep the keys visible so they know what fields
      // exist. Values default to empty strings (which the host treats as
      // "still missing"), so the textarea is always a valid JSON shape.
      var templateObj = {}
      for (var i = 0; i < issues.length; i++) {
        var issue = issues[i]
        if (issue.key === 'tapd_token') templateObj.tapdApiToken = ''
        else if (issue.key === 'gitlab_token') templateObj.gitlabApiToken = ''
        else if (issue.key === 'workspace_root') templateObj.workspaceRoot = ''
        else if (issue.key === 'modules') templateObj.modules = []
        else if (issue.key === 'tapd_workspaces') templateObj.tapdWorkspaceIds = []
      }
      var template = JSON.stringify(templateObj, null, 2)

      var state = React.useState(template)
      var text = state[0]
      var setText = state[1]
      var busy = React.useState(false)
      var isBusy = busy[0]
      var setBusy = busy[1]
      var status = React.useState(null)
      var statusValue = status[0]
      var setStatus = status[1]

      // When the host reports a new set of issues (different keys), reset
      // the template so the form stays in sync. We compare keys, not the
      // whole JSON, so the user can edit freely without us stomping.
      var issueKeys = issues.map(function (i) { return i.key }).join(',')
      var lastKeysRef = React.useRef(issueKeys)
      React.useEffect(function () {
        if (lastKeysRef.current !== issueKeys) {
          lastKeysRef.current = issueKeys
          setText(JSON.stringify(templateObj, null, 2))
        }
      }, [issueKeys])

      function fillExample() {
        setText(JSON.stringify(EXAMPLE_CONFIG, null, 2))
      }

      function submit() {
        setStatus(null)
        var parsed
        try {
          parsed = JSON.parse(text)
        } catch (err) {
          setStatus({ kind: 'error', message: 'Invalid JSON: ' + err.message })
          return
        }
        setBusy(true)
        fetch(RECONFIGURE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ config: parsed }),
        })
          .then(function (res) {
            return res.json().then(function (body) {
              return { ok: res.ok, status: res.status, body: body }
            })
          })
          .then(function (result) {
            setBusy(false)
            if (result.ok && result.body && result.body.ok === true) {
              setStatus({
                kind: 'success',
                message: 'Applied. Re-fetching panel data.',
              })
              if (typeof props.onApplied === 'function') props.onApplied(result.body)
            } else if (result.body && result.body.error === 'invalid_config') {
              setStatus({
                kind: 'error',
                message: 'Host rejected the config: ' + JSON.stringify(result.body.issues || result.body.error),
              })
            } else {
              setStatus({
                kind: 'error',
                message: 'HTTP ' + result.status + ': ' + JSON.stringify(result.body),
              })
            }
          })
          .catch(function (err) {
            setBusy(false)
            setStatus({
              kind: 'error',
              message: 'Network error: ' + (err && err.message ? err.message : String(err)),
            })
          })
      }

      return h(
        'div',
        {
          className: 'auto-rd-reconfigure',
          style: {
            marginTop: 12,
            padding: 10,
            background: 'rgba(0,0,0,0.04)',
            borderRadius: 3,
            border: '1px solid rgba(209,154,63,0.25)',
          },
        },
        h(
          'div',
          { style: { fontSize: 12, marginBottom: 6 } },
          'Edit config below and click Apply. The plugin re-reads it without restarting DSH.',
        ),
        h('textarea', {
          value: text,
          onChange: function (e) { setText(e.target.value) },
          disabled: isBusy,
          spellCheck: false,
          style: {
            width: '100%',
            minHeight: 120,
            fontFamily: 'var(--ds-font-family-code, monospace)',
            fontSize: 11,
            padding: 8,
            boxSizing: 'border-box',
            border: '1px solid rgba(0,0,0,0.20)',
            borderRadius: 3,
            background: 'var(--dsw-alias-surface-primary, white)',
            color: 'var(--dsw-alias-label-primary, inherit)',
            resize: 'vertical',
          },
        }),
        h(
          'div',
          { style: { marginTop: 6, display: 'flex', gap: 8 } },
          h(
            'button',
            {
              type: 'button',
              onClick: submit,
              disabled: isBusy,
              style: {
                padding: '4px 12px',
                fontSize: 12,
                cursor: isBusy ? 'wait' : 'pointer',
                background: 'var(--dsw-alias-accent-primary, #4f7c6c)',
                color: 'white',
                border: 'none',
                borderRadius: 3,
              },
            },
            isBusy ? 'Applying…' : 'Apply',
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: fillExample,
              disabled: isBusy,
              style: {
                padding: '4px 12px',
                fontSize: 12,
                cursor: isBusy ? 'wait' : 'pointer',
                background: 'transparent',
                color: 'var(--dsw-alias-label-primary)',
                border: '1px solid rgba(0,0,0,0.20)',
                borderRadius: 3,
              },
            },
            'Fill example',
          ),
        ),
        statusValue
          ? h(
              'div',
              {
                style: {
                  marginTop: 6,
                  fontSize: 11,
                  color:
                    statusValue.kind === 'success'
                      ? 'var(--dsw-alias-label-primary, #2a7f5f)'
                      : '#d9534f',
                },
              },
              statusValue.message,
            )
          : null,
        lastResult && lastResult.newModules && lastResult.newModules.length > 0
          ? h(
              'div',
              { style: { marginTop: 4, fontSize: 11, opacity: 0.75 } },
              'Newly seeded module(s): ',
              lastResult.newModules.map(function (m) { return m.id }).join(', '),
            )
          : null,
      )
    }

    /** A known-good example config the user can paste in as a starting point. */
    var EXAMPLE_CONFIG = {
      tapdBaseUrl: 'https://api.tapd.cn',
      tapdApiToken: '',
      tapdPollIntervalMs: 60000,
      tapdWorkspaceIds: [],
      useTapdMock: true,
      gitlabBaseUrl: 'https://gitlab.com',
      gitlabApiToken: '',
      workspaceRoot: 'C:/work',
      modules: [
        {
          id: 'payment',
          title: 'Payment Service',
          repoUrl: 'https://gitlab.example.com/payment/payment-service.git',
          defaultBranch: 'main',
        },
      ],
      maxConcurrentStoriesPerModule: 1,
      maxTotalConcurrentStories: 4,
      logLevel: 'info',
    }

    /**
     * Live runtime strip rendered when the host supplies `health` info.
     * Shows uptime, last TAPD poll timestamp, and last poll error.
     */
    function HealthStrip(health) {
      if (!health) return null
      var mountedForSec = (health && health.mountedForSec) || 0
      var minutes = Math.floor(mountedForSec / 60)
      var seconds = mountedForSec % 60
      var uptime = minutes > 0 ? minutes + 'm ' + seconds + 's' : seconds + 's'
      var lastPoll = health.lastTapdPollAt
        ? new Date(health.lastTapdPollAt).toLocaleTimeString()
        : '(never)'
      var pollErrorColor = health.lastTapdError ? '#d9534f' : 'inherit'
      return h(
        'div',
        {
          style: {
            marginBottom: 12,
            opacity: 0.75,
            fontSize: 11,
            display: 'flex',
            gap: 16,
            flexWrap: 'wrap',
          },
        },
        h('span', null, 'mounted for ' + uptime),
        h('span', null, 'last TAPD poll: ' + lastPoll),
        health.lastTapdError
          ? h('span', { style: { color: pollErrorColor } }, 'last poll error: ' + health.lastTapdError)
          : null,
      )
    }

    /**
     * The main-column panel body. Registered against the keyed `main` slot
     * with the same key the sidebar entry uses, which is how the shell pairs
     * a sidebar button with its panel. The frame selects the keyed entry by
     * `ctx.layout.selectPanel(id)` — see ui-layout's AppFrame MainPanel.
     */
    function AutoRdPanel() {
      var data = usePanelData()
      var panel = data.panel
      var applyBody = data.applyBody
      var lastResult = data.lastResult
      var totals = (panel.model && panel.model.totals) || null
      var health = (panel.model && panel.model.health) || null

      return h(
        'div',
        {
          className: 'auto-rd-panel',
          style: {
            padding: 16,
            fontSize: 13,
            color: 'var(--dsw-alias-label-primary)',
            overflow: 'auto',
            height: '100%',
            boxSizing: 'border-box',
          },
        },
        h('h3', { style: { margin: '0 0 4px', fontSize: 15 } }, 'Auto-RD Pipeline'),
        health ? HealthStrip(health) : null,
        totals
          ? h(
              'div',
              { style: { marginBottom: 12, opacity: 0.75, fontSize: 12 } },
              totals.modules +
                ' module(s), ' +
                totals.stories +
                ' story(ies) — ' +
                totals.inFlight +
                ' in flight, ' +
                totals.blocked +
                ' blocked, ' +
                totals.completed +
                ' completed, ' +
                totals.failed +
                ' failed',
            )
          : null,
        // Setup checklist is the FIRST thing the user sees when their
        // config is incomplete — even before the modules list. That way
        // a freshly-installed plugin never looks "broken" with an empty
        // list; the user always sees a clear list of what to fix AND a
        // textarea to apply a fix in-place without restarting DSH.
        health && health.setupRequired
          ? SetupChecklist({ issues: health.issues, onApplied: applyBody, lastResult: lastResult })
          : null,
        panel.status === 'error'
          ? h(
              'div',
              { style: { color: '#d9534f', fontSize: 12, marginBottom: 8 } },
              'Panel data unavailable: ' + panel.error,
            )
          : null,
        panel.status === 'loading' && !panel.model
          ? h('div', { style: { opacity: 0.6, fontSize: 12 } }, 'Loading…')
          : null,
        // Only render the modules list when there are modules; the setup
        // checklist already covers the empty case with a richer message.
        panel.model && panel.model.modules.length > 0 ? panel.model.modules.map(ModuleSection) : null,
        panel.model && panel.model.modules.length === 0 && !(health && health.setupRequired)
          ? h('div', { style: { opacity: 0.6, fontSize: 12 } }, 'No modules configured.')
          : null,
      )
    }

    // ---- plugin lifecycle ---------------------------------------------
    //
    // Each `ctx.slots.inject(key, callback)` runs the callback when the slot
    // is declared. The callback's return value is a disposer (or iterable
    // of disposers). The registry ties the disposer to the caller's fiber
    // through a nested Cordis effect, so plugin unload or slot re-declaration
    // removes the cell automatically. We use TWO injects so each is its own
    // effect with its own disposer — one cell collapse does not collapse the
    // other.
    //
    // The `apply` half is also wrapped in `ctx.effect` so a failed cell
    // registration (e.g. main slot missing) does not leave the sidebar cell
    // dangling without its paired body.

    function apply(ctx) {
      // Resolve services defensively. The `inject` declaration below names
      // 'slots', but on hot reload or in a degraded test harness the service
      // may briefly be missing; we surface a clear warning instead of
      // throwing past the fiber.
      var slots = ctx.slots || (typeof ctx.get === 'function' ? ctx.get('slots') : undefined)
      if (!slots) {
        if (ctx.logger) ctx.logger('auto-rd').warn('client slots service unavailable; panel not registered')
        return
      }

      // 1. Sidebar list cell. The cell component renders into the rail/
      //    wide-column row the shell allocates; owner props are
      //    `{ size, active }`. `id`/`order`/`label` are read by the shipped
      //    `ui-sidebar` package to sort rows and show tooltips.
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

      // 2. Main keyed cell. The shell selects this entry whenever the user
      //    activates the sidebar list cell with the same `id` (it routes
      //    through `ctx.layout.selectPanel`). The cell renders into the
      //    centre column without a Session binding — `main` keyed entries
      //    do not receive one — which is fine for a read-only pipeline view.
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

    /**
     * Runtime service inject. SHORT names — the shell resolves them. On the
     * client `slots` really is a service (unlike on the host, where it does
     * not exist at all).
     */
    var inject = ['slots']

    // Public exports consumed by the shell's loader. `_unwrapExports` reads
    // `apply` and `inject` as named properties — there is no `default`.
    var module = {
      apply: apply,
      inject: inject,
    }

    // Exported for the structural tests; harmless to the shell because
    // `_unwrapExports` stops at `apply`/`inject`.
    module.__autoRd = {
      PANEL_SLOT: PANEL_SLOT,
      MAIN_SLOT: MAIN_SLOT,
      PANEL_ID: PANEL_ID,
      PANEL_ORDER: PANEL_ORDER,
      PANEL_LABEL: PANEL_LABEL,
      DATA_URL: DATA_URL,
      components: { AutoRdIcon: AutoRdIcon, AutoRdPanel: AutoRdPanel },
    }

    return module
  },
})