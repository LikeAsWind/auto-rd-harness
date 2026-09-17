/**
 * UI panel — the auto-rd sidebar surface.
 *
 * Design doc §7.1 asks for a list-type sidebar entry showing every
 * module and the stories in flight. Two facts about the real DSH runtime
 * decide how much of that this plugin can do, and both were verified
 * against the live slot registry rather than assumed:
 *
 *   1. Slots are a CLIENT-realm concept. The host service catalog has no
 *      `slots` key; the `Slots` inspect provider lives on the client.
 *      A host-only Node plugin cannot register into a slot.
 *
 *   2. A list slot's cell is a React component. Its registration
 *      metadata is only `{ id, order?, label? }`, and the cell receives
 *      typed owner props plus injected hooks — for `sidebar.panellist`
 *      (`"Global panel icons. Each list id addresses the matching main
 *      panel"`) the owner props are
 *      `SidebarPanelIconOwnerProps { size: number; active: boolean }`.
 *      There is no "renderer function" parameter, and no JSON element
 *      tree is accepted. An earlier revision of this file passed a
 *      renderer as a third argument to `slots.register`, which the real
 *      API does not have.
 *
 * So this module does NOT pretend to render. Instead it:
 *
 *   - keeps `buildPanelModel()`, the pure data projection the sidebar
 *     needs (modules -> stories -> state badge). It is host-side,
 *     framework-free and fully testable, and a client contribution can
 *     consume the same shape.
 *   - exposes `renderPanelText()`, a plain-text rendering of that model.
 *     This is what the host CAN produce, and it is what the
 *     `auto_rd_status` tool returns, so the information is reachable
 *     from the conversation even without a client plugin.
 *   - reports precisely, once at mount, that the sidebar panel requires
 *     a client-side contribution, instead of silently registering
 *     something that would never appear.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../config.js'
import type { AutoRdStorage } from '../domain/storage.js'
import type { Logger } from '../utils/logger.js'
import type { ModuleRecord, StoryRecord } from '../domain/schema.js'

export interface AutoRdPanelDeps {
  storage: AutoRdStorage
  logger: Logger
  /**
   * Current parsed + normalized config. Optional — when provided, the
   * panel surfaces a "setup checklist" derived from it. When omitted
   * (legacy callers, unit tests) the panel skips the checklist.
   */
  config?: Config
}

/** How many stories to show per module before summarising the rest. */
export const PANEL_STORY_LIMIT = 10

export interface PanelStory {
  id: string
  title: string
  state: string
  mrUrl?: string
  updatedAt: string
  badge: string
  /**
   * Story detail fields, mirrored from StoryRecord so the client can
   * render a read-only detail view without another round trip. Empty
   * values (never undefined) when the pipeline has not filled them in
   * yet — the client renders "尚未创建" rather than guessing.
   */
  branch: string
  worktreePath: string
  mainSessionId: string
  acceptanceCriteria: string
  blockedReason: string
  /** Newest-last artifact refs, ready for a timeline. */
  artifacts: PanelArtifactRef[]
}

/** Flattened ArtifactRef: kind, filename, when it was written. */
export interface PanelArtifactRef {
  kind: string
  filename: string
  createdAt: string
}

export interface PanelModule {
  id: string
  title: string
  defaultBranch: string
  stories: PanelStory[]
  /** Count hidden by PANEL_STORY_LIMIT. */
  overflow: number
  /** Stories that are neither completed nor failed. */
  inFlight: number
  /**
   * Per-workspace settings, surfaced to the client so the expanded
   * workspace panel can offer an edit form. Tokens are never sent to
   * the browser — only whether one is configured, mirroring how the
   * shell's own settings UI treats model API keys (describe(ref) says
   * `configured`, never the value). Empty booleans mean "inherit the
   * global config" (see services/story-runner.ts + tapd-poller.ts).
   */
  tapdWorkspaceId?: string
  tapdTokenConfigured?: boolean
  gitlabTokenConfigured?: boolean
  modelSelection?: Record<string, string>
}

