import { z } from 'zod';
import { badRequest, created, defineRoutes, notFound, route } from '@moxxy/companion-sdk/server';
import type { AuthUser } from '@moxxy/companion-contracts';
import '../contract/index.js';

const notificationKinds = z.enum(['action_required', 'finished', 'error', 'info']);

/**
 * Only http(s) targets. A `file:` or `gopher:` destination is not a channel
 * anyone meant to configure, and the daemon fetches this URL server-side.
 */
const targetUrl = z
  .string()
  .trim()
  .url()
  .max(2_000)
  .refine((value) => /^https?:\/\//i.test(value), 'the destination must be an http(s) URL');

const createSchema = z.object({
  workspaceId: z.string().min(1).max(100).nullable().default(null),
  kind: z.enum(['webhook', 'slack', 'discord', 'ntfy']),
  name: z.string().trim().min(1).max(80),
  url: targetUrl,
  kinds: z.array(notificationKinds).max(4).default([]),
  secret: z.string().max(500).optional(),
  enabled: z.boolean().default(true),
});

const patchSchema = z.object({
  workspaceId: z.string().min(1).max(100).nullable().optional(),
  name: z.string().trim().min(1).max(80).optional(),
  // Empty means "leave the stored credential alone": the form is never shown it.
  url: z.union([targetUrl, z.literal('')]).optional(),
  kinds: z.array(notificationKinds).max(4).optional(),
  secret: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
});

export default defineRoutes((ctx) => {
  const notify = ctx.services.get('notify');
  const workspace = ctx.services.get('workspace');

  /**
   * A channel scoped to a workspace the caller cannot reach reads as "not
   * found", the house convention. Instance-wide channels (null) are
   * administration and ride the route's own permission.
   */
  const requireScope = (user: AuthUser | null, workspaceId: string | null | undefined): void => {
    if (workspaceId === null || workspaceId === undefined) return;
    workspace.requireAccessible(user, workspaceId);
  };

  const requireChannel = (user: AuthUser | null, id: string): void => {
    const channel = notify.get(id);
    if (!channel) throw notFound('channel not found');
    requireScope(user, channel.workspaceId);
    // Somebody else's personal channel reads as absent, the house convention. Its
    // existence is not the caller's business, and neither is its destination.
    if (channel.userId !== null && channel.userId !== user?.username) throw notFound('channel not found');
  };

  const requireOwnedChannel = (user: AuthUser | null, id: string): void => {
    const channel = notify.get(id);
    if (!channel || !user || channel.userId !== user.username) throw notFound('channel not found');
    requireScope(user, channel.workspaceId);
  };

  return [
    route({
      method: 'GET',
      path: '/api/notify/channels',
      access: 'notify:read',
      handler: () => ({ channels: notify.listShared() }),
    }),

    /**
     * Your own channels. A separate route with its own permission rather than a
     * branch inside the one above: someone who may wire up their own destination
     * need not be able to see the team's, and the router should say so.
     */
    route({
      method: 'GET',
      path: '/api/notify/channels/mine',
      access: 'notify:self',
      handler: ({ user }) => ({ channels: notify.listOwnedBy(user?.username ?? null) }),
    }),

    route({
      method: 'GET',
      path: '/api/notify/deliveries',
      access: 'notify:read',
      // Data scoping, not an auth decision: the log names channels, and another
      // person's personal one is not this reader's to see.
      handler: ({ user }) => ({ deliveries: notify.deliveriesFor(user?.username ?? null) }),
    }),

    /**
     * A channel of your own. Separate route rather than a branch inside the
     * shared one, so the authority difference is declared where the router can
     * see it instead of being re-derived in a handler: wiring up your own
     * destination is not the same act as configuring the team's.
     *
     * The owner is taken from the session, never from the body, so this cannot be
     * used to create a channel that delivers somebody else's work somewhere.
     */
    route({
      method: 'POST',
      path: '/api/notify/channels/mine',
      access: 'notify:self',
      body: createSchema,
      handler: ({ body, user }) => {
        if (!user) throw badRequest('a personal channel needs a signed-in owner');
        requireScope(user, body.workspaceId);
        return created({ channel: notify.create({ ...body, userId: user.username }) });
      },
    }),

    route({
      method: 'POST',
      path: '/api/notify/channels',
      access: 'notify:manage',
      body: createSchema,
      handler: ({ body, user }) => {
        requireScope(user, body.workspaceId);
        return created({ channel: notify.create({ ...body, userId: null }) });
      },
    }),

    // Personal destinations have their own route family so the router can
    // enforce notify:self centrally. Reusing the team route made it possible
    // for business users to create a channel they could never edit, test, or
    // remove afterwards.
    route({
      method: 'PATCH',
      path: '/api/notify/channels/mine/:id',
      access: 'notify:self',
      body: patchSchema,
      handler: ({ params, body, user }) => {
        requireOwnedChannel(user, params.id);
        requireScope(user, body.workspaceId);
        return { channel: notify.update(params.id, body) };
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/notify/channels/mine/:id',
      access: 'notify:self',
      handler: ({ params, user }) => {
        requireOwnedChannel(user, params.id);
        notify.remove(params.id);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/notify/channels/mine/:id/test',
      access: 'notify:self',
      handler: async ({ params, user }) => {
        requireOwnedChannel(user, params.id);
        return notify.test(params.id);
      },
    }),

    route({
      method: 'PATCH',
      path: '/api/notify/channels/:id',
      access: 'notify:manage',
      body: patchSchema,
      handler: ({ params, body, user }) => {
        requireChannel(user, params.id);
        requireScope(user, body.workspaceId);
        return { channel: notify.update(params.id, body) };
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/notify/channels/:id',
      access: 'notify:manage',
      handler: ({ params, user }) => {
        requireChannel(user, params.id);
        notify.remove(params.id);
        return { ok: true };
      },
    }),

    // Proving a channel works must not require waiting for a real event. A dead
    // destination answers 200 with a failed status, not an HTTP error: the
    // caller asked "does this work", and "no, 404 from Slack" is the answer.
    route({
      method: 'POST',
      path: '/api/notify/channels/:id/test',
      access: 'notify:manage',
      handler: async ({ params, user }) => {
        requireChannel(user, params.id);
        return notify.test(params.id);
      },
    }),
  ];
});
