import { useState } from 'react';
import type { RunnerTaskPolicy, RunTaskDescriptor, RunTaskGroup } from '../../contract/index.js';
import { taskModuleId, taskPolicyAllows } from '../../contract/index.js';

/**
 * The two-level workforce policy: a module row over everything that module
 * registers (now and in future), expanding to its individual tasks.
 *
 * A tick always reads the same way — "this machine may run this" — whichever
 * mode the policy is in, so an operator never has to invert the list in their
 * head. The stored shape is what differs: under `allow` a tick is an entry,
 * under `deny` it is the absence of one.
 */
export function TaskPolicyEditor({
  groups,
  policy,
  onChange,
}: {
  groups: readonly RunTaskGroup[];
  policy: RunnerTaskPolicy;
  onChange: (next: RunnerTaskPolicy) => void;
}): JSX.Element {
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const known = new Set(groups.flatMap((g) => [g.moduleId, ...g.tasks.map((t) => t.id)]));
  const orphans = [...policy.modules, ...policy.tasks].filter((id) => !known.has(id));

  return (
    <div className="flex flex-col gap-3">
      {groups.length === 0 ? (
        <p className="dim text-[13px]">No module has registered agent work yet.</p>
      ) : null}
      {groups.map((group) => {
        const state = moduleState(policy, group);
        const open = opened[group.moduleId] ?? state === 'some';
        const blanket = policy.modules.includes(group.moduleId);
        const placeable = group.tasks.filter((t) => t.placeable);
        const daemonBound = group.tasks.filter((t) => !t.placeable);
        return (
          <div key={group.moduleId} className="rounded-lg border border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center gap-2.5 px-3 py-2.5">
              <TriCheckbox
                label={`All ${group.moduleTitle} work`}
                state={state}
                onChange={(next) => onChange(withModuleAllowed(policy, group.moduleId, next))}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium">{group.moduleTitle}</span>
                <span className="dim block text-xs">{moduleNote(state, blanket, group.tasks.length)}</span>
              </span>
              <button
                type="button"
                className="btn-ghost shrink-0 text-xs"
                aria-expanded={open}
                onClick={() => setOpened((prev) => ({ ...prev, [group.moduleId]: !open }))}
              >
                {open ? 'Hide tasks' : `${group.tasks.length} task${group.tasks.length === 1 ? '' : 's'}`}
              </button>
            </div>

            {open ? (
              <div className="flex flex-col gap-0.5 border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
                {placeable.map((task) => (
                  <label
                    key={task.id}
                    title={task.hint}
                    className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-zinc-100 dark:hover:bg-zinc-800/60"
                  >
                    <input
                      type="checkbox"
                      checked={taskPolicyAllows(policy, task.id)}
                      onChange={(e) => onChange(withTaskAllowed(policy, groups, task.id, e.target.checked))}
                    />
                    <span className="flex-1">{task.label}</span>
                  </label>
                ))}
                {daemonBound.map((task) => (
                  <DaemonBoundRow key={task.id} task={task} allowed={taskPolicyAllows(policy, task.id)} />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}

      {orphans.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="dim text-xs">
            {policy.mode === 'allow' ? 'Allowed' : 'Refused'} entries whose module is not in this build:
          </span>
          {orphans.map((id) => (
            <button
              key={id}
              type="button"
              className="chip cursor-pointer font-mono hover:border-red-500/50 hover:text-red-600 dark:hover:text-red-400"
              title={`Drop ${id} from this machine's policy`}
              onClick={() => onChange(withoutEntry(policy, id))}
            >
              {id} ✕
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A task whose runs prepare their working directory on the daemon's machine and
 * land there without consulting placement. A fact about the work, not a setting
 * — so it states itself rather than rendering a control nobody switched off.
 * The state chip still shows the policy's answer, because a few of these do
 * reach placement (the ones that work from a shared snapshot).
 */
function DaemonBoundRow({ task, allowed }: { task: RunTaskDescriptor; allowed: boolean }): JSX.Element {
  return (
    <div className="flex items-center gap-2.5 px-2 py-1.5 text-sm" title={task.hint}>
      <span className="size-3.5 shrink-0" aria-hidden />
      <span className="flex-1">{task.label}</span>
      <span className="dim text-xs">runs on the daemon&apos;s machine</span>
      {allowed ? null : <span className="chip shrink-0">refused here</span>}
    </div>
  );
}

/** Checkbox with the third state a module row needs: all, none, or some. */
function TriCheckbox({
  label,
  state,
  onChange,
}: {
  label: string;
  state: ModuleState;
  onChange: (allowed: boolean) => void;
}): JSX.Element {
  return (
    <input
      type="checkbox"
      className="shrink-0"
      aria-label={label}
      checked={state === 'all'}
      ref={(el) => {
        if (el) el.indeterminate = state === 'some';
      }}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}

type ModuleState = 'all' | 'none' | 'some';

function moduleState(policy: RunnerTaskPolicy, group: RunTaskGroup): ModuleState {
  const allowed = group.tasks.filter((task) => taskPolicyAllows(policy, task.id)).length;
  if (allowed === group.tasks.length) return 'all';
  return allowed === 0 ? 'none' : 'some';
}

function moduleNote(state: ModuleState, blanket: boolean, count: number): string {
  if (state === 'some') return 'Some of its tasks — new tasks it registers are not covered.';
  if (state === 'all') {
    return blanket
      ? 'Everything it registers, including tasks added by future updates.'
      : `All ${count} of its tasks today; new ones are not covered.`;
  }
  return blanket ? 'Nothing it registers, now or in future.' : 'None of its tasks today.';
}

/** Set every task of a module, present and future, to one answer. */
function withModuleAllowed(policy: RunnerTaskPolicy, moduleId: string, allowed: boolean): RunnerTaskPolicy {
  // The blanket subsumes any individual entries underneath it, so they go.
  const tasks = policy.tasks.filter((id) => taskModuleId(id) !== moduleId);
  const listed = allowed === (policy.mode === 'allow');
  const modules = listed
    ? [...policy.modules.filter((m) => m !== moduleId), moduleId]
    : policy.modules.filter((m) => m !== moduleId);
  return { ...policy, modules, tasks };
}

/**
 * Set one task's answer. Doing so under a module blanket expands that blanket
 * over the tasks that exist today and drops it, because "everything this module
 * registers" and "everything but this one" cannot both be true. Tasks the
 * module adds later stop being covered — which is what per-task control means.
 */
function withTaskAllowed(
  policy: RunnerTaskPolicy,
  groups: readonly RunTaskGroup[],
  taskId: string,
  allowed: boolean,
): RunnerTaskPolicy {
  const moduleId = taskModuleId(taskId);
  let modules = policy.modules;
  let tasks = policy.tasks;
  if (modules.includes(moduleId)) {
    const siblings = groups.find((g) => g.moduleId === moduleId)?.tasks ?? [];
    modules = modules.filter((m) => m !== moduleId);
    tasks = [...new Set([...tasks, ...siblings.map((t) => t.id)])];
  }
  const listed = allowed === (policy.mode === 'allow');
  return {
    ...policy,
    modules,
    tasks: listed ? [...new Set([...tasks, taskId])] : tasks.filter((id) => id !== taskId),
  };
}

function withoutEntry(policy: RunnerTaskPolicy, id: string): RunnerTaskPolicy {
  return {
    ...policy,
    modules: policy.modules.filter((m) => m !== id),
    tasks: policy.tasks.filter((t) => t !== id),
  };
}

/**
 * Rewrite a policy into the other mode, preserving what the machine may do
 * TODAY: a fully-allowed module becomes a blanket entry, a partly-allowed one
 * becomes its individual tasks. What changes is the future, which is the whole
 * reason to switch — an allow-list stops covering tasks a module adds later,
 * and a deny-list starts covering them.
 *
 * Entries for modules not in this build are dropped: their effective answer
 * survives either way, because an unlisted id is allowed under `deny` and
 * refused under `allow`, which is exactly what they were.
 */
export function convertPolicyMode(
  policy: RunnerTaskPolicy,
  groups: readonly RunTaskGroup[],
  mode: RunnerTaskPolicy['mode'],
): RunnerTaskPolicy {
  if (mode === policy.mode) return policy;
  const modules: string[] = [];
  const tasks: string[] = [];
  for (const group of groups) {
    const listed = group.tasks.filter((task) => taskPolicyAllows(policy, task.id) === (mode === 'allow'));
    if (listed.length === group.tasks.length) modules.push(group.moduleId);
    else tasks.push(...listed.map((task) => task.id));
  }
  return { mode, modules, tasks };
}
