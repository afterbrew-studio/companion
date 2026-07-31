import { useEffect, useMemo, useRef, useState } from 'react';
import { Markdown, type DiffAnnotation } from '@moxxy/companion-sdk/ui';
import { FindingChat } from './FindingChat.js';
import type { FindingSeverity, ReviewFinding } from '../../../contract/index.js';
import { FINDING_SEVERITIES } from '../../../contract/index.js';

const SEVERITY_CLS: Record<FindingSeverity, string> = {
  blocker: 'badge-danger',
  major: 'badge-warn',
  minor: 'badge',
  nit: 'badge',
};

const SEVERITY_TEXT: Record<FindingSeverity, string> = {
  blocker: 'text-red-500',
  major: 'text-amber-500',
  minor: 'text-yellow-500',
  nit: 'text-zinc-400',
};

const SEVERITY_DOT: Record<FindingSeverity, string> = {
  blocker: 'bg-red-500',
  major: 'bg-amber-500',
  minor: 'bg-yellow-500',
  nit: 'bg-zinc-400',
};

/**
 * Anchored findings as annotations for the diff viewer.
 *
 * Dropped findings leave the diff entirely: a reviewer who rejected a comment
 * should not keep tripping over it while reading the code. They stay in the
 * list, where the decision can be undone.
 */
export function useFindingAnnotations(findings: readonly ReviewFinding[]): DiffAnnotation[] {
  return useMemo(
    () =>
      findings
        .filter((f) => f.anchor !== null && f.state !== 'rejected')
        .map((f) => ({
          id: f.id,
          path: f.anchor!.file,
          side: f.anchor!.side,
          line: f.anchor!.line,
          marker: <span className={SEVERITY_TEXT[f.severity]}>●</span>,
          body: (
            <div className="font-sans">
              <div className="flex flex-wrap items-center gap-2">
                {f.source === 'human' ? <span className="badge">your comment</span> : null}
                <span className={SEVERITY_CLS[f.severity]}>{f.severity}</span>
                {f.verification === 'confirmed' ? <span className="badge-ok">verified</span> : null}
                {f.verification === 'refuted' ? <span className="badge-warn">refuted</span> : null}
                {f.state === 'included' ? <span className="badge">will post</span> : null}
                {f.state === 'posted' ? <span className="badge-ok">posted</span> : null}
              </div>
              <p className="mt-1.5 text-[13px] font-medium">{f.title}</p>
              {f.reason.trim() ? <p className="dim mt-1 text-xs">{f.reason}</p> : null}
            </div>
          ),
        })),
    [findings],
  );
}

/**
 * The findings of one review, each armed or dropped independently before the
 * review is posted.
 *
 * Ordered by severity rather than by the order the agent happened to emit
 * them: what decides whether this pull request ships should not be below a
 * naming nit. Refuted findings are collapsed out of the way but never hidden
 * outright, because the verifier is wrong sometimes too.
 */
export function ReviewFindings({
  reviewId,
  findings,
  canAct,
  busy,
  onToggle,
  onReject,
  focusedFinding = null,
  onFocusFinding,
}: {
  reviewId: string;
  findings: readonly ReviewFinding[];
  canAct: boolean;
  busy: boolean;
  onToggle: (id: string, include: boolean) => void;
  onReject: (id: string, reason: string) => void;
  /** Shared with the diff viewer; both surfaces point at the same finding. */
  focusedFinding?: string | null;
  onFocusFinding?: (id: string | null) => void;
}): JSX.Element | null {
  const [showRefuted, setShowRefuted] = useState(false);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const ordered = [...findings].sort(
    (a, b) => FINDING_SEVERITIES.indexOf(a.severity) - FINDING_SEVERITIES.indexOf(b.severity),
  );
  const refuted = ordered.filter((f) => f.verification === 'refuted');
  const visible = showRefuted ? ordered : ordered.filter((f) => f.verification !== 'refuted');
  const included = visible.filter((f) => f.state === 'included' || f.state === 'posted').length;

  // j/k to walk the list, a to arm, x to drop: a reviewer works through
  // findings faster than a mouse allows, and this is the whole point of a
  // dedicated surface rather than reading them on GitHub.
  useEffect(() => {
    if (!canAct) return;
    const step = (by: number): void => {
      const next = Math.min(Math.max(cursor + by, 0), visible.length - 1);
      setCursor(next);
      const finding = visible[next];
      if (finding) onFocusFinding?.(finding.id);
    };
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (!listRef.current?.offsetParent) return;
      const current = visible[cursor];
      if (e.key === 'j') step(1);
      else if (e.key === 'k') step(-1);
      else if (e.key === 'a' && current) onToggle(current.id, true);
      else if (e.key === 'x' && current) onToggle(current.id, false);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canAct, cursor, visible, onToggle, onFocusFinding]);

  // Focus set from the diff moves the cursor, so keyboard work continues from
  // wherever the reviewer just clicked.
  useEffect(() => {
    if (!focusedFinding) return;
    const at = visible.findIndex((f) => f.id === focusedFinding);
    if (at >= 0) setCursor(at);
  }, [focusedFinding, visible]);

  if (findings.length === 0) return null;

  return (
    <div className="mt-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <strong className="text-sm">Findings</strong>
        <span className="dim text-xs tabular-nums">
          {included} of {visible.length} selected
        </span>
        <span className="flex-1" />
        {refuted.length > 0 ? (
          <button className="linkish text-xs" onClick={() => setShowRefuted((v) => !v)}>
            {showRefuted ? 'Hide' : 'Show'} {refuted.length} refuted
          </button>
        ) : null}
        {canAct ? <span className="dim hidden text-[11px] sm:inline">j/k move · a keep · x drop</span> : null}
      </div>

      <ul ref={listRef} className="flex flex-col gap-2">
        {visible.map((finding, i) => (
          <FindingCard
            key={finding.id}
            reviewId={reviewId}
            finding={finding}
            focused={i === cursor || finding.id === focusedFinding}
            canAct={canAct}
            busy={busy}
            onFocus={() => {
              setCursor(i);
              onFocusFinding?.(finding.id);
            }}
            onToggle={onToggle}
            onReject={onReject}
          />
        ))}
      </ul>
    </div>
  );
}

