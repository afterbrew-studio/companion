import { useCallback, useState } from 'react';
import { useKernel, useLive } from '@moxxy/companion-sdk/client';
import { useAuth } from '@companion/module-core/client';
import { useWorkspace } from '@companion/module-workspace/client';
import { EmptyState, ErrorBar, Page, PageHeader, PageLoading, SegmentedControl } from '@moxxy/companion-sdk/ui';
import type { AgentQuality } from '../../contract/index.js';
import { codeApi as api } from '../api.js';
import { QualityStat, hasQualitySignal } from '../components/QualityStat.js';

const WINDOWS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
] as const;

/**
 * Is the agent's judgement worth trusting?
 *
 * Every number here is derived from outcome columns the verdict tables already
 * carry, so nothing had to start being recorded and nothing can drift from the
 * rows it describes. The one thing the page will not do is invent a score: a
 * surface nobody has decided on yet reports "no decisions yet" rather than a
 * flattering 100%.
 *
 * Surfaces owned by modules that depend on code contribute through the
 * `quality.panels` slot, because code cannot import them.
 */
export function AgentQualityPage(): React.JSX.Element {
  const { current } = useWorkspace();
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const [quality, setQuality] = useState<AgentQuality | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!current) return;
    try {
      setQuality(await api.agentQuality(current.id, Number(days)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [current, days]);
  // Only this module's own messages: a slot panel fetches its own data and
  // listens for its own module's signal, which is what keeps code free of any
  // reference to the modules that depend on it.
  useLive(refresh, (msg) => msg.t === 'triage.changed' || msg.t === 'prs.changed');

  if (!current) {
    return (
      <Page>
        <EmptyState title="No workspace yet" hint="Create a workspace from the sidebar switcher first." />
      </Page>
    );
  }
  if (quality === null && error === null) return <PageLoading label="Loading agent quality…" />;

  const surfaces = quality?.surfaces ?? [];

  return (
    <Page>
      <PageHeader
        title="Agent quality"
        subtitle="How often a human accepts what the agents propose, per surface"
        actions={
          <SegmentedControl
            value={days}
            onChange={setDays}
            options={WINDOWS}
            label="Reporting window"
            name="quality-window"
          />
        }
      />
      <ErrorBar error={error} />

      {surfaces.length > 0 && !surfaces.some(hasQualitySignal) ? (
        // One empty state for the page, not the same sentence repeated in every
        // card next to a column of zeros. Nothing has happened yet, and saying
        // so once is the whole message.
        <EmptyState
          title="Nothing to judge yet"
          hint={`No agent verdict has been raised in the last ${days} days. Triage an issue or run an AI review, then come back: this page reports how often you accept what they propose.`}
        />
      ) : (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            {surfaces.map((stat) => (
              <QualityStat key={stat.surface} stat={stat} />
            ))}
            <QualityPanels days={Number(days)} />
          </div>

          <details className="mt-4 max-w-2xl">
            <summary className="dim cursor-pointer text-xs">How the number is worked out</summary>
            <p className="dim mt-1.5 text-xs">
              Accepted means a human applied the verdict; dismissed means they rejected it. Verdicts still awaiting a
              decision are excluded from the percentage rather than counted either way, so the number tracks quality
              rather than how far behind the queue is. Runs that produced nothing are a reliability problem and are
              counted separately.
            </p>
          </details>
        </>
      )}
    </Page>
  );
}

/**
 * Panels contributed by other modules. Same slot mechanism the dashboard uses:
 * they render into this page, this module never imports theirs, and each
 * contribution is gated on its own permission.
 */
function QualityPanels({ days }: { days: number }): React.JSX.Element | null {
  const kernel = useKernel();
  const { can } = useAuth();
  const panels = kernel.slots('quality.panels').filter((s) => s.permission === undefined || can(s.permission));
  if (panels.length === 0) return null;
  return (
    <>
      {panels.map((s) => (
        <s.component key={s.key} days={days} />
      ))}
    </>
  );
}
