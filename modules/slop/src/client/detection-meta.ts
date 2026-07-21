import type { StatusTone } from '@companion/ui';
import type { SlopAction, SlopDetectionResult, SlopSignal } from '../contract/index.js';

/** Detection wording/tones shared by the list page and the detection subpage. */

export const ACTION_LABEL: Record<SlopAction, string> = {
  none: 'nothing',
  label: 'apply label',
  comment: 'comment',
  request_changes: 'request changes',
  close: 'close PR',
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
