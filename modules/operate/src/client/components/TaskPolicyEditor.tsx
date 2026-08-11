import { useState } from 'react';
import { ChevronDown } from '@moxxy/companion-ui';
import type { RunnerTaskPolicy, RunTaskDescriptor, RunTaskGroup } from '../../contract/index.js';
import {
  moduleTaskPolicyReach,
  taskPolicyAllows,
  withModuleAllowed,
  withoutTaskPolicyEntry,
  withTaskAllowed,
} from '../../contract/index.js';

/**
 * The two-level workforce policy: a module row over everything that module
 * registers (now and in future), expanding to its individual tasks.
 *
 * A tick always reads the same way ("this machine may run this") whichever mode
 * the policy is in, so an operator never has to invert the list in their head.
 * The stored shape is what differs: under `allow` a tick is an entry, under
 * `deny` it is the absence of one.
 *
 * Reach is the only thing a row must convey beyond its tick, so it rides in the
 * count: "all tasks" and "no tasks" also answer what the module registers later,
 * "3 of 7" answers only what exists today. The rule behind that reading is
 * stated once above the list rather than repeated on every row, and it depends
 * on the mode, so it is written from the mode.
 */
export function TaskPolicyEditor({
  groups,
  policy,
  onChange,
}: {
  groups: readonly RunTaskGroup[];
  policy: RunnerTaskPolicy;
  onChange: (next: RunnerTaskPolicy) => void;
}): React.JSX.Element {
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const known = new Set(groups.flatMap((g) => [g.moduleId, ...g.tasks.map((t) => t.id)]));
  const orphans = [...policy.modules, ...policy.tasks].filter((id) => !known.has(id));

  return (
    <div className="flex flex-col gap-2">
      {groups.length === 0 ? (
        <p className="dim text-[13px]">No module has registered agent work yet.</p>
      ) : (
        <p className="dim text-xs">
          {policy.mode === 'deny'
            ? 'Tasks a module registers later are allowed, unless you untick the whole module.'
            : 'Tasks a module registers later are refused, unless you tick the whole module.'}
        </p>
      )}
      {groups.map((group) => {
        const state = moduleState(policy, group);
        const open = opened[group.moduleId] ?? state === 'some';
        const placeable = group.tasks.filter((t) => t.placeable);
        const daemonBound = group.tasks.filter((t) => !t.placeable);
        const panelId = `task-policy-${group.moduleId}`;
        const summary = moduleSummary(policy, group);
        return (
          <div key={group.moduleId} className="rounded-lg border border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center gap-2.5 px-3 py-2">
              <TriCheckbox
                label={`All ${group.moduleTitle} work`}
                state={state}
                onChange={(next) => onChange(withModuleAllowed(policy, group.moduleId, next))}
              />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{group.moduleTitle}</span>
              <button
                type="button"
                className="btn-ghost shrink-0 gap-1.5 text-xs"
                aria-expanded={open}
                aria-controls={open ? panelId : undefined}
                aria-label={`${group.moduleTitle}: ${summary}`}
                onClick={() => setOpened((prev) => ({ ...prev, [group.moduleId]: !open }))}
              >
                <span className="tabular-nums">{summary}</span>
                <ChevronDown open={open} className="size-3.5" />
              </button>
            </div>

            {open ? (
              <div
                id={panelId}
                className="flex flex-col gap-0.5 border-t border-zinc-200 px-3 py-2 dark:border-zinc-800"
              >
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
                    <span className="min-w-0 flex-1">{task.label}</span>
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
              onClick={() => onChange(withoutTaskPolicyEntry(policy, id))}
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
function DaemonBoundRow({ task, allowed }: { task: RunTaskDescriptor; allowed: boolean }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5 px-2 py-1.5 text-sm" title={task.hint}>
      <span className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{task.label}</span>
      <span className="dim shrink-0 text-xs">runs on the daemon&apos;s machine</span>
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
}): React.JSX.Element {
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

/**
 * The row's whole reading. A module answered uniformly is uncountable, because
 * the answer also covers tasks it has not registered yet, so it reads as a word;
 * one pinned to today's tasks reads as a number.
 */
function moduleSummary(policy: RunnerTaskPolicy, group: RunTaskGroup): string {
  const reach = moduleTaskPolicyReach(policy, group.moduleId);
  if (reach !== 'partial') return reach === 'all' ? 'all tasks' : 'no tasks';
  const allowed = group.tasks.filter((task) => taskPolicyAllows(policy, task.id)).length;
  return `${allowed} of ${group.tasks.length}`;
}
