import { useState, type ReactNode } from 'react';
import {
  ActionMenu,
  ChevronDown,
  Dropdown,
  Field,
  FormActions,
  Modal,
  SparkleIcon,
  Spinner,
  aiAccentClass,
  useConfirm,
  type MenuAction,
} from '@moxxy/companion-sdk/ui';

/**
 * The selection bar above the PR and issue lists.
 *
 * Three controls, not seven. Everything a maintainer can do to a selection used
 * to sit here as a peer button, plus a pipeline dropdown that did nothing until
 * you also pressed the button beside it, and the row read as a wall. What is
 * left: the action people came for (the AI verb, marked with the sparkle like
 * every other agent action), the pipelines, and one menu holding the closed set
 * of GitHub verbs, in the same vocabulary the row menu already uses.
 *
 * Picking a pipeline runs it. The count is in each label, so the item names the
 * whole outcome and there is nothing left to confirm by pressing something else.
 */
export function BulkBar({
  count,
  noun,
  busy,
  running,
  canAct,
  ai,
  pipelines,
  onRunPipeline,
  onLabel,
  onComment,
  onCloseItems,
  onRerunChecks,
  onSelectAll,
  onClear,
  children,
}: {
  count: number;
  /** Singular, e.g. "PR" or "issue". */
  noun: string;
  busy: boolean;
  /** Label of the item a bulk run is currently starting, for the button text. */
  running: string | null;
  /** May label / comment / close, i.e. holds the module's act permission. */
  canAct: boolean;
  /** The one AI verb this list offers, when the viewer may run it. */
  ai: { readonly label: string; readonly onRun: () => void } | null;
  /** Runnable pipelines for this list; empty when the viewer cannot run them. */
  pipelines: readonly { readonly id: string; readonly name: string }[];
  onRunPipeline: (id: string) => void;
  onLabel: (labels: string[]) => void;
  onComment: (body: string) => void;
  onCloseItems: () => void;
  /** PR lists only: issues have no CI to re-run. */
  onRerunChecks?: () => void;
  onSelectAll: () => void;
  onClear: () => void;
  /** Bulk verbs contributed by other modules (a slot), kept as rendered controls
   *  because a slot contributes components, not menu items. */
  children?: ReactNode;
}): React.JSX.Element {
  const [prompt, setPrompt] = useState<'label' | 'comment' | null>(null);
  const [draft, setDraft] = useState('');
  const { confirmDanger, confirmElement } = useConfirm();

  const plural = count === 1 ? noun : `${noun}s`;
  const subject = `${count} ${plural}`;

  const openPrompt = (which: 'label' | 'comment'): void => {
    setDraft('');
    setPrompt(which);
  };

  const submit = (): void => {
    const value = draft.trim();
    if (!value) return;
    if (prompt === 'label') onLabel(value.split(',').map((l) => l.trim()).filter(Boolean));
    else onComment(value);
    setPrompt(null);
    setDraft('');
  };

  const confirmClose = (): void =>
    void (async () => {
      const ok = await confirmDanger({
        title: `Close ${subject}`,
        message: `This closes ${subject} on GitHub. Reopening is per item.`,
        confirmLabel: `Close ${subject}`,
      });
      if (ok) onCloseItems();
    })();

  const actions: MenuAction[] = [
    ...(onRerunChecks ? [{ label: `Re-run failed CI jobs on ${subject}`, disabled: busy, onSelect: onRerunChecks }] : []),
    ...(canAct
      ? [
          { label: `Label ${subject}…`, disabled: busy, onSelect: () => openPrompt('label') },
          { label: `Comment on ${subject}…`, disabled: busy, onSelect: () => openPrompt('comment') },
          { label: `Close ${subject}`, danger: true, disabled: busy, onSelect: confirmClose },
        ]
      : []),
  ];

  return (
    <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-800">
      <span className="text-[13px] font-medium tabular-nums">{count} selected</span>
      {/* One progress readout for the whole bar, because the runner is shared:
          hanging it off the AI button would announce "Starting #12" there while
          what is actually starting is a pipeline picked from the menu. */}
      {running ? (
        <span className="dim flex items-center gap-1.5 text-xs" role="status">
          <Spinner />
          Starting {running}…
        </span>
      ) : (
        <>
          <button className="linkish text-xs" onClick={onSelectAll}>
            select all loaded
          </button>
          <button className="linkish text-xs" onClick={onClear}>
            clear
          </button>
        </>
      )}
      <span className="flex-1" />
      {children}
      {ai ? (
        <button
          className={`flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-sm font-medium transition-colors disabled:cursor-default disabled:opacity-50 ${aiAccentClass(false)}`}
          disabled={busy}
          onClick={ai.onRun}
        >
          <SparkleIcon />
          {ai.label} {count}
        </button>
      ) : null}
      {pipelines.length > 0 ? (
        // A picker over a user-defined list, which is what Dropdown is for: it
        // brings the filter box, the capped scrolling list and the placement
        // already, and picking is the whole interaction, so nothing stays
        // selected afterwards. Same threshold for the filter as the other long
        // pickers on these pages.
        <Dropdown
          value=""
          onChange={onRunPipeline}
          options={pipelines.map((pl) => ({ value: pl.id, label: pl.name }))}
          ariaLabel={`Run a pipeline on the selected ${plural}`}
          searchable={pipelines.length > 8}
          disabled={busy}
          className="shrink-0"
          triggerClassName="btn-ghost gap-1.5"
          renderTrigger={(_selected, open) => (
            <>
              Run pipeline
              <ChevronDown open={open} className="size-3.5" />
            </>
          )}
        />
      ) : null}
      {actions.length > 0 ? (
        <ActionMenu actions={actions} label={`More actions for the selected ${plural}`} trigger="Actions" />
      ) : null}

      {confirmElement}
      {prompt ? (
        <Modal
          title={prompt === 'label' ? `Label ${subject}` : `Comment on ${subject}`}
          onClose={() => setPrompt(null)}
        >
          <Field label={prompt === 'label' ? 'Labels, comma-separated (added, never replaced)' : 'Comment body'}>
            {prompt === 'label' ? (
              <input
                className="input"
                value={draft}
                placeholder="needs-qa, blocked"
                onChange={(e) => setDraft(e.target.value)}
              />
            ) : (
              <textarea className="input min-h-24" value={draft} onChange={(e) => setDraft(e.target.value)} />
            )}
          </Field>
          <FormActions>
            <button className="btn-ghost" onClick={() => setPrompt(null)}>
              Cancel
            </button>
            <button className="btn" disabled={!draft.trim()} onClick={submit}>
              Apply to {subject}
            </button>
          </FormActions>
        </Modal>
      ) : null}
    </div>
  );
}
