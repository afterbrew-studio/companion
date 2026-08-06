import type { ModelMessage } from 'ai';

/**
 * Keeping a long run inside its context window.
 *
 * Without this a run does not degrade, it fails: the provider refuses the turn
 * that crosses the window, and the work done so far is lost. Trimming is the
 * cheap, boring answer and it has exactly one rule that must not be broken.
 *
 * **A tool result may never outlive its call.** Providers reject a conversation
 * whose `tool` message answers an assistant tool call that is no longer there,
 * so trimming happens at USER-message boundaries: whole exchanges leave
 * together, or nothing does. Trimming by message count, or by token count
 * alone, produces a conversation the provider rejects for a reason that reads
 * nothing like "too long".
 *
 * Probing and judging are separate, as elsewhere in this codebase: this is a
 * pure function of a message list and a budget, so every outcome is reachable
 * from a test without a model, a key or a long conversation.
 */

/**
 * Characters per token, near enough. A real tokenizer would be a dependency per
 * provider family to decide when to trim, and being 20% out here costs a
 * slightly early trim rather than a wrong answer. The budget below is set well
 * under the window for the same reason.
 */
const CHARS_PER_TOKEN = 4;

/** How much of the window a conversation may occupy before it is trimmed. */
export const CONTEXT_BUDGET = 0.7;

export function estimateTokens(messages: readonly ModelMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += typeof message.content === 'string' ? message.content.length : JSON.stringify(message.content).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export interface Compaction {
  readonly messages: readonly ModelMessage[];
  readonly droppedMessages: number;
  readonly droppedTokens: number;
}

/**
 * Drop the oldest exchanges until the conversation fits, at user-message
 * boundaries only.
 *
 * Returns the input untouched when it already fits, and when it does not fit
 * even after dropping everything droppable: a single exchange larger than the
 * window is not something trimming can solve, and pretending otherwise would
 * turn a clear provider error into a silently mutilated conversation.
 */
export function compactMessages(messages: readonly ModelMessage[], budgetTokens: number): Compaction {
  const none = { messages, droppedMessages: 0, droppedTokens: 0 };
  if (budgetTokens <= 0 || estimateTokens(messages) <= budgetTokens) return none;

  // Every point a whole exchange can be cut at, oldest first. Index 0 is not
  // one: cutting there would drop nothing.
  const boundaries: number[] = [];
  for (let i = 1; i < messages.length; i++) {
    if (messages[i]?.role === 'user') boundaries.push(i);
  }

  for (const cut of boundaries) {
    const kept = messages.slice(cut);
    if (estimateTokens(kept) <= budgetTokens) {
      return {
        messages: kept,
        droppedMessages: cut,
        droppedTokens: estimateTokens(messages) - estimateTokens(kept),
      };
    }
  }
  return none;
}
