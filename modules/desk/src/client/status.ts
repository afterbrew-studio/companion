import type { DeskMissionView } from '../contract/index.js';

export interface MissionStatus {
  readonly label: string;
  readonly tone: 'blue' | 'amber' | 'red' | 'green' | 'zinc';
  readonly pulse: boolean;
}

export function missionStatus(view: DeskMissionView): MissionStatus {
  if (view.pendingAsks.length > 0) return { label: 'Needs you', tone: 'amber', pulse: true };
  const status = view.run?.status;
  if (!status) return { label: 'Draft', tone: 'zinc', pulse: false };
  if (status === 'queued' || status === 'provisioning') return { label: 'Queued', tone: 'blue', pulse: true };
  if (status === 'running') return { label: 'Working', tone: 'green', pulse: true };
  if (status === 'idle') return { label: 'Ready', tone: 'green', pulse: false };
  if (status === 'review') return { label: 'Review', tone: 'amber', pulse: false };
  if (status === 'completed') return { label: 'Done', tone: 'green', pulse: false };
  if (status === 'failed' || status === 'interrupted' || status === 'abandoned') {
    return { label: status === 'failed' ? 'Failed' : 'Interrupted', tone: 'red', pulse: false };
  }
  return { label: 'Stopped', tone: 'zinc', pulse: false };
}
