import { unmeteredHarnesses } from '../../contract/index.js';
import { useRunners } from '../hooks/useRunners.js';

/**
 * What the monthly ceiling cannot see, said where the ceiling is set.
 *
 * A ceiling counts what a harness reports a turn consumed. One that reports
 * nothing does not make the ceiling smaller, it makes it blind: work runs, the
 * number stays where it was, and the operator reads "under budget" from a
 * figure that never moved. That is worse than having no ceiling, so it is named
 * before the field is edited rather than discovered from a bill.
 *
 * Silent when every machine's runtimes report usage, which is every instance
 * until a second harness is chosen anywhere.
 */
export function CeilingReach(): JSX.Element | null {
  const { runners } = useRunners();
  if (runners === null) return null;
  const blind = unmeteredHarnesses(runners.flatMap((r) => r.harnesses));
  if (blind.length === 0) return null;
  const names = [...new Set(blind.map((h) => h.label))];
  return (
    <div className="banner-warn mb-3" role="status">
      {names.join(' and ')} {names.length === 1 ? 'reports' : 'report'} nothing about what a turn consumed, so work
      run through {names.length === 1 ? 'it' : 'them'} does not count towards either ceiling below. The ceilings still
      hold for everything else.
    </div>
  );
}
