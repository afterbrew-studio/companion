import { defineServices } from '@moxxy/companion-core/server';
import type { SpaServerMessage } from '@moxxy/companion-contracts';
import { paths } from '@moxxy/companion-services';
import type { GitCredentialResolver, GithubTokenSource } from '../contract/index.js';
import { detectMoxxyCli } from '../exec/cli.js';
import { adoptDailyMoxxyHome, healCredentialLinks, seedPermissionDenyRules } from '../exec/home.js';
import { Checkouts } from '../exec/checkouts.js';
import { AgentPolicy } from './agent-policy.js';
import { OperateStore } from './operate-store.js';
import { Budgets, type PriceResolver } from './budgets.js';
import { Orchestrator } from './orchestrator.js';
import { WebhookTunnel } from './webhook-tunnel.js';
import { Skills } from './skills.js';
import { OperateService } from './operate-service.js';

/**
 * Construct the execution plane: moxxy-home hygiene, CLI detection, the narrow
 * store facade, the orchestrator (which owns the runner registry), the public
 * webhook tunnel and the skill library — then publish the bundle as `operate`.
 */
export default defineServices(async (ctx) => {
  // moxxy-home hygiene the legacy main() ran at boot.
  seedPermissionDenyRules();
  adoptDailyMoxxyHome();
  healCredentialLinks();

  const settings = ctx.services.get('settings');

  // One-time adoption of the pre-framework settings keys into module config
  // (via ctx.modules.setConfig — the kernel validates and encodes). Deleting the
  // legacy keys makes this run once ever.
  const legacySlots = settings.get('reservedRunnerSlots');
  const legacyTunnel = settings.get('webhookTunnel');
  if (legacySlots !== null || legacyTunnel !== null) {
    const patch: Record<string, unknown> = {};
    const n = Math.floor(Number(legacySlots));
    if (legacySlots !== null && Number.isFinite(n)) patch.reservedRunnerSlots = Math.min(64, Math.max(0, n));
    if (legacyTunnel !== null) patch.webhookTunnel = legacyTunnel === 'on';
    if (Object.keys(patch).length) ctx.modules.setConfig('operate', patch);
    settings.delete('reservedRunnerSlots');
    settings.delete('webhookTunnel');
  }

  // Git credentials: module-code plugs its personal-account resolver in at
  // onEnable. Without it, network Git fails closed; a legacy instance token
  // must never become an implicit credential shared by every profile.
  const tokenSource: { current: GithubTokenSource } = {
    current: { tokenFor: () => null },
  };
  // What agent work may do, as instance configuration. Enforced at the
  // credential seam below rather than per feature: every network git operation
  // on every runner resolves its credential through this one function, so a
  // refusal cannot be routed around by a caller added later.
  const agentPolicy = new AgentPolicy(ctx.moduleConfig, (action, detail) =>
    ctx.audit.record({ at: Date.now(), actor: null, action, access: 'runs:act', status: 403, module: 'operate', detail }),
  );
  const githubTokenFor: GitCredentialResolver = async (repo, username, access) => {
    if (access === 'write') agentPolicy.assertGitWrite(repo);
    return (await tokenSource.current.tokenFor(repo, username, access)) ?? null;
  };

  // run.changed fans out to browsers AND to the server bus, replacing the
  // legacy composition root's hard-coded proposals forward-ref: reacting
  // modules (plan) subscribe in their onEnable.
  const broadcast = (msg: SpaServerMessage): void => {
    ctx.broadcast(msg);
    if (msg.t === 'run.changed') ctx.bus.emit('run.changed', msg.run);
    else if (msg.t === 'ask') ctx.bus.emit('run.ask', { runId: msg.runId, ask: msg.ask });
    else if (msg.t === 'askResolved') ctx.bus.emit('run.askResolved', { runId: msg.runId, requestId: msg.requestId });
  };

  // Runtime adapters discover their own prerequisites. The composition root
  // needs this handle only to construct the built-in adapter; absence is a
  // valid configuration when another installed runtime handles the work.
  const moxxyCli = await detectMoxxyCli(paths.moxxyHome());

  // Per-repo resolution, so the invoking/run-owning profile governs clones too.
  const checkouts = new Checkouts(githubTokenFor, ctx.config.github.host, (repo, branch) =>
    agentPolicy.assertPushTarget(repo, branch),
  );
  const store = new OperateStore(ctx.db, settings, ctx.secrets);
  // Roles are module-core's to store and edit; placement only reads them, live,
  // so a role change takes effect on the next placement rather than a restart.
  const auth = ctx.services.get('core');
  // The ceiling reads the runs table directly rather than accumulating, so it
  // cannot drift from what was actually spent. Its alert is an inbox entry with
  // no workspace: a spend ceiling is instance-wide, not a workspace's concern.
  // Late-bound because the module that owns provider records enables after
  // this one, and the ceiling has to price its models the moment it does.
  const modelPrice: { current: PriceResolver } = { current: () => null };
  const budgets = new Budgets(
    store.runs,
    ctx.moduleConfig,
    settings,
    (title, body) =>
      ctx.notify.emit({ workspaceId: null, kind: 'action_required', title, body, href: '#/settings/modules' }),
    (model) => modelPrice.current(model),
  );
  const orchestrator = new Orchestrator(
    store,
    ctx.config,
    checkouts,
    moxxyCli,
    broadcast,
    githubTokenFor,
    ctx.moduleConfig,
    (username) => auth.activeUserRole(username) ?? null,
    (userId) => budgets.check(userId),
    // Instance-wide, like the budget alert: a machine going offline is not one
    // workspace's problem, and scoping it to one would hide it from the rest.
    (kind, title, body) => ctx.notify.emit({ workspaceId: null, kind, title, body, href: '#/runners' }),
    agentPolicy,
  );
  await orchestrator.runners.adoptDetectedRuntimes();
  orchestrator.setRunAuthorityResolver((username) => {
    const role = auth.activeUserRole(username);
    return role !== undefined && ctx.rbac.has(role, 'runs:read') && ctx.rbac.has(role, 'runs:act');
  });
  const webhookTunnel = new WebhookTunnel(
    () => ctx.moduleConfig.get('webhookTunnel') === true,
    () => String(ctx.moduleConfig.get('webhookPublicUrl') ?? ''),
    ctx.config.port,
    () => ctx.broadcast({ t: 'modules.changed' }),
  );
  const skills = new Skills();

  const service = new OperateService(
    orchestrator,
    orchestrator.runners,
    checkouts,
    webhookTunnel,
    skills,
    store.runs,
    tokenSource,
    modelPrice,
    budgets,
    agentPolicy,
  );
  // The registry resolves a scoped provider credential per run, and only the
  // module that owns repositories knows which workspace a repository belongs
  // to, so the answer is forwarded rather than duplicated.
  orchestrator.runners.setWorkspaceForRepo((repo) => service.workspaceForRepo(repo));
  service.registerRunTask({ id: 'operate.chat', label: 'Interactive chats', placeable: true });
  ctx.services.register('operate', service);
});
