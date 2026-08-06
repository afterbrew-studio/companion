import { z } from 'zod';
import type { AuthUser } from '@moxxy/companion-contracts';
import { badRequest, created, defineRoutes, notFound, route } from '@moxxy/companion-sdk/server';
import type { IntegrationScope } from '@companion/module-integrations/contract';
import type { JiraSubjectRef } from '../contract/index.js';

const subjectSchema = z.object({
  kind: z.enum(['issue', 'pull-request']),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/).max(300),
  number: z.number().int().positive(),
});
const scopedSubjectSchema = z.object({
  subject: subjectSchema,
  workspaceId: z.string().min(1).max(100),
});
const createSchema = scopedSubjectSchema.extend({
  connectionId: z.string().min(1).max(120),
  issueKey: z.string().trim().min(3).max(60),
});
const workspaceSchema = z.object({ workspaceId: z.string().min(1).max(100) });
const commentSchema = workspaceSchema.extend({ body: z.string().trim().min(1).max(20_000) });
const transitionSchema = workspaceSchema.extend({ transitionId: z.string().regex(/^\d{1,12}$/) });

export default defineRoutes((ctx) => {
  const jira = ctx.services.get('jira');
  const code = ctx.services.get('code');
  const workspaces = ctx.services.get('workspace');

  const scopeFor = async (
    user: AuthUser | null,
    subject: JiraSubjectRef,
    workspaceId: string,
  ): Promise<IntegrationScope> => {
    workspaces.requireAccessible(user, workspaceId);
    if (!user || !code.repos.inWorkspace(subject.repo, workspaceId) || !workspaces.canAccessRepo(user, subject.repo)) {
      throw notFound(`${subject.repo} not found`);
    }
    const permission = await code.githubAccounts.permissionFor('fetch', subject.repo, {
      username: user.username,
      workspaceId,
    });
    if (!permission) throw notFound(`${subject.repo} not found`);
    const item = subject.kind === 'issue'
      ? code.issues.get(subject.repo, subject.number)
      : code.prs.get(subject.repo, subject.number);
    if (!item) throw notFound(`${subject.kind} ${subject.repo}#${subject.number} not found`);
    return { kind: 'repository', workspaceId, repo: subject.repo };
  };

  const querySubject = (query: URLSearchParams): { subject: JiraSubjectRef; workspaceId: string } => {
    const parsed = scopedSubjectSchema.safeParse({
      subject: {
        kind: query.get('kind'),
        repo: query.get('repo'),
        number: Number(query.get('number')),
      },
      workspaceId: query.get('workspaceId'),
    });
    if (!parsed.success) throw badRequest('kind, repo, number and workspaceId are required');
    return parsed.data;
  };

  const execute = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error) {
      throw badRequest(error instanceof Error ? error.message : String(error));
    }
  };

  const linkedScope = async (user: AuthUser | null, id: string, workspaceId: string) => {
    let link;
    try {
      link = jira.requireLink(id);
    } catch {
      throw notFound('Jira link not found');
    }
    if (link.workspaceId !== workspaceId) throw notFound('Jira link not found');
    return { link, scope: await scopeFor(user, link.subject, workspaceId) };
  };

  return [
    route({
      method: 'GET',
      path: '/api/jira/links',
      access: 'jira:read',
      handler: async ({ query, user }) => {
        const { subject, workspaceId } = querySubject(query);
        await scopeFor(user, subject, workspaceId);
        return { links: jira.list(workspaceId, subject) };
      },
    }),
    route({
      method: 'POST',
      path: '/api/jira/links',
      access: 'jira:act',
      body: createSchema,
      handler: async ({ body, user }) => {
        const scope = await scopeFor(user, body.subject, body.workspaceId);
        return created({
          link: await execute(() =>
            jira.link(body.subject, scope, body.connectionId, body.issueKey, user!.username),
          ),
        });
      },
    }),
    route({
      method: 'DELETE',
      path: '/api/jira/links/:id',
      access: 'jira:act',
      handler: async ({ params, query, user }) => {
        const workspaceId = query.get('workspaceId');
        if (!workspaceId) throw badRequest('workspaceId is required');
        await linkedScope(user, params.id, workspaceId);
        jira.unlink(params.id);
        return { ok: true };
      },
    }),
    route({
      method: 'POST',
      path: '/api/jira/links/:id/refresh',
      access: 'jira:act',
      body: workspaceSchema,
      handler: async ({ params, body, user }) => {
        const { scope } = await linkedScope(user, params.id, body.workspaceId);
        return { link: await execute(() => jira.refresh(params.id, scope, user!.username)) };
      },
    }),
    route({
      method: 'POST',
      path: '/api/jira/links/:id/comments',
      access: 'jira:act',
      body: commentSchema,
      handler: async ({ params, body, user }) => {
        const { scope } = await linkedScope(user, params.id, body.workspaceId);
        return { link: await execute(() => jira.comment(params.id, scope, user!.username, body.body)) };
      },
    }),
    route({
      method: 'GET',
      path: '/api/jira/links/:id/transitions',
      access: 'jira:read',
      handler: async ({ params, query, user }) => {
        const workspaceId = query.get('workspaceId');
        if (!workspaceId) throw badRequest('workspaceId is required');
        const { scope } = await linkedScope(user, params.id, workspaceId);
        return { transitions: await execute(() => jira.transitions(params.id, scope, user!.username)) };
      },
    }),
    route({
      method: 'POST',
      path: '/api/jira/links/:id/transitions',
      access: 'jira:act',
      body: transitionSchema,
      handler: async ({ params, body, user }) => {
        const { scope } = await linkedScope(user, params.id, body.workspaceId);
        return {
          link: await execute(() => jira.transition(params.id, scope, user!.username, body.transitionId)),
        };
      },
    }),
  ];
});
