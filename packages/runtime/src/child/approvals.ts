import { randomUUID } from 'node:crypto';

/**
 * Asking a person before a tool call, which is the one thing no other harness
 * Companion runs can do.
 *
 * Claude Code and Codex settle permission as a start-time policy and offer no
 * headless round trip, so their approval affordance has always been dark. We
 * own this loop, so a mutating tool can stop, raise the same `AskRequest` moxxy
 * raises, and wait for the answer on the same pipe its events go out on.
 *
 * Two rules keep it from becoming a hang:
 *  - it is only ever armed for a run somebody is watching, because unattended
 *    work has nobody to answer and would sit until its turn timed out;
 *  - the turn's abort signal rejects every waiter, so stopping a run stops the
 *    people it was waiting for too.
 */

export type ApprovalMode = 'allow' | 'allow_session' | 'allow_always' | 'deny';

export interface ApprovalRequest {
  readonly requestId: string;
  readonly workspaceId: string;
  readonly kind: 'permission';
  readonly tool: { readonly name: string; readonly input: unknown; readonly description?: string };
}

export interface ApprovalOutcome {
  readonly allowed: boolean;
  readonly mode: ApprovalMode;
  /** Nobody answered in time, which the model is told rather than left to guess. */
  readonly expired?: boolean;
}

export class Approvals {
  private readonly pending = new Map<string, (outcome: ApprovalOutcome) => void>();
  /** Tools an `allow_session` answer settled for the rest of this session. */
  private readonly allowedForSession = new Set<string>();

  constructor(
    private readonly armed: boolean,
    private readonly raise: (ask: ApprovalRequest) => void,
    private readonly resolved: (requestId: string) => void,
    /**
     * Announced where the decision is APPLIED rather than where an answer
     * arrives, because a decision has three sources: a person, the deadline,
     * and an aborted turn. Reporting only the first left the other two silently
     * changing what the agent could do, which is the thing a transcript exists
     * to prevent.
     */
    private readonly decided: (requestId: string, tool: string, outcome: ApprovalOutcome) => void = () => undefined,
  ) {}

  get enabled(): boolean {
    return this.armed;
  }

  /**
   * Whether this call may proceed. An unarmed session allows everything, which
   * is the existing rule for unattended work: its fence is the run's access and
   * its credential-less worktree, not a person.
   */
  async request(
    tool: string,
    input: unknown,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<ApprovalOutcome> {
    if (!this.armed || this.allowedForSession.has(tool)) return { allowed: true, mode: 'allow' };
    const requestId = randomUUID();
    return await new Promise<ApprovalOutcome>((resolve) => {
      const settle = (outcome: ApprovalOutcome): void => {
        if (!this.pending.delete(requestId)) return;
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.decided(requestId, tool, outcome);
        this.resolved(requestId);
        resolve(outcome);
      };
      // An aborted turn must not leave the model waiting on a person who is no
      // longer being asked.
      const onAbort = (): void => settle({ allowed: false, mode: 'deny' });
      // Nor may a closed tab hold a runner slot until the turn times out.
      // Unanswered is refused, never allowed: an approval that granted itself
      // by expiring would be worse than not asking.
      const timer = setTimeout(() => settle({ allowed: false, mode: 'deny', expired: true }), timeoutMs);
      timer.unref();
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(requestId, settle);
      this.raise({ requestId, workspaceId: '', kind: 'permission', tool: { name: tool, input } });
    });
  }

  /**
   * The person answered. Returns whether it settled anything: an unknown id is
   * a late or duplicate reply, and reporting one as a decision would put an
   * approval on the transcript that nobody made.
   */
  answer(requestId: string, mode: string | undefined, tool?: string): boolean {
    const settle = this.pending.get(requestId);
    if (!settle) return false;
    const decided: ApprovalMode =
      mode === 'deny' || mode === 'allow_session' || mode === 'allow_always' ? mode : 'allow';
    // Only an answer that ASKED to stand for more than this call does. A plain
    // `allow` is one call; remembering it would silently turn the first yes
    // into permission for every later write, which is the opposite of what the
    // person chose.
    if (tool && (decided === 'allow_session' || decided === 'allow_always')) {
      this.allowedForSession.add(tool);
    }
    settle({ allowed: decided !== 'deny', mode: decided });
    return true;
  }
}
