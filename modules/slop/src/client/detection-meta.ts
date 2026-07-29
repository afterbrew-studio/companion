import type { StatusTone } from '@moxxy/companion-sdk/ui';
import type { SlopAppliedAction, SlopDetectionResult, SlopSignal } from '../contract/index.js';

/** Detection wording/tones shared by the list page and the detection subpage. */

export const ACTION_LABEL: Record<SlopAppliedAction, string> = {
  none: 'nothing',
  label: 'apply label',
  comment: 'comment',
  request_changes: 'request changes',
  close: 'close PR',
  refinement: 'moved to refinement',
};

export const STATUS_META: Record<SlopDetectionResult['status'], { label: string; tone: StatusTone }> = {
  running: { label: 'running', tone: 'blue' },
  pending: { label: 'pending review', tone: 'amber' },
  applied: { label: 'applied', tone: 'green' },
  dismissed: { label: 'dismissed', tone: 'zinc' },
  failed: { label: 'failed', tone: 'red' },
};

export const STRENGTH_TONE: Record<SlopSignal['strength'], StatusTone> = {
  weak: 'zinc',
  moderate: 'amber',
  strong: 'red',
};

export type SlopBandId = 'high' | 'elevated' | 'low';

export interface SlopBand {
  readonly id: SlopBandId;
  /** Lowest score in the band. */
  readonly min: number;
  readonly label: string;
  readonly tone: StatusTone;
  /** One line for the legend: what a score in this band means. */
  readonly meaning: string;
}

/**
 * The bands the meter paints with, so the thresholds live in one place and a
 * page can name the scale instead of leaving the colour to be decoded.
 * Descending: `slopBand` takes the first match, and a legend reads worst first.
 */
export const SLOP_BANDS: ReadonlyArray<SlopBand> = [
  { id: 'high', min: 70, label: 'high', tone: 'red', meaning: 'reads as machine-written, barely reviewed' },
  { id: 'elevated', min: 40, label: 'elevated', tone: 'amber', meaning: 'mixed signals, worth reading' },
  { id: 'low', min: 0, label: 'low', tone: 'green', meaning: 'reads as human-authored' },
];

export function slopBand(value: number): SlopBand {
  return SLOP_BANDS.find((b) => value >= b.min) ?? SLOP_BANDS[SLOP_BANDS.length - 1]!;
}

/** A band's span in words, read off the thresholds so the copy cannot drift. */
export function slopBandRange(band: SlopBand): string {
  const above = SLOP_BANDS[SLOP_BANDS.findIndex((b) => b.id === band.id) - 1];
  if (!above) return `${band.min} and up`;
  return band.min === 0 ? `under ${above.min}` : `${band.min} to ${above.min - 1}`;
}

const STRENGTH_RANK: Record<SlopSignal['strength'], number> = { strong: 0, moderate: 1, weak: 2 };

/** Strongest first; ties keep the order the agent reported them in. */
export function rankSignals(signals: ReadonlyArray<SlopSignal>): ReadonlyArray<SlopSignal> {
  return [...signals].sort((a, b) => STRENGTH_RANK[a.strength] - STRENGTH_RANK[b.strength]);
}
