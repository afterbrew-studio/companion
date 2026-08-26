import { z } from 'zod';
import { badRequest, defineRoutes, route, forbidden, HttpError, notFound } from '@moxxy/companion-sdk/server';
import type { AuthUser } from '@moxxy/companion-contracts';
import type { WorkspaceRecord } from '@companion/module-workspace/contract';
import { REPO_PRESETS, findPreset, resolveSteps } from '@companion/module-code/contract';
import '../contract/index.js';

const automationSchema = z.object({
  autoTriage: z.boolean().optional(),
  digest: z.boolean().optional(),
  staleSweep: z.boolean().optional(),
  prGate: z.boolean().optional(),
  autoMerge: z.boolean().optional(),
  reviewReplies: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0, 'provide at least one automation switch');

const presetSchema = z.object({ preset: z.enum(['oss', 'internal', 'watch']) });

const contributorFlowSchema = z.object({
  mode: z.enum(['off', 'governed', 'autonomous']),
  actionableIssueKinds: z
    .array(z.enum(['bug', 'feature', 'docs', 'chore']))
    .max(4)
    .default(['bug', 'docs', 'chore']),
  queueIssues: z.boolean().default(true),
  autoApplyTriage: z.boolean().default(true),
  // Optional, NOT defaulted. A client that does not send the field must leave
  // the stored value alone: defaulting to null means any save from a surface
  // that has not been taught about this field silently switches the
  // authorization gate off, with no audit entry and nothing visible in the UI.
  // Sending an explicit null is how it is cleared.
  admitLabel: z.string().trim().min(1).max(100).nullable().optional(),
  mergeMethod: z.enum(['merge', 'squash', 'rebase']).default('squash'),
  maxAttempts: z.number().int().min(1).max(10).default(3),
});

const contributorFlowDryRunSchema = z.object({
  mode: z.enum(['governed', 'autonomous']),
  mergeMethod: z.enum(['merge', 'squash', 'rebase']).default('squash'),
});

const admissionControlSchema = z
  .object({
    paused: z.boolean(),
    reason: z.string().trim().min(3).max(500).nullable().optional(),
  })
  .superRefine((value, refine) => {
    if (value.paused && !value.reason) {
      refine.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'record why admission is paused' });
    }
  });

const webhookSchema = z.object({ accountId: z.string().min(1).max(60) });
const BRIEFING_PERMISSIONS = ['issues:read', 'prs:read', 'reports:read'] as const;

const messageSchema = z.object({
  text: z.string().min(1).max(32_000),
  /** Repo the conversation currently focuses on (the panel's scope select). */
  repo: z.string().max(200).optional(),
});

const askSchema = z.object({
  requestId: z.string(),
  response: z.object({
    mode: z.enum(['allow', 'allow_session', 'allow_always', 'deny']).optional(),
    optionId: z.string().optional(),
    text: z.string().optional(),
  }),
});

