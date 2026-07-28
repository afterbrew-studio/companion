import { useEffect, useState } from 'react';
import type { RunnerPolicyOptions } from '../../contract/index.js';
import { operateApi as api } from '../api.js';

const EMPTY: RunnerPolicyOptions = { groups: [], repos: [], roles: [] };

/**
 * What a machine's policy and placement can be written against. Deliberately
 * NOT live: it turns over with the module set and the repo list, while the
 * runners stream re-fires on every health probe, and a settings form being
 * edited must not have its choices swapped out underneath it.
 */
export function useRunnerOptions(): RunnerPolicyOptions {
  const [options, setOptions] = useState<RunnerPolicyOptions>(EMPTY);
  useEffect(() => {
    api
      .runnerOptions()
      .then(setOptions)
      .catch(() => setOptions(EMPTY));
  }, []);
  return options;
}
