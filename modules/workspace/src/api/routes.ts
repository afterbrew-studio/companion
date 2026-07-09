import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineRoutes, route, created, notFound, badRequest, forbidden } from '@companion/core/server';
import type { AuthUser } from '@companion/contracts';
import type { WorkspaceRecord } from '../contract/index.js';

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

  // Access gate: a private workspace the user isn't in reads as "not found" —
  // membership is hidden, so its existence is too.
  const requireWorkspace = (user: AuthUser | null, id: string): WorkspaceRecord => {
    const ws = workspaces.get(id);
    if (!ws || !user || !workspaces.canAccess(user, ws)) {
      throw notFound(`workspace ${id} not found`);
    }
    return ws;
  };
  // Manage gate (rename/delete/members): owner or admin only.
  const requireManage = (user: AuthUser | null, id: string): WorkspaceRecord => {
    const ws = requireWorkspace(user, id);
    if (!user || !workspaces.canManage(user, ws)) {
      throw forbidden('only the workspace owner or an admin can manage this workspace');
    }
    return ws;
  };

  // Resolve the notification scope for a user. A specific, accessible workspace
  // → just that one (+ instance-wide). Otherwise fall back to everything the
  // user can see: admins get all workspaces (undefined = unrestricted), others
  // get instance-wide + their accessible workspaces — so a private workspace's
  // inbox never leaks, even via the no-workspace path.
  const scope = (
    user: AuthUser | null,
    workspaceId: string | null,
  ): { workspaceId: string | null; accessibleIds?: readonly string[] } => {
    if (workspaceId && user) {
      const ws = workspaces.get(workspaceId);
      if (ws && workspaces.canAccess(user, ws)) return { workspaceId };
    }
    if (!user || user.role === 'admin') return { workspaceId: null };
    return { workspaceId: null, accessibleIds: [...workspaces.accessibleIds(user)] };
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
        if (params.username === user!.username && user!.role !== 'admin') {
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
      handler: ({ params, user }) => {
        requireWorkspace(user, params.id);
        return { metrics: workspaces.metrics(params.id) };
      },
    }),

    // ---------- notification inbox ----------------------------------------------

    route({
      method: 'GET',
      path: '/api/notifications',
      access: 'workspaces:read',
      handler: ({ query, user }) => {
        const s = scope(user, query.get('workspace'));
        return { notifications: notifications.list(s.workspaceId, 100, s.accessibleIds) };
      },
    }),

    route({
      method: 'POST',
      path: '/api/notifications/:id/read',
      access: 'workspaces:read',
      handler: ({ params }) => {
        notifications.markRead(params.id);
        ctx.broadcast({ t: 'notifications.changed' });
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/notifications/read-all',
      access: 'workspaces:read',
      handler: ({ query, user }) => {
        const s = scope(user, query.get('workspace'));
        notifications.markAllRead(s.workspaceId, s.accessibleIds);
        ctx.broadcast({ t: 'notifications.changed' });
        return { ok: true };
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
