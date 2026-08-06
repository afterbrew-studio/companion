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
}

export class Approvals {
  private readonly pending = new Map<string, (outcome: ApprovalOutcome) => void>();
  /** Tools an `allow_session` answer settled for the rest of this session. */
  private readonly allowedForSession = new Set<string>();

  constructor(
    private readonly armed: boolean,
    private readonly raise: (ask: ApprovalRequest) => void,
    private readonly resolved: (requestId: string) => void,
  ) {}

  get enabled(): boolean {
    return this.armed;
  }

  /**
   * Whether this call may proceed. An unarmed session allows everything, which
   * is the existing rule for unattended work: its fence is the run's access and
   * its credential-less worktree, not a person.
   */
  async request(tool: string, input: unknown, signal: AbortSignal): Promise<ApprovalOutcome> {
    if (!this.armed || this.allowedForSession.has(tool)) return { allowed: true, mode: 'allow' };
    const requestId = randomUUID();
    return await new Promise<ApprovalOutcome>((resolve) => {
      const settle = (outcome: ApprovalOutcome): void => {
        if (!this.pending.delete(requestId)) return;
        signal.removeEventListener('abort', onAbort);
        this.resolved(requestId);
        resolve(outcome);
      };
      // An aborted turn must not leave the model waiting on a person who is no
      // longer being asked.
      const onAbort = (): void => settle({ allowed: false, mode: 'deny' });
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(requestId, settle);
      this.raise({ requestId, workspaceId: '', kind: 'permission', tool: { name: tool, input } });
    });
  }

  /** The person answered. An unknown id is a late or duplicate reply; ignore it. */
  answer(requestId: string, mode: string | undefined, tool?: string): void {
    const settle = this.pending.get(requestId);
    if (!settle) return;
    const decided: ApprovalMode =
      mode === 'deny' || mode === 'allow_session' || mode === 'allow_always' ? mode : 'allow';
    if (decided !== 'deny' && tool) this.allowedForSession.add(tool);
    settle({ allowed: decided !== 'deny', mode: decided });
  }

  /** Which tool a pending request belongs to, so a session answer can remember it. */
  has(requestId: string): boolean {
    return this.pending.has(requestId);
  }
}