/**
 * One setup-checklist row. Each row tells the user (or a CI runner
 * inspecting the panel JSON) what is missing or wrong in the plugin
 * config. The client renders these as a friendly checklist; the host
 * uses them to flag unhealthy deployments.
 */
export interface PanelSetupIssue {
  /** Stable identifier so the client can de-duplicate or key off it. */
  key:
    | 'tapd_token'
    | 'gitlab_token'
    | 'workspace_root'
    | 'modules'
    | 'tapd_workspaces'
  /** Human-readable short message ("Set DSH_TAPD_API_TOKEN to fetch real stories"). */
  message: string
  /** Suggested fix — usually a `cordis.patch.yml` edit or an env var. */
  remedy: string
}

export interface PanelHealth {
  /**
   * True when the panel JSON returned at least one setup issue. The
   * client uses this to decide whether to render the checklist section.
   */
  setupRequired: boolean
  issues: PanelSetupIssue[]
  /** Plugin uptime in seconds since mount. */
  mountedForSec: number
  /** ISO timestamp at which the plugin last polled TAPD, or null. */
  lastTapdPollAt: string | null
  /** Last TapdPoller error message, if any. */
  lastTapdError: string | null
}

export interface PanelModel {
  modules: PanelModule[]
  totals: {
    modules: number
    stories: number
    inFlight: number
    blocked: number
    completed: number
    failed: number
  }
  health: PanelHealth
}

const TERMINAL_STATES = new Set(['completed', 'failed'])

/**
 * Compute the "what is missing" checklist from the current config.
 *
 * Every entry corresponds to a single concrete user action:
 *   - set DSH_TAPD_API_TOKEN (or paste a token into cordis.yml)
 *   - set DSH_GITLAB_API_TOKEN
 *   - set `workspaceRoot`
 *   - add at least one module under `modules:`
 *   - add at least one workspace id when not in mock mode
 *
 * Empty array = plugin is fully configured and polling for real.
 */
export function buildSetupIssues(config: Config | undefined): PanelSetupIssue[] {
  if (!config) return []
  const issues: PanelSetupIssue[] = []

  if (!config.tapdApiToken || config.tapdApiToken.trim() === '') {
    issues.push({
      key: 'tapd_token',
      message: 'TAPD token is empty — the poller is running against a local mock fixture.',
      remedy:
        'Set the DSH_TAPD_API_TOKEN env var in the shell that launches DSH, ' +
        'or paste a real token into cordis.patch.yml under the TAPD token field.',
    })
  }

  if (!config.gitlabApiToken || config.gitlabApiToken.trim() === '') {
    issues.push({
      key: 'gitlab_token',
      message: 'GitLab token is empty — MR creation will fail per story.',
      remedy:
        'Set the DSH_GITLAB_API_TOKEN env var, or paste a real token with `api` scope into ' +
        'cordis.patch.yml under the GitLab token field.',
    })
  }

  if (!config.workspaceRoot || config.workspaceRoot.trim() === '') {
    issues.push({
      key: 'workspace_root',
      message: 'workspaceRoot is empty — module repos cannot be cloned.',
      remedy:
        'Set an absolute path under config.workspaceRoot in cordis.patch.yml, ' +
        'e.g. `workspaceRoot: "C:/work"`.',
    })
  }

  if ((config.modules ?? []).length === 0) {
    issues.push({
      key: 'modules',
      message: 'modules is empty — TAPD stories cannot be routed to a repo.',
      remedy:
        'Add at least one module under config.modules in cordis.patch.yml. ' +
        'Example:\n' +
        '  modules:\n' +
        '    - id: payment\n' +
        '      title: Payment Service\n' +
        '      repoUrl: https://gitlab.example.com/payment/payment-service.git\n' +
        '      defaultBranch: main',
    })
  }

  // Read through defaults rather than the declared types: these fields
  // only acquire their Zod defaults when the config was parsed, and the
  // panel is also handed configs assembled by hand.
  if (
    !config.useTapdMock &&
    (config.tapdApiToken ?? '').length > 0 &&
    (config.tapdWorkspaceIds ?? []).length === 0
  ) {
    issues.push({
      key: 'tapd_workspaces',
      message: 'TAPD token is set but tapdWorkspaceIds is empty — the poller has nothing to route to.',
      remedy:
        'Add at least one TAPD workspace id under config.tapdWorkspaceIds in cordis.patch.yml, ' +
        'or temporarily set `useTapdMock: true` to develop offline.',
    })
  }

  return issues
}

