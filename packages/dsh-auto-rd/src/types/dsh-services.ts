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

/**
 * Options accepted by `SessionStore.create()`. We only use `meta.cwd`
 * (an absolute working directory that keys the session's storage).
 */
export interface CreateSessionOptions {
  meta?: {
    cwd?: string
    parentSession?: string
    origin?: 'subagent'
    agentPreset?: string
  }
}

/** The live session returned by `sessions.create()`. */
export interface SessionHandle {
  id: string
}

export interface SessionsService {
  /** Takes NO arguments and returns every live session. */
  list(): SessionRef[]
  get(id: string): SessionRef | undefined
  /**
   * Create a session owned by the calling fiber. Requires `meta.cwd`
   * to be an absolute path. Returns the live session (already entered
   * and announced); its `.id` is what we persist into
   * `StoryRecord.mainSessionId`.
   */
  create(id?: string, options?: CreateSessionOptions): SessionHandle
}

// ---- sessionTitle ----------------------------------------------------

/**
 * Sets / refreshes a session's display title. We call `rename` after
 * creating a story session so the DSH session list shows the story
 * title instead of a generated id.
 */
export interface SessionTitleService {
  rename(session: SessionHandle, title: string): unknown
}

// ---- workspaceController ---------------------------------------------

/**
 * Host Workspace controller (`ctx.workspaceController`). We use only
 * `create`, which idempotently adopts an existing directory as a DSH
 * workspace and returns the workspace id (plus whether this call
 * actually created it).
 */
export interface WorkspaceView {
  readonly workspaceId: string
  readonly title?: string
  readonly path?: string
}

export interface WorkspaceCreateValue {
  readonly workspace: WorkspaceView
  readonly created: boolean
}

export interface WorkspaceControllerService {
  create(request: { readonly path: string }): Promise<WorkspaceCreateValue>
}

// ---- tools -----------------------------------------------------------

/** A content block as it appears in a message or a rendered tool result. */
export type ContentBlock = { readonly type: string; readonly [key: string]: unknown }

/**
 * How a tool's return value is described to, and rendered for, the model.
 *
 * This is REQUIRED on ToolDefinition. Omitting it makes
 * `tools.register()` reject the definition, so a tool that only declares
 * name/description/parameters/execute silently never appears.
 */
export interface ToolOutputDefinition {
  /** JSON Schema for the value returned by `execute`. */
  readonly schema: Record<string, unknown>
  render(args: unknown, value: unknown): ContentBlock[]
  presentationMeta?(args: unknown, value: unknown): unknown
}

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema describing the parameters. */
  parameters: Record<string, unknown>
  /** Required output contract; see ToolOutputDefinition. */
  output: ToolOutputDefinition
  execute(args: unknown, exec?: unknown): Promise<unknown>
  timeoutMs?: number
  isConcurrencySafe?(args: unknown): boolean
}

export interface ToolsService {
  /** Returns the exact disposer that unregisters the tool. */
  register(definition: ToolDefinition): () => void
  get(name: string, scope?: unknown): ToolDefinition | undefined
  restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }): () => void
}

// ---- systemPrompt ----------------------------------------------------

/**
 * An ordered prompt section.
 *
 * Verified shape: the identifier field is `name` (NOT `id`) and the body
 * field is `text` (NOT `content`). Registering `{ id, content }` gives
 * the service an undefined name and an undefined body.
 *
 * `text` may be a function, evaluated on every assembly, so a section can
 * reflect live state without being re-registered.
 */
export interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: unknown) => string)
  /** Marks the section as the sole prompt body when set. */
  readonly complete?: boolean
}

export interface PromptContext {
  readonly name: string
  readonly order: number
  readonly text: string | ((context: unknown) => string)
}

export interface PromptAssembly {
  sections: Array<{ name: string; text: string }>
  contexts: Array<{ name: string; text: string }>
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>
  variables: Record<string, string | undefined>
}

export interface SystemPromptService {
  /** Returns the exact Cordis effect disposer. */
  section(section: PromptSection): () => void
  context(context: PromptContext): () => void
  suppressRuntimeContext(): () => void
  getSectionOrder(name: string): number
  getContextOrder(name: string): number
  variable(name: string, provider: (context: unknown) => string | undefined): () => void
  assemble(context?: unknown): Promise<PromptAssembly>
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

// ---- credentials -----------------------------------------------------

/**
 * A credential reference name — a POSIX shell identifier such as
 * `DSH_TAPD_API_TOKEN`. Branded for safety so the compiler refuses to
 * pass arbitrary strings to `ctx.credentials` calls.
 *
 * The actual values are NEVER carried in the cordis patch tree. They
 * live in `~/.dsh/.credentials.yaml` (managed by the
 * `@deepseek-ai/dsh-credentials-local` provider that ships with the
 * web profile). When that service is unavailable (headless profile),
 * `credentials.resolve` falls back to `process.env[<name>]`.
 */
export type CredentialRef = string & { readonly __brand: 'CredentialRef' }

export type CredentialSource = 'credentials-file' | 'process-env' | 'shadow' | 'unset'

/**
 * What `ctx.credentials.resolve` returns when the reference is known
 * AND resolvable. `source` lets the caller distinguish "user set it
 * explicitly" from "we fell through to env" without leaking the value.
 */
export interface ResolvedCredential {
  readonly value: string
  readonly source: Exclude<CredentialSource, 'unset'>
}

export interface CredentialDescriptor {
  /** Whether any source (file or env) currently resolves this ref. */
  readonly configured: boolean
  /** Which layer won the last resolve, if any. */
  readonly source?: CredentialSource
  /** Whether this caller may write to the store. False while a read-only
   *  shadow (typically the launching process env) takes precedence. */
  readonly writable: boolean
}

/**
 * The narrow shape we actually call. The real provider offers more
 * (records / grant flows), but auto-rd only uses the reference half:
 * setting, unsetting, resolving, and describing.
 *
 * Every method is async even when the underlying store is synchronous
 * (the local provider hits disk), so the rest of the codebase can
 * `await ctx.credentials.set(...)` uniformly.
 */
export interface CredentialsService {
  /**
   * Store `value` under `ref`. Rejects if the ref is invalid syntax
   * (`isCredentialRefName` returns false) or if a read-only shadow
   * (e.g. the launching shell still has the env var set to a non-empty
   * value) takes precedence over the writable store.
   */
  set(ref: CredentialRef, value: string): Promise<void>

  /**
   * Remove `ref` from the store. No-op when absent. Same shadow rule
   * as `set`. The env var, if set, is untouched.
   */
  unset(ref: CredentialRef): Promise<void>

  /**
   * Read the current value. Returns `undefined` when no source
   * resolves the ref. `source` tells the caller whether the value
   * came from the credentials file or the process env, so we can
   * warn the user when their env-var override no longer matches
   * what's in the file.
   */
  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>

  /**
   * Cheap "is it set?" probe — used by the panel to show the
   * configured / not-configured indicator without ever surfacing the
   * actual value to the browser.
   */
  describe(ref: CredentialRef): Promise<CredentialDescriptor>
}

// ---- Local StoryRecord re-export -------------------------------------

export type { StoryRecord } from '../domain/schema.js'
