import { useEffect, useState } from 'react';
import { onServerMessage } from '@moxxy/companion-core/client';
import type { RoleRecord } from '../../contract/index.js';
import { coreApi } from '../api.js';

/**
 * The instance's roles. Every role picker reads from here rather than hardcoding
 * the three built-ins, which is the whole point of roles being instance data.
 * Falls back to an empty list on failure so a picker degrades to "no change"
 * instead of silently offering roles the server would reject.
 */
export function useRoles(): { roles: readonly RoleRecord[]; loading: boolean; reload: () => void } {
  const [roles, setRoles] = useState<readonly RoleRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void coreApi
      .listRoles()
      .then((r) => alive && setRoles(r.roles))
      .catch(() => alive && setRoles([]))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [attempt]);

  useEffect(() => onServerMessage((message) => {
    if (message.t === 'roles.changed') setAttempt((n) => n + 1);
  }), []);

  return { roles, loading, reload: () => setAttempt((n) => n + 1) };
}
