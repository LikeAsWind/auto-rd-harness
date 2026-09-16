/**
 * auto-rd client half — the sidebar panel and its main-panel body.
 *
 * This file is NOT bundled or transpiled. It is copied verbatim to
 * `lib/client.js` and loaded by the shell's module loader, which is why
 * it is written in the shell's own envelope rather than as an ES module:
 *
 *   window.__ModuleLoader__.load({
 *     id: "<package name>",
 *     factory: (require) => { ... return module.exports }
 *   })
 *
 * The envelope, the `require` externals, the `apply`/`inject` exports and
 * the slot API below were all read off an installed shipped client plugin
 * (`@deepseek-ai/dsh-client-ui-sidebar`) rather than inferred:
 *
 *   - the shell calls `exports.apply(ctx)` and reads `exports.inject`
 *   - `inject` uses SHORT service names ("slots"), not package names
 *   - `ctx.slots` is a Cordis service in the browser realm — this is the
 *     service the host half cannot reach, which is why the panel is split
 *     across two realms at all
 *   - a slot is filled with
 *       ctx.slots.register({ name, id?, key?, order?, label? }, Component)
 *   - `ctx.slots.inject(key, cb)` waits for a slot's declaration and then
 *     runs `cb`, which is how a third-party panel safely fills a slot it
 *     does not itself declare
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
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement

    /** Slot ids. Kept in sync with services/ui-panel.ts by a test. */
    var PANEL_SLOT = 'sidebar.panellist'
    var MAIN_SLOT = 'main'
    var PANEL_ID = 'auto-rd-modules'
    var PANEL_ORDER = 100
    var PANEL_LABEL = 'Auto-RD'
    var DATA_URL = '/auto-rd/panel'
    var POLL_MS = 5000

    // ---- sidebar icon -------------------------------------------------

    /**
     * The sidebar row's icon. Owner props are `{ size, active }`
     * (SidebarPanelIconOwnerProps).
     */
    function AutoRdIcon(props) {
      var size = (props && props.size) || 16
      var active = !!(props && props.active)
      var color = active ? 'currentColor' : 'currentColor'
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

      return value
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
     * The main-column panel body. Registered against the keyed `main` slot
     * with the same id the sidebar entry uses, which is how the shell pairs
     * a sidebar button with its panel.
     */
    function AutoRdPanel() {
      var data = usePanelData()
      var totals = (data.model && data.model.totals) || null

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
        data.status === 'error'
          ? h(
              'div',
              { style: { color: '#d9534f', fontSize: 12, marginBottom: 8 } },
              'Panel data unavailable: ' + data.error,
            )
          : null,
        data.status === 'loading' && !data.model
          ? h('div', { style: { opacity: 0.6, fontSize: 12 } }, 'Loading…')
          : null,
        data.model && data.model.modules.length === 0
          ? h('div', { style: { opacity: 0.6, fontSize: 12 } }, 'No modules configured.')
          : null,
        data.model ? data.model.modules.map(ModuleSection) : null,
      )
    }

    // ---- plugin lifecycle ---------------------------------------------

    /**
     * Called by the shell with the client Cordis context.
     *
     * Both registrations go through `ctx.slots.inject` so they are queued
     * until the owning slot exists and are torn down with this plugin's
     * fiber. Registering directly would throw if this plugin happened to
     * apply before the sidebar declares `sidebar.panellist`.
     */
    function apply(ctx) {
      var slots = ctx.slots || ctx.get('slots')
      if (!slots) {
        // Nothing sensible to do; the shell always provides it because
        // `inject` below declares it. Log once and stop.
        if (ctx.logger) ctx.logger('auto-rd').warn('client slots service unavailable; panel not registered')
        return
      }

      // 1. The sidebar entry (a list slot: fill with id + order + label).
      ctx.slots.inject(PANEL_SLOT, function () {
        return slots.register(
          { name: PANEL_SLOT, id: PANEL_ID, order: PANEL_ORDER, label: PANEL_LABEL },
          AutoRdIcon,
        )
      })

      // 2. The main-column body (a keyed slot: fill with key).
      ctx.slots.inject(MAIN_SLOT, function () {
        return slots.register({ name: MAIN_SLOT, key: PANEL_ID }, AutoRdPanel)
      })
    }

    /**
     * Runtime service inject. SHORT names — the shell resolves them. On the
     * client `slots` really is a service (unlike on the host, where it does
     * not exist at all).
     */
    var inject = ['slots']

    exports.apply = apply
    exports.inject = inject
    // Exported for the structural tests; harmless to the shell.
    exports.__autoRd = {
      PANEL_SLOT: PANEL_SLOT,
      MAIN_SLOT: MAIN_SLOT,
      PANEL_ID: PANEL_ID,
      PANEL_ORDER: PANEL_ORDER,
      PANEL_LABEL: PANEL_LABEL,
      DATA_URL: DATA_URL,
      components: { AutoRdIcon: AutoRdIcon, AutoRdPanel: AutoRdPanel },
    }
    return module.exports
  },
})
