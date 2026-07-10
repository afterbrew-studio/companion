import { useState } from 'react';
import {
  EmptyState,
  ErrorBar,
  Field,
  FormActions,
  ListCard,
  Modal,
  Page,
  PageHeader,
  SparkleIcon,
  aiAccentClass,
  timeAgo,
  useConfirm,
} from '@companion/ui';
import type { SkillFile } from '../../contract/index.js';
import { operateApi as api } from '../api.js';
import { useSkills } from '../hooks/useSkills.js';

/**
 * Agent skills: markdown instructions injected into every agent run (triage,
 * reviews, pipelines, fixes). Full CRUD — list with previews, editor modal,
 * delete with confirm.
 */
export function SkillsPage(): JSX.Element {
  const { skills, error, setError, refresh } = useSkills();
  const [editing, setEditing] = useState<SkillFile | 'new' | null>(null);
  const { confirmDanger, confirmElement } = useConfirm();

  const remove = async (name: string): Promise<void> => {
    const ok = await confirmDanger({
      title: `Delete skill ${name}`,
      message: `Agent runs stop receiving "${name}" immediately. Pipelines whose prompts reference it lose that guidance.`,
    });
    if (!ok) return;
    try {
      await api.deleteSkill(name);
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <Page>
      <PageHeader
        title="Skills"
        subtitle="Markdown instructions available to every agent run — triage, reviews, pipelines, fixes"
        actions={
          <button className="btn" onClick={() => setEditing('new')}>
            New skill
          </button>
        }
      />
      <ErrorBar error={error} />

      {skills === null ? null : skills.length === 0 ? (
        <EmptyState
          title="No skills yet"
          hint="A skill is a markdown file the agents read before working — coding conventions, review checklists, domain knowledge."
          action={
            <button className="btn" onClick={() => setEditing('new')}>
              Write the first skill
            </button>
          }
        />
      ) : (
        <ListCard>
          {skills.map((s) => (
            <div key={s.name} className="flex flex-wrap items-center gap-2.5 px-4 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[13px] font-medium">{s.name}</span>
                  <span className="dim">updated {timeAgo(s.updatedAt)}</span>
                </div>
                <p className="dim mt-0.5 truncate">{preview(s.content)}</p>
              </div>
              <button className="btn-ghost" onClick={() => setEditing(s)}>
                Edit
              </button>
              <span className="action-sep" aria-hidden />
              <button className="btn-danger-ghost" onClick={() => void remove(s.name)}>
                Delete
              </button>
            </div>
          ))}
        </ListCard>
      )}

      {editing ? (
        <SkillEditorModal
          skill={editing === 'new' ? null : editing}
          existingNames={new Set((skills ?? []).map((s) => s.name))}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      ) : null}
      {confirmElement}
    </Page>
  );
}

function preview(content: string): string {
  const line = content
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l.length > 0);
  return line ?? 'empty';
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function SkillEditorModal({
  skill,
  existingNames,
  onClose,
  onSaved,
}: {
  skill: SkillFile | null;
  existingNames: ReadonlySet<string>;
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [name, setName] = useState(skill?.name ?? '');
  const [content, setContent] = useState(
    skill?.content ?? '# When to use\n\nDescribe when and how agents should use this skill.\n',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [genInstructions, setGenInstructions] = useState('');
  const [generating, setGenerating] = useState(false);

  const generate = async (): Promise<void> => {
    setGenerating(true);
    setError(null);
    try {
      const { draft } = await api.generateSkill(genInstructions.trim());
      if (skill === null) setName(draft.name);
      setContent(draft.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  const trimmedName = name.trim();
  const nameTaken = skill === null && existingNames.has(trimmedName);
  const nameValid = NAME_RE.test(trimmedName);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!nameValid || nameTaken) return;
    setBusy(true);
    setError(null);
    try {
      await api.saveSkill(trimmedName, content);
      onSaved();
    } catch (err) {
      setError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={skill ? `Edit skill — ${skill.name}` : 'New skill'} onClose={onClose} wide>
      <div className="mb-4 flex items-end gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <Field label="Generate with AI — describe what the skill should teach the agents" className="min-w-0 flex-1">
          <input
            className="input"
            placeholder="e.g. our TypeScript review conventions: no any, exhaustive switches, zod at boundaries"
            value={genInstructions}
            onChange={(e) => setGenInstructions(e.target.value)}
            disabled={generating}
          />
        </Field>
        <button
          type="button"
          className={`flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 text-sm font-medium transition-colors disabled:cursor-default disabled:opacity-50 ${aiAccentClass(false)}`}
          disabled={generating || genInstructions.trim().length < 8}
          onClick={() => void generate()}
        >
          <SparkleIcon />
          {generating ? 'Generating…' : 'Generate'}
        </button>
      </div>
      <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
        <Field label="Name (lowercase letters, digits, dashes)">
          <input
            className="input font-mono disabled:opacity-60"
            required
            disabled={skill !== null}
            placeholder="review-checklist"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={trimmedName.length > 0 && (!nameValid || nameTaken)}
            autoFocus={skill === null}
          />
          {nameTaken ? <span className="text-xs text-red-600 dark:text-red-400">A skill with this name already exists.</span> : null}
        </Field>
        <Field label="Content (markdown)">
          <textarea
            className="input min-h-80 w-full resize-y font-mono text-xs leading-relaxed"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            autoFocus={skill !== null}
          />
        </Field>
        <ErrorBar error={error} />
        <FormActions>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={busy || !nameValid || nameTaken}>
            {busy ? 'Saving…' : skill ? 'Save changes' : 'Create skill'}
          </button>
        </FormActions>
      </form>
    </Modal>
  );
}
