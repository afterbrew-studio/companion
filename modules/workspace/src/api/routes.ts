import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineRoutes, route, created, notFound, badRequest, forbidden } from '@moxxy/companion-sdk/server';
import type { AuthUser } from '@moxxy/companion-contracts';
import type { WorkspaceRecord } from '../contract/index.js';

type CodeReportAccess = {
  readonly repos: {
    listByWorkspace(workspaceId: string): Array<{ readonly full_name: string }>;
  };
  readonly githubAccounts: {
    verifiedClientFor(
      purpose: 'fetch',
      repo: string,
      ctx: { readonly username: string; readonly workspaceId?: string },
    ): Promise<{ readonly client: unknown | null }>;
  };
};

const workspaceSchema = z.object({
  name: z.string().min(2).max(80),
  description: z.string().max(500).default(''),
  visibility: z.enum(['public', 'private']).optional(),
});
const workspacePatchSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  description: z.string().max(500).optional(),
  visibility: z.enum(['public', 'private']).optional(),
});
const memberSchema = z.object({ username: z.string().min(1).max(100) });

/**
 * Workspace lifecycle + membership + metrics, plus the notification inbox. The
 * cross-domain per-workspace feeds (repos/issues/prs/proposals/pipelines/
 * step-definitions/briefing) stay with their owning modules (code/plan) and are
 * carved separately — they are NOT part of module-workspace.
 */
