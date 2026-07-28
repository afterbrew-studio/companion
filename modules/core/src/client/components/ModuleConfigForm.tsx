import { useState } from 'react';
import type { ModuleConfigField, ModuleConfigState, ModuleConfigValue } from '@moxxy/companion-core';
import { Dropdown, ErrorBar, Field, FormActions, SettingRow, Switch } from '@moxxy/companion-ui';

/**
 * Renders a module's declared config fields (the manifest spec) as a form and
 * submits only the DIRTY keys — untouched fields stay on their stored value or
 * default. Secrets follow the wire convention: the stored value never reaches
 * the client (only a set/unset flag), typing replaces it, "Clear" sends the
 * explicit `null`, and an untouched blank input sends nothing.
 */

type Draft = Record<string, ModuleConfigValue>;
/** Secret keys the user explicitly cleared (null on the wire). */
type Cleared = ReadonlySet<string>;

/** The effective pre-edit value the form seeds from and diffs against. */
function seed(fields: readonly ModuleConfigField[], state?: ModuleConfigState): Draft {
  const draft: Draft = {};
  for (const f of fields) {
    if (f.kind === 'secret') {
      draft[f.key] = ''; // never prefilled — typing = replace
      continue;
    }
    const stored = state?.values[f.key];
    draft[f.key] = stored ?? f.default ?? (f.kind === 'boolean' ? false : '');
  }
  return draft;
}

export function ModuleConfigForm({
  fields,
  state,
  busy,
  error,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  fields: readonly ModuleConfigField[];
  /** Stored (redacted) config — absent on install, when nothing is stored yet. */
  state?: ModuleConfigState;
  busy: boolean;
  error: string | null;
  submitLabel: string;
  onSubmit: (patch: Record<string, ModuleConfigValue | null>) => void;
  onCancel: () => void;
}): JSX.Element {
  // Recomputed per render, but only ever read against the CURRENT draft — the
  // form remounts (keyed modal) when the target module changes.
  const initial = seed(fields, state);
  const [draft, setDraft] = useState<Draft>(initial);
  const [cleared, setCleared] = useState<Cleared>(new Set());

  const set = (key: string, value: ModuleConfigValue): void => setDraft((d) => ({ ...d, [key]: value }));

  const patch = (): Record<string, ModuleConfigValue | null> => {
    const out: Record<string, ModuleConfigValue | null> = {};
    for (const f of fields) {
      if (f.kind === 'secret') {
        const typed = String(draft[f.key] ?? '');
        if (typed !== '') out[f.key] = typed;
        else if (cleared.has(f.key)) out[f.key] = null;
        continue;
      }
      // Blanking a stored number = "revert to default" (the explicit null).
      if (f.kind === 'number' && draft[f.key] === '') {
        if (initial[f.key] !== '') out[f.key] = null;
        continue;
      }
      // A required field with no default and nothing stored must always be
      // sent, dirty or not — a boolean left on its seeded `false` is a real
      // answer, and omitting it would 409 the install as unconfigured.
      const mustSend = f.required === true && f.default === undefined && state?.values[f.key] === undefined;
      if (draft[f.key] !== initial[f.key] || mustSend) out[f.key] = draft[f.key]!;
    }
    return out;
  };

  /** A required field is satisfiable: has a value in the draft, a stored secret, or a default. */
  const missingRequired = fields.some((f) => {
    if (!f.required) return false;
    if (f.kind === 'secret') return String(draft[f.key] ?? '') === '' && !(state?.secrets[f.key] && !cleared.has(f.key));
    if (f.default !== undefined) return false;
    return draft[f.key] === '' || draft[f.key] === undefined;
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(patch());
      }}
    >
      <div className="flex flex-col gap-4">
        {fields.map((f) => (
          <ConfigField
            key={f.key}
            field={f}
            value={draft[f.key] ?? ''}
            secretSet={f.kind === 'secret' ? (state?.secrets[f.key] ?? false) && !cleared.has(f.key) : false}
            onChange={(v) => set(f.key, v)}
            onClearSecret={() => {
              set(f.key, '');
              setCleared((c) => new Set(c).add(f.key));
            }}
          />
        ))}
      </div>
      <ErrorBar error={error} className="mt-3" />
      <FormActions divider>
        <button type="button" className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn" disabled={busy || missingRequired}>
          {busy ? 'Saving…' : submitLabel}
        </button>
      </FormActions>
    </form>
  );
}

function ConfigField({
  field,
  value,
  secretSet,
  onChange,
  onClearSecret,
}: {
  field: ModuleConfigField;
  value: ModuleConfigValue;
  /** kind:'secret' only — a value is stored server-side and not marked cleared. */
  secretSet: boolean;
  onChange: (v: ModuleConfigValue) => void;
  onClearSecret: () => void;
}): JSX.Element {
  const label = field.required ? `${field.label} *` : field.label;

  switch (field.kind) {
    case 'boolean':
      return (
        <SettingRow title={label} description={field.description}>
          <Switch checked={value === true} label={field.label} onChange={(v) => onChange(v)} />
        </SettingRow>
      );
    case 'select':
      return (
        <Field label={label} hint={field.description}>
          <Dropdown
            value={value === '' ? null : String(value)}
            onChange={(v) => onChange(v)}
            options={(field.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
            ariaLabel={field.label}
            placeholder={field.placeholder ?? 'Choose…'}
          />
        </Field>
      );
    case 'number':
      return (
        <Field label={label} hint={field.description}>
          <input
            className="input"
            type="number"
            value={value === '' ? '' : Number(value)}
            min={field.min}
            max={field.max}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
          />
        </Field>
      );
    case 'secret':
      return (
        <Field
          label={label}
          hint={
            secretSet ? (
              <span className="flex items-center gap-2">
                <span>A value is saved — leave blank to keep it.</span>
                <button type="button" className="cursor-pointer underline hover:text-red-600" onClick={onClearSecret}>
                  Clear
                </button>
              </span>
            ) : (
              field.description
            )
          }
        >
          <input
            className="input font-mono"
            type="password"
            autoComplete="new-password"
            value={String(value)}
            placeholder={secretSet ? '•••••••• (saved)' : field.placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        </Field>
      );
    case 'text':
      return (
        <Field label={label} hint={field.description}>
          <input
            className="input"
            type="text"
            value={String(value)}
            minLength={field.min}
            maxLength={field.max}
            placeholder={field.placeholder}
            onChange={(e) => onChange(e.target.value)}
          />
        </Field>
      );
  }
}
