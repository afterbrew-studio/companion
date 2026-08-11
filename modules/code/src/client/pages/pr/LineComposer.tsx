import { useState } from 'react';
import { ErrorBar, Spinner } from '@moxxy/companion-sdk/ui';
import type { FindingSeverity } from '../../../contract/index.js';

/** A line the reviewer picked, waiting for them to say something about it. */
export interface DraftComment {
  readonly path: string;
  readonly side: 'LEFT' | 'RIGHT';
  readonly line: number;
}

/**
 * Composer for the reviewer's own inline comment.
 *
 * Rendered inside the diff as an annotation, so a comment being written sits
 * exactly where it will be posted rather than in a panel elsewhere.
 */
export function LineComposer({
  draft,
  busy,
  onCancel,
  onSubmit,
}: {
  draft: DraftComment;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (body: string, severity: FindingSeverity) => Promise<void>;
}): React.JSX.Element {
  const [body, setBody] = useState('');
  const [severity, setSeverity] = useState<FindingSeverity>('major');
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const text = body.trim();
    if (!text) return;
    setError(null);
    try {
      await onSubmit(text, severity);
      setBody('');
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <div className="font-sans">
      <div className="dim mb-1.5 text-[11px]">
        Your comment on <code>{draft.path}</code>:{draft.line}
        {draft.side === 'LEFT' ? ' (removed line)' : ''}
      </div>
      <textarea
        className="input min-h-16 w-full text-[13px]"
        placeholder="What should the author change here? (markdown, posted with the review)"
        value={body}
        autoFocus
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          // Enter alone inserts a newline: a review comment is usually more
          // than one line, unlike a chat message.
          // The same guard the button carries: `addFinding` makes a GitHub
          // round trip before it inserts, so a second press lands a duplicate.
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !busy) void submit();
        }}
      />
      <ErrorBar error={error} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          className="input w-auto text-xs"
          value={severity}
          onChange={(e) => setSeverity(e.target.value as FindingSeverity)}
          aria-label="Severity"
        >
          <option value="blocker">Blocker</option>
          <option value="major">Major</option>
          <option value="minor">Minor</option>
          <option value="nit">Nit</option>
        </select>
        <span className="flex-1" />
        <button className="btn-ghost text-xs" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn" disabled={busy || !body.trim()} onClick={() => void submit()}>
          {busy ? <Spinner /> : null} Add comment
        </button>
      </div>
    </div>
  );
}