/**
 * Build the sidebar model from a storage snapshot.
 *
 * Pure over its inputs so it can be unit-tested without a runtime, and
 * so the same projection can serve a client-side renderer.
 */
export function buildPanelModel(
  storage: AutoRdStorage,
  config?: Config,
  runtime?: { mountedAt: Date; lastTapdPollAt: Date | null; lastTapdError: string | null },
): PanelModel {
  // Module ids come from `config.modules` (the live source of truth),
  // not from storage. Two reasons:
  //
  //   1. DSH restarts wipe `liveConfig.current` but leave storage
  //      intact, so storage can carry "orphan" records from a previous
  //      run that the user did not expect to see again. The live
  //      config is the user-visible contract.
  //
  //   2. `add_workspace` / `remove_workspace` both mutate
  //      `liveConfig.current.modules` and storage in lock-step, so
  //      reading modules from config is consistent with the routes the
  //      UI talks to. The UI then never disagrees with the host.
  //
  // Stories still come from storage (they are stored keyed by moduleId,
  // and the live config does not duplicate them).
  const configModules = (config && config.modules) || []
  const configModuleIds = new Set(configModules.map((m) => m.id))
  const moduleRecordsById = new Map<string, ModuleRecord>()
  for (const m of storage.modules().values()) {
    moduleRecordsById.set(m.id, m)
  }
  const modules: ModuleRecord[] = configModules.map((m) => {
    const stored = moduleRecordsById.get(m.id)
    if (stored) return stored
    // Synthesize a minimal record from the config entry when the
    // storage layer doesn't have one (e.g. a workspace that was
    // added by the UI but whose storage write failed). Title /
    // repoUrl / defaultBranch come straight from config.
    return {
      id: m.id,
      title: m.title,
      repoUrl: m.repoUrl,
      defaultBranch: m.defaultBranch,
      workspacePath: '',
      createdAt: '',
    } as ModuleRecord
  })
  // Filter orphan stories whose moduleId is not in the live config.
  // They would otherwise show up under a module id the UI does not
  // know about, breaking the per-module grouping. `remove_workspace`
  // now deletes a module's stories with it, so orphans only come from
  // pre-cleanup storage — totals count them so a leftover pile stays
  // visible instead of silently vanishing from every number.
  const stories: StoryRecord[] = [...storage.stories().values()].filter((s) =>
    configModuleIds.has(s.moduleId),
  )

  const byModule = new Map<string, StoryRecord[]>()
  for (const s of stories) {
    const arr = byModule.get(s.moduleId) ?? []
    arr.push(s)
    byModule.set(s.moduleId, arr)
  }

  let inFlightTotal = 0
  let blockedTotal = 0
  let completedTotal = 0
  let failedTotal = 0

  const panelModules: PanelModule[] = modules.map((m) => {
    const all = [...(byModule.get(m.id) ?? [])].sort((a, b) =>
      a.updatedAt < b.updatedAt ? 1 : -1,
    )
    const inFlight = all.filter((s) => !TERMINAL_STATES.has(s.state)).length
    inFlightTotal += inFlight
    blockedTotal += all.filter((s) => s.state === 'blocked').length
    completedTotal += all.filter((s) => s.state === 'completed').length
    failedTotal += all.filter((s) => s.state === 'failed').length

    const visible = all.slice(0, PANEL_STORY_LIMIT)
    return {
      id: m.id,
      title: m.title,
      defaultBranch: m.defaultBranch,
      stories: visible.map((s) => ({
        id: s.id,
        title: s.title,
        state: s.state,
        mrUrl: s.mrUrl,
        updatedAt: s.updatedAt,
        badge: stateBadge(s.state),
        branch: s.branch ?? '',
        worktreePath: s.worktreePath ?? '',
        mainSessionId: s.mainSessionId ?? '',
        acceptanceCriteria: s.acceptanceCriteria ?? '',
        blockedReason: s.blockedReason ?? '',
        // Record insertion order is arbitrary; the timeline reads in
        // chronological order.
        artifacts: Object.values(s.artifacts ?? {}).sort((a, b) =>
          a.createdAt < b.createdAt ? -1 : 1,
        ),
      })),
      overflow: Math.max(0, all.length - visible.length),
      inFlight,
      // Per-workspace settings (empty = inherit global). Token values
      // stay in the host; the client only learns whether one exists.
      tapdWorkspaceId: m.tapdWorkspaceId ?? '',
      tapdTokenConfigured: (m.tapdApiToken ?? '').length > 0,
      gitlabTokenConfigured: (m.gitlabApiToken ?? '').length > 0,
      modelSelection: m.modelSelection ?? {},
    }
  })

  const issues = buildSetupIssues(config)
  const mountedAt = runtime?.mountedAt ?? new Date()
  const mountedForSec = Math.max(0, Math.floor((Date.now() - mountedAt.getTime()) / 1000))

  // Stories total counts everything in storage — grouped and orphan —
  // so the number never silently drops what the module sections cannot
  // place. (Orphans come from storage written before remove_workspace
  // learned to delete a module's stories; the count keeps that pile
  // visible.)
  const totalStories = [...storage.stories().values()].length

  return {
    modules: panelModules,
    totals: {
      modules: modules.length,
      stories: totalStories,
      inFlight: inFlightTotal,
      blocked: blockedTotal,
      completed: completedTotal,
      failed: failedTotal,
    },
    health: {
      setupRequired: issues.length > 0,
      issues,
      mountedForSec,
      lastTapdPollAt: runtime?.lastTapdPollAt?.toISOString() ?? null,
      lastTapdError: runtime?.lastTapdError ?? null,
    },
  }
}

