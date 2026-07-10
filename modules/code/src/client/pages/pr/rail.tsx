import type { ReactNode } from 'react';

/** Metadata-rail rows shared by the PR sidebars (PrView, PrBuild). */

/** Inline label/value row — for short scalar facts. */
export function RailRow({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-start gap-3">
      <span className="dim w-16 shrink-0 pt-0.5 text-xs font-medium tracking-wide uppercase">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

/** Stacked label-above-value block — for wide values (branches, chips, people). */
export function RailBlock({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="min-w-0">
      <div className="dim mb-1 text-[11px] font-medium tracking-wide uppercase">{label}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
