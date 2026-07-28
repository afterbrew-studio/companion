import { defineSlots } from '@moxxy/companion-sdk/client';
import { ListCard, Section, timeAgo } from '@moxxy/companion-sdk/ui';
import { SlopMeter } from './components/SlopMeter.js';
import { useSlopDetections } from './hooks/useSlopDetections.js';

/**
 * Contributions rendered INTO other modules' pages. The dashboard (module-code)
 * exposes `dashboard.widgets`; slop drops its radar there so high-scoring PRs
 * awaiting review are visible at a glance — without code importing this module.
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
  // No blip, no widget — the dashboard stays quiet when the radar is clear.
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

export const slots = defineSlots([
  {
    slot: 'dashboard.widgets',
    key: 'slop-radar',
    order: 30,
    permission: 'slop:read',
    component: SlopRadarWidget,
  },
]);
