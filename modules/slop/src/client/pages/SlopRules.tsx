import { useState } from 'react';
import {
  Breadcrumb,
  EmptyState,
  ErrorBar,
  Field,
  FormActions,
  IconButton,
  Modal,
  Page,
  PageHeader,
  PageLoading,
  Switch,
  useConfirm,
} from '@moxxy/companion-sdk/ui';
import { NavIcon } from '@moxxy/companion-sdk/client';
import { useAuth } from '@companion/module-core/client';
import type { SlopRuleRecord } from '../../contract/index.js';
import { slopApi } from '../api.js';
import { useSlopRules } from '../hooks/useSlopRules.js';

/**
 * The workspace's detection rule set: built-ins toggle per workspace, custom
 * rules are full CRUD. A rule's instructions are fed verbatim to the one-shot
 * detection agent alongside every other enabled rule.
 */
export default function SlopRules(): React.JSX.Element {
  const { current, rules, error, setError } = useSlopRules();
  const { can } = useAuth();
  const { confirmDanger, confirmElement } = useConfirm();
  const [editing, setEditing] = useState<SlopRuleRecord | 'new' | null>(null);

  if (!current) return <EmptyState title="No workspace selected" />;
  const canManage = can('slop:manage');
  const canGenerate = can('runs:read') && can('runs:act');

  const toggle = async (rule: SlopRuleRecord, enabled: boolean): Promise<void> => {
    try {
      await slopApi.toggleRule(rule.id, current.id, enabled);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const remove = async (rule: SlopRuleRecord): Promise<void> => {
    const ok = await confirmDanger({
      title: 'Delete rule',
      message: `Delete the rule "${rule.name}"? Future assessments will run without it; past verdicts keep their signals.`,
    });
    if (!ok) return;
    try {
      await slopApi.deleteRule(rule.id);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  };

  return (
    <Page>
      <Breadcrumb items={[{ label: 'Contribution Quality', href: '#/slop' }, { label: 'Rules' }]} />
      <PageHeader
        title="Quality Rules"
        subtitle={current.name}
        actions={
          canManage ? (
            <button className="btn" onClick={() => setEditing('new')}>
              New rule
            </button>
          ) : undefined
        }
      />
      <ErrorBar error={error} className="mb-3" />

      {rules === null ? (
        <PageLoading label="Loading rules…" />
      ) : (
        <div className="flex flex-col gap-2">
          {rules.map((rule) => (
            <div
              key={rule.id}
              className={`flex items-start gap-3 rounded-xl border border-zinc-200 bg-white p-3.5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 ${rule.enabled ? '' : 'opacity-60'}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-medium">{rule.name}</h2>
                  {rule.builtin ? <span className="badge">built-in</span> : null}
                </div>
                <p className="dim mt-0.5 text-xs">{rule.description}</p>
              </div>
              {canManage ? (
                <div className="flex shrink-0 items-center gap-1">
                  {!rule.builtin ? (
                    <>
                      <IconButton label="Edit rule" onClick={() => setEditing(rule)}>
                        <NavIcon>
                          <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z" />
                        </NavIcon>
                      </IconButton>
                      <IconButton label="Delete rule" danger onClick={() => void remove(rule)}>
                        <NavIcon>
                          <path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13M10 11v5M14 11v5" />
                        </NavIcon>
                      </IconButton>
                    </>
                  ) : null}
                  <Switch
                    checked={rule.enabled}
                    onChange={(v) => void toggle(rule, v)}
                    label={`${rule.enabled ? 'Disable' : 'Enable'} ${rule.name}`}
                  />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}

      {editing ? (
        <RuleEditor
          workspaceId={current.id}
          rule={editing === 'new' ? null : editing}
          canGenerate={canGenerate}
          onClose={() => setEditing(null)}
          onError={setError}
        />
      ) : null}
      {confirmElement}
    </Page>
  );
}

function RuleEditor({
  workspaceId,
  rule,
  canGenerate,
  onClose,
  onError,
}: {
  workspaceId: string;
  rule: SlopRuleRecord | null;
  canGenerate: boolean;
  onClose: () => void;
  onError: (e: string | null) => void;
}): React.JSX.Element {
  const [name, setName] = useState(rule?.name ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');
  const [instructions, setInstructions] = useState(rule?.instructions ?? '');
  const [busy, setBusy] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);

  const generate = async (): Promise<void> => {
    const prompt = aiPrompt.trim();
    if (prompt.length < 3 || generating) return;
    setGenerating(true);
    setGenError(null);
    try {
      const { draft } = await slopApi.generateRule(workspaceId, prompt);
      setName(draft.name);
      setDescription(draft.description);
      setInstructions(draft.instructions);
    } catch (err) {
      setGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  const submit = async (): Promise<void> => {
    setBusy(true);
    try {
      const fields = { name: name.trim(), description: description.trim(), instructions: instructions.trim() };
      if (rule) await slopApi.updateRule(rule.id, fields);
      else await slopApi.createRule(workspaceId, fields);
      onError(null);
      onClose();
    } catch (err) {
      onError(String(err));
      setBusy(false);
    }
  };

  return (
    <Modal title={rule ? `Edit rule: ${rule.name}` : 'New quality rule'} onClose={onClose} wide>
      <div className="flex flex-col gap-4">
        {!rule && canGenerate ? (
          <div className="border-b border-zinc-200 pb-4 dark:border-zinc-800">
            <Field
              label="Generate with AI"
              hint="Describe a tell your team keeps seeing (e.g. “PRs whose tests assert nothing”): the draft fills the fields below for review."
            >
              <div className="flex items-center gap-2">
                <input
                  className="input flex-1"
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value)}
                  maxLength={2_000}
                  placeholder="e.g. lockfile churn unrelated to the change"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void generate();
                  }}
                />
                <button
                  className="btn-ghost shrink-0"
                  disabled={generating || aiPrompt.trim().length < 3}
                  onClick={() => void generate()}
                >
                  {generating ? 'Drafting… (asking the agent)' : '✦ Generate'}
                </button>
              </div>
            </Field>
            <ErrorBar error={genError} className="mt-2" />
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Commit-message tells"
              maxLength={80}
            />
          </Field>
          <Field label="Description">
            <input
              className="input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="One line for the rules list"
              maxLength={300}
            />
          </Field>
        </div>
        <Field
          label="Instructions"
          hint="Fed verbatim to the assessment agent. Describe the signal, what evidence to look for, and how strongly to weigh it."
        >
          <textarea
            className="input min-h-40"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            maxLength={8_000}
          />
        </Field>
        <FormActions>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn"
            disabled={busy || generating || name.trim().length < 2 || instructions.trim().length < 8}
            onClick={() => void submit()}
          >
            {busy ? 'Saving…' : rule ? 'Save rule' : 'Create rule'}
          </button>
        </FormActions>
      </div>
    </Modal>
  );
}
