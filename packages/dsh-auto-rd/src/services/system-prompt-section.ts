/**
 * System-prompt section — tell the main DSH model about auto-rd.
 *
 * Design doc §13.2 step 5: "注册 system prompt section，让模型知道
 * auto-rd 可用".
 *
 * The main chat session's system prompt is assembled by DSH from many
 * section sources. Our section is one of them. We describe:
 *   - what auto-rd is (one paragraph)
 *   - the three tools the model can call
 *   - the canonical "blocked story" recovery flow
 *   - a pointer to the sidebar / status tool for visibility
 *
 * Order 50 puts us after typical framework sections (memory,
 * environment, etc.) but before any plugin-specific extras.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SystemPromptService, SystemPromptSection } from '../types/dsh-services.js'

export function registerAutoRdPromptSection(ctx: Context): boolean {
  const systemPrompt = ctx.get('systemPrompt') as SystemPromptService | undefined
  if (!systemPrompt) {
    ctx.logger('auto-rd').warn(
      'systemPrompt service not available; auto-rd prompt section will not be registered',
    )
    return false
  }

  const section: SystemPromptSection = {
    id: 'auto-rd-overview',
    order: 50,
    content: AUTORD_PROMPT_SECTION.trim(),
  }
  systemPrompt.section(section)
  ctx.logger('auto-rd').info('Registered system-prompt section: auto-rd-overview')
  return true
}

const AUTORD_PROMPT_SECTION = `
## Auto-RD Pipeline

You have access to an auto-rd plugin that drives a 19-state pipeline
(pending -> context -> ... -> completed) for each TAPD story the user
configures. The plugin runs in the background; you can observe and
control it via three tools:

- \`auto_rd_status\`: query what stories and tasks are in flight. Default
  scope is 'summary' (counts by state); pass scope='stories' or
  scope='tasks' for detail. Optional filters: moduleId, state, limit.

- \`auto_rd_trigger\`: take an out-of-band action. action='poll_now'
  triggers an immediate TAPD poll; action='advance_story' wakes a
  stuck story from the queue; action='mark_reviewed' records a
  human review decision (approve / request_changes / skip) against
  a story.

- \`auto_rd_retry\`: recover a blocked or failed story. action='retry'
  sets state back to pending and resets retryCount; 'skip' is
  terminal (state=failed); 'reset_to_pending' sets state to pending
  without resetting retryCount.

When a story is in state 'blocked', the user is the human-in-the-loop
checkpoint. Use \`auto_rd_status\` to see which stories are blocked
and their \`blockedReason\`; use \`auto_rd_retry\` to recover.

Do NOT proactively call these tools unless the user has asked about
auto-rd or a story has just transitioned to blocked. Do not narrate
the pipeline to the user unless they ask.

The auto-rd sidebar (when DSH renders it) shows modules + stories;
\`auto_rd_status\` is the headless equivalent.
`