/** Short glyph for a state. The client maps these to colours. */
export function stateBadge(state: string): string {
  switch (state) {
    case 'completed':
      return '\u2713'
    case 'failed':
      return '\u2717'
    case 'blocked':
      return '\u26A0'
    case 'pending':
      return '\u00B7'
    case 'implementing':
    case 'testing':
    case 'fixing':
    case 'verifying':
    case 'reviewing':
    case 'final_verifying':
    case 'mr_creating':
    case 'tapd_syncing':
      return '\u21BB'
    default:
      return '\u00B7'
  }
}

/**
 * Plain-text rendering of the panel model. This is the host-side
 * substitute for the graphical sidebar: the same information, reachable
 * from the conversation.
 *
 * When the model carries a setup-required health block, the rendering
 * surfaces it first so the user (or the model) immediately sees what
 * is missing without having to read the JSON health field.
 */
export function renderPanelText(model: PanelModel): string {
  const lines: string[] = []
  const t = model.totals

  // Uptime + last poll (cheap and useful for debugging).
  const h = model.health
  const uptimeMin = Math.floor(h.mountedForSec / 60)
  const uptimeSec = h.mountedForSec % 60
  const uptime = uptimeMin > 0 ? `${uptimeMin}m ${uptimeSec}s` : `${uptimeSec}s`
  const lastPoll = h.lastTapdPollAt ? h.lastTapdPollAt : '(never)'
  const lastErr = h.lastTapdError ? `, last error: ${h.lastTapdError}` : ''
  lines.push(`Auto-RD: mounted for ${uptime}, last TAPD poll: ${lastPoll}${lastErr}`)

  if (h.setupRequired && h.issues.length > 0) {
    lines.push('')
    lines.push(`Setup required (${h.issues.length} issue${h.issues.length === 1 ? '' : 's'}):`)
    for (const issue of h.issues) {
      lines.push(`  - [${issue.key}] ${issue.message}`)
    }
  }

  lines.push(
    `Modules: ${t.modules}, stories: ${t.stories} — ` +
      `${t.inFlight} in flight, ${t.blocked} blocked, ${t.completed} completed, ${t.failed} failed`,
  )

  if (model.modules.length === 0) {
    if (!h.setupRequired) {
      lines.push('')
      lines.push('No modules configured.')
    }
    return lines.join('\n')
  }

  for (const m of model.modules) {
    lines.push('')
    lines.push(`${m.title} (${m.id}) — target: ${m.defaultBranch}`)
    if (m.stories.length === 0) {
      lines.push('  no stories')
      continue
    }
    for (const s of m.stories) {
      const mr = s.mrUrl ? ` [MR](${s.mrUrl})` : ''
      lines.push(`  ${s.badge} ${s.id}: ${s.title} [${s.state}]${mr}`)
      if (s.branch) lines.push(`      branch: ${s.branch}`)
      if (s.blockedReason) lines.push(`      blocked: ${s.blockedReason}`)
    }
    if (m.overflow > 0) {
      lines.push(`  +${m.overflow} more (query with auto_rd_status)`)
    }
  }
  return lines.join('\n')
}

