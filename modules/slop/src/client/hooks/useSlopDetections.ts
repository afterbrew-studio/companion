import { useCallback, useState } from 'react';
import { useLive } from '@moxxy-ai/companion-sdk/client';
import { useWorkspace } from '@companion/module-workspace/client';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import type { SlopDetectionResult } from '../../contract/index.js';
import { slopApi } from '../api.js';

/** The active workspace's detections, kept live over slop.changed. */
export function useSlopDetections(): {
  current: WorkspaceRecord | null;
  /** null until the first load resolves. */
  detections: SlopDetectionResult[] | null;
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
} {
  const { current } = useWorkspace();
  const [detections, setDetections] = useState<SlopDetectionResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!current) return;
    try {
      setDetections((await slopApi.list(current.id)).detections);
      setError(null);
    } catch (err) {
      setError(String(err));
      setDetections([]);
    }
  }, [current]);

  useLive(refresh, (msg) => msg.t === 'slop.changed');

  return { current, detections, error, setError, refresh };
}