export default defineRoutes((ctx) => {
  const workspaces = ctx.services.get('workspace');
  const auth = ctx.services.get('core');
  const notifications = ctx.services.get('notifications');
  const reports = ctx.services.get('reports');
  // workspace cannot depend on code (code already depends on workspace), but
  // report visibility still needs code's personal-GitHub access boundary at
  // request time. Keep the reverse lookup narrow and fail closed if the code
  // module is disabled or unavailable.
  const codeAccess = (): CodeReportAccess | null =>
    (((ctx.services.tryGet.bind(ctx.services) as (key: string) => unknown)('code') as CodeReportAccess | undefined) ??
      null);
  const accessibleRepos = async (username: string, workspaceId: string): Promise<string[]> => {
    const code = codeAccess();
    if (!code) return [];
    const rows = code.repos.listByWorkspace(workspaceId);
    const access = await Promise.all(
      rows.map(async ({ full_name }) => {
        try {
          const { client } = await code.githubAccounts.verifiedClientFor('fetch', full_name, {
            username,
            workspaceId,
          });
          return client ? full_name : null;
        } catch {
          return null;
        }
      }),
    );
    return access.filter((repo): repo is string => repo !== null);
  };

  // Access gate: a private workspace the user isn't in reads as "not found" —
  // membership is hidden, so its existence is too. Platform role never bypasses it.
  const requireWorkspace = (user: AuthUser | null, id: string): WorkspaceRecord =>
    workspaces.requireAccessible(user, id);
  // Manage gate (rename/delete/members): owner or admin only.
  const requireManage = (user: AuthUser | null, id: string): WorkspaceRecord => {
    const ws = requireWorkspace(user, id);
    if (!user || (ws.ownerId !== user.username && !ctx.rbac.has(user.role, 'workspaces:manage'))) {
      throw forbidden('only the workspace owner or an admin can manage this workspace');
    }
    return ws;
  };

  // Resolve the notification scope for a user. A specific, accessible workspace
  // → just that one (+ instance-wide). Otherwise use instance-wide + every
  // accessible workspace. Platform role never widens the workspace boundary.
  const scope = (
    user: AuthUser | null,
    workspaceId: string | null,
  ): { workspaceId: string | null; accessibleIds?: readonly string[] } => {
    if (workspaceId && user) {
      const ws = workspaces.get(workspaceId);
      if (ws && workspaces.canAccess(user, ws)) return { workspaceId };
    }
    if (!user) return { workspaceId: null, accessibleIds: [] };
    return { workspaceId: null, accessibleIds: [...workspaces.accessibleIds(user)] };
  };

  const visibleNotifications = async (
    items: ReturnType<typeof notifications.list>,
    user: AuthUser,
  ): Promise<ReturnType<typeof notifications.list>> => {
    const code = codeAccess();
    if (!code) return items.filter((item) => item.repo === null);
    const checks = new Map<string, Promise<boolean>>();
    const visible = await Promise.all(
      items.map(async (item) => {
        if (!item.repo) return true;
        let check = checks.get(item.repo);
        if (!check) {
          check = code.githubAccounts
            .verifiedClientFor('fetch', item.repo, { username: user.username })
            .then(({ client }) => client !== null)
            .catch(() => false);
          checks.set(item.repo, check);
        }
        return check;
      }),
    );
    return items.filter((_, index) => visible[index]);
  };

  return [
    // ---------- workspace lifecycle ---------------------------------------------

    route({
      method: 'GET',
      path: '/api/workspaces',
      access: 'workspaces:read',
      handler: ({ user }) => ({ workspaces: workspaces.listFor(user!) }),
    }),

    route({
      method: 'POST',
      path: '/api/workspaces',
      access: 'workspaces:create',
      body: workspaceSchema,
      handler: ({ body, user }) => {
        // Omitted visibility defaults to private (the per-user case); making a
        // workspace public — shared with everyone — needs workspaces:manage.
        const visibility = body.visibility ?? 'private';
        if (visibility === 'public' && !ctx.rbac.has(user!.role, 'workspaces:manage')) {
          throw forbidden('only an admin can create a public workspace');
        }
        const id = `ws-${randomUUID().slice(0, 12)}`;
        const taken = new Set(workspaces.list().map((w) => w.slug));
        let slug = slugify(body.name, id);
        if (taken.has(slug)) slug = `${slug}-${id.slice(3, 7)}`;
        workspaces.insert({
          id,
          name: body.name,
          slug,
          description: body.description,
          visibility,
          ownerId: visibility === 'private' ? user!.username : null,
        });
        ctx.broadcast({ t: 'workspaces.changed' });
        return created({ workspace: workspaces.get(id) });
      },
    }),

    route({
      method: 'PATCH',
      path: '/api/workspaces/:id',
      access: 'workspaces:read',
      body: workspacePatchSchema,
      handler: ({ params, body, user }) => {
        requireManage(user, params.id);
        if (body.visibility) workspaces.setVisibility(params.id, body.visibility, user!.username);
        workspaces.update(params.id, body);
        ctx.broadcast({ t: 'workspaces.changed' });
        return { workspace: workspaces.get(params.id) };
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/workspaces/:id',
      access: 'workspaces:read',
      handler: ({ params, user }) => {
        const ws = requireManage(user, params.id);
        if (ws.repoCount > 0) {
          throw badRequest('workspace still has repos — move or remove them first');
        }
        if (workspaces.list().length === 1) {
          throw badRequest('cannot delete the last workspace');
        }
        workspaces.delete(params.id);
        ctx.broadcast({ t: 'workspaces.changed' });
        return { ok: true };
      },
    }),

    // ---------- private-workspace membership ------------------------------------

    route({
      method: 'GET',
      path: '/api/workspaces/:id/members',
      access: 'workspaces:read',
      handler: ({ params, user }) => {
        requireWorkspace(user, params.id);
        return { members: workspaces.members(params.id) };
      },
    }),

    // Typeahead for the member picker: users who could be invited (not already
    // members, not disabled). Manager-gated, and returns only name + handle —
    // never roles/emails — so a non-admin owner can search without users:manage.
    route({
      method: 'GET',
      path: '/api/workspaces/:id/member-candidates',
      access: 'workspaces:read',
      handler: ({ params, query, user }) => {
        requireManage(user, params.id);
        const members = new Set(workspaces.members(params.id).map((m) => m.username));
        const { users } = auth.searchUsers({ q: query.get('q') ?? undefined, limit: 24 });
        const candidates = users
          .filter((u) => !u.disabled && !members.has(u.username))
          .slice(0, 8)
          .map((u) => ({ username: u.username, displayName: u.displayName }));
        return { candidates };
      },
    }),

    route({
      method: 'POST',
      path: '/api/workspaces/:id/members',
      access: 'workspaces:read',
      body: memberSchema,
      handler: ({ params, body, user }) => {
        const ws = requireManage(user, params.id);
        if (ws.visibility !== 'private') throw badRequest('only private workspaces have members');
        if (!auth.userRole(body.username)) throw notFound(`user ${body.username} not found`);
        workspaces.addMember(params.id, body.username, 'member');
        ctx.broadcast({ t: 'workspaces.changed' });
        return created({ members: workspaces.members(params.id) });
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/workspaces/:id/members/:username',
      access: 'workspaces:read',
      handler: ({ params, user }) => {
        requireManage(user, params.id);
        if (params.username === user!.username && !ctx.rbac.has(user!.role, 'workspaces:manage')) {
          throw badRequest('the owner cannot remove themselves — delete the workspace instead');
        }
        workspaces.removeMember(params.id, params.username);
        ctx.broadcast({ t: 'workspaces.changed' });
        return { members: workspaces.members(params.id) };
      },
    }),

    // ---------- dashboard metrics -----------------------------------------------

    route({
      method: 'GET',
      path: '/api/workspaces/:id/metrics',
      access: 'workspaces:read',
      handler: async ({ params, user }) => {
        requireWorkspace(user, params.id);
        const repos = await accessibleRepos(user!.username, params.id);
        return { metrics: workspaces.metrics(params.id, 12, repos) };
      },
    }),

    // ---------- notification inbox ----------------------------------------------

    route({
      method: 'GET',
      path: '/api/notifications',
      access: 'workspaces:read',
      handler: async ({ query, user }) => {
        const s = scope(user, query.get('workspace'));
        // The reader, so a notification addressed to somebody else stays theirs.
        const items = notifications.list(s.workspaceId, 100, s.accessibleIds, user?.username);
        return { notifications: await visibleNotifications(items, user!) };
      },
    }),

    route({
      method: 'POST',
      path: '/api/notifications/:id/read',
      access: 'workspaces:read',
      handler: async ({ params, user }) => {
        const item = notifications.get(params.id, user!.username);
        if (!item) throw notFound('notification not found');
        if (item.workspaceId) requireWorkspace(user, item.workspaceId);
        const visible = await visibleNotifications([item], user!);
        if (visible.length === 0) throw notFound('notification not found');
        notifications.markRead(params.id, user!.username);
        ctx.broadcast({ t: 'notifications.changed' });
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/notifications/read-all',
      access: 'workspaces:read',
      handler: async ({ query, user }) => {
        const s = scope(user, query.get('workspace'));
        const pageSize = 500;
        let before: { createdAt: number; id: string } | undefined;
        let changed = false;
        try {
          for (;;) {
            const candidates = notifications.list(
              s.workspaceId,
              pageSize,
              s.accessibleIds,
              user!.username,
              before,
            );
            if (candidates.length === 0) break;
            const visible = await visibleNotifications(candidates, user!);
            notifications.markManyRead(visible.map((item) => item.id), user!.username);
            changed ||= visible.length > 0;
            if (candidates.length < pageSize) break;
            const last = candidates[candidates.length - 1]!;
            before = { createdAt: last.createdAt, id: last.id };
          }
        } finally {
          // A later page can fail after earlier receipts committed. Preserve
          // the mutation→broadcast invariant even on that partial failure.
          if (changed) ctx.broadcast({ t: 'notifications.changed' });
        }
        return { ok: true };
      },
    }),

    // ---------- reports -----------------------------------------------------------

    route({
      method: 'GET',
      path: '/api/reports',
      access: 'reports:read',
      handler: async ({ user }) => {
        const scoped = reports.list().filter((report) => {
          if (report.workspaceId) return workspaces.canAccessWorkspace(user!, report.workspaceId);
          // Legacy briefings predate workspace_id; hiding them is safer than
          // guessing their scope from a non-unique workspace name in the title.
          if (report.kind === 'briefing') return false;
          return !report.repo || workspaces.canAccessRepo(user!, report.repo);
        });
        const code = codeAccess();
        if (!code) return { reports: scoped.filter((report) => !report.repo && !report.workspaceId) };

        const repoChecks = new Map<string, Promise<boolean>>();
        const canAccessRepo = (repo: string, workspaceId?: string): Promise<boolean> => {
          const key = `${workspaceId ?? ''}:${repo}`;
          let check = repoChecks.get(key);
          if (!check) {
            check = code.githubAccounts
              .verifiedClientFor('fetch', repo, {
                username: user!.username,
                ...(workspaceId ? { workspaceId } : {}),
              })
              .then(({ client }) => client !== null)
              .catch(() => false);
            repoChecks.set(key, check);
          }
          return check;
        };
        const visible = await Promise.all(
          scoped.map(async (report) => {
            if (report.repo) return canAccessRepo(report.repo, report.workspaceId ?? undefined);
            if (!report.workspaceId) return true;
            // A workspace briefing may contain titles and activity from every
            // connected repo. Do not return a partially redacted cached body:
            // hide it unless the current profile can see every source repo.
            const repos = code.repos.listByWorkspace(report.workspaceId);
            const access = await Promise.all(
              repos.map((repo) => canAccessRepo(repo.full_name, report.workspaceId ?? undefined)),
            );
            return access.every(Boolean);
          }),
        );
        return { reports: scoped.filter((_, index) => visible[index]) };
      },
    }),
  ];
});

function slugify(name: string, fallback: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || fallback;
}
