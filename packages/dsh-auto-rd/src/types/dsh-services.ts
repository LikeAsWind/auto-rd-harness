/**
 * Type declarations for DSH services that the auto-rd plugin consumes.
 *
 * Why a local copy?
 *   The DSH host process provides `slots`, `tools`, `systemPrompt`, and
 *   other extension services that this plugin depends on. Those services
 *   live inside the proprietary DSH distribution and are not exported as
 *   a public npm package. Importing from `@deepseek-ai/dsh-*` here would
 *   resolve only when this package is being built inside the DSH monorepo;
 *   in standalone builds (e.g. CI on GitHub), the imports would fail.
 *
 *   Instead, we declare the shapes we depend on. The plugin reads these
 *   services via `ctx.get('slots')` etc., and narrows with `instanceof`
 *   on locally-defined symbol sentinels. If DSH's actual implementation
 *   drifts from these shapes, runtime errors surface when the slot / tool
 *   registration attempts to call into them -- the contract violation is
 *   loud and immediate, not silent.
 *
 *   When DSH ships a public type package, this file becomes a thin shim
 *   that re-exports from it; the rest of the plugin code does not need
 *   to change.
 *
 * IMPORTANT: keep the shape minimal. We only declare what we call.
 */

import type { StoryRecord } from '../domain/schema.js'

// ---- Slots service ----------------------------------------------------

/**
 * A slot renderer is a pure function: it takes the current DSH theme /
 * user / storage context and returns a React node (or, in our world,
 * a serialized element tree that the browser side renders). We type the
 * return as `unknown` so this file does not depend on a React runtime.
 */
export type SlotRenderer = (...args: unknown[]) => unknown

/**
 * Minimal declaration of the slot registration contract. DSH exposes
 * many registration flavours (header / footer / context-menu / etc.);
 * we only declare the `list` flavour used by the auto-rd sidebar.
 */
export interface SlotsService {
  /**
   * Register a slot entry. The third argument is a renderer that DSH
   * re-evaluates whenever the underlying storage mutates.
   *
   * M4-U: `slot` is one of the documented DSH slot names such as
   * 'sidebar.worktable.project'.
   */
  register(
    slot: string,
    entry: {
      id: string
      /** Lower renders first. */
      order?: number
      label?: string | (() => string)
    },
    renderer: SlotRenderer,
  ): () => void
}

// ---- Tools service ----------------------------------------------------

/**
 * A DSH tool is a model-callable function. The auto-rd plugin registers
 * three tools: auto_rd_status, auto_rd_trigger, auto_rd_retry. Each is
 * typed here by name; the implementation lives in `src/tools/*.ts`.
 */
export interface ToolDefinition {
  name: string
  description: string
  /**
   * JSON Schema describing the parameters. DSH serializes this into
   * the model's function-call spec.
   */
  parameters: Record<string, unknown>
  /**
   * The actual implementation. Receives the parsed args plus an
   * exec-helper for nested tool calls. We type the args loosely here
   * so each tool's .ts file can narrow with zod at the boundary.
   */
  execute: (args: any, exec?: unknown) => Promise<unknown>
}

export interface ToolsService {
  register(tool: ToolDefinition): () => void
}

// ---- System-prompt section --------------------------------------------

export interface SystemPromptSection {
  /** Stable id so DSH can de-duplicate if a plugin is loaded twice. */
  id: string
  /** Lower renders first within the system prompt. */
  order?: number
  /** Markdown body. DSH joins sections together to form the prompt. */
  content: string
}

export interface SystemPromptService {
  section(section: SystemPromptSection): void
}

// ---- Subagent / session helpers --------------------------------------

/**
 * Minimal surface used by the StoryNotifier. DSH exposes a richer
 * session API; we only need "send a text message to a user-facing
 * session".
 */
export interface SessionRef {
  id: string
}

export interface SubagentsService {
  sendMessage(
    agentName: string,
    sessionId: string,
    content: Array<{ type: 'text'; text: string }>,
    options?: Record<string, unknown>,
  ): Promise<unknown>
}

// ---- Cordis context shape we assume DSH augments ---------------------

/**
 * The auto-rd plugin reads DSH services through `ctx.get('slots')` etc.
 * To make those calls type-safe without depending on a DSH types
 * package, we declare the slot names as keys on `ctx`. Cordis's reflect
 * layer (`ctx.get` / `ctx.inject`) does not require the service to be
 * typed here -- runtime resolution still goes through the registry.
 *
 * This declaration is consumed via:
 *   const slots = ctx.get('slots') as SlotsService | undefined
 *
 * The `as` cast is local; it does not leak into storage / domain.
 */
export interface DshAugmentedContext {
  slots?: SlotsService
  tools?: ToolsService
  systemPrompt?: SystemPromptService
  subagents?: SubagentsService
}

// ---- Local StoryRecord re-export (so the file is self-contained) ----

export type { StoryRecord }