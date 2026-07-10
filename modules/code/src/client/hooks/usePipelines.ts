import { useCallback, useState } from 'react';
import { useLive } from '@companion/core/client';
import { useWorkspace } from '@companion/module-workspace/client';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import type { PipelineRecord, StepDefinitionRecord } from '../../contract/index.js';
import { codeApi as api } from '../api.js';

/**
 * The active workspace's pipelines and reusable step definitions, kept live.
 * The error setter is exposed for the page's manage actions.
 */
export function usePipelines(): {
  current: WorkspaceRecord | null;
  pipelines: PipelineRecord[];
  stepDefs: StepDefinitionRecord[];
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
} {
  const { current } = useWorkspace();
  const [pipelines, setPipelines] = useState<PipelineRecord[]>([]);
  const [stepDefs, setStepDefs] = useState<StepDefinitionRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!current) return;
    try {
      const res = await api.workspacePipelines(current.id);
      setPipelines(res.pipelines);
      setStepDefs(res.stepDefinitions);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [current]);

  useLive(refresh, (msg) => msg.t === 'pipelines.changed');

  return { current, pipelines, stepDefs, error, setError, refresh };
}
