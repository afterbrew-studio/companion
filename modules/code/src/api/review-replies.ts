/**
 * The rules that decide whether the agent may answer a reply to one of its own
 * inline review comments.
 *
 * Its replies arrive back here as the same `pull_request_review_comment`
 * delivery that triggered them, so without these the agent holds an endless
 * conversation with itself on a public pull request. They are pure decisions
 * over data the caller already holds, and every one of them refuses rather than
 * guesses.
 */

/** At most this many agent replies in one inline thread. */
export const MAX_THREAD_REPLIES = 3;

/** The `pull_request_review_comment` payload slice this reacts to. */
export interface ReviewCommentPayload {
  readonly id?: number;
  /** GitHub sets this to the id of the comment that STARTED the thread. */
  readonly in_reply_to_id?: number | null;
  readonly user?: { readonly login?: string | null } | null;
  readonly body?: string | null;
}

/** One inline comment of a pull request, as the GitHub client returns them. */
export interface ThreadComment {
  readonly id?: number;
  readonly in_reply_to_id?: number | null;
  readonly user?: { readonly login?: string | null } | null;
}

/** Why a delivery produced no reply. Each value is a deliberate silence. */
export type ReplyRefusal = 'malformed' | 'own-comment' | 'bot-comment' | 'not-a-reply' | 'empty';

/** A delivery that survived every rule the payload alone can decide. */
export interface ReviewCommentTrigger {
  readonly commentId: number;
  /** The comment that opened this thread, which is our finding's own comment. */
  readonly rootId: number;
  readonly author: string;
  readonly body: string;
}

export type TriggerDecision =
  | { readonly reply: true; readonly trigger: ReviewCommentTrigger }
  | { readonly reply: false; readonly refusal: ReplyRefusal };

/**
 * What the delivery alone decides, before any query or network call.
 *
 * `ourLogins` must be every connected GitHub account, not just the acting
 * profile's: any credential this instance holds could have posted the comment,
 * and recognising only some of them is the same as recognising none.
 */
export function reviewCommentTrigger(
  comment: ReviewCommentPayload | undefined,
  ourLogins: Iterable<string>,
): TriggerDecision {
  const id = comment?.id;
  const author = (comment?.user?.login ?? '').trim();
  if (typeof id !== 'number' || !author) return { reply: false, refusal: 'malformed' };
  const key = author.toLowerCase();
  if (ownSet(ourLogins).has(key)) return { reply: false, refusal: 'own-comment' };
  if (key.endsWith('[bot]')) return { reply: false, refusal: 'bot-comment' };
  const rootId = comment?.in_reply_to_id;
  if (typeof rootId !== 'number') return { reply: false, refusal: 'not-a-reply' };
  const body = (comment?.body ?? '').trim();
  if (!body) return { reply: false, refusal: 'empty' };
  return { reply: true, trigger: { commentId: id, rootId, author, body } };
}

/**
 * Whether one more agent reply fits in the thread. The root is our finding
 * itself, so it is not counted as a reply.
 */
export function underReplyCap(
  comments: readonly ThreadComment[],
  rootId: number,
  ourLogins: Iterable<string>,
  cap: number = MAX_THREAD_REPLIES,
): boolean {
  const own = ownSet(ourLogins);
  let ours = 0;
  for (const comment of comments) {
    if (comment.in_reply_to_id !== rootId) continue;
    if (isOurs(comment.user?.login ?? '', own)) ours++;
  }
  return ours < cap;
}

/** GitHub logins are case-insensitive, so a stored `Acme` matches an authored `acme`. */
function ownSet(logins: Iterable<string>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const login of logins) {
    const key = login.trim().toLowerCase();
    if (key) out.add(key);
  }
  return out;
}

/**
 * A GitHub App installation posts as `<app-slug>[bot]`, while the accounts
 * registry stores the login of the account the app is INSTALLED ON. The login
 * set therefore cannot recognise our own app-authored comments, and no human
 * login can end in `[bot]`, so the suffix is treated as ours too.
 */
function isOurs(login: string, own: ReadonlySet<string>): boolean {
  const key = login.trim().toLowerCase();
  return key.endsWith('[bot]') || own.has(key);
}
