import { useEffect, useState } from 'react';
import { useAuth } from '@companion/module-core/client';
import type { PipelineRecord, PipelineType } from '../../contract/index.js';
import { codeApi as api } from '../api.js';

/**
 * The active workspace's pipelines of one type (pr / issue / platform). One
 * concern, one piece of state; empty without the pipelines:read permission.
 */
export function useWorkspacePipelines(workspaceId: string | undefined, type: PipelineType): PipelineRecord[] {
  const { can } = useAuth();
  const [pipelines, setPipelines] = useState<PipelineRecord[]>([]);
  useEffect(() => {
    if (!workspaceId || !can('pipelines:read')) {
      setPipelines([]);
      return;
    }
    let alive = true;
    api
      .workspacePipelines(workspaceId)
      .then((r) => alive && setPipelines(r.pipelines.filter((pl) => pl.type === type)))
      .catch(() => alive && setPipelines([]));
    return () => {
      alive = false;
    };
  }, [workspaceId, can, type]);
  return pipelines;
}
