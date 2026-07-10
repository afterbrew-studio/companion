import { Markdown, timeAgo } from '@companion/ui';
import type { ReportRecord } from '@companion/module-workspace/contract';

/**
 * Collapsible feed entry for a scheduled-agent report — shared by the
 * Automations feed and the Digest history. `showRepo` is for mixed-repo feeds;
 * the Digest omits it because every row is the selected repo.
 */
export function ReportCard({ report, showRepo }: { report: ReportRecord; showRepo?: boolean }): JSX.Element {
  return (
    <details className="card">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm select-none">
        <span className="badge">{report.kind}</span>
        <strong className="min-w-0 flex-1 truncate">{report.title}</strong>
        {showRepo && report.repo ? <span className="dim">{report.repo}</span> : null}
        <span className="dim">{timeAgo(report.createdAt)}</span>
      </summary>
      <div className="mt-2.5 border-t border-zinc-200 pt-2.5 dark:border-zinc-800">
        <Markdown text={report.body} />
      </div>
    </details>
  );
}
