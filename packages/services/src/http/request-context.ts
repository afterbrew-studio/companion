import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthUser } from '@moxxy/companion-contracts';

/**
 * Request-scoped context — the invoking user for the duration of one HTTP
 * request (and anything it awaits or fires off synchronously within it). Lets
 * deep resolvers (e.g. which GitHub account to act as) know who is acting
 * without threading the user through every service method. Work that runs
 * outside a request (automations, background sync, orchestrator-driven posts)
 * sees no user and falls back to the default account.
 */
export interface RequestContext {
  readonly user: AuthUser | null;
  /** See {@link claimAuditActor}. Mutable: written by the handler, read by the router. */
  auditActor?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** The router allocates one context per request so it can read back what the
 *  handler claimed even after the storage scope has exited (or thrown). */
export function createRequestContext(user: AuthUser | null): RequestContext {
  return { user };
}

/** Run `fn` with `ctx` as the request context for its async subtree. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** Run `fn` with `user` as the invoking user for its async subtree. */
export function withRequestUser<T>(user: AuthUser | null, fn: () => T): T {
  return storage.run(createRequestContext(user), fn);
}

/** The invoking user of the current request, or null outside one. */
export function currentUser(): AuthUser | null {
  return storage.getStore()?.user ?? null;
}

/**
 * Name the acting identity for the audit trail on a route the router cannot
 * attribute itself — the public auth surface, where the credential is being
 * established rather than presented. Claim BEFORE the operation that can throw:
 * both the success and the refusal are then recorded against the attempted
 * identity instead of `actor: null`.
 */
export function claimAuditActor(username: string): void {
  const store = storage.getStore();
  if (store) store.auditActor = username;
}
