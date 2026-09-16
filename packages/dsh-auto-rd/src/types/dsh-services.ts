/**
 * Type declarations for the DSH Host services the auto-rd plugin consumes.
 *
 * Why a local copy?
 *   The DSH host process provides these services, but the distribution
 *   does not export them as a public npm package. Importing from
 *   `@deepseek-ai/dsh-*` here would resolve only when this package is
 *   built inside the DSH monorepo; in standalone builds (CI on GitHub)
 *   the imports would fail.
 *
 *   The shapes below are NOT guesses. They were taken from the live
 *   runtime's service catalog via the Cordis Inspect `Service` provider
 *   (host platform) and trimmed to the members this plugin calls. Keep
 *   them in sync with that source of truth rather than with what the
 *   call sites happen to assume.
 *
 * Scope note — Slots are CLIENT-ONLY:
 *   The host service catalog contains no `slots` key. Slot registration
 *   happens in the browser realm, and a slot's cell is a React
 *   component that receives typed owner props plus injected hooks (for
 *   `sidebar.panellist`, `SidebarPanelIconOwnerProps { size, active }`).
 *   A host-only Node plugin therefore cannot register a sidebar panel
 *   itself; see services/ui-panel.ts for how this plugin handles that.
 */

// ---- storageDomain ----------------------------------------------------

/**
 * A key/value table as exposed by `Domain.table()`.
 *
 * NOTE: there is deliberately no `values()` method — the real table
 * exposes `entries()` / `keys()` / `size`. `AutoRdStorage` adds a
 * `values()` convenience on its own adapter; do not assume it here.
 */
export interface KvTable<K extends string = string, V = unknown> {
  get(key: K): V | undefined
  entries(): IterableIterator<[K, V]>
  keys(): IterableIterator<K>
  readonly size: number
  put(key: K, value: V): Promise<void>
  delete(key: K): Promise<boolean>
  update(key: K, fn: (current: V) => V): Promise<V>
}

export interface DomainTableSpec<K extends string = string, V = unknown> {
  readonly valueSchema: unknown
  readonly __key?: K
}

export interface DomainSpec {
  readonly name: string
  readonly version: number
  /** Note: `'single'`, not `'single-file'`. */
  readonly layout?: 'single' | 'per-record'
  readonly compatibleVersions?: readonly number[]
  readonly invalidRecords?: 'backup-and-skip'
  readonly tables: Record<string, DomainTableSpec>
}

export interface Domain {
  readonly name: string
  table<N extends string = string, V = unknown>(name: N): KvTable<string, V>
  close(): Promise<void>
}

/**
 * The `storageDomain` facility.
 *
 * IMPORTANT: `open()` is ASYNC and rejects a name that is already open
 * (`already-open`). The caller owns the returned handle and is expected
 * to close it from its own disposer.
 */
export interface StorageDomainService {
  open(spec: DomainSpec): Promise<Domain>
  get(name: string): unknown
  closeAll(): Promise<void>
}

// ---- agents / subagents ----------------------------------------------

/**
 * An initiating Agent. `subagents.sendMessage` requires a real Agent as
 * its sender, and `agents.currentInitiator()` is the supported way to
 * obtain one for the current asynchronous driver chain (it is
 * process-local, so a bare timer callback has no initiator).
 */
export interface AgentRef {
  readonly id?: string
}

export interface AgentsService {
  currentInitiator(): AgentRef | undefined
  requireInitiator(): AgentRef
  get(id: string): AgentRef | undefined
}

export interface SubagentsService {
  /**
   * Send a message from `sender` into `targetId`.
   *
   * The first parameter is an Agent, NOT a provider name — passing a
   * string here fails at runtime.
   */
  sendMessage(
    sender: AgentRef,
    targetId: string,
    content: Array<{ type: 'text'; text: string }>,
    options?: Record<string, unknown>,
  ): Promise<unknown>
}

// ---- sessions --------------------------------------------------------

/** A live session. We only rely on the id. */
export interface SessionRef {
  id: string
}

export interface SessionsService {
  /** Takes NO arguments and returns every live session. */
  list(): SessionRef[]
  get(id: string): SessionRef | undefined
}

// ---- tools -----------------------------------------------------------

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema describing the parameters. */
  parameters: Record<string, unknown>
  execute: (args: any, exec?: unknown) => Promise<unknown>
}

export interface ToolsService {
  register(definition: ToolDefinition): () => void
  get(name: string, scope?: string): ToolDefinition | undefined
  restrict(filter: unknown): () => void
}

// ---- systemPrompt ----------------------------------------------------

export interface PromptSection {
  id: string
  order?: number
  content: string
}

export interface SystemPromptService {
  /** Returns a disposer. */
  section(section: PromptSection): () => void
  context(context: unknown): () => void
  variable(name: string, provider: (context: unknown) => string | undefined): () => void
}

// ---- Subagent handlers (internal) ------------------------------------

/**
 * The narrow shape AgentProvider uses to launch a subagent run. The
 * real service also offers continuable children and discovery; we only
 * use the one-shot start.
 */
export interface SubagentsStartService {
  start(name: string, request: Record<string, unknown>): Promise<unknown>
}

// ---- Local StoryRecord re-export -------------------------------------

export type { StoryRecord } from '../domain/schema.js'
