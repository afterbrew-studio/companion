import { DetailGrid, DetailRow, Eyebrow, MetaSignal, type StatusTone } from '@moxxy/companion-sdk/ui';
import type { PrQualityClass, SlopVerdict } from '../../contract/index.js';

export const QUALITY_META: Record<PrQualityClass, { label: string; tone: StatusTone }> = {
  valuable: { label: 'valuable', tone: 'green' },
  promising: { label: 'promising', tone: 'blue' },
  needs_evidence: { label: 'needs evidence', tone: 'amber' },
  low_value: { label: 'low value', tone: 'red' },
  unsafe: { label: 'unsafe', tone: 'red' },
};

/** The merge-decision axes, kept separate from the AI-authorship score. */
export function PrQualityAssessment({ verdict }: { verdict: SlopVerdict }): React.JSX.Element {
  const quality = QUALITY_META[verdict.qualityClass];
  const riskTone: StatusTone =
    verdict.technicalRisk === 'low'
      ? 'green'
      : verdict.technicalRisk === 'medium'
        ? 'amber'
        : 'red';
  return (
    <div className="card mt-5">
      <div className="flex flex-wrap items-center gap-2">
        <Eyebrow>PR quality</Eyebrow>
        <span className="flex-1" />
        <MetaSignal tone={quality.tone} label={quality.label} />
        <MetaSignal tone={riskTone} label={`${verdict.technicalRisk} technical risk`} />
      </div>
      <DetailGrid className="mt-4 gap-y-3">
        <DetailRow label="Value">
          <Score value={verdict.valueScore} />
        </DetailRow>
        <DetailRow label="Evidence">
          <Score value={verdict.evidenceScore} />
        </DetailRow>
        <DetailRow label="Tests">{verdict.testEvidence}</DetailRow>
        <DetailRow label="Reviewability">{verdict.reviewability.replace('_', ' ')}</DetailRow>
      </DetailGrid>
      <p className="dim mt-3 text-xs leading-relaxed">
        Quality and evidence are assessed independently from whether the change appears AI-assisted.
      </p>
    </div>
  );
}

function Score({ value }: { value: number }): React.JSX.Element {
  return (
    <span className="flex max-w-52 items-center gap-2">
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <span className="block h-full rounded-full bg-accent-500" style={{ width: `${value}%` }} />
      </span>
      <span className="w-8 text-right text-xs font-semibold tabular-nums">{value}</span>
    </span>
  );
}
