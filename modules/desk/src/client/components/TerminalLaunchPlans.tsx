import { useState } from 'react';
import { ErrorBar, Spinner, StatusDot } from '@moxxy/companion-sdk/ui';
import type { DeskLaunchPlanRecord } from '../../contract/index.js';
import { deskApi } from '../api.js';
import { useLaunchPlans } from '../hooks/useLaunchPlans.js';

export function TerminalLaunchPlans({ workspaceId }: { readonly workspaceId: string }): React.JSX.Element | null {
  const feed = useLaunchPlans(workspaceId);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recentThreshold = Date.now() - 10 * 60_000;
  const visible = feed.plans.filter((plan) => {
    if (plan.status === 'pending' || plan.status === 'executing') return true;
    return (plan.status === 'completed' || plan.status === 'failed') &&
      (plan.executedAt ?? plan.createdAt) >= recentThreshold;
  }).slice(0, 3);

  const act = async (plan: DeskLaunchPlanRecord, action: 'execute' | 'cancel'): Promise<void> => {
    if (workingId) return;
    setWorkingId(plan.id);
    setError(null);
    try {
      if (action === 'execute') await deskApi.executeLaunchPlan(plan.id);
      else await deskApi.cancelLaunchPlan(plan.id);
      await feed.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorkingId(null);
    }
  };

  if (feed.loading && feed.plans.length === 0) return null;
  if (visible.length === 0 && !feed.error) return null;

  return (
    <div className="mt-5 space-y-3">
      {visible.map((plan) => (
        <LaunchPlanCard
          key={plan.id}
          plan={plan}
          working={workingId === plan.id}
          onExecute={() => void act(plan, 'execute')}
          onCancel={() => void act(plan, 'cancel')}
        />
      ))}
      <ErrorBar error={error ?? feed.error} />
    </div>
  );
}

function LaunchPlanCard({
  plan,
  working,
  onExecute,
  onCancel,
}: {
  readonly plan: DeskLaunchPlanRecord;
  readonly working: boolean;
  readonly onExecute: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  const pending = plan.status === 'pending';
  const executing = plan.status === 'executing';
  const completed = plan.status === 'completed';
  const status = completed ? 'Started' : executing ? 'Starting' : plan.status === 'failed' ? 'Needs attention' : 'Ready to start';
  const tone = completed ? 'green' : plan.status === 'failed' ? 'red' : 'amber';
  return (
    <section className="anim-in overflow-hidden rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950" aria-label={`Launch ${plan.missions.length} missions`}>
      <div className="flex flex-wrap items-start gap-3 px-4 py-3.5">
        <StatusDot tone={tone} pulse={executing} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">Start {plan.missions.length} independent mission{plan.missions.length === 1 ? '' : 's'}</h3>
          <p className="dim mt-0.5 text-[11px]">{status} · prepared by Terminal · inherits its runtime preference</p>
        </div>
        {executing || working ? <Spinner /> : null}
      </div>

      <div className="divide-y divide-zinc-100 border-y border-zinc-100 dark:divide-zinc-800 dark:border-zinc-800">
        {plan.missions.map((mission, index) => (
          <div key={`${plan.id}:${index}`} className="px-4 py-3">
            <div className="flex items-baseline gap-2">
              <span className="dim text-[10px] tabular-nums">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{mission.title}</span>
              <span className="dim shrink-0 text-[10px]">{targetLabel(mission)}</span>
            </div>
            <p className="dim mt-1 line-clamp-2 pl-5 text-[11px] leading-relaxed">{mission.prompt}</p>
          </div>
        ))}
      </div>

      {plan.error ? (
        <p className="px-4 pt-3 text-xs text-red-600 dark:text-red-400">{plan.error}</p>
      ) : null}
      {plan.missionIds.length > 0 ? (
        <p className="dim px-4 pt-3 text-[11px]">
          {plan.missionIds.length} mission{plan.missionIds.length === 1 ? '' : 's'} available in{' '}
          <a className="link" href="#/missions">Missions</a>.
        </p>
      ) : null}
      {pending ? (
        <div className="flex items-center gap-2 px-4 py-3">
          <button type="button" className="btn h-8 text-xs" disabled={working} onClick={onExecute}>
            {working ? <Spinner /> : null}
            Start {plan.missions.length} mission{plan.missions.length === 1 ? '' : 's'}
          </button>
          <button type="button" className="btn-ghost h-8 text-xs" disabled={working} onClick={onCancel}>Cancel</button>
        </div>
      ) : null}
    </section>
  );
}

function targetLabel(mission: DeskLaunchPlanRecord['missions'][number]): string {
  if (mission.contexts.length === 1) {
    const context = mission.contexts[0]!;
    return `${context.kind === 'pull-request' ? 'PR' : 'Issue'} #${context.number}`;
  }
  if (mission.contexts.length > 1) return `${mission.contexts.length} targets`;
  return mission.repo ?? 'Workspace';
}
