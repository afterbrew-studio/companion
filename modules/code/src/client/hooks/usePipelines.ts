import { useCallback, useEffect, useRef, useState } from 'react';
import { useLive } from '@moxxy/companion-sdk/client';
import { useWorkspace } from '@companion/module-workspace/client';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import type { PipelineRecord, PipelineRunRecord, StepDefinitionRecord } from '../../contract/index.js';
import { codeApi as api } from '../api.js';

/**
 * The active workspace's pipelines and reusable step definitions, kept live.
 * The error setter is exposed for the page's manage actions.
 */
export function usePipelines(): {
  current: WorkspaceRecord | null;
  pipelines: PipelineRecord[];
  runs: PipelineRunRecord[];
  stepDefs: StepDefinitionRecord[];
  /** False until the first fetch lands — the page shows skeletons, not "no pipelines". */
  loaded: boolean;
  /** The definition feed failed; an empty array must not become an empty-state claim. */
  definitionsFailed: boolean;
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
} {
  const { current } = useWorkspace();
  const workspaceId = current?.id ?? null;
  const [pipelines, setPipelines] = useState<PipelineRecord[]>([]);
  const [runs, setRuns] = useState<PipelineRunRecord[]>([]);
  const [stepDefs, setStepDefs] = useState<StepDefinitionRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [definitionsFailed, setDefinitionsFailed] = useState(false);
  const [dataWorkspaceId, setDataWorkspaceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refreshGeneration = useRef(0);

  // Never flash the previous workspace's definitions or run history while the
  // next scoped fetch is in flight.
  useEffect(() => {
    refreshGeneration.current++;
    setPipelines([]);
    setRuns([]);
    setStepDefs([]);
    setLoaded(false);
    setDefinitionsFailed(false);
    setDataWorkspaceId(null);
    setError(null);
  }, [workspaceId]);

  const refresh = useCallback(async () => {
    if (!workspaceId) return;
    const request = ++refreshGeneration.current;
    try {
      const [definitions, history] = await Promise.allSettled([
        api.workspacePipelines(workspaceId),
        api.workspacePipelineRuns(workspaceId),
      ]);
      if (request !== refreshGeneration.current) return;
      if (definitions.status === 'fulfilled') {
        setPipelines(definitions.value.pipelines);
        setStepDefs(definitions.value.stepDefinitions);
        setDefinitionsFailed(false);
      } else {
        setDefinitionsFailed(true);
      }
      if (history.status === 'fulfilled') setRuns(history.value.runs);
      setDataWorkspaceId(workspaceId);
      const failures = [
        ...(definitions.status === 'rejected' ? [`pipeline definitions: ${String(definitions.reason)}`] : []),
        ...(history.status === 'rejected' ? [`run history: ${String(history.reason)}`] : []),
      ];
      setError(failures.length > 0 ? `Could not refresh ${failures.join('; ')}` : null);
    } catch (err) {
      if (request === refreshGeneration.current) {
        setDataWorkspaceId(workspaceId);
        setDefinitionsFailed(true);
        setError(String(err));
      }
    } finally {
      if (request === refreshGeneration.current) setLoaded(true);
    }
  }, [workspaceId]);

  useLive(refresh, (msg) => msg.t === 'pipelines.changed' || msg.t === 'pipelineRuns.changed');

  const inCurrentWorkspace = dataWorkspaceId === workspaceId;
  return {
    current,
    pipelines: inCurrentWorkspace ? pipelines : [],
    runs: inCurrentWorkspace ? runs : [],
    stepDefs: inCurrentWorkspace ? stepDefs : [],
    loaded: inCurrentWorkspace && loaded,
    definitionsFailed: inCurrentWorkspace && definitionsFailed,
    error: inCurrentWorkspace ? error : null,
    setError,
    refresh,
  };
}
