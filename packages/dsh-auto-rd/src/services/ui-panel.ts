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
import type { AutoRdStorage } from '../domain/storage.js'
import type { Logger } from '../utils/logger.js'
import type { ModuleRecord, StoryRecord } from '../domain/schema.js'

export interface AutoRdPanelDeps {
  storage: AutoRdStorage
  logger: Logger
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
}

const TERMINAL_STATES = new Set(['completed', 'failed'])

/**
 * Build the sidebar model from a storage snapshot.
 *
 * Pure over its inputs so it can be unit-tested without a runtime, and
 * so the same projection can serve a client-side renderer.
 */
export function buildPanelModel(storage: AutoRdStorage): PanelModel {
  const modules: ModuleRecord[] = [...storage.modules().values()]
  const stories: StoryRecord[] = [...storage.stories().values()]

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
      })),
      overflow: Math.max(0, all.length - visible.length),
      inFlight,
    }
  })

  return {
    modules: panelModules,
    totals: {
      modules: modules.length,
      stories: stories.length,
      inFlight: inFlightTotal,
      blocked: blockedTotal,
      completed: completedTotal,
      failed: failedTotal,
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
 */
export function renderPanelText(model: PanelModel): string {
  const lines: string[] = []
  const t = model.totals
  lines.push(
    `Auto-RD: ${t.modules} module(s), ${t.stories} story(ies) — ` +
      `${t.inFlight} in flight, ${t.blocked} blocked, ${t.completed} completed, ${t.failed} failed`,
  )

  if (model.modules.length === 0) {
    lines.push('')
    lines.push('No modules configured.')
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

  if (clientSlotsAvailable) {
    // Unexpected: a `slots` service appeared on the host. Do not guess at
    // its contract — the verified client contract has no host-side
    // renderer parameter, so registering here could corrupt the panel.
    deps.logger.warn(
      `[auto-rd] a host 'slots' service is present, but its contract is unverified; ` +
        `the sidebar panel is intentionally NOT registered from the host. ` +
        `Expected client key: ${CLIENT_PANEL_SLOT}#${CLIENT_PANEL_ID}.`,
    )
  } else {
    deps.logger.info(
      `[auto-rd] sidebar panel is a client-side contribution (${CLIENT_PANEL_SLOT}#${CLIENT_PANEL_ID}); ` +
        `the host renders the same data through the auto_rd_status tool instead`,
    )
  }

  // The host-side surface that always works.
  const model = buildPanelModel(deps.storage)
  const text = renderPanelText(model)
  deps.logger.debug(`[auto-rd] panel snapshot:\n${text}`)

  // Nothing was registered into a UI; report that honestly.
  return false
}