/**
 * The slots key a client contribution would register the panel under.
 *
 * Exported as data rather than used for a host-side registration: the
 * `main` keyed slot dispatches on the same id, so a client half that
 * registers `sidebar.panellist#auto-rd-modules` gets both the sidebar
 * button and the main panel for free.
 */
export const CLIENT_PANEL_SLOT = 'sidebar.panellist'
export const CLIENT_PANEL_ID = 'auto-rd-modules'
export const CLIENT_PANEL_ORDER = 100
export const CLIENT_PANEL_LABEL = 'Auto-RD'

/**
 * Report the sidebar situation once, precisely.
 *
 * Returns a snapshot provider the caller can use (the tools already
 * expose the same data), and logs the exact reason the graphical panel
 * is not registered from here.
 */
export function registerAutoRdPanel(ctx: Context, deps: AutoRdPanelDeps): boolean {
  const clientSlotsAvailable = ctx.get('slots' as never) as unknown
  // `deps.logger` is the plugin's own Logger, which already resolves the
  // host channel defensively; use it rather than ctx.logger directly.
  const log = deps.logger

  if (clientSlotsAvailable) {
    // Unexpected: a `slots` service appeared on the host. Do not guess at
    // its contract — the verified client contract has no host-side
    // renderer parameter, so registering here could corrupt the panel.
    log.warn(
      `a host 'slots' service is present, but its contract is unverified; ` +
        `the sidebar panel is intentionally NOT registered from the host. ` +
        `Expected client key: ${CLIENT_PANEL_SLOT}#${CLIENT_PANEL_ID}.`,
    )
  } else {
    log.info(
      `sidebar panel is a client-side contribution (${CLIENT_PANEL_SLOT}#${CLIENT_PANEL_ID}); ` +
        `the host renders the same data through the auto_rd_status tool instead`,
    )
  }

  // The host-side surface that always works.
  const model = buildPanelModel(deps.storage)
  const text = renderPanelText(model)
  log.debug(`panel snapshot:\n${text}`)

  // Nothing was registered into a UI; report that honestly.
  return false
}
