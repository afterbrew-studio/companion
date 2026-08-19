import { useCallback, useEffect, useState } from 'react';
import { useLive } from '@moxxy/companion-sdk/client';
import {
  ExternalLinkIcon,
  SparkleIcon,
  Spinner,
  StatusDot,
  timeAgo,
} from '@moxxy/companion-sdk/ui';
import { useAuth } from '@companion/module-core/client';
import { QUALITY_META, SlopMeter, slopApi } from '@companion/module-slop/client';
import type { SlopDetectionResult } from '@companion/module-slop/contract';

interface PrHealthProps {
  readonly repo: string;
  readonly number: number;
}

/** A compact view of module-slop's real assessment. Desk composes the existing
 * service instead of growing a second detector with different rules. */
export function PrHealth({ repo, number }: PrHealthProps): React.JSX.Element | null {
  const { can } = useAuth();
  const [detections, setDetections] = useState<readonly SlopDetectionResult[] | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!can('slop:read')) return;
    try {
      setDetections((await slopApi.detectionsForPr(repo, number)).detections);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [can, number, repo]);

  useEffect(() => {
    setDetections(null);
    setError(null);
  }, [number, repo]);

  useLive(refresh, (message) => message.t === 'slop.changed');

  if (!can('slop:read')) return null;

  const latest = detections?.[0] ?? null;
  const canRun = can('slop:act') && can('runs:read') && can('runs:act');

  const run = async (): Promise<void> => {
    if (!canRun || starting || latest?.status === 'running') return;
    setStarting(true);
    setError(null);
    try {
      await slopApi.detect(repo, number);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  return (
    <section className="mt-5 border-t border-zinc-200 pt-4 dark:border-zinc-800" aria-labelledby={`pr-health-${number}`}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
          <SparkleIcon className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={`pr-health-${number}`} className="text-xs font-semibold">PR health</h3>
          <p className="dim mt-0.5 text-[10px]">Contribution quality &amp; AI signals</p>
        </div>
        {canRun ? (
          <button
            type="button"
            className="dim h-7 shrink-0 cursor-pointer rounded-md px-2 text-[10px] font-medium hover:bg-zinc-100 hover:text-zinc-900 disabled:cursor-default disabled:opacity-50 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            disabled={starting || latest?.status === 'running'}
            onClick={() => void run()}
          >
            {starting ? 'Starting…' : latest ? 'Check again' : 'Check now'}
          </button>
        ) : null}
      </div>

      {detections === null && !error ? (
        <div className="mt-4 flex items-center gap-2 text-[11px] text-zinc-500"><Spinner /> Loading assessment…</div>
      ) : error && detections === null ? (
        <div className="mt-4 flex items-start gap-2 text-[11px] text-red-600 dark:text-red-400">
          <StatusDot tone="red" size="sm" className="mt-1" />
          <span className="min-w-0 leading-relaxed">{error}</span>
        </div>
      ) : !latest ? (
        <p className="dim mt-4 text-[11px] leading-relaxed">
          Not assessed yet. The check reads the diff, tests, evidence and contribution signals in the background.
        </p>
      ) : latest.status === 'running' ? (
        <div className="mt-4 flex items-start gap-2.5">
          <Spinner />
          <div className="min-w-0">
            <div className="text-[11px] font-medium">Reading the diff and evidence…</div>
            <div className="dim mt-0.5 text-[10px]">Started {timeAgo(latest.createdAt)}</div>
          </div>
        </div>
      ) : latest.status === 'failed' || !latest.verdict ? (
        <div className="mt-4 flex items-start gap-2.5">
          <StatusDot tone="red" size="sm" className="mt-1" />
          <div className="min-w-0">
            <div className="text-[11px] font-medium">Assessment failed</div>
            <div className="dim mt-0.5 line-clamp-3 text-[10px] leading-relaxed">{latest.error ?? 'No verdict was produced.'}</div>
          </div>
        </div>
      ) : (
        <Assessment detection={latest} />
      )}
      {error && detections !== null ? <p className="mt-3 text-[10px] text-red-600 dark:text-red-400">Could not refresh: {error}</p> : null}
    </section>
  );
}

function Assessment({ detection }: { readonly detection: SlopDetectionResult }): React.JSX.Element {
  const verdict = detection.verdict!;
  const quality = QUALITY_META[verdict.qualityClass];
  return (
    <div className="mt-4">
      <div className="flex items-center gap-2">
        <StatusDot tone={quality.tone} size="sm" />
        <span className="text-[11px] font-medium capitalize">{quality.label}</span>
        <span className="dim ml-auto text-[10px]">{timeAgo(detection.createdAt)}</span>
      </div>

      <div className="mt-3 space-y-2.5">
        <div className="flex items-center justify-between gap-3 text-[10px]">
          <span className="dim">AI signal</span>
          <SlopMeter value={verdict.aiLikelihood} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <CompactScore label="Value" value={verdict.valueScore} />
          <CompactScore label="Evidence" value={verdict.evidenceScore} />
        </div>
      </div>

      <p className="mt-3 line-clamp-3 text-[11px] leading-relaxed text-zinc-700 dark:text-zinc-300">{verdict.summary}</p>
      <a
        href={`/#/contribution-quality/${encodeURIComponent(detection.id)}`}
        target="_blank"
        rel="noreferrer"
        className="dim mt-3 inline-flex items-center gap-1.5 text-[10px] hover:text-zinc-900 dark:hover:text-zinc-100"
      >
        Full report <ExternalLinkIcon className="size-3" />
      </a>
    </div>
  );
}

function CompactScore({ label, value }: { readonly label: string; readonly value: number }): React.JSX.Element {
  return (
    <div className="rounded-md bg-zinc-50 px-2.5 py-2 dark:bg-zinc-900">
      <div className="dim text-[9px]">{label}</div>
      <div className="mt-0.5 text-xs font-semibold tabular-nums">{value}<span className="dim text-[9px] font-normal">/100</span></div>
    </div>
  );
}
