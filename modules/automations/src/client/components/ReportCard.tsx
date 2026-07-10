import { Markdown, timeAgo } from '@companion/ui';
import type { ReportRecord } from '@companion/module-workspace/contract';

/**
 * Collapsible feed entry for a scheduled-agent report — shared by the
 * Automations feed and the Digest history. Both render inside a repo-scoped
 * context, so the row shows kind + title, never the repo.
 */
export function ReportCard({ report }: { report: ReportRecord }): JSX.Element {
  return (
    <details className="card">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-sm select-none">
        <span className="badge">{report.kind}</span>
        <strong className="min-w-0 flex-1 truncate">{report.title}</strong>
        <span className="dim">{timeAgo(report.createdAt)}</span>
      </summary>
      <div className="mt-2.5 border-t border-zinc-200 pt-2.5 dark:border-zinc-800">
        <Markdown text={report.body} />
      </div>
    </details>
  );
}