/** A UI directive AI Help emits into the caller's own browser. */
const uiSchema = z
  .object({
    hash: z
      .string()
      .max(300)
      .regex(/^#\//, 'hash must start with #/')
      .optional(),
    intent: z
      .enum([
        'ask-ai',
        'new-workspace',
        'connect-repo',
        'connect-github',
        'new-spec',
        'new-doc',
        'new-task',
        'new-idea',
        'new-agent-run',
      ])
      .optional(),
  })
  .refine((v) => v.hash || v.intent, 'provide a hash to navigate or an intent to open');

/**
 * The reactor domain's HTTP surface: the per-repo automation switches and
 * webhook receiver, the instance-wide delivery tunnel, the run-now actions
 * (digest, stale sweep), the workspace briefing cadence, and AI Help. Every
 * AI Help resolves the CALLER's own conversation run — there is no way to
 * address another user's assistant. Driving that run also needs the generic
 * run capability, independently revocable from automation configuration.
 */
export default defineRoutes((ctx) => {
  const { automations, assistant } = ctx.services.get('automations');
  const operate = ctx.services.get('operate');
  const code = ctx.services.get('code');
  const workspace = ctx.services.get('workspace');

  // Resolve a repo and enforce its workspace's access rule — a repo in a
  // private workspace the user isn't in reads as "not connected".
  const requireRepo = (user: AuthUser | null, owner: string, name: string) => {
    const fullName = `${owner}/${name}`;
    const row = code.repos.get(fullName);
    if (!row || !user || !workspace.canAccessRepo(user, fullName)) {
      throw notFound(`repo ${fullName} not connected`);
    }
    return { fullName, row };
  };

  // Access gate: a private workspace the user isn't in reads as "not found" —
  // membership is hidden, so its existence is too.
  const requireWorkspace = (user: AuthUser | null, id: string): WorkspaceRecord =>
    workspace.requireAccessible(user, id);

  const requirePersonalRepoAccess = async (user: AuthUser | null, fullName: string): Promise<void> => {
    const { client } = await code.githubAccounts.verifiedClientFor('fetch', fullName, {
      username: user?.username ?? null,
    });
    if (!client) throw badRequest(`your connected GitHub accounts cannot access ${fullName}`);
  };

  const requireRunRead: (user: AuthUser | null) => asserts user is AuthUser = (user) => {
    if (!user || !ctx.rbac.allows(user, 'runs:read')) throw forbidden('requires runs:read');
  };
  const requireRunAct: (user: AuthUser | null) => asserts user is AuthUser = (user) => {
    requireRunRead(user);
    if (!ctx.rbac.allows(user, 'runs:act')) throw forbidden('requires runs:act');
  };

  /**
   * Automation identities deliberately belong to people, not to an ambient
   * instance account. `users:manage` is the narrow break-glass capability for
   * offboarding: it may make foreign work safer immediately, while taking it
   * over still has to pass every normal live capability/account check below.
   */
  const foreignOwners = (user: AuthUser, ...owners: ReadonlyArray<string | null | undefined>): string[] =>
    [...new Set(owners.filter((owner): owner is string => Boolean(owner) && owner !== user.username))];

  const requireOwnerOrBreakGlass = (user: AuthUser, owners: readonly string[]): void => {
    if (owners.length === 0) return;
    if (!ctx.rbac.allows(user, 'users:manage')) {
      throw forbidden('this automation is managed by another Companion profile');
    }
  };

  const auditBreakGlass = (
    user: AuthUser,
    action: string,
    fullName: string,
    owners: readonly string[],
    result: string,
  ): void => {
    if (owners.length === 0) return;
    ctx.audit.record({
      at: Date.now(),
      actor: user.username,
      action,
      access: 'users:manage',
      status: 200,
      module: 'automations',
      detail: `${fullName}: ${result}; previous owner${owners.length === 1 ? '' : 's'} ${owners.join(', ')}`,
    });
  };

  /** Enabling durable background work is a second action beyond editing its
   * switch. Refuse incomplete capability bundles now instead of dead-lettering
   * the first webhook minutes later. False/off updates deliberately need none,
   * so a demoted operator can always make the system safer. */
  const requireAutomationCapabilities = (
    user: AuthUser,
    fields: z.infer<typeof automationSchema>,
  ): void => {
    const required = new Set<Parameters<typeof ctx.rbac.has>[1]>();
    if (fields.autoTriage === true) {
      required.add('issues:read');
      required.add('issues:act');
      required.add('runs:read');
      required.add('runs:act');
    }
    if (fields.digest === true) {
      required.add('issues:read');
      required.add('prs:read');
      required.add('runs:read');
      required.add('runs:act');
    }
    if (fields.staleSweep === true) required.add('issues:read');
    if (fields.prGate === true || fields.reviewReplies === true) {
      required.add('prs:read');
      required.add('prs:act');
      required.add('runs:read');
      required.add('runs:act');
    }
    if (fields.autoMerge === true) {
      required.add('prs:read');
      required.add('prs:act');
    }
    for (const permission of required) {
      if (!ctx.rbac.allows(user, permission)) {
        throw forbidden(`this automation also requires ${permission}`);
      }
    }
  };

  const requireAutomationAccounts = async (
    user: AuthUser,
    fullName: string,
    fields: z.infer<typeof automationSchema>,
  ): Promise<void> => {
    if (fields.autoTriage === true || fields.prGate === true || fields.reviewReplies === true) {
      const { client, tried } = await code.githubAccounts.verifiedClientFor('runs', fullName, {
        username: user.username,
        need: 'pull',
      });
      if (!client) {
        throw badRequest(
          `no runs account can read ${fullName} for agent work${tried.length ? ` (tried ${tried.join(', ')})` : ''}`,
        );
      }
    }
    if (fields.prGate === true || fields.reviewReplies === true || fields.autoMerge === true) {
      const { client, tried } = await code.githubAccounts.verifiedClientFor('pipelines', fullName, {
        username: user.username,
        need: 'push',
      });
      if (!client) {
        throw badRequest(
          `no pipelines account can write reviews or merges in ${fullName}${tried.length ? ` (tried ${tried.join(', ')})` : ''}`,
        );
      }
    }
  };

  const requireBriefingCapabilities = (user: AuthUser): void => {
    for (const permission of BRIEFING_PERMISSIONS) {
      if (!ctx.rbac.allows(user, permission)) {
        throw forbidden(`workspace briefings also require ${permission}`);
      }
    }
  };

  /** A scheduled aggregate must not be assigned to a profile whose own
   * GitHub credentials cannot see every repository it will summarize. Keep
   * probes bounded so a large workspace cannot fan out an unbounded burst. */
  const requireBriefingRepoAccess = async (user: AuthUser, workspaceId: string): Promise<void> => {
    const repos = code.repos.listByWorkspace(workspaceId);
    const inaccessible = (
      await mapConcurrent(repos, 8, async (repo) => {
        const { client } = await code.githubAccounts.verifiedClientFor('fetch', repo.full_name, {
          username: user.username,
          workspaceId,
          need: 'pull',
        });
        return client ? null : repo.full_name;
      })
    ).filter((repo): repo is string => repo !== null);
    if (inaccessible.length > 0) {
      const sample = inaccessible.slice(0, 3).join(', ');
      throw badRequest(
        `your fetch accounts cannot read ${sample}${inaccessible.length > 3 ? ` and ${inaccessible.length - 3} more repositories` : ''}`,
      );
    }
  };

  return [
    // ---------- per-repo automation switches + webhook receiver -------------------

    route({
      method: 'GET',
      path: '/api/workspaces/:id/contributor-flows',
      access: 'automations:manage',
      handler: ({ params, user }) => {
        requireWorkspace(user, params.id);
        return { flows: automations.listContributorFlows(params.id) };
      },
    }),

    route({
      method: 'GET',
      path: '/api/workspaces/:id/automation-admission',
      access: 'automations:manage',
      handler: ({ params, user }) => {
        requireWorkspace(user, params.id);
        const repos = code.repos.listByWorkspace(params.id).map((repo) => repo.full_name);
        return { controls: automations.admissionControls(repos) };
      },
    }),

    route({
      method: 'PUT',
      path: '/api/workspaces/:id/repos/:owner/:name/automation-admission',
      access: 'automations:manage',
      body: admissionControlSchema,
      handler: ({ params, body, user }) => {
        requireWorkspace(user, params.id);
        const { fullName } = requireRepo(user, params.owner, params.name);
        if (!code.repos.inWorkspace(fullName, params.id)) throw notFound(`repo ${fullName} not connected here`);
        const flow = automations.contributorFlow(fullName);
        const automationOwner = code.repos.automationOwner(fullName);
        const overriddenOwners = foreignOwners(user!, flow?.ownerId, automationOwner);
        // Pausing only reduces authority and is available to a scoped incident
        // operator. Resuming foreign work is a takeover and needs break-glass.
        if (!body.paused) requireOwnerOrBreakGlass(user!, overriddenOwners);
        const control = automations.setAdmissionControl(
          fullName,
          body.paused,
          user!.username,
          body.paused ? body.reason! : '',
        );
        ctx.audit.record({
          at: Date.now(),
          actor: user!.username,
          action: body.paused ? 'automation.admission.paused' : 'automation.admission.resumed',
          access: !body.paused && overriddenOwners.length > 0 ? 'users:manage' : 'automations:manage',
          status: 200,
          module: 'automations',
          detail: body.paused
            ? `${fullName}: ${body.reason}`
            : `${fullName}: intake resumed${overriddenOwners.length > 0 ? `; previous owner${overriddenOwners.length === 1 ? '' : 's'} ${overriddenOwners.join(', ')}` : ''}`,
        });
        return { control };
      },
    }),

    route({
      method: 'POST',
      path: '/api/workspaces/:id/repos/:owner/:name/contributor-flow/dry-run',
      access: 'automations:manage',
      body: contributorFlowDryRunSchema,
      handler: async ({ params, body, user }) => {
        requireWorkspace(user, params.id);
        const { fullName, row } = requireRepo(user, params.owner, params.name);
        if (!code.repos.inWorkspace(fullName, params.id)) throw notFound(`repo ${fullName} not connected here`);
        for (const permission of ['issues:read', 'prs:read'] as const) {
          if (!ctx.rbac.allows(user!, permission)) throw forbidden(`dry-run also requires ${permission}`);
        }
        const requiredPermissions = [
          'issues:read',
          'issues:act',
          'prs:read',
          'prs:act',
          'runs:read',
          'runs:act',
          'board:manage',
        ] as const;
        const [fetchAccount, runsAccount, pipelinesAccount, webhookAccount] = await Promise.all([
          code.githubAccounts.verifiedClientFor('fetch', fullName, {
            username: user!.username,
            workspaceId: params.id,
            need: 'pull',
          }),
          code.githubAccounts.verifiedClientFor('runs', fullName, {
            username: user!.username,
            workspaceId: params.id,
            need: 'push',
          }),
          code.githubAccounts.verifiedClientFor('pipelines', fullName, {
            username: user!.username,
            workspaceId: params.id,
            need: 'push',
          }),
          code.githubAccounts.verifiedClientFor('webhooks', fullName, {
            username: user!.username,
            workspaceId: params.id,
            need: 'admin',
          }),
        ]);
        const registration = code.repos.getWebhookRegistration(fullName);
        const report = await automations.dryRunContributorFlow({
          workspaceId: params.id,
          repo: fullName,
          defaultBranch: row.default_branch,
          mode: body.mode,
          mergeMethod: body.mergeMethod,
          client: fetchAccount.client,
          admission: automations.admissionControl(fullName),
          missingPermissions: requiredPermissions.filter((permission) => !ctx.rbac.allows(user!, permission)),
          accounts: {
            fetch: fetchAccount.client !== null,
            runs: runsAccount.client !== null,
            pipelines: pipelinesAccount.client !== null,
            webhooks: registration !== null || webhookAccount.client !== null,
          },
          boardEnabled: ctx.isEnabled('board'),
          webhookConfigured: registration !== null,
          webhookHealthy:
            registration !== null && registration.remoteId !== null && registration.remoteError === null,
          publicDeliveryReady: operate.webhookTunnel.deliveryUrl(`/webhooks/github/${fullName}`) !== null,
        });
        ctx.audit.record({
          at: Date.now(),
          actor: user!.username,
          action: 'automation.contributor-flow.dry-run',
          access: 'automations:manage',
          status: 200,
          module: 'automations',
          detail: `${fullName}: ${body.mode} → ${report.status}; ${report.workload.openPulls} PR(s), ${report.workload.openIssues} issue(s), no GitHub mutations or agent runs`,
        });
        return { report };
      },
    }),

    route({
      method: 'PUT',
      path: '/api/workspaces/:id/repos/:owner/:name/contributor-flow',
      access: 'automations:manage',
      body: contributorFlowSchema,
      handler: async ({ params, body, user }) => {
        requireWorkspace(user, params.id);
        const { fullName } = requireRepo(user, params.owner, params.name);
        if (!code.repos.inWorkspace(fullName, params.id)) throw notFound(`repo ${fullName} not connected here`);
        const existing = automations.contributorFlow(fullName);
        const automationOwner = code.repos.automationOwner(fullName);
        const overriddenOwners = foreignOwners(user!, existing?.ownerId, automationOwner);
        requireOwnerOrBreakGlass(user!, overriddenOwners);
        if (body.mode === 'off') {
          automations.removeContributorFlow(fullName);
          // Autonomous mode owns this irreversible switch. Turning the
          // lifecycle off must not leave its periodic merge reactor running;
          // triage and PR-gate remain independent granular tools below.
          code.repos.setAutomation(fullName, 'auto_merge', false);
          const row = code.repos.get(fullName)!;
          const anyEnabled =
            row.auto_triage === 1 ||
            row.digest_enabled === 1 ||
            row.stale_enabled === 1 ||
            row.pr_gate === 1 ||
            row.review_replies === 1;
          // Disabling one lifecycle must not silently lend the caller's
          // identity to independent switches that remain enabled.
          code.repos.setAutomationOwner(fullName, anyEnabled ? (automationOwner ?? existing?.ownerId ?? null) : null);
          ctx.broadcast({ t: 'repos.changed' });
          auditBreakGlass(user!, 'automation.break-glass-disable-flow', fullName, overriddenOwners, 'flow disabled');
          return { flow: null, repo: code.repos.getRecord(fullName)! };
        }
        for (const permission of [
          'issues:read',
          'issues:act',
          'prs:read',
          'prs:act',
          'runs:read',
          'runs:act',
          'board:manage',
        ] as const) {
          if (!ctx.rbac.allows(user!, permission)) {
            throw badRequest(`your role needs ${permission} to enable an end-to-end contributor flow`);
          }
        }
        // Validate the actual forge capabilities now. A flow that only learns
        // it cannot clone, push or publish after a multi-minute agent run is a
        // misleading success and wastes reviewer capacity.
        for (const [purpose, need, label] of [
          ['fetch', 'pull', 'read issues, pull requests and checks'],
          ['runs', 'push', 'push agent branches'],
          ['pipelines', 'push', 'label, review and merge contributions'],
        ] as const) {
          const { client, tried } = await code.githubAccounts.verifiedClientFor(purpose, fullName, {
            username: user!.username,
            workspaceId: params.id,
            need,
          });
          if (!client) {
            throw badRequest(
              `no ${purpose} account can ${label} in ${fullName}${tried.length ? ` (tried ${tried.join(', ')})` : ''}`,
            );
          }
        }

        // Existing registrations may be centrally managed by another profile;
        // the verified HMAC delivery is infrastructure and never lends that
        // profile's authority to this flow. Regardless of ownership, an active
        // lifecycle needs a connected public receiver now, not merely an
        // enablement flag whose relay is still failing in the background.
        const deliveryPath = `/webhooks/github/${fullName}`;
        if (!operate.webhookTunnel.deliveryUrl(deliveryPath)) {
          if (!operate.webhookTunnel.enabled()) {
            throw badRequest(
              'configure the webhook relay or a valid Self-managed webhook URL in Operate settings before enabling this flow',
            );
          }
          try {
            await operate.webhookTunnel.start();
          } catch {
            throw badRequest('public webhook delivery is not connected yet; retry after the relay recovers');
          }
        }

        let registration = code.repos.getWebhookRegistration(fullName);
        if (!registration) {
          const { row, tried } = await code.githubAccounts.verifiedRowFor('webhooks', fullName, {
            username: user!.username,
            workspaceId: params.id,
            need: 'admin',
          });
          if (!row) {
            throw badRequest(
              `a webhook-enabled GitHub account with admin access is required${tried.length ? ` (tried ${tried.join(', ')})` : ''}`,
            );
          }
          const webhook = await automations.installWebhook(
            fullName,
            user!.username,
            row.id,
            row.login,
            code.githubAccounts.clientOf(row),
          );
          if (webhook.remoteError) {
            throw badRequest(`GitHub webhook installation failed: ${webhook.remoteError}`);
          }
        } else if (registration.ownerId === user!.username) {
          // Reconcile URL, secret, event list and active state every time the
          // owner enables/saves the flow. This repairs a changed self-managed
          // ingress or a remote hook edited in GitHub without creating another.
          if (!registration.accountId) {
            throw badRequest('reconnect the GitHub account that owns this repository webhook');
          }
          const { row, tried } = await code.githubAccounts.verifiedRowFor('webhooks', fullName, {
            accountId: registration.accountId,
            username: user!.username,
            workspaceId: params.id,
            need: 'admin',
          });
          if (!row) {
            throw badRequest(
              `the webhook owner account no longer has admin access${tried.length ? ` (tried ${tried.join(', ')})` : ''}`,
            );
          }
          const webhook = await automations.installWebhook(
            fullName,
            user!.username,
            row.id,
            row.login,
            code.githubAccounts.clientOf(row),
          );
          if (webhook.remoteError) {
            throw badRequest(`GitHub webhook reconciliation failed: ${webhook.remoteError}`);
          }
        }
        registration = code.repos.getWebhookRegistration(fullName);
        if (registration?.remoteError) {
          throw badRequest(`repair the repository webhook before enabling this flow: ${registration.remoteError}`);
        }
        if (!registration?.remoteId) {
          throw badRequest(
            'a healthy GitHub-side webhook is not confirmed; install or repair it before enabling the contributor flow',
          );
        }
        const flow = automations.setContributorFlow({
          workspaceId: params.id,
          repo: fullName,
          mode: body.mode,
          actionableIssueKinds: body.actionableIssueKinds,
          queueIssues: body.queueIssues,
          autoApplyTriage: body.autoApplyTriage,
          admitLabel: body.admitLabel,
          mergeMethod: body.mergeMethod,
          maxAttempts: body.maxAttempts,
          ownerId: user!.username,
          updatedAt: Date.now(),
        });
        // The profile is a coherent starting point. Granular switches remain
        // editable below it, but a newly enabled flow cannot be inert because
        // its triage/review reactors were left off.
        code.repos.setAutomation(fullName, 'auto_triage', true);
        code.repos.setAutomation(fullName, 'pr_gate', true);
        code.repos.setAutomation(fullName, 'auto_merge', body.mode === 'autonomous');
        code.repos.setAutomationOwner(fullName, user!.username);
        ctx.broadcast({ t: 'repos.changed' });
        auditBreakGlass(
          user!,
          'automation.break-glass-takeover-flow',
          fullName,
          overriddenOwners,
          `${body.mode} flow assigned to ${user!.username}`,
        );
        return { flow, repo: code.repos.getRecord(fullName)! };
      },
    }),

    route({
      method: 'GET',
      path: '/api/workspaces/:id/automation-deliveries',
      access: 'automations:manage',
      handler: ({ params, user }) => {
        requireWorkspace(user, params.id);
        const repos = code.repos.listByWorkspace(params.id).map((repo) => repo.full_name);
        return automations.deliveryHealth(repos);
      },
    }),

    route({
      method: 'POST',
      path: '/api/workspaces/:id/automation-deliveries/:deliveryId/retry',
      access: 'automations:manage',
      handler: ({ params, user }) => {
        requireWorkspace(user, params.id);
        const repos = code.repos.listByWorkspace(params.id).map((repo) => repo.full_name);
        const result = automations.retryDelivery(params.deliveryId, repos);
        if (result === 'not-found') {
          throw notFound('failed delivery not found in this workspace');
        }
        if (result === 'saturated') {
          throw new HttpError(503, 'delivery queue is at capacity; retry after the active backlog drains');
        }
        if (result === 'paused') {
          throw new HttpError(409, 'automation admission is paused for this repository');
        }
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/automation',
      access: 'automations:manage',
      body: automationSchema,
      handler: async ({ params, body, user }) => {
        const { fullName } = requireRepo(user, params.owner, params.name);
        const ownerId = code.repos.automationOwner(fullName);
        const flow = automations.contributorFlow(fullName);
        const overriddenOwners = foreignOwners(user!, ownerId, flow?.ownerId);
        requireOwnerOrBreakGlass(user!, overriddenOwners);
        const enabling = Object.values(body).some((value) => value === true);
        // A granular switch does not prove the full Board + issue + PR bundle
        // needed to inherit a contributor flow. Make the administrator use the
        // flow editor, where that complete takeover is validated.
        if (enabling && flow && flow.ownerId !== user!.username) {
          throw badRequest('take over the contributor flow before enabling granular automations');
        }
        requireAutomationCapabilities(user!, body);
        if (enabling) {
          await requirePersonalRepoAccess(user, fullName);
          await requireAutomationAccounts(user!, fullName, body);
        }
        if (body.autoTriage !== undefined) code.repos.setAutomation(fullName, 'auto_triage', body.autoTriage);
        if (body.digest !== undefined) code.repos.setAutomation(fullName, 'digest_enabled', body.digest);
        if (body.staleSweep !== undefined) code.repos.setAutomation(fullName, 'stale_enabled', body.staleSweep);
        if (body.prGate !== undefined) code.repos.setAutomation(fullName, 'pr_gate', body.prGate);
        if (body.autoMerge !== undefined) code.repos.setAutomation(fullName, 'auto_merge', body.autoMerge);
        if (body.reviewReplies !== undefined) {
          code.repos.setAutomation(fullName, 'review_replies', body.reviewReplies);
        }
        const row = code.repos.get(fullName)!;
        const anyEnabled =
          row.auto_triage === 1 ||
          row.digest_enabled === 1 ||
          row.stale_enabled === 1 ||
          row.pr_gate === 1 ||
          row.auto_merge === 1 ||
          row.review_replies === 1;
        const preservedOwner = ownerId ?? flow?.ownerId ?? null;
        code.repos.setAutomationOwner(fullName, anyEnabled ? (enabling ? user!.username : preservedOwner) : null);
        ctx.broadcast({ t: 'repos.changed' });
        auditBreakGlass(
          user!,
          enabling ? 'automation.break-glass-takeover' : 'automation.break-glass-reduce',
          fullName,
          overriddenOwners,
          enabling ? `automation assigned to ${user!.username}` : 'automation switches reduced without reassignment',
        );
        return { repo: code.repos.getRecord(fullName)! };
      },
    }),

    // ---------- presets -----------------------------------------------------------

    route({
      method: 'GET',
      path: '/api/repo-presets',
      access: 'automations:manage',
      // Served rather than hardcoded in the SPA so the choices and what they
      // actually write cannot drift apart.
      handler: () => ({ presets: REPO_PRESETS }),
    }),

    /**
     * Apply a starting configuration to a connected repository: the automation
     * switches plus, where the preset defines one, a pipeline.
     *
     * Lives here rather than in module-code because these switches are only
     * meaningful while automations is enabled (it owns the ticker and the webhook
     * receiver), and because claiming the automation owner is part of turning
     * them on: switches with no owner read as paused and would silently do
     * nothing.
     */
    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/preset',
      access: 'automations:manage',
      body: presetSchema,
      handler: async ({ params, body, user }) => {
        const { fullName, row } = requireRepo(user, params.owner, params.name);
        const preset = findPreset(body.preset);
        if (!preset) throw badRequest(`unknown preset '${body.preset}'`);

        const a = preset.automation;
        const owner = code.repos.automationOwner(fullName);
        const flow = automations.contributorFlow(fullName);
        const overriddenOwners = foreignOwners(user!, owner, flow?.ownerId);
        requireOwnerOrBreakGlass(user!, overriddenOwners);
        const anyEnabled = Object.values(a).some(Boolean);
        if (flow) {
          throw badRequest('disable the contributor flow before applying a repository preset');
        }
        requireAutomationCapabilities(user!, a);
        if (anyEnabled) {
          await requirePersonalRepoAccess(user, fullName);
          await requireAutomationAccounts(user!, fullName, a);
        }
        code.repos.setAutomation(fullName, 'auto_triage', a.autoTriage);
        code.repos.setAutomation(fullName, 'digest_enabled', a.digest);
        code.repos.setAutomation(fullName, 'stale_enabled', a.staleSweep);
        code.repos.setAutomation(fullName, 'pr_gate', a.prGate);
        code.repos.setAutomation(fullName, 'auto_merge', a.autoMerge);
        code.repos.setAutomation(fullName, 'review_replies', a.reviewReplies);
        code.repos.setAutomationOwner(fullName, anyEnabled ? user!.username : null);

        // The pipeline is module-code's to write, and a custom role may hold
        // automations:manage while an override revoked pipelines:manage. Reading
        // the grid here is not re-checking this route's own permission; it is
        // asking whether to take a second, different action.
        let pipelineId: string | null = null;
        let pipelineSkipped: 'not-permitted' | 'account-unavailable' | 'no-steps-left' | null = null;
        const { steps, skipped } = resolveSteps(preset, ctx.isEnabled);
        if (preset.pipeline !== null) {
          const pipelinePermissions = new Set<Parameters<typeof ctx.rbac.has>[1]>([
            'pipelines:manage',
            'pipelines:run',
            'prs:read',
            'runs:read',
            'runs:act',
          ]);
          for (const spec of steps) {
            if (spec.type !== 'inline') continue;
            if (spec.step.kind === 'slop-check') {
              pipelinePermissions.add('slop:read' as Parameters<typeof ctx.rbac.has>[1]);
              pipelinePermissions.add('slop:act' as Parameters<typeof ctx.rbac.has>[1]);
            }
            if (spec.step.kind === 'ai-review' && spec.step.config.post) pipelinePermissions.add('prs:act');
          }
          if (
            user === null ||
            [...pipelinePermissions].some((permission) => !ctx.rbac.allows(user, permission))
          ) {
            pipelineSkipped = 'not-permitted';
          } else if (steps.length === 0) {
            pipelineSkipped = 'no-steps-left';
          } else {
            const writesGithub = steps.some(
              (spec) => spec.type === 'inline' && spec.step.kind === 'ai-review' && spec.step.config.post,
            );
            const { client } = await code.githubAccounts.verifiedClientFor('pipelines', fullName, {
              username: user!.username,
              workspaceId: row.workspace_id,
              need: writesGithub ? 'push' : 'pull',
            });
            if (!client) {
              pipelineSkipped = 'account-unavailable';
            } else {
              pipelineId = code.pipelines.create(row.workspace_id, {
                type: 'pr',
                name: preset.pipeline.name,
                description: preset.pipeline.description,
                // The contract's step DTOs are readonly; the engine's zod-inferred
                // input is not. Same cast the engine itself uses in the other
                // direction, and no preset step carries an array to begin with.
                steps: steps as Parameters<typeof code.pipelines.create>[1]['steps'],
                autoRunOnPrOpen: preset.pipeline.autoRunOnPrOpen,
                autoRunOnPrUpdate: preset.pipeline.autoRunOnPrUpdate,
              }, user!.username).id;
            }
          }
        }

        ctx.broadcast({ t: 'repos.changed' });
        auditBreakGlass(
          user!,
          anyEnabled ? 'automation.break-glass-apply-preset' : 'automation.break-glass-disable-preset',
          fullName,
          overriddenOwners,
          anyEnabled ? `${preset.id} preset assigned to ${user!.username}` : `${preset.id} preset disabled automations`,
        );
        return {
          repo: code.repos.getRecord(fullName)!,
          result: { preset: preset.id, pipelineId, skippedSteps: skipped, pipelineSkipped },
        };
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/webhook',
      access: 'automations:manage',
      body: webhookSchema,
      handler: async ({ params, body, user }) => {
        const { fullName } = requireRepo(user, params.owner, params.name);
        const account = code.githubAccounts.row(body.accountId);
        if (!account || account.ownerId !== user!.username || !account.purposes.includes('webhooks')) {
          throw badRequest('choose one of your GitHub accounts enabled for webhooks');
        }
        // Registering a webhook is an admin-level repository action; without
        // that grade GitHub answers 404 and the failure reads as "missing repo".
        const { client } = await code.githubAccounts.verifiedClientFor('webhooks', fullName, {
          accountId: account.id,
          username: user!.username,
          need: 'admin',
        });
        if (!client) {
          throw badRequest(`${account.login} needs admin access to ${fullName} to register a webhook`);
        }
        try {
          return await automations.installWebhook(fullName, user!.username, account.id, account.login, client);
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    route({
      method: 'DELETE',
      path: '/api/repos/:owner/:name/webhook',
      access: 'automations:manage',
      handler: async ({ params, user }) => {
        const { fullName } = requireRepo(user, params.owner, params.name);
        const registration = code.repos.getWebhookRegistration(fullName);
        const overriddenOwners = foreignOwners(user!, registration?.ownerId);
        requireOwnerOrBreakGlass(user!, overriddenOwners);
        try {
          const client = registration?.accountId && registration.ownerId === user!.username
            ? code.githubAccounts.clientFor('webhooks', {
                accountId: registration.accountId,
                username: user!.username,
                repo: fullName,
              })
            : null;
          const warning = await automations.disableWebhook(
            fullName,
            user!.username,
            client,
            overriddenOwners.length > 0,
          );
          if (automations.contributorFlow(fullName)) {
            automations.removeContributorFlow(fullName);
            code.repos.setAutomation(fullName, 'auto_merge', false);
            ctx.broadcast({ t: 'repos.changed' });
          }
          auditBreakGlass(
            user!,
            'automation.break-glass-disable-webhook',
            fullName,
            overriddenOwners,
            'local receiver and contributor flow disabled',
          );
          return { ok: true as const, warning };
        } catch (err) {
          throw badRequest(String(err instanceof Error ? err.message : err));
        }
      },
    }),

    /** Read-only info: unlike the POST, never (re-)enables the receiver. */
    route({
      method: 'GET',
      path: '/api/repos/:owner/:name/webhook',
      access: 'automations:manage',
      handler: ({ params, user }) => {
        const { fullName } = requireRepo(user, params.owner, params.name);
        const registration = code.repos.getWebhookRegistration(fullName);
        const accountLogin = registration?.accountId && registration.ownerId === user!.username
          ? (code.githubAccounts.row(registration.accountId)?.login ?? null)
          : null;
        return { webhook: automations.webhookInfo(fullName, user!.username, accountLogin) };
      },
    }),

    /** Instance-wide public webhook delivery over moxxy's proxy relay. */
    route({
      method: 'GET',
      path: '/api/webhooks/tunnel',
      access: 'automations:manage',
      handler: () => operate.webhookTunnel.state(),
    }),

    route({
      method: 'POST',
      path: '/api/webhooks/tunnel/retry',
      access: 'settings:manage',
      handler: async () => {
        if (!operate.webhookTunnel.enabled()) throw badRequest('enable public webhook delivery first');
        await operate.webhookTunnel
          .start()
          .catch((err) => ctx.log.warn('manual webhook tunnel retry failed', { err: String(err) }));
        return operate.webhookTunnel.state();
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/digest-now',
      access: 'automations:manage',
      handler: async ({ params, user }) => {
        const { fullName } = requireRepo(user, params.owner, params.name);
        await requirePersonalRepoAccess(user, fullName);
        for (const permission of ['issues:read', 'prs:read', 'runs:read', 'runs:act'] as const) {
          if (!ctx.rbac.allows(user!, permission)) {
            throw forbidden(`requires ${permission} to build a repository digest`);
          }
        }
        // Kick off and return: the run takes minutes and must not hold the
        // request open. Progress streams via runs.changed/reports.changed.
        automations.startDigest(fullName, user!.username);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/repos/:owner/:name/stale-now',
      access: 'automations:manage',
      handler: async ({ params, user }) => {
        const { fullName } = requireRepo(user, params.owner, params.name);
        await requirePersonalRepoAccess(user, fullName);
        if (!ctx.rbac.allows(user!, 'issues:read')) throw forbidden('requires issues:read to scan stale issues');
        automations.runStaleSweep(fullName);
        return { ok: true };
      },
    }),

    // ---------- workspace briefing ----------------------------------------------

    route({
      method: 'GET',
      path: '/api/workspaces/:id/briefing',
      access: 'automations:manage',
      handler: ({ params, user }) => {
        requireWorkspace(user, params.id);
        return automations.briefingSchedule(params.id);
      },
    }),

    route({
      method: 'PUT',
      path: '/api/workspaces/:id/briefing',
      access: 'automations:manage',
      body: z.object({ cadence: z.enum(['off', 'daily', 'weekly']) }),
      handler: async ({ params, body, user }) => {
        requireWorkspace(user, params.id);
        const existing = automations.briefingSchedule(params.id);
        const overriddenOwners = foreignOwners(user!, existing.ownerId);
        requireOwnerOrBreakGlass(user!, overriddenOwners);
        if (body.cadence !== 'off') {
          requireBriefingCapabilities(user!);
          await requireBriefingRepoAccess(user!, params.id);
        }
        const schedule = automations.setBriefingCadence(params.id, body.cadence, user!.username);
        auditBreakGlass(
          user!,
          body.cadence === 'off'
            ? 'automation.break-glass-disable-workspace-briefing'
            : 'automation.break-glass-takeover-workspace-briefing',
          `workspace:${params.id}`,
          overriddenOwners,
          body.cadence === 'off' ? 'briefing disabled' : `${body.cadence} briefing assigned to ${user!.username}`,
        );
        return schedule;
      },
    }),

    route({
      method: 'POST',
      path: '/api/workspaces/:id/briefing-now',
      access: 'automations:manage',
      handler: async ({ params, user }) => {
        requireWorkspace(user, params.id);
        requireBriefingCapabilities(user!);
        await requireBriefingRepoAccess(user!, params.id);
        await automations.runBriefing(params.id);
        return { ok: true };
      },
    }),

    // ---------- AI Help ------------------------------------------------------------

    route({
      method: 'GET',
      path: '/api/assistant',
      access: 'any',
      handler: ({ user }) => {
        requireRunRead(user);
        return assistant.info(user);
      },
    }),

    route({
      method: 'POST',
      path: '/api/assistant/session',
      access: 'any',
      handler: async ({ user }) => {
        requireRunAct(user);
        const run = await assistant.ensureRun(user);
        return { run, pendingAsks: assistant.info(user).pendingAsks };
      },
    }),

    route({
      method: 'POST',
      path: '/api/assistant/message',
      access: 'any',
      body: messageSchema,
      handler: async ({ user, body }) => {
        requireRunAct(user);
        return assistant.send(user, body.text, body.repo);
      },
    }),

    route({
      method: 'GET',
      path: '/api/assistant/history',
      access: 'any',
      handler: async ({ user, query }) => {
        requireRunRead(user);
        const beforeRaw = query.get('before');
        const before = beforeRaw === null ? null : Number(beforeRaw);
        const limit = Math.min(Number(query.get('limit')) || 300, 1000);
        return assistant.history(user, Number.isFinite(before as number) ? before : null, limit);
      },
    }),

    route({
      method: 'POST',
      path: '/api/assistant/ask',
      access: 'any',
      body: askSchema,
      handler: async ({ user, body }) => {
        requireRunAct(user);
        await assistant.respondAsk(user, body.requestId, body.response);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/assistant/abort',
      access: 'any',
      handler: async ({ user }) => {
        requireRunAct(user);
        await assistant.abort(user);
        return { ok: true };
      },
    }),

    route({
      method: 'POST',
      path: '/api/assistant/reset',
      access: 'any',
      handler: async ({ user }) => {
        requireRunAct(user);
        await assistant.reset(user);
        return { ok: true };
      },
    }),

    // AI Help drives the caller's own browser: navigate to a page or open a
    // create/connect form. Pushed only to this user's sockets — never another's.
    route({
      method: 'POST',
      path: '/api/assistant/ui',
      access: ['runs:read', 'runs:act'],
      allowDelegatedWrite: true,
      body: uiSchema,
      handler: ({ user, body }) => {
        ctx.pushToUser(user!.username, { t: 'client.intent', hash: body.hash, intent: body.intent });
        return { ok: true };
      },
    }),
  ];
});

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  work: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker));
  return results;
}
