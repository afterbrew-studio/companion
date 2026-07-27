/**
 * `@moxxy-ai/companion-sdk/agents` — the types a module needs to compose an
 * agent run through the `operate` service.
 *
 * This is the curated slice of `@companion/types`. The rest of that package is
 * the daemon-to-runner wire protocol (`RpcRequestFrame`, `AgentDiffResponse`,
 * `MOXXY_WS_SUBPROTOCOL`, and fifteen more): plumbing between `operate` and
 * `companion-runner` that changes with the runner and that no module should
 * compile against. Publishing `@companion/types` as-is would freeze it.
 */
export type { AskRequest, AskResponse, MoxxyEvent, HistorySegment, PromptAttachment } from '@companion/types';

/**
 * Pull the JSON object out of a model reply that wrapped it in prose or a fence.
 * Lives here rather than in `/server` because it is the other half of asking an
 * agent for structured output: five in-tree modules import it exactly where they
 * import `AskRequest`.
 */
export { extractModelJson } from '@companion/services';
