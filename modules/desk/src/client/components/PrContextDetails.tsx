import { useCallback, useEffect, useRef, useState } from 'react';
import { onServerMessage } from '@moxxy/companion-sdk/client';
import {
  BranchIcon,
  DiffView,
  MAX_DIFF_CHARS,
  Modal,
} from '@moxxy/companion-sdk/ui';
import type {
  PrFileChange,
  PrFileChangesPage,
  PrRecord,
} from '@companion/module-code/contract';
import { codeApi } from '@companion/module-code/client';

type PrState = Pick<PrRecord, 'state' | 'draft' | 'mergeable' | 'mergeStateStatus' | 'checks'>;

export function PrContextIcon({ pr, className = '' }: { readonly pr: PrState | null; readonly className?: string }): React.JSX.Element {
  return <BranchIcon className={`size-4 ${prIconClass(pr)} ${className}`} />;
}

export function PrMergeStatus({ pr }: { readonly pr: PrState }): React.JSX.Element {
  const status = mergeStatus(pr);
  return (
    <span className={`flex items-center gap-2 ${status.className}`} title={status.hint}>
      <span className={`size-2 shrink-0 rounded-full ${status.dotClassName}`} aria-hidden="true" />
      {status.label}
    </span>
  );
}

export function PrChangesPreview({ repo, number }: { readonly repo: string; readonly number: number }): React.JSX.Element {
  const [data, setData] = useState<PrFileChangesPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const generation = useRef(0);
  const pageRef = useRef(1);
  const cache = useRef(new Map<number, PrFileChangesPage>());

  const loadPage = useCallback(async (page: number, fresh = false): Promise<void> => {
    const request = ++generation.current;
    pageRef.current = page;
    const cached = fresh ? null : cache.current.get(page) ?? null;
    if (cached) {
      setData(cached);
      setSelectedFile((current) => cached.files.some((file) => file.filename === current) ? current : cached.files[0]?.filename ?? null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await codeApi.prFiles(repo, number, page);
      if (request !== generation.current) return;
      rememberPage(cache.current, result);
      setData(result);
      setSelectedFile((current) => result.files.some((file) => file.filename === current) ? current : result.files[0]?.filename ?? null);
    } catch (err) {
      if (request === generation.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [number, repo]);

  useEffect(() => {
    generation.current++;
    cache.current.clear();
    pageRef.current = 1;
    setData(null);
    setSelectedFile(null);
    setError(null);
    setLoading(true);
    void loadPage(1, true);
  }, [loadPage, number, repo]);

  useEffect(() => onServerMessage((message) => {
    if (message.t !== 'prs.changed' || message.repo !== repo) return;
    cache.current.clear();
    void loadPage(pageRef.current, true);
  }), [loadPage, repo]);

  const totals = data ? fileTotals(data.files) : null;
  const preview = data ? previewFile(data.files) : null;

  return (
    <>
      <button
        type="button"
        className="group mt-5 w-full cursor-pointer border-t border-zinc-200 pt-4 text-left dark:border-zinc-800"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
      >
        <span className="flex items-center gap-2 text-xs">
          <span className="font-semibold">Changes</span>
          {data && totals ? (
            <span className="ml-auto flex items-center gap-2 tabular-nums">
              <span className="dim">{fileCount(data)}</span>
              <span className="text-emerald-600 dark:text-emerald-400">+{totals.added}</span>
              <span className="text-red-600 dark:text-red-400">−{totals.removed}</span>
            </span>
          ) : loading ? <ChangesSummarySkeleton /> : null}
        </span>

        {preview ? (
          <MiniDiff file={preview} />
        ) : loading ? (
          <MiniDiffSkeleton />
        ) : (
          <span className={`mt-3 block text-xs ${error ? 'text-red-600 dark:text-red-400' : 'dim'}`}>
            {error ? 'Changes unavailable — open to retry.' : 'No changed files reported.'}
          </span>
        )}
        <span className="dim mt-2 block text-[10px] transition-colors group-hover:text-zinc-700 dark:group-hover:text-zinc-300">Open diff preview ↗</span>
      </button>

      {open ? (
        <ChangesModal
          repo={repo}
          number={number}
          data={data}
          loading={loading}
          error={error}
          selectedFile={selectedFile}
          onSelectFile={setSelectedFile}
          onPage={(page) => void loadPage(page)}
          onRetry={() => void loadPage(pageRef.current, true)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function ChangesModal({
  repo,
  number,
  data,
  loading,
  error,
  selectedFile,
  onSelectFile,
  onPage,
  onRetry,
  onClose,
}: {
  readonly repo: string;
  readonly number: number;
  readonly data: PrFileChangesPage | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly selectedFile: string | null;
  readonly onSelectFile: (path: string) => void;
  readonly onPage: (page: number) => void;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const file = data?.files.find((entry) => entry.filename === selectedFile) ?? data?.files[0] ?? null;
  const totals = data ? fileTotals(data.files) : null;
  const diff = file ? fileDiff(file) : '';
  return (
    <Modal title={`Changes · PR #${number}`} onClose={onClose} xl>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="dim min-w-0 flex-1 truncate">{repo}</span>
        {totals && data ? (
          <span className="flex items-center gap-2 tabular-nums">
            <span className="dim">{fileCount(data)}</span>
            <span className="text-emerald-600 dark:text-emerald-400">+{totals.added}</span>
            <span className="text-red-600 dark:text-red-400">−{totals.removed}</span>
          </span>
        ) : null}
      </div>

      {data && data.files.length > 0 ? (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-y border-zinc-200 py-3 dark:border-zinc-800">
          <select
            className="input input-sm min-w-0 flex-1 font-mono text-xs"
            value={file?.filename ?? ''}
            onChange={(event) => onSelectFile(event.target.value)}
            aria-label="Changed file"
          >
            {data.files.map((entry) => <option key={entry.filename} value={entry.filename}>{entry.filename}</option>)}
          </select>
          <button type="button" className="btn-ghost h-8 text-xs" disabled={loading || data.page <= 1} onClick={() => onPage(data.page - 1)}>Previous</button>
          <span className="dim tabular-nums text-xs">Page {data.page}</span>
          <button type="button" className="btn-ghost h-8 text-xs" disabled={loading || !data.hasNextPage} onClick={() => onPage(data.page + 1)}>Next</button>
        </div>
      ) : null}

      {error && data ? (
        <div className="mt-3 flex items-center gap-3 rounded-lg bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          <span className="min-w-0 flex-1 truncate">{error}</span>
          <button type="button" className="btn-ghost shrink-0 text-xs" onClick={onRetry}>Retry</button>
        </div>
      ) : null}

      {loading && !data ? (
        <DiffModalSkeleton />
      ) : error && !data ? (
        <div className="mt-5 rounded-lg bg-red-500/5 px-4 py-3 text-sm text-red-600 dark:text-red-400">
          <div>{error}</div>
          <button type="button" className="btn-ghost mt-3 text-xs" onClick={onRetry}>Retry</button>
        </div>
      ) : file && diff ? (
        <div className="mt-4 max-h-[65vh] overflow-auto"><DiffView diff={diff} /></div>
      ) : file ? (
        <p className="dim mt-5 text-sm">GitHub did not provide a text patch for this file. It may be binary or too large to preview.</p>
      ) : (
        <p className="dim mt-5 text-sm">No changed files reported.</p>
      )}
    </Modal>
  );
}

function MiniDiff({ file }: { readonly file: PrFileChange }): React.JSX.Element {
  const lines = miniDiffLines(file.patch);
  return (
    <span className="mt-3 block overflow-hidden rounded-lg bg-zinc-950 text-zinc-200 shadow-inner">
      <span className="block truncate border-b border-white/10 px-3 py-2 font-mono text-[9px] text-zinc-400">{file.filename}</span>
      <span className="block min-h-16 px-3 py-2 font-mono text-[9px] leading-4">
        {lines.length > 0 ? lines.map((line, index) => (
          <span key={`${line}:${index}`} className={`block truncate ${diffLineClass(line)}`}>{line || ' '}</span>
        )) : <span className="text-zinc-500">Binary or large file — no inline patch</span>}
      </span>
    </span>
  );
}

function MiniDiffSkeleton(): React.JSX.Element {
  return (
    <span className="mt-3 block min-h-24 animate-pulse rounded-lg bg-zinc-200 motion-reduce:animate-none dark:bg-zinc-800" aria-label="Loading changes" />
  );
}

function ChangesSummarySkeleton(): React.JSX.Element {
  return <span className="ml-auto h-3 w-24 animate-pulse rounded bg-zinc-200 motion-reduce:animate-none dark:bg-zinc-800" />;
}

function DiffModalSkeleton(): React.JSX.Element {
  const line = 'animate-pulse rounded bg-zinc-200 motion-reduce:animate-none dark:bg-zinc-800';
  return (
    <div className="mt-5 space-y-3" aria-label="Loading diff">
      <div className={`${line} h-9 w-full`} />
      <div className={`${line} h-4 w-[92%]`} />
      <div className={`${line} h-4 w-[78%]`} />
      <div className={`${line} h-4 w-[86%]`} />
      <div className={`${line} h-4 w-[64%]`} />
    </div>
  );
}

function prIconClass(pr: PrState | null): string {
  if (!pr) return 'text-zinc-400';
  if (pr.state === 'merged') return 'text-violet-600 dark:text-violet-400';
  if (pr.state === 'closed') return 'text-red-600 dark:text-red-400';
  if (pr.mergeStateStatus === 'dirty' || pr.checks?.state === 'failing') return 'text-red-600 dark:text-red-400';
  if (pr.checks?.state === 'pending') return 'text-blue-600 dark:text-blue-400';
  if (pr.draft) return 'text-zinc-500 dark:text-zinc-400';
  if (pr.mergeStateStatus === 'blocked' || pr.mergeStateStatus === 'behind' || pr.mergeStateStatus === 'unstable') return 'text-amber-600 dark:text-amber-400';
  if (pr.mergeable === false) return 'text-red-600 dark:text-red-400';
  return 'text-emerald-600 dark:text-emerald-400';
}

function mergeStatus(pr: PrState): {
  readonly label: string;
  readonly hint: string;
  readonly dotClassName: string;
  readonly className: string;
} {
  if (pr.state === 'merged') return { label: 'Merged', hint: 'This pull request has been merged.', dotClassName: 'bg-violet-500', className: 'text-violet-600 dark:text-violet-400' };
  if (pr.state === 'closed') return { label: 'Closed', hint: 'This pull request was closed without merging.', dotClassName: 'bg-zinc-400', className: 'dim' };
  if (pr.mergeStateStatus === 'dirty') return { label: 'Conflicts', hint: 'The branch has merge conflicts that must be resolved.', dotClassName: 'bg-red-500', className: 'text-red-600 dark:text-red-400' };
  if (pr.mergeStateStatus === 'blocked') return { label: 'Blocked', hint: 'A branch rule, review or check is blocking this pull request.', dotClassName: 'bg-amber-500', className: 'text-amber-600 dark:text-amber-400' };
  if (pr.mergeStateStatus === 'behind') return { label: 'Behind', hint: 'The head branch is behind the base branch.', dotClassName: 'bg-amber-500', className: 'text-amber-600 dark:text-amber-400' };
  if (pr.mergeStateStatus === 'unstable') return { label: 'Unstable', hint: 'GitHub reports an unstable merge state.', dotClassName: 'bg-amber-500', className: 'text-amber-600 dark:text-amber-400' };
  if (pr.draft || pr.mergeStateStatus === 'draft') return { label: 'Draft', hint: 'Draft pull requests cannot be merged yet.', dotClassName: 'bg-zinc-400', className: 'dim' };
  if (pr.mergeable === false) return { label: 'Not mergeable', hint: 'GitHub currently reports that this pull request cannot be merged.', dotClassName: 'bg-red-500', className: 'text-red-600 dark:text-red-400' };
  if (pr.mergeable === true || pr.mergeStateStatus === 'clean') return { label: 'Ready', hint: 'GitHub reports a clean merge state.', dotClassName: 'bg-emerald-500', className: 'text-emerald-600 dark:text-emerald-400' };
  return { label: 'Checking', hint: 'GitHub is still calculating mergeability.', dotClassName: 'bg-zinc-400', className: 'dim' };
}

function miniDiffLines(patch: string | null): string[] {
  if (!patch) return [];
  const lines = patch.split('\n');
  const firstChange = lines.findIndex((line) => line.startsWith('+') || line.startsWith('-'));
  const start = firstChange >= 0 ? Math.max(0, firstChange - 1) : 0;
  return lines.slice(start, start + 4);
}

function diffLineClass(line: string): string {
  if (line.startsWith('+')) return 'text-emerald-400';
  if (line.startsWith('-')) return 'text-red-400';
  if (line.startsWith('@@')) return 'text-violet-400';
  return 'text-zinc-400';
}

function fileTotals(files: readonly PrFileChange[]): { readonly added: number; readonly removed: number } {
  return files.reduce((totals, file) => ({
    added: totals.added + file.additions,
    removed: totals.removed + file.deletions,
  }), { added: 0, removed: 0 });
}

function fileCount(data: PrFileChangesPage): string {
  if (data.page > 1) return `${data.files.length} file${data.files.length === 1 ? '' : 's'} on page ${data.page}`;
  const suffix = data.hasNextPage ? '+' : '';
  return `${data.files.length}${suffix} file${data.files.length === 1 && !data.hasNextPage ? '' : 's'}`;
}

function previewFile(files: readonly PrFileChange[]): PrFileChange | null {
  return files.find((file) => file.patch !== null) ?? files[0] ?? null;
}

function fileDiff(file: PrFileChange): string {
  if (!file.patch) return '';
  const from = file.previousFilename ?? file.filename;
  const raw = `diff --git a/${from} b/${file.filename}\n${file.patch}`;
  return raw.length > MAX_DIFF_CHARS ? raw.slice(0, MAX_DIFF_CHARS) : raw;
}

function rememberPage(cache: Map<number, PrFileChangesPage>, data: PrFileChangesPage): void {
  cache.delete(data.page);
  cache.set(data.page, data);
  while (cache.size > 3) {
    const oldest = cache.keys().next().value as number | undefined;
    if (oldest === undefined) return;
    cache.delete(oldest);
  }
}
