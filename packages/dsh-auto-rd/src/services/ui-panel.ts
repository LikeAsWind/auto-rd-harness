/**
 * UI panel — register the auto-rd sidebar entry.
 *
 * Design doc §7.1: a list-type sidebar entry on the
 * 'sidebar.worktable.project' slot, showing every module + the
 * stories currently in flight.
 *
 * Implementation note: DSH's sidebar renderer runs in the browser
 * process and uses React. The plugin (running in the DSH host Node
 * process) cannot ship a React tree directly; it sends a JSON
 * description that the browser side renders. We do not depend on a
 * React import here -- the renderer returns a plain JS object tree
 * keyed by element type, and the DSH client translates it into
 * React elements.
 *
 * Re-evaluation: the slot registration's renderer is called by DSH
 * whenever the storage changes (DSH observes storage-domain writes
 * and re-renders). We read fresh state from storage on each call.
 * No caching, no subscriptions; correctness > micro-perf.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AutoRdStorage } from '../domain/storage.js'
import type { Logger } from '../utils/logger.js'
import type { SlotsService, SlotRenderer } from '../types/dsh-services.js'

export interface AutoRdPanelDeps {
  storage: AutoRdStorage
  logger: Logger
}

const SLOT_NAME = 'sidebar.worktable.project'
const PANEL_ID = 'auto-rd-modules'
const PANEL_ORDER = 100
const PANEL_LABEL = 'Auto-RD Modules'

/**
 * Element node shape -- intentionally minimal. DSH's slot renderer
 * accepts a JSON tree of `{ type: 'div' | 'span' | 'ul' | ..., props,
 * children }` which the client side maps to React.createElement.
 *
 * We use 'string' leaf nodes for text and a fixed set of element
 * types. Anything more elaborate belongs in a client-side render
 * helper; this file deliberately stays UI-framework-agnostic.
 */
type PanelNode =
  | { type: 'div'; props?: Record<string, unknown>; children: PanelNode[] }
  | { type: 'span'; props?: Record<string, unknown>; children: PanelNode[] }
  | { type: 'h4'; props?: Record<string, unknown>; children: PanelNode[] }
  | { type: 'ul'; props?: Record<string, unknown>; children: PanelNode[] }
  | { type: 'li'; props?: Record<string, unknown>; children: PanelNode[] }
  | { type: 'small'; props?: Record<string, unknown>; children: PanelNode[] }
  | { type: 'a'; props?: { href: string; target?: string }; children: PanelNode[] }
  | string

/**
 * Register the auto-rd panel. Returns true on success, false if the
 * DSH slots service is unavailable. The caller can use the return
 * value to decide whether to surface a console hint.
 */
export function registerAutoRdPanel(ctx: Context, deps: AutoRdPanelDeps): boolean {
  const slots = ctx.get('slots') as SlotsService | undefined
  if (!slots) {
    ctx.logger('auto-rd').warn(
      `slots service not available; ${SLOT_NAME}#${PANEL_ID} will not be registered`,
    )
    return false
  }

  const renderer: SlotRenderer = () => renderPanel(deps)

  slots.register(
    SLOT_NAME,
    {
      id: PANEL_ID,
      order: PANEL_ORDER,
      label: () => PANEL_LABEL,
    },
    renderer,
  )
  ctx.logger('auto-rd').info(`Registered sidebar panel: ${SLOT_NAME}#${PANEL_ID}`)
  return true
}

/**
 * Build the panel tree. Pure function over the storage snapshot.
 * Each section groups stories by module; within a section we list
 * stories by updatedAt desc, capped at 10 to keep the sidebar tidy.
 */
function renderPanel(deps: AutoRdPanelDeps): PanelNode {
  const modules = [...deps.storage.modules().values()]
  const stories = [...deps.storage.stories().values()]
  const storiesByModule = new Map<string, typeof stories>()
  for (const s of stories) {
    const arr = storiesByModule.get(s.moduleId) ?? []
    arr.push(s)
    storiesByModule.set(s.moduleId, arr)
  }

  if (modules.length === 0) {
    return {
      type: 'div',
      children: [
        { type: 'small', children: ['No modules configured.'] },
      ],
    }
  }

  return {
    type: 'div',
    props: { className: 'auto-rd-panel' },
    children: modules.map((m) => renderModuleSection(m, storiesByModule.get(m.id) ?? [])),
  }
}

function renderModuleSection(
  m: { id: string; title: string; repoUrl: string; defaultBranch: string },
  stories: Array<{
    id: string
    title: string
    state: string
    mrUrl?: string
    updatedAt: string
  }>,
): PanelNode {
  stories.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  const visible = stories.slice(0, 10)
  const overflow = stories.length - visible.length

  return {
    type: 'div',
    props: { className: 'auto-rd-module' },
    children: [
      {
        type: 'h4',
        children: [
          { type: 'span', children: [`${m.title} `] },
          { type: 'small', children: [`(${m.id})`] },
        ],
      },
      visible.length === 0
        ? { type: 'small', children: ['No stories.'] }
        : {
            type: 'ul',
            children: visible.map(renderStoryRow),
          },
      overflow > 0
        ? { type: 'small', children: [`+${overflow} more (use auto_rd_status to query)`] }
        : { type: 'small', children: [`target: ${m.defaultBranch}`] },
    ],
  }
}

function renderStoryRow(s: {
  id: string
  title: string
  state: string
  mrUrl?: string
  updatedAt: string
}): PanelNode {
  return {
    type: 'li',
    children: [
      { type: 'span', children: [stateBadge(s.state)] },
      { type: 'span', children: [` ${s.id}: ${s.title}`] },
      s.mrUrl
        ? {
            type: 'a',
            props: { href: s.mrUrl, target: '_blank' },
            children: [' [MR]'],
          }
        : { type: 'small', children: [''] },
    ],
  }
}

/**
 * Render the state as a short badge. The full text is returned so the
 * DSH client can apply its own colour mapping based on the string.
 */
function stateBadge(state: string): string {
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