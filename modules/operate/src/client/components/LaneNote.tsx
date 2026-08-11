import { useLane } from '../hooks/useLane.js';

/**
 * Where the thing you are about to start will run.
 *
 * Placed next to a launch control rather than left to the sidebar: the lane is
 * ambient and therefore easy to forget, and the moment it matters most is the
 * moment before you commit work to it.
 *
 * Silent on `Auto`, which is the default and says nothing worth a line of
 * chrome. It only speaks when someone has chosen something.
 */
export function LaneNote({ className = '' }: { className?: string }): React.JSX.Element | null {
  const { lane, label, defaultModel, loading } = useLane();
  if (loading || lane === null || lane.runnerId === null) return null;
  return (
    <span className={`dim text-[11px] ${className}`}>
      Runs on {label}
      {defaultModel ? ` · ${defaultModel}` : ''}
    </span>
  );
}
