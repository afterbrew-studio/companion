import { defineSlots } from '@companion/core/client';
import { Section, timeAgo } from '@companion/ui';
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
    .slice(0, 5);
  // No blip, no widget — the dashboard stays quiet when the radar is clear.
  if (hot.length === 0) return null;
  return (
    <Section
      title="AI slop radar"
      description={
        <a className="row-link" href="#/slop">
          High-likelihood verdicts awaiting review
        </a>
      }
    >
      <ul className="flex flex-col gap-1.5">
        {hot.map((d) => (
          <li key={d.id} className="flex items-center gap-2 text-xs">
            <a className="row-link shrink-0 font-mono" href={`#/repos/${d.repo}/prs/${d.prNumber}`}>
              {d.repo}#{d.prNumber}
            </a>
            <span className="dim min-w-0 truncate">{d.prTitle}</span>
            <span className="flex-1" />
            <SlopMeter value={d.verdict?.aiLikelihood ?? 0} />
            <span className="dim tabular-nums">{timeAgo(d.createdAt)}</span>
          </li>
        ))}
      </ul>
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
