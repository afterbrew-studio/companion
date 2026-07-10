import { useCallback, useEffect, useState } from 'react';
import { Avatar, ErrorBar, Markdown, Spinner, timeAgo } from '@companion/ui';
import type { CommentRecord } from '../../contract/index.js';

/**
 * GitHub conversation for an issue or PR: read-through list + composer.
 * The caller supplies fetch/post so the same component serves both views.
 */
export function CommentsSection({
  load,
  post,
  canComment,
}: {
  load: () => Promise<{ comments: CommentRecord[] }>;
  post?: (body: string) => Promise<unknown>;
  canComment: boolean;
}): JSX.Element {
  const [comments, setComments] = useState<CommentRecord[] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { comments } = await load();
      setComments(comments);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setComments([]);
    }
  }, [load]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = async (): Promise<void> => {
    const body = draft.trim();
    if (!body || !post) return;
    setBusy(true);
    setError(null);
    try {
      await post(body);
      setDraft('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-5" aria-label="Conversation">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold">
        Conversation
        {comments ? <span className="dim font-normal">{comments.length}</span> : null}
      </h2>

      {comments === null ? (
        <div className="dim flex items-center gap-2 py-4 text-sm">
          <Spinner /> Loading conversation…
        </div>
      ) : (
        <ol className="flex flex-col gap-2.5">
          {comments.map((c, i) => (
            <li key={i} className="anim-in card py-3">
              <div className="mb-1.5 flex items-center gap-2 text-[13px]">
                <Avatar name={c.author} size="xs" />
                <strong>{c.author}</strong>
                <span className="dim">{timeAgo(c.createdAt)}</span>
              </div>
              <Markdown text={c.body} />
            </li>
          ))}
          {comments.length === 0 ? <li className="dim py-2 text-sm">No comments yet.</li> : null}
        </ol>
      )}

      <ErrorBar error={error} />

      {canComment && post ? (
        <div className="mt-3 flex flex-col gap-2">
          <textarea
            className="input min-h-20"
            placeholder="Write a comment (markdown supported) — posts to GitHub"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="New comment"
          />
          <div className="flex justify-end">
            <button className="btn" disabled={busy || !draft.trim()} onClick={() => void submit()}>
              {busy ? (
                <>
                  <Spinner /> Posting…
                </>
              ) : (
                'Comment'
              )}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
