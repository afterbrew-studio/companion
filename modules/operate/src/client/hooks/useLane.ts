import { useCallback, useEffect, useState } from 'react';
import { onServerMessage } from '@moxxy/companion-core/client';
import type { RunLane } from '../../contract/index.js';
import { operateApi as api, type LaneSnapshot } from '../api.js';

/**
 * The lane this person's own actions run in, for any page that needs to say so.
 *
 * Exported for other modules, not just the picker: a page offering to start
 * work should be able to name the machine, the runtime and the models it will
 * actually get, instead of leaving the user to infer it from a sidebar control
 * two screens away.
 *
 * Read-only on purpose. Changing the lane is an ambient decision and belongs to
 * the one control that owns it; a second place to set it would let two screens
 * disagree about what is selected.
 */
export interface UseLane {
  readonly lane: RunLane | null;
  /** Human label for the current lane, e.g. `This machine · Claude Code`. */
  readonly label: string;
  /** Models the current lane can actually serve; empty while loading. */
  readonly models: ReadonlyArray<{ readonly id: string }>;
  /** The lane's fallback model, or null when its runtime decides. */
  readonly defaultModel: string | null;
  readonly loading: boolean;
}

export function useLane(): UseLane {
  const [snapshot, setSnapshot] = useState<LaneSnapshot | null>(null);

  const load = useCallback(() => {
    api
      .lane()
      .then(setSnapshot)
      .catch(() => setSnapshot(null));
  }, []);

  useEffect(() => {
    load();
    // The chosen machine can go away or change its runtimes under us.
    return onServerMessage((msg) => {
      if (msg.t === 'runners.changed' || msg.t === 'task-models.changed') load();
    });
  }, [load]);

  if (!snapshot) return { lane: null, label: 'Auto', models: [], defaultModel: null, loading: true };
  const { lane, machines } = snapshot;
  const machine = machines.find((m) => m.id === lane.runnerId) ?? null;
  const harness = machine?.harnesses.find((h) => h.id === lane.harness) ?? null;
  return {
    lane,
    label: machine === null ? 'Auto' : harness ? `${machine.name} · ${harness.label}` : machine.name,
    models: snapshot.servable,
    defaultModel: snapshot.models.defaultModel,
    loading: false,
  };
}
