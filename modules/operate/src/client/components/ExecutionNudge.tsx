import { useEffect, useState } from 'react';
import { CloseIcon, IconButton } from '@moxxy/companion-ui';
import { onServerMessage } from '@moxxy/companion-core/client';
import type { OperateStatus } from '../../contract/index.js';
import { operateApi } from '../api.js';

const DISMISS_KEY = 'companion.operate.execution-nudge.dismissed';

/**
 * Shell banner while agents literally cannot run: no attached runner is ready
 * and this machine has no ready runtime CLI. Reads the same /api/status
 * `executionReady` the AgentsStatus pill reports, kept fresh on
 * `runners.changed` so attaching a machine clears it without a reload.
 * Dismissal sticks per browser.
 */
export function NoExecutionBanner(): React.JSX.Element | null {
  const [status, setStatus] = useState<OperateStatus | null>(null);
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) !== null);

  useEffect(() => {
    if (dismissed) return;
    let alive = true;
    const load = (): void => {
      operateApi
        .status()
        .then((s) => alive && setStatus(s))
        .catch(() => alive && setStatus(null));
    };
    load();
    const off = onServerMessage((msg) => {
      if (msg.t === 'runners.changed') load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [dismissed]);

  const dismiss = (): void => {
    localStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  };

  if (dismissed || !status || status.executionReady) return null;
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-amber-300/70 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200"
      role="status"
    >
      <span className="size-1.5 shrink-0 rounded-full bg-amber-500" aria-hidden />
      <span>
        <strong>Agents cannot run yet</strong>, attach a runner or install a runtime CLI.
      </span>
      <a href="#/runners" className="shrink-0 font-medium underline underline-offset-2">
        Open Runners
      </a>
      <span className="ml-auto">
        <IconButton label="Dismiss" onClick={dismiss}>
          <CloseIcon />
        </IconButton>
      </span>
    </div>
  );
}
