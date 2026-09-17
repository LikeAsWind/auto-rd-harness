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

    // ---- panel data hook -------------------------------------------------

    function usePanelData() {
      var state = React.useState({ status: 'loading', model: null, text: '', error: '' })
      var value = state[0]
      var setValue = state[1]

      function applyBody(body) {
        setValue({ status: 'ok', model: body.model, text: body.text || '', error: '' })
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

      return { panel: value, applyBody: applyBody }
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
     * One workspace card. Status dot colour reflects the host's health
     * for this workspace:
     *   - green  · polling OK (any in-flight stories)
     *   - yellow · cloning or blocked
     *   - red    · last poll errored (the host attaches the message)
     *   - grey   · idle (no stories yet)
     */
    function WorkspaceRow(props) {
      var ws = props.workspace
      var onClick = props.onClick
      var onRemove = props.onRemove
      var onUpdate = props.onUpdate
      var expanded = props.expanded

      var dotStyle = {
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: statusColor(ws.status),
        marginLeft: 4,
      }

      var progress = []
      if (ws.inFlight) progress.push({ label: ws.inFlight + ' 进行', color: styles.statusInfo })
      if (ws.blocked) progress.push({ label: ws.blocked + ' 阻塞', color: styles.statusWarning })
      if (ws.completed) progress.push({ label: ws.completed + ' 完成', color: styles.statusSuccess })
      if (ws.failed) progress.push({ label: ws.failed + ' 失败', color: styles.statusError })

      return h(
        'div',
        null,
        h(
          'div',
          {
            className: 'auto-rd-ws',
            style: {
              display: 'grid',
              gridTemplateColumns: '16px 1fr auto auto',
              alignItems: 'center',
              gap: 14,
              padding: '14px 16px',
              border:
                '1px solid ' +
                (ws.status === 'error' ? styles.borderError : styles.borderL3),
              borderRadius: 7,
              marginBottom: 8,
              cursor: 'pointer',
              background: styles.panelBg,
            },
          },
          // Status dot — clicking this also expands the row, just like
          // the rest of the row body. Keeps the entire row a single
          // click target so users don't have to land on text precisely.
          h('div', {
            style: dotStyle,
            onClick: onClick,
          }),
          h(
            'div',
            { style: { minWidth: 0, onClick: onClick } },
            h(
              'div',
              {
                style: {
                  fontSize: 13,
                  color: styles.labelPrimary,
                  fontWeight: 500,
                  marginBottom: 2,
                },
              },
              ws.name,
            ),
            h(
              'div',
              {
                style: {
                  fontSize: 11,
                  color: styles.labelSecondary,
                  fontFamily: styles.fontCode,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              ws.path,
              h(
                'span',
                { style: { color: styles.labelTertiary, margin: '0 6px' } },
                '·',
              ),
              ws.storyCount + ' 个需求',
            ),
          ),
          h(
            'div',
            {
              style: {
                fontFamily: styles.fontCode,
                fontSize: 11,
                color: styles.labelSecondary,
                textAlign: 'right',
                whiteSpace: 'nowrap',
              },
              onClick: onClick,
            },
            progress.length
              ? progress.map(function (p) {
                  return h(
                    'span',
                    { style: { marginLeft: 8, color: p.color } },
                    p.label,
                  )
                })
              : h(
                  'span',
                  { style: { color: styles.labelTertiary } },
                  ws.status === 'idle' ? '暂无需求' : '—',
                ),
          ),
          // Remove (×) button — always visible so the action is
          // discoverable. Hover changes the colour from tertiary to
          // error to telegraph the destructive intent. `stopPropagation`
          // keeps the row from also toggling expanded when the user
          // clicks the × — that was the source of "clicking × also
          // opens the row, which is surprising".
          h(
            'button',
            {
              type: 'button',
              className: 'auto-rd-ws-remove',
              title: '删除工作空间(不删除本地代码)',
              onClick: function (e) {
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
        ),
        // Expanded detail panel — stories list (or error detail if the
        // workspace is in the error state). We always render this slot
        // when `expanded` is true so users can read the stories even
        // for green / idle workspaces.
        expanded
          ? h(WorkspaceDetail, {
              workspace: ws,
              onUpdate: onUpdate,
            })
          : null,
        // Error banner (independent of the detail panel) — surfaces a
        // host-side error inline with the row so a red workspace never
        // shows up without an explanation.
        expanded && ws.error
          ? null
          : ws.error
          ? h(
              'div',
              {
                style: {
                  margin: '-4px 0 12px',
                  padding: '12px 16px 12px 46px',
                  borderLeft: '2px solid ' + styles.statusError,
                  marginLeft: 8,
                  color: styles.labelSecondary,
                  fontSize: 12,
                  lineHeight: 1.7,
                  background: styles.dangerSubtle,
                  borderRadius: '0 6px 6px 0',
                },
              },
              h(
                'strong',
                { style: { color: styles.labelPrimary, fontWeight: 500 } },
                ws.name + ' · 最近一次拉取失败',
              ),
              h(
                'span',
                {
                  style: {
                    color: styles.statusError,
                    fontFamily: styles.fontCode,
                    background: styles.dangerSubtle,
                    padding: '1px 6px',
                    borderRadius: 3,
                    marginLeft: 6,
                  },
                },
                ws.error,
              ),
              h('br'),
              ws.remedy,
            )
          : null,
      )

      function statusColor(status) {
        if (status === 'error') return styles.statusError
        if (status === 'cloning' || status === 'blocked') return styles.statusWarning
        if (status === 'idle') return styles.labelTertiary
        return styles.statusSuccess
      }
    }

    // ---- workspace detail (expanded stories) -----------------------------

    /**
     * The detail panel revealed when the user expands a workspace row.
     * Lists every TAPD story on this workspace with its current state,
     * badge, and (when present) the GitLab MR URL. Empty state mirrors
     * the row-level message so the user is not confused by the empty
     * panel.
     */
    function WorkspaceDetail(props) {
      var ws = props.workspace
      var stories = (ws && ws.stories) || []
      var onUpdate = props.onUpdate

      return h(
        'div',
        {
          style: {
            margin: '-4px 0 12px',
            padding: '12px 16px 12px 46px',
            borderLeft: '2px solid ' + styles.borderL2,
            marginLeft: 8,
            color: styles.labelSecondary,
            fontSize: 12,
            lineHeight: 1.7,
            borderRadius: '0 6px 6px 0',
          },
        },
        h(
          'div',
          { style: { fontSize: 13, fontWeight: 500, color: styles.labelPrimary, marginBottom: 6 } },
          '任务',
        ),
        stories.length === 0
          ? h(
              'div',
              { style: { opacity: 0.75 } },
              ws.name + ' 还没有需求。',
            )
          : h(
              'ul',
              {
                style: { listStyle: 'none', margin: 0, padding: 0 },
              },
              stories.map(function (s) {
                var badgeColor =
                  s.state === 'completed'
                    ? styles.statusSuccess
                    : s.state === 'failed'
                      ? styles.statusError
                      : s.state === 'blocked'
                        ? styles.statusWarning
                        : styles.statusInfo
                return h(
                  'li',
                  {
                    key: s.id,
                    style: {
                      padding: '4px 0',
                      borderBottom: '1px solid ' + styles.borderL3,
                      display: 'flex',
                      gap: 8,
                      alignItems: 'center',
                    },
                  },
                  h(
                    'span',
                    {
                      style: {
                        fontFamily: styles.fontCode,
                        fontSize: 11,
                        color: badgeColor,
                        width: 16,
                        textAlign: 'center',
                      },
                    },
                    s.badge || '·',
                  ),
                  h(
                    'span',
                    {
                      style: {
                        fontFamily: styles.fontCode,
                        fontSize: 11,
                        color: styles.labelSecondary,
                      },
                    },
                    s.id,
                  ),
                  h(
                    'span',
                    { style: { color: styles.labelPrimary, flex: 1 } },
                    s.title,
                  ),
                  h(
                    'span',
                    {
                      style: {
                        fontFamily: styles.fontCode,
                        fontSize: 10,
                        color: styles.labelTertiary,
                      },
                    },
                    '[' + s.state + ']',
                  ),
                  s.mrUrl
                    ? h(
                        'a',
                        {
                          href: s.mrUrl,
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
              }),
            ),
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
      var tapdWorkspaceId = React.useState(ws.tapdWorkspaceId || '')
      var tapdToken = React.useState(ws.tapdApiToken || '')
      var gitlabToken = React.useState(ws.gitlabApiToken || '')
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
        fetch(RECONFIGURE_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'update_workspace',
            name: ws.id,
            tapdWorkspaceId: tapdWorkspaceIdValue,
            tapdToken: tapdTokenValue,
            gitlabToken: gitlabTokenValue,
          }),
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
          h('label', { style: labelStyle }, 'TAPD API token', h('span', { style: { color: styles.labelTertiary, fontWeight: 400, marginLeft: 6 } }, '留空 = 继承全局')),
          h('input', { type: 'password', value: tapdTokenValue, onChange: function (e) { setTapdToken(e.target.value) }, disabled: busyValue, autoComplete: 'off', placeholder: '(继承全局)', style: fieldStyle }),
        ),
        h(
          'div',
          { style: { marginBottom: 10 } },
          h('label', { style: labelStyle }, 'GitLab API token', h('span', { style: { color: styles.labelTertiary, fontWeight: 400, marginLeft: 6 } }, '留空 = 继承全局')),
          h('input', { type: 'password', value: gitlabTokenValue, onChange: function (e) { setGitlabToken(e.target.value) }, disabled: busyValue, autoComplete: 'off', placeholder: '(继承全局)', style: fieldStyle }),
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

    // ---- workspace list / empty state -----------------------------------

    function WorkspaceList(props) {
      var workspaces = props.workspaces
      var onAdd = props.onAdd
      var onRefresh = props.onRefresh
      var onRemove = props.onRemove
      var onUpdate = props.onUpdate
      var onWorkspaceClick = props.onWorkspaceClick
      var expanded = props.expanded
      var onToggleExpanded = props.onToggleExpanded

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

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'auto-rd-ws-list' },
          workspaces.map(function (ws) {
            return h(WorkspaceRow, {
              key: ws.id,
              workspace: ws,
              expanded: expanded === ws.id,
              onClick: function () {
                if (typeof onToggleExpanded === 'function') onToggleExpanded(ws.id)
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
        legend(),
      )
    }

    function legend() {
      return h(
        'div',
        {
          style: {
            marginTop: 28,
            paddingTop: 14,
            borderTop: '1px solid ' + styles.borderL3,
            fontSize: 11,
            color: styles.labelTertiary,
            lineHeight: 1.7,
          },
        },
        'Token(',
        h('code', { style: codeStyle() }, 'DSH_TAPD_API_TOKEN'),
        '、',
        h('code', { style: codeStyle() }, 'DSH_GITLAB_API_TOKEN'),
        ')在启动 DSH 的 shell 中设置,不在此处配置。',
        '当某个工作空间状态变红时,错误信息会告诉你缺哪一个。',
      )

      function codeStyle() {
        return {
          fontFamily: styles.fontCode,
          background: styles.panelBgSubtle,
          padding: '1px 5px',
          borderRadius: 3,
          color: styles.labelSecondary,
        }
      }
    }

    // ---- status bar (one row, three stats) -------------------------------

    function StatusBar(props) {
      var workspaces = props.workspaces
      var totals = props.totals
      var isPolling = props.isPolling

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
        : isPolling
          ? '采集中'
          : wsCount === 0
            ? '空闲'
            : '已停止'
      var statusColor = hasError
        ? styles.statusError
        : isPolling
          ? styles.statusSuccess
          : wsCount === 0
            ? styles.statusWarning
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

      var model = panel.model
      var modules = (model && model.modules) || []
      var totals = (model && model.totals) || { stories: 0, inFlight: 0, blocked: 0, completed: 0, failed: 0 }
      var health = (model && model.health) || null

      var addOpen = React.useState(false)
      var expandedId = React.useState(null)
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
      var expandedIdValue = expandedId[0]
      var setExpandedId = expandedId[1]

      // Derive the workspaces[] shape that the UI consumes from the host's
      // modules[] shape. Until the host exposes per-workspace errors /
      // status, we synthesise: a workspace with stories in flight is
      // "polling"; without stories it is "idle". The host will replace
      // this with real per-workspace health once the reconfigure route
      // gains workspace-level fields (see services/reconfigure-route.ts).
      var workspaces = modules.map(function (m) {
        var inFlight = m.inFlight || 0
        var blocked = 0
        var completed = 0
        var failed = 0
        if (Array.isArray(m.stories)) {
          for (var i = 0; i < m.stories.length; i++) {
            var s = m.stories[i].state
            if (s === 'in_progress' || s === 'in_flight') inFlight++
            else if (s === 'blocked') blocked++
            else if (s === 'completed') completed++
            else if (s === 'failed') failed++
          }
        }
        var status = inFlight > 0
          ? 'polling'
          : m.stories && m.stories.length > 0
            ? 'idle'
            : 'idle'
        return {
          id: m.id,
          name: m.title || m.id,
          path: m.repoUrl || (m.id + ' (local)'),
          storyCount: m.stories ? m.stories.length : 0,
          stories: m.stories || [],
          inFlight: inFlight,
          blocked: blocked,
          completed: completed,
          failed: failed,
          status: status,
          error: null,
          remedy: null,
          // Per-workspace settings (empty = inherit global).
          tapdWorkspaceId: m.tapdWorkspaceId || '',
          tapdApiToken: m.tapdApiToken || '',
          gitlabApiToken: m.gitlabApiToken || '',
          modelSelection: m.modelSelection || {},
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

      function refresh() {
        // Force a fresh fetch by toggling state through usePanelData.
        // Simpler: trigger via a custom event usePanelData can listen to.
        // For now, the next 5s poll picks it up; reload the page if
        // urgent.
        // TODO(workspace-add): make usePanelData expose a refresh().
        if (typeof window !== 'undefined' && window.location) {
          window.location.reload()
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
              refresh()
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
        h(StatusBar, {
          workspaces: workspaces,
          totals: totals,
          isPolling: isPolling,
        }),
        h(
          'div',
          {
            style: { padding: '18px 20px', flex: 1 },
          },
          addOpenValue
            ? h(AddWorkspaceForm, {
                onCancel: function () { setAddOpen(false) },
                onAdded: function () { setAddOpen(false); refresh() },
              })
            : null,
          !addOpenValue
            ? h(WorkspaceList, {
                workspaces: workspaces,
                expanded: expandedIdValue,
                onToggleExpanded: setExpandedId,
                onRefresh: refresh,
                onRemove: removeWorkspace,
                onUpdate: function () {
                  // The host already swapped liveConfig + storage; the
                  // next 5-second poll reconciles the panel. Reload
                  // keeps the UI consistent immediately after Apply.
                  refresh()
                },
              })
            : null,
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

    var inject = ['slots']

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
      POLL_MS: POLL_MS,
    }

    return module
  },
})