import { useState } from 'react';
import { Field, Modal, FormActions, useConfirm } from '@moxxy/companion-sdk/ui';

/**
 * The label/comment/close trio, shared by the PR and issue lists.
 *
 * Deliberately the same verbs the row menu offers: a maintainer working through
 * fifteen items should not have to learn a second vocabulary just because they
 * ticked some checkboxes. Closing asks for confirmation because it is the one
 * that is outward-facing and annoying to undo across a selection.
 */
export function BulkActions({
  count,
  noun,
  canAct,
  busy,
  onLabel,
  onComment,
  onClose,
}: {
  count: number;
  /** Singular, e.g. "PR" or "issue". */
  noun: string;
  canAct: boolean;
  busy: boolean;
  onLabel: (labels: string[]) => void;
  onComment: (body: string) => void;
  onClose: () => void;
}): JSX.Element | null {
  const [prompt, setPrompt] = useState<'label' | 'comment' | null>(null);
  const [draft, setDraft] = useState('');
  const { confirmDanger, confirmElement } = useConfirm();

  if (!canAct) return null;
  const plural = count === 1 ? noun : `${noun}s`;

  const submit = (): void => {
    const value = draft.trim();
    if (!value) return;
    if (prompt === 'label') {
      onLabel(value.split(',').map((l) => l.trim()).filter(Boolean));
    } else {
      onComment(value);
    }
    setPrompt(null);
    setDraft('');
  };

  return (
    <>
      <button className="btn-ghost" disabled={busy} onClick={() => { setDraft(''); setPrompt('label'); }}>
        Label
      </button>
      <button className="btn-ghost" disabled={busy} onClick={() => { setDraft(''); setPrompt('comment'); }}>
        Comment
      </button>
      <button
        className="btn-danger-ghost"
        disabled={busy}
        onClick={() =>
          void (async () => {
            const ok = await confirmDanger({
              title: `Close ${count} ${plural}`,
              message: `This closes ${count} ${plural} on GitHub. Reopening is per item.`,
            });
            if (ok) onClose();
          })()
        }
      >
        Close
      </button>
      {confirmElement}
      {prompt ? (
        <Modal
          title={prompt === 'label' ? `Label ${count} ${plural}` : `Comment on ${count} ${plural}`}
          onClose={() => setPrompt(null)}
        >
          <Field
            label={prompt === 'label' ? 'Labels, comma-separated — added, never replaced' : 'Comment body'}
          >
            {prompt === 'label' ? (
              <input
                className="input"
                value={draft}
                placeholder="needs-qa, blocked"
                onChange={(e) => setDraft(e.target.value)}
              />
            ) : (
              <textarea
                className="input min-h-24"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
              />
            )}
          </Field>
          <FormActions>
            <button className="btn-ghost" onClick={() => setPrompt(null)}>
              Cancel
            </button>
            <button className="btn" disabled={!draft.trim()} onClick={submit}>
              Apply to {count} {plural}
            </button>
          </FormActions>
        </Modal>
      ) : null}
    </>
  );
}
