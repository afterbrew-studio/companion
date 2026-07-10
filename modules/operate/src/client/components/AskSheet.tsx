import { useState } from 'react';
import type { AskRequest } from '@companion/types';

export function AskSheet({
  ask,
  onRespond,
}: {
  ask: AskRequest;
  onRespond: (response: Record<string, unknown>) => void;
}): JSX.Element {
  const [text, setText] = useState('');

  if (ask.kind === 'permission') {
    return (
      <div className="my-2 rounded-xl border border-amber-500/70 bg-zinc-50 p-4 dark:bg-zinc-900">
        <div className="text-[13px]">
          Permission: <strong>{ask.tool?.name ?? 'tool'}</strong>
        </div>
        <pre className="mono-pane mt-2 max-h-40">{safeJson(ask.tool?.input)}</pre>
        <div className="mt-2.5 flex gap-2">
          <button className="btn" onClick={() => onRespond({ mode: 'allow' })}>
            Allow
          </button>
          <button className="btn-ghost" onClick={() => onRespond({ mode: 'allow_session' })}>
            Allow for session
          </button>
          <span className="action-sep" aria-hidden />
          <button className="btn-danger-ghost" onClick={() => onRespond({ mode: 'deny' })}>
            Deny
          </button>
        </div>
      </div>
    );
  }

  if (ask.kind === 'approval') {
    const options = ask.approval?.options ?? [];
    return (
      <div className="my-2 rounded-xl border border-amber-500/70 bg-zinc-50 p-4 dark:bg-zinc-900">
        <div className="text-[13px] font-medium">{ask.approval?.title ?? 'Approval requested'}</div>
        {ask.approval?.body ? <p className="mt-1 text-sm">{ask.approval.body}</p> : null}
        <div className="mt-2.5 flex flex-wrap gap-2">
          {options.map((opt) => (
            <button key={opt.id} className="btn-ghost" onClick={() => onRespond({ optionId: opt.id })}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="my-2 rounded-xl border border-amber-500/70 bg-zinc-50 p-4 dark:bg-zinc-900">
      <div className="text-[13px] font-medium">{ask.workflow?.label ?? 'Input requested'}</div>
      {ask.workflow?.prompt ? <p className="mt-1 text-sm">{ask.workflow.prompt}</p> : null}
      <div className="mt-2.5 flex gap-2">
        <input className="input flex-1" value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply…" />
        <button className="btn" onClick={() => onRespond({ text })}>
          Send
        </button>
      </div>
    </div>
  );
}

function safeJson(value: unknown): string {
  try {
    const raw = JSON.stringify(value, null, 2) ?? '';
    return raw.length > 800 ? `${raw.slice(0, 800)}…` : raw;
  } catch {
    return String(value);
  }
}
