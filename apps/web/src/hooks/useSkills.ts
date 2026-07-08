import { useCallback, useEffect, useState } from 'react';
import type { SkillFile } from '@companion/contract';
import { api } from '../lib/api.js';

/**
 * The instance's skill files. One concern; null until the first load resolves.
 * Skills are global (not workspace-scoped) and change only through this UI, so
 * there's no live subscription.
 */
export function useSkills(): {
  skills: SkillFile[] | null;
  error: string | null;
  setError: (e: string | null) => void;
  refresh: () => Promise<void>;
} {
  const [skills, setSkills] = useState<SkillFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { skills } = await api.listSkills();
      setSkills(skills);
      setError(null);
    } catch (err) {
      setError(String(err));
      setSkills([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { skills, error, setError, refresh };
}