function FindingCard({
  reviewId,
  finding,
  focused,
  canAct,
  busy,
  onFocus,
  onToggle,
  onReject,
}: {
  reviewId: string;
  finding: ReviewFinding;
  focused: boolean;
  canAct: boolean;
  busy: boolean;
  onFocus: () => void;
  onToggle: (id: string, include: boolean) => void;
  onReject: (id: string, reason: string) => void;
}): JSX.Element {
  const [reason, setReason] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [discussing, setDiscussing] = useState(false);
  const included = finding.state === 'included';
  const posted = finding.state === 'posted';
  const rejected = finding.state === 'rejected';

  return (
    <li
      className={`card anim-in py-3 transition-colors ${focused ? 'ring-1 ring-accent-500/60' : ''} ${
        rejected || finding.verification === 'refuted' ? 'opacity-60' : ''
      }`}
    >
      {/* Only the card's own header and body select it. On the whole <li> this
          fired for the Discuss button, the chat box and the drop-reason input
          too, so opening the discussion immediately scrolled the page away from
          it and expanded a diff nobody asked to see. */}
      <div className="flex flex-wrap items-center gap-2" onClick={onFocus}>
        <span className={`size-2 shrink-0 rounded-full ${SEVERITY_DOT[finding.severity]}`} aria-hidden />
        {finding.source === 'human' ? <span className="badge">your comment</span> : null}
        <span className={SEVERITY_CLS[finding.severity]}>{finding.severity}</span>
        {finding.anchor ? (
          <code className="min-w-0 truncate text-[11px]">
            {finding.anchor.file}:{finding.anchor.startLine ? `${finding.anchor.startLine}-` : ''}
            {finding.anchor.line}
          </code>
        ) : (
          <span className="dim text-[11px]" title="Not tied to a line of this diff — posted in the review summary">
            no line anchor
          </span>
        )}
        {finding.verification === 'confirmed' ? (
          <span className="badge-ok" title={finding.verificationNote ?? undefined}>
            verified
          </span>
        ) : null}
        {finding.verification === 'refuted' ? (
          <span className="badge-warn" title={finding.verificationNote ?? undefined}>
            refuted
          </span>
        ) : null}
        <span className="flex-1" />
        {posted ? <span className="badge-ok">posted</span> : null}
        {rejected ? <span className="badge">dropped</span> : null}
      </div>

      {finding.source === 'human' ? (
        <div className="mt-2 text-[13px]">
          <Markdown text={finding.reason} />
        </div>
      ) : (
        <>
          <p className="mt-2 text-[13px] font-medium">{finding.title}</p>
          {finding.reason.trim() ? (
            <div className="mt-1.5 text-[13px]">
              <Markdown text={finding.reason} />
            </div>
          ) : null}
        </>
      )}
      {finding.impact.trim() ? <p className="dim mt-1.5 text-xs">Impact: {finding.impact}</p> : null}
      {finding.suggestion.trim() ? (
        <div className="mt-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-[13px] dark:border-zinc-800">
          <Markdown text={finding.suggestion} />
        </div>
      ) : null}
      {finding.suggestedPatch ? (
        <pre className="mt-1.5 overflow-x-auto rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-[11px]">
          <code>{finding.suggestedPatch}</code>
        </pre>
      ) : null}
      {finding.verificationNote && finding.verification === 'refuted' ? (
        <p className="dim mt-1.5 text-xs">Verifier: {finding.verificationNote}</p>
      ) : null}
      {finding.rejectionReason ? <p className="dim mt-1.5 text-xs">Dropped: {finding.rejectionReason}</p> : null}

      {canAct && !posted ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-zinc-200/80 pt-2.5 dark:border-zinc-800">
          {rejecting ? (
            <>
              <input
                className="input flex-1 text-xs"
                placeholder="Why is this not worth posting? (feeds future reviews)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                autoFocus
              />
              <button className="btn-ghost" onClick={() => setRejecting(false)}>
                Cancel
              </button>
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  onReject(finding.id, reason.trim());
                  setRejecting(false);
                  setReason('');
                }}
              >
                Drop
              </button>
            </>
          ) : (
            <>
              <label className="flex cursor-pointer items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={included}
                  disabled={busy}
                  onChange={(e) => onToggle(finding.id, e.target.checked)}
                />
                Post this comment
              </label>
              <span className="flex-1" />
              {finding.source === 'human' ? null : (
                <button className="btn-ghost text-xs" onClick={() => setDiscussing((v) => !v)}>
                  {discussing ? 'Hide discussion' : 'Discuss'}
                </button>
              )}
              <button className="btn-ghost text-xs" disabled={busy} onClick={() => setRejecting(true)}>
                Drop with reason
              </button>
            </>
          )}
        </div>
      ) : null}

      {discussing ? <FindingChat reviewId={reviewId} finding={finding} canAct={canAct} /> : null}
    </li>
  );
}
