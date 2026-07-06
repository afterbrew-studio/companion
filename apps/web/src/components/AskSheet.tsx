import { useState } from 'react';
import type { AskRequest } from '@companion/contract';

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
      <div className="ask-sheet">
        <div className="ask-title">
          Permission: <strong>{ask.tool?.name ?? 'tool'}</strong>
        </div>
        <pre className="ask-input">{safeJson(ask.tool?.input)}</pre>
        <div className="ask-actions">
          <button onClick={() => onRespond({ mode: 'allow' })}>Allow</button>
          <button onClick={() => onRespond({ mode: 'allow_session' })}>Allow for session</button>
          <button className="danger" onClick={() => onRespond({ mode: 'deny' })}>
            Deny
          </button>
        </div>
      </div>
    );
  }

  if (ask.kind === 'approval') {
    const options = ask.approval?.options ?? [];
    return (
      <div className="ask-sheet">
        <div className="ask-title">{ask.approval?.title ?? 'Approval requested'}</div>
        {ask.approval?.body ? <p>{ask.approval.body}</p> : null}
        <div className="ask-actions">
          {options.map((opt) => (
            <button key={opt.id} onClick={() => onRespond({ optionId: opt.id })}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="ask-sheet">
      <div className="ask-title">{ask.workflow?.label ?? 'Input requested'}</div>
      {ask.workflow?.prompt ? <p>{ask.workflow.prompt}</p> : null}
      <div className="ask-actions">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Reply…" />
        <button onClick={() => onRespond({ text })}>Send</button>
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
