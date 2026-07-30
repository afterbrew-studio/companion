import type { JSX } from 'react';
import type { RepoSyncFailure } from '../../contract/index.js';

/**
 * A refresh that failed says so, and says why. Reporting it as missing access
 * would send the reader to GitHub's permission settings for a problem that is
 * not there; the rows below are still the last data GitHub gave us.
 */
export function SyncFailureBanner({ failures }: { failures: readonly RepoSyncFailure[] }): JSX.Element | null {
  if (failures.length === 0) return null;
  return (
    <div className="banner-warn flex-col items-start gap-1" role="status">
      <span>Could not refresh from GitHub. Showing the last synced data.</span>
      <ul className="dim">
        {failures.map((failure) => (
          <li key={failure.repo}>
            <span className="font-medium">{failure.repo}</span>: {failure.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
