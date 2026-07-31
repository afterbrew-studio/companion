import { useCallback, useState } from 'react';
import { defineSlots, useLive } from '@moxxy/companion-sdk/client';
import { ListCard, Section, timeAgo } from '@moxxy/companion-sdk/ui';
import { QualityStat, usePrSelection } from '@companion/module-code/client';
import { useWorkspace } from '@companion/module-workspace/client';
import type { AgentQualityStat } from '@companion/module-code/contract';
import { SlopMeter } from './components/SlopMeter.js';
import { useSlopDetections } from './hooks/useSlopDetections.js';
import { slopApi } from './api.js';

/**
 * Contributions rendered INTO other modules' pages. The dashboard (module-code)
 * exposes `dashboard.widgets`; slop drops its radar there so high-scoring PRs
 * awaiting review are visible at a glance, without code importing this module.
 */

const RADAR_MIN_LIKELIHOOD = 50;

function SlopRadarWidget(): JSX.Element | null {
  const { detections } = useSlopDetections();
  const hot = (detections ?? [])
    .filter((d) => d.status === 'pending' && (d.verdict?.aiLikelihood ?? 0) >= RADAR_MIN_LIKELIHOOD)
    .sort(
      (a, b) =>
        (b.verdict?.aiLikelihood ?? 0) - (a.verdict?.aiLikelihood ?? 0) || b.createdAt - a.createdAt,
    )
    .slice(0, 5);
  // No blip, no widget: the dashboard stays quiet when the radar is clear.
  if (hot.length === 0) return null;
  return (
    <Section
      title="Slop radar"
      description={
        <>
          PRs with elevated AI-likelihood scores awaiting review.{' '}
          <a className="linkish" href="#/slop">
            View all detections
          </a>
        </>
      }
    >
      <ListCard ariaLabel="Slop detections awaiting review">
        {hot.map((d) => (
          <a key={d.id} className="row-link" href={`#/slop/${d.id}`}>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{d.prTitle}</span>
              <span className="dim mt-0.5 block truncate font-mono text-xs">
                {d.repo}#{d.prNumber} · {timeAgo(d.createdAt)}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2.5">
              <span className="dim hidden text-[11px] sm:inline">AI likelihood</span>
              <SlopMeter value={d.verdict?.aiLikelihood ?? 0} />
            </span>
          </a>
        ))}
      </ListCard>
    </Section>
  );
}

/**
 * Slop's row on code's Agent quality page. It fetches its own aggregate and
 * listens for its own module's signal, so code needs no reference to this module
 * and a build without slop simply has one fewer card.
 *
 * Rendered with code's exported card so it is visually indistinguishable from
 * the built-in surfaces: a contributed panel that looks different reads as an
 * afterthought.
 */
function SlopQualityPanel({ days }: { days?: number }): JSX.Element | null {
  const { current } = useWorkspace();
  const [stat, setStat] = useState<AgentQualityStat | null>(null);
  const window = days ?? 30;

  const refresh = useCallback(async (): Promise<void> => {
    if (!current) return setStat(null);
    // A failure hides the card rather than breaking the host page: this is one
    // panel among several on somebody else's screen.
    try {
      setStat((await slopApi.stats(current.id, window)).stat);
    } catch {
      setStat(null);
    }
  }, [current, window]);
  useLive(refresh, (msg) => msg.t === 'slop.changed');

  if (!stat) return null;
  return <QualityStat stat={stat} />;
}

/**
 * Screen a selection of pull requests in one gesture.
 *
 * Lives here rather than in the PR list because module-code must not import
 * this module: slop depends on code, so the arrow only points one way. The
 * selection arrives through code's published context.
 */
function BulkSlopCheck(): JSX.Element | null {
  const selection = usePrSelection();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!selection || selection.selected.length === 0) return null;

  const count = selection.selected.length;
  const run = (): void => {
    setBusy(true);
    setError(null);
    void (async () => {
      const failures: string[] = [];
      // Sequential: each detection is an agent run, and firing fifteen at once
      // would just fill the queue in an order nobody chose.
      for (const pr of selection.selected) {
        try {
          await slopApi.detect(pr.repo, pr.number);
        } catch {
          failures.push(`#${pr.number}`);
        }
      }
      setBusy(false);
      if (failures.length > 0) setError(`Failed for ${failures.join(', ')}`);
      else selection.clear();
    })();
  };

  return (
    <>
      <button className="btn-ghost" disabled={busy || selection.busy} onClick={run}>
        {busy ? 'Screening…' : `Slop check ${count}`}
      </button>
      {error ? <span className="text-xs text-red-500">{error}</span> : null}
    </>
  );
}

export const slots = defineSlots([
  {
    slot: 'prs.bulkActions',
    key: 'slop-bulk-check',
    order: 10,
    permission: 'slop:act',
    component: BulkSlopCheck,
  },
  {
    slot: 'dashboard.widgets',
    key: 'slop-radar',
    order: 30,
    permission: 'slop:read',
    component: SlopRadarWidget,
  },
  {
    slot: 'quality.panels',
    key: 'slop-quality',
    order: 30,
    permission: 'slop:read',
    component: SlopQualityPanel,
  },
]);
