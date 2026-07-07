import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ChecksSnapshot, IssueRecord, PipelineRunStatus, StepResultStatus } from '@companion/contract';

/** Small shared primitives so every page speaks the same visual language. */

export function ChevronDown({ open, className = '' }: { open?: boolean; className?: string }): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      className={`size-4 shrink-0 text-zinc-400 transition-transform dark:text-zinc-500 ${open ? 'rotate-180' : ''} ${className}`}
    >
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
  /** Dim secondary text, right-aligned in the menu (e.g. a count). */
  hint?: string;
}

/**
 * Custom single-select listbox: a trigger button + popover menu, replacing
 * native `<select>` where we want full control over the menu's look.
 * Keyboard: arrows move, Enter/Space select, Escape closes and refocuses.
 */
export function Dropdown<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  placeholder = 'Select…',
  className = '',
  triggerClassName,
  renderTrigger,
  searchable,
  action,
}: {
  value: T | null;
  onChange: (v: T) => void;
  options: ReadonlyArray<DropdownOption<T>>;
  ariaLabel: string;
  placeholder?: string;
  className?: string;
  /** Replaces the default input-like trigger styling. */
  triggerClassName?: string;
  /** Replaces the default trigger content (label + chevron). */
  renderTrigger?: (selected: DropdownOption<T> | null, open: boolean) => ReactNode;
  /** Adds a filter input at the top of the menu. */
  searchable?: boolean;
  /** Pinned action row at the bottom of the menu (e.g. "New workspace"). */
  action?: { label: string; onSelect: () => void };
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = options.find((o) => o.value === value) ?? null;

  const q = query.trim().toLowerCase();
  const visible = q ? options.filter((o) => `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(q)) : options;

  // Focus the search field (if any) or the selected option when the menu opens.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    if (searchable) {
      searchRef.current?.focus();
      return;
    }
    const list = listRef.current;
    const target =
      list?.querySelector<HTMLButtonElement>('[aria-selected="true"]') ??
      list?.querySelector<HTMLButtonElement>('[role="option"]');
    target?.focus();
  }, [open, searchable]);

  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const onListKeyDown = (e: KeyboardEvent<HTMLUListElement>): void => {
    const items = [...(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[e.key === 'ArrowDown' ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0)]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      items[items.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    }
  };

  return (
    <div
      className={`relative ${className}`}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={
          triggerClassName ??
          'flex h-10 w-full cursor-pointer items-center justify-between gap-2 rounded-lg border border-zinc-300 bg-white px-3.5 text-left text-[13px] font-medium transition-colors hover:border-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-zinc-500'
        }
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        {renderTrigger ? (
          renderTrigger(selected, open)
        ) : (
          <>
            {selected ? (
              <span className="truncate">{selected.label}</span>
            ) : (
              <span className="truncate font-normal text-zinc-400 dark:text-zinc-500">{placeholder}</span>
            )}
            <ChevronDown open={open} />
          </>
        )}
      </button>

      {open ? (
        <div className="absolute inset-x-0 z-30 mt-1.5 overflow-hidden rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          {searchable ? (
            <input
              ref={searchRef}
              type="search"
              className="w-full border-b border-zinc-200 bg-transparent px-3 py-2 text-[13px] outline-none placeholder:text-zinc-400 dark:border-zinc-800"
              placeholder="Search…"
              aria-label={`Filter ${ariaLabel}`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  listRef.current?.querySelector<HTMLButtonElement>('[role="option"]')?.focus();
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  const first = visible[0];
                  if (first) {
                    onChange(first.value);
                    close(true);
                  }
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  close(true);
                }
              }}
            />
          ) : null}
          <ul
            ref={listRef}
            role="listbox"
            aria-label={ariaLabel}
            className="max-h-72 overflow-y-auto p-1"
            onKeyDown={onListKeyDown}
          >
          {visible.map((o) => {
            const isSelected = o.value === value;
            return (
              <li key={o.value}>
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className="flex w-full cursor-pointer items-center justify-between gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] outline-none hover:bg-zinc-100 focus:bg-zinc-100 dark:hover:bg-zinc-800 dark:focus:bg-zinc-800"
                  onClick={() => {
                    onChange(o.value);
                    close(true);
                  }}
                >
                  <span className="min-w-0">
                    <span className={`block truncate ${isSelected ? 'font-medium' : ''}`}>{o.label}</span>
                    {o.hint ? <span className="dim block truncate text-[11px]">{o.hint}</span> : null}
                  </span>
                  {isSelected ? (
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      aria-hidden
                      className="size-4 shrink-0 text-accent-600 dark:text-accent-400"
                    >
                      <path
                        d="M3.5 8.5l3 3 6-7"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  ) : null}
                </button>
              </li>
            );
          })}
            {visible.length === 0 ? <li className="dim px-2.5 py-2">{q ? 'No matches' : 'No options'}</li> : null}
          </ul>
          {action ? (
            <div className="border-t border-zinc-200 p-1 dark:border-zinc-800">
              <button
                type="button"
                className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-2 text-left text-[13px] font-medium outline-none hover:bg-zinc-100 focus:bg-zinc-100 dark:hover:bg-zinc-800 dark:focus:bg-zinc-800"
                onClick={() => {
                  close(false);
                  action.onSelect();
                }}
              >
                <span aria-hidden>＋</span> {action.label}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Standard page container — every page shares the same content width. */
export function Page({ children, className = '' }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={`mx-auto w-full max-w-5xl px-6 py-6 ${className}`}>{children}</div>;
}

/** Titled page section (heading + optional description above the content). */
export function Section({
  title,
  description,
  children,
  className = '',
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <section className={`mt-8 ${className}`} aria-label={title}>
      <h2 className="mb-2 text-sm font-semibold">{title}</h2>
      {description ? <p className="dim mb-3 text-[13px]">{description}</p> : null}
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle ? <div className="dim mt-0.5">{subtitle}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Signed change vs a named period; color = direction × whether up is good. */
export interface StatDelta {
  readonly current: number;
  readonly previous: number;
  /** Named comparison period, e.g. "vs last week". */
  readonly period: string;
  /** Colors the marker: green when upward movement is desirable. Default true. */
  readonly upIsGood?: boolean;
}

function DeltaChip({ delta }: { delta: StatDelta }): JSX.Element {
  const diff = delta.current - delta.previous;
  // Percent only against a real base; from zero the absolute count is honest.
  const pct = delta.previous > 0 ? Math.round((diff / delta.previous) * 100) : null;
  const amount = diff === 0 ? '±0' : `${diff > 0 ? '+' : ''}${pct !== null ? `${pct}%` : diff}`;
  const cls =
    diff === 0
      ? 'text-zinc-400 dark:text-zinc-500'
      : (delta.upIsGood ?? true) === diff > 0
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-red-600 dark:text-red-400';
  return (
    <span className={`inline-flex items-baseline gap-1 text-[11px] font-medium whitespace-nowrap ${cls}`}>
      <span aria-hidden>{diff > 0 ? '▲' : diff < 0 ? '▼' : '→'}</span>
      {amount} <span className="dim font-normal">{delta.period}</span>
    </span>
  );
}

/**
 * Full-bleed trend behind a stat tile's content: a recessive line + soft area
 * fill hugging the tile's bottom edge. Decorative — the delta chip carries the
 * readable comparison.
 */
function TrendBackground({ points }: { points: ReadonlyArray<number> }): JSX.Element | null {
  if (points.length < 2) return null;
  const w = 100;
  const h = 32;
  const max = Math.max(...points);
  const min = Math.min(...points);
  const flat = max === min;
  const x = (i: number): number => (i / (points.length - 1)) * w;
  // Headroom at the top so peaks never touch the content; flat series sit low.
  const y = (v: number): number => (flat ? h * 0.72 : 6 + (1 - (v - min) / (max - min)) * (h - 10));
  const line = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${w} ${h} L0 ${h} Z`;
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-x-0 bottom-0 h-12 w-full"
      aria-hidden
    >
      <path d={area} className="fill-zinc-200/40 dark:fill-zinc-700/25" />
      <path
        d={line}
        fill="none"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-zinc-300/60 dark:stroke-zinc-600/50"
      />
    </svg>
  );
}

export function StatTile({
  label,
  value,
  hint,
  href,
  tone = 'default',
  delta,
  trend,
}: {
  label: string;
  value: string | number;
  hint?: string;
  href?: string;
  tone?: 'default' | 'ok' | 'warn' | 'danger';
  delta?: StatDelta;
  trend?: ReadonlyArray<number>;
}): JSX.Element {
  const toneClass =
    tone === 'danger'
      ? 'text-red-600 dark:text-red-400'
      : tone === 'warn'
        ? 'text-amber-600 dark:text-amber-400'
        : tone === 'ok'
          ? 'text-emerald-600 dark:text-emerald-400'
          : '';
  const body = (
    <>
      {trend ? <TrendBackground points={trend} /> : null}
      <div className="dim relative text-[11px] tracking-wide uppercase">{label}</div>
      <div className={`relative mt-1 flex flex-wrap items-baseline gap-x-2 text-2xl font-semibold ${toneClass}`}>
        {value}
        {delta ? <DeltaChip delta={delta} /> : null}
      </div>
      {hint ? <div className="dim relative mt-0.5 truncate">{hint}</div> : null}
    </>
  );
  return href ? (
    <a
      href={href}
      className="card relative block overflow-hidden transition-colors hover:border-accent-400 dark:hover:border-accent-500"
    >
      {body}
    </a>
  ) : (
    <div className="card relative overflow-hidden">{body}</div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }): JSX.Element {
  return (
    <div className="card my-4 flex flex-col items-center gap-1.5 py-10 text-center">
      <div className="text-sm font-medium">{title}</div>
      {hint ? <div className="dim max-w-md">{hint}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}): JSX.Element {
  // Portaled to <body>: a transformed ancestor (e.g. the animated sidebar)
  // would otherwise become the containing block and trap the overlay.
  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-black/50 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div
        className={`anim-in my-6 w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xl dark:border-zinc-700 dark:bg-zinc-900`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-5 py-3.5 dark:border-zinc-800">
          <h2 className="min-w-0 truncate text-sm font-semibold">{title}</h2>
          <button
            className="dim -mr-1.5 shrink-0 cursor-pointer rounded-md p-1.5 transition-colors hover:bg-zinc-100 hover:text-zinc-800 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            onClick={onClose}
            aria-label={`Close ${title}`}
          >
            <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden>
              <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

interface ConfirmRequest {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly resolve: (confirmed: boolean) => void;
}

/**
 * Promise-based destructive-action confirmation: `await confirmDanger({...})`
 * opens a danger-styled modal and resolves with the user's choice. Render
 * `confirmElement` once in the component.
 */
export function useConfirm(): {
  confirmDanger: (opts: { title: string; message: string; confirmLabel?: string }) => Promise<boolean>;
  confirmElement: ReactNode;
} {
  const [pending, setPending] = useState<ConfirmRequest | null>(null);

  const confirmDanger = useCallback(
    (opts: { title: string; message: string; confirmLabel?: string }) =>
      new Promise<boolean>((resolve) => {
        setPending({ title: opts.title, message: opts.message, confirmLabel: opts.confirmLabel ?? 'Delete', resolve });
      }),
    [],
  );

  const close = (confirmed: boolean): void => {
    pending?.resolve(confirmed);
    setPending(null);
  };

  const confirmElement = pending ? (
    <Modal title={pending.title} onClose={() => close(false)}>
      <div className="flex items-start gap-2.5 rounded-lg border border-red-500/50 bg-red-500/5 px-3.5 py-2.5 text-[13px]">
        <span className="text-red-600 dark:text-red-400" aria-hidden>
          ⚠
        </span>
        <span>This action is destructive and cannot be undone.</span>
      </div>
      <p className="mt-3 text-sm">{pending.message}</p>
      <div className="mt-4 flex justify-end gap-2">
        <button className="btn-ghost" onClick={() => close(false)} autoFocus>
          Cancel
        </button>
        <button className="btn-danger" onClick={() => close(true)}>
          {pending.confirmLabel}
        </button>
      </div>
    </Modal>
  ) : null;

  return { confirmDanger, confirmElement };
}

export function Tabs<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string; count?: number }>;
}): JSX.Element {
  return (
    <div role="tablist" className="flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          className={`rounded-md px-3 py-1 text-[13px] transition-colors ${
            value === o.value
              ? 'bg-white font-medium shadow-sm dark:bg-zinc-700'
              : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
          }`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
          {o.count !== undefined ? <span className="dim ml-1.5 tabular-nums">{o.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

// ---------- status renderers ---------------------------------------------------

/**
 * CI snapshot as a compact icon (✓ / ✕ / ●) — shape + color, never color
 * alone; the counts live in the tooltip and aria-label.
 */
export function ChecksBadge({ checks }: { checks: ChecksSnapshot | null }): JSX.Element | null {
  if (!checks || checks.state === 'none') return null;
  const spec =
    checks.state === 'passing'
      ? {
          cls: 'border-emerald-500/50 text-emerald-600 dark:text-emerald-400',
          icon: '✓',
          label: `CI passing — ${checks.passed}/${checks.total} checks`,
        }
      : checks.state === 'failing'
        ? {
            cls: 'border-red-500/50 text-red-600 dark:text-red-400',
            icon: '✕',
            label: `CI failing — ${checks.failed} of ${checks.total} checks failing`,
          }
        : {
            cls: 'border-amber-500/50 text-amber-600 dark:text-amber-400',
            icon: '●',
            label: `CI running — ${checks.pending} of ${checks.total} checks pending`,
          };
  return (
    <Tooltip content={`CI: ${checks.passed} passed, ${checks.failed} failed, ${checks.pending} running`}>
      <span
        className={`inline-flex size-[18px] shrink-0 items-center justify-center rounded-full border text-[10px] leading-none ${spec.cls}`}
        role="img"
        aria-label={spec.label}
      >
        {spec.icon}
      </span>
    </Tooltip>
  );
}

export function pipelineStatusBadge(status: PipelineRunStatus | StepResultStatus): string {
  switch (status) {
    case 'passed':
      return 'badge-ok';
    case 'failed':
    case 'error':
      return 'badge-danger';
    case 'running':
      return 'badge-accent';
    default:
      return 'badge';
  }
}

export function Spinner(): JSX.Element {
  return (
    <span
      className="inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent align-middle opacity-70 motion-reduce:animate-none"
      role="status"
      aria-label="Loading"
    />
  );
}

/** Shimmering placeholder line for content that is still loading. */
export function Skeleton({ className = '' }: { className?: string }): JSX.Element {
  return <span className={`skeleton ${className}`} aria-hidden />;
}

export function PageLoading({ label = 'Loading…' }: { label?: string }): JSX.Element {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-6">
      <div className="dim flex items-center gap-2.5 text-sm">
        <Spinner /> {label}
      </div>
      <div className="mt-5 flex flex-col gap-3">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-40 w-full" />
      </div>
    </div>
  );
}

/** Accessible toggle switch (monochrome: filled track when on). */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-default disabled:opacity-50 ${
        checked ? 'bg-zinc-900 dark:bg-zinc-100' : 'bg-zinc-300 dark:bg-zinc-700'
      }`}
      onClick={() => onChange(!checked)}
    >
      <span
        className={`inline-block size-4 transform rounded-full bg-white shadow transition-transform motion-reduce:transition-none ${
          checked ? 'translate-x-[18px] dark:bg-zinc-900' : 'translate-x-0.5'
        }`}
        aria-hidden
      />
    </button>
  );
}

/** Click-to-copy inline text: copies `value` (or the visible text) and flashes confirmation. */
export function CopyText({
  value,
  children,
  className = '',
  title,
}: {
  value: string;
  children: ReactNode;
  className?: string;
  title?: string;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`inline-flex cursor-pointer items-center gap-1 border-none bg-transparent p-0 text-left font-[inherit] text-inherit hover:opacity-80 ${className}`}
      title={copied ? 'Copied!' : (title ?? `Copy "${value}"`)}
      aria-label={`Copy ${value}`}
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {children}
      <span
        className={`text-[10px] transition-opacity ${copied ? 'text-emerald-600 opacity-100 dark:text-emerald-400' : 'dim opacity-0'}`}
        aria-hidden
      >
        {copied ? '✓ copied' : ''}
      </span>
    </button>
  );
}

/**
 * Styled hover tooltip (replaces native `title` on custom hover elements).
 * Shows above the anchor on hover/focus; content can be any node.
 */
export function Tooltip({
  content,
  children,
  className = '',
}: {
  content: ReactNode;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <span className={`group/tip relative inline-flex ${className}`}>
      {children}
      <span
        role="tooltip"
        className="pointer-events-none invisible absolute bottom-full left-1/2 z-40 mb-1.5 w-max max-w-72 -translate-x-1/2 rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-xs leading-snug text-zinc-700 opacity-0 shadow-md transition-opacity delay-150 group-hover/tip:visible group-hover/tip:opacity-100 group-focus-within/tip:visible group-focus-within/tip:opacity-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
      >
        {content}
      </span>
    </span>
  );
}

/**
 * "Filters" popover for list pages: sits right of the tabs, shows how many
 * filters are active, and hosts custom Dropdowns for each dimension.
 */
export function FiltersPopover({
  active,
  onClear,
  children,
}: {
  active: number;
  onClear: () => void;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="relative"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
    >
      <Tooltip content={active > 0 ? `Filters — ${active} active` : 'Filters'}>
        <button
          type="button"
          className="btn-ghost relative w-9 justify-center px-0"
          aria-expanded={open}
          aria-haspopup="true"
          aria-label={active > 0 ? `Filters (${active} active)` : 'Filters'}
          onClick={() => setOpen((o) => !o)}
        >
          {/* funnel */}
          <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden>
            <path
              d="M2.5 3h11l-4.2 5v4.2l-2.6 1.3V8L2.5 3z"
              stroke="currentColor"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
          {active > 0 ? (
            <span
              className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-zinc-900 px-1 text-[9px] font-semibold text-white dark:bg-zinc-100 dark:text-zinc-900"
              aria-hidden
            >
              {active}
            </span>
          ) : null}
        </button>
      </Tooltip>
      {open ? (
        <div className="absolute top-full right-0 z-30 mt-1.5 w-72 rounded-lg border border-zinc-200 bg-white p-3 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <div className="flex flex-col gap-2.5">{children}</div>
          <div className="mt-3 flex justify-end border-t border-zinc-200 pt-2.5 dark:border-zinc-800">
            <button className="linkish text-xs" disabled={active === 0} onClick={onClear}>
              Clear filters
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Labeled row inside a FiltersPopover. */
export function FilterField({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <label className="flex flex-col gap-1 text-xs">
      <span className="dim">{label}</span>
      {children}
    </label>
  );
}

export interface MenuAction {
  label: string;
  onSelect?: () => void;
  /** Renders as a link (external ones get ↗ and a new tab). */
  href?: string;
  external?: boolean;
  danger?: boolean;
  disabled?: boolean;
}

const MENU_ITEM_CLASS =
  'flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] outline-none hover:bg-zinc-100 focus:bg-zinc-100 disabled:cursor-default disabled:opacity-50 dark:hover:bg-zinc-800 dark:focus:bg-zinc-800';

/** Shared item list for ActionMenu and ContextMenu. */
function MenuItems({ actions, onClose }: { actions: MenuAction[]; onClose: () => void }): JSX.Element {
  return (
    <>
      {actions.map((a) =>
        a.href ? (
          <a
            key={a.label}
            role="menuitem"
            className={MENU_ITEM_CLASS}
            href={a.href}
            target={a.external ? '_blank' : undefined}
            rel={a.external ? 'noreferrer' : undefined}
            onClick={onClose}
          >
            {a.label}
            {a.external ? <span aria-hidden>↗</span> : null}
          </a>
        ) : (
          <button
            key={a.label}
            type="button"
            role="menuitem"
            disabled={a.disabled}
            className={`${MENU_ITEM_CLASS} ${a.danger ? 'text-red-600 dark:text-red-400' : ''}`}
            onClick={() => {
              onClose();
              a.onSelect?.();
            }}
          >
            {a.label}
          </button>
        ),
      )}
    </>
  );
}

/** State for a cursor-positioned ContextMenu; owners keep it in useState. */
export interface ContextMenuState {
  readonly x: number;
  readonly y: number;
  readonly actions: MenuAction[];
}

/**
 * Cursor-positioned menu for list-row right-clicks (a hover ⋯ trigger can
 * open it too, anchored to the button). Controlled: the owner holds
 * {x, y, actions} and clears it on close.
 */
export function ContextMenu({ menu, onClose }: { menu: ContextMenuState | null; onClose: () => void }): JSX.Element | null {
  useEffect(() => {
    if (!menu) return;
    const close = (): void => onClose();
    // ui.tsx imports React's KeyboardEvent type; this is the DOM one.
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menu, onClose]);
  if (!menu) return null;
  const width = 224; // matches w-56
  const estimatedHeight = menu.actions.length * 34 + 10;
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - estimatedHeight - 8));
  return createPortal(
    <div
      role="menu"
      className="fixed z-50 w-56 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
      style={{ left, top }}
    >
      <MenuItems actions={menu.actions} onClose={onClose} />
    </div>,
    document.body,
  );
}

/** "⋯" overflow menu for secondary actions — keeps toolbars to one primary button. */
export function ActionMenu({ actions, label = 'More actions' }: { actions: MenuAction[]; label?: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="relative"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
    >
      <button
        type="button"
        className="btn-ghost w-9 justify-center px-0"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 16 16" className="size-4 fill-current" aria-hidden>
          <circle cx="3" cy="8" r="1.4" />
          <circle cx="8" cy="8" r="1.4" />
          <circle cx="13" cy="8" r="1.4" />
        </svg>
      </button>
      {open ? (
        <div
          role="menu"
          aria-label={label}
          className="absolute top-full right-0 z-30 mt-1.5 w-48 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
        >
          <MenuItems actions={actions} onClose={() => setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}

const PR_STATE_GLYPHS = {
  pr: (
    <>
      <circle cx="4.5" cy="3.5" r="1.7" />
      <circle cx="4.5" cy="12.5" r="1.7" />
      <circle cx="11.5" cy="12.5" r="1.7" />
      <path d="M4.5 5.4v5.2M8 3.5h2A1.5 1.5 0 0 1 11.5 5v5.6" />
    </>
  ),
  merge: (
    <>
      <circle cx="4.5" cy="3.5" r="1.7" />
      <circle cx="4.5" cy="12.5" r="1.7" />
      <circle cx="11.5" cy="8.5" r="1.7" />
      <path d="M4.5 5.4v5.2M4.5 5.8c.4 2.3 2.6 2.7 5.1 2.7" />
    </>
  ),
  check: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="m5.4 8.2 1.8 1.8 3.4-3.9" />
    </>
  ),
  diff: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.6v3.6M6.2 6.4h3.6M6.2 10.6h3.6" />
    </>
  ),
  closed: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="m5.9 5.9 4.2 4.2M10.1 5.9l-4.2 4.2" />
    </>
  ),
} as const;

/**
 * Leading PR state icon: review decision when there is one, else lifecycle
 * state — color + glyph, never a space-eating pill. Details on hover.
 */
export function PrStateIcon({
  state,
  draft = false,
  decision = null,
  className = '',
}: {
  state: 'open' | 'merged' | 'closed';
  draft?: boolean;
  decision?: 'approved' | 'changes_requested' | null;
  className?: string;
}): JSX.Element {
  const spec =
    state === 'open' && decision === 'changes_requested'
      ? { label: 'Changes requested', cls: 'text-red-600 dark:text-red-400', glyph: PR_STATE_GLYPHS.diff }
      : state === 'open' && decision === 'approved'
        ? { label: 'Approved', cls: 'text-emerald-600 dark:text-emerald-400', glyph: PR_STATE_GLYPHS.check }
        : state === 'merged'
          ? { label: 'Merged', cls: 'text-[#2a78d6] dark:text-[#3987e5]', glyph: PR_STATE_GLYPHS.merge }
          : state === 'closed'
            ? { label: 'Closed without merging', cls: 'text-red-600 dark:text-red-400', glyph: PR_STATE_GLYPHS.closed }
            : draft
              ? { label: 'Draft', cls: 'text-zinc-400 dark:text-zinc-500', glyph: PR_STATE_GLYPHS.pr }
              : { label: 'Open', cls: 'text-emerald-600 dark:text-emerald-400', glyph: PR_STATE_GLYPHS.pr };
  const label = draft && state === 'open' ? `${spec.label} · draft` : spec.label;
  return (
    <Tooltip content={label} className={className}>
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={`size-4 shrink-0 ${spec.cls}`}
        role="img"
        aria-label={label}
      >
        {spec.glyph}
      </svg>
    </Tooltip>
  );
}

const TRIAGE_STATE_SPECS = {
  none: {
    label: 'Not triaged',
    cls: 'text-zinc-300 dark:text-zinc-600',
    glyph: (
      <>
        <circle cx="8" cy="8" r="6.2" />
        <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      </>
    ),
  },
  pending: {
    label: 'Triage pending',
    cls: 'text-amber-600 dark:text-amber-400',
    glyph: (
      <>
        <circle cx="8" cy="8" r="6.2" />
        <path d="M8 4.9V8l2.2 1.6" />
      </>
    ),
  },
  applied: {
    label: 'Triage applied',
    cls: 'text-emerald-600 dark:text-emerald-400',
    glyph: (
      <>
        <circle cx="8" cy="8" r="6.2" />
        <path d="m5.4 8.2 1.8 1.8 3.4-3.9" />
      </>
    ),
  },
  dismissed: {
    label: 'Triage dismissed',
    cls: 'text-zinc-400 dark:text-zinc-500',
    glyph: (
      <>
        <circle cx="8" cy="8" r="6.2" />
        <path d="m5.9 5.9 4.2 4.2M10.1 5.9l-4.2 4.2" />
      </>
    ),
  },
} as const;

type TriageIconState = keyof typeof TRIAGE_STATE_SPECS;

function TriageGlyph({ state, className = 'size-4' }: { state: TriageIconState; className?: string }): JSX.Element {
  const spec = TRIAGE_STATE_SPECS[state];
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${spec.cls} ${className}`}
      role="img"
      aria-label={spec.label}
    >
      {spec.glyph}
    </svg>
  );
}

/**
 * Leading AI-triage state icon for issue rows — color + glyph, never a
 * space-eating pill. The label lives in the tooltip; TriageLegend spells the
 * states out under the list.
 */
export function TriageStateIcon({ triage, className = '' }: { triage: IssueRecord['triage']; className?: string }): JSX.Element {
  const state: TriageIconState = triage ?? 'none';
  return (
    <Tooltip content={TRIAGE_STATE_SPECS[state].label} className={className}>
      <TriageGlyph state={state} />
    </Tooltip>
  );
}

/** What the issue-row triage icons mean; sits under the issue list. */
export function TriageLegend(): JSX.Element {
  return (
    <div className="dim mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
      {(Object.keys(TRIAGE_STATE_SPECS) as TriageIconState[]).map((state) => (
        <span key={state} className="flex items-center gap-1.5">
          <TriageGlyph state={state} className="size-3.5" />
          {TRIAGE_STATE_SPECS[state].label}
        </span>
      ))}
    </div>
  );
}

/**
 * Clickable GitHub handle: opens the profile in a new tab. Rendered as a
 * role=link span so it can sit inside list-row anchors without nesting <a>s.
 */
export function GitHubUser({ login, className = '' }: { login: string; className?: string }): JSX.Element {
  const open = (): void => {
    window.open(`https://github.com/${encodeURIComponent(login)}`, '_blank', 'noopener');
  };
  return (
    <Tooltip content={`Open @${login} on GitHub ↗`}>
      <span
        role="link"
        tabIndex={0}
        className={`cursor-pointer hover:underline ${className}`}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          open();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            open();
          }
        }}
      >
        {login}
      </span>
    </Tooltip>
  );
}

/** Compact label display for list rows: first label + "+N more" (rest on hover). */
export function LabelChips({ labels }: { labels: ReadonlyArray<string> }): JSX.Element | null {
  if (labels.length === 0) return null;
  return (
    <Tooltip content={labels.join(', ')}>
      <span className="flex shrink-0 items-center gap-1">
        <span className="chip max-w-32 truncate">{labels[0]}</span>
        {labels.length > 1 ? <span className="chip">+{labels.length - 1} more</span> : null}
      </span>
    </Tooltip>
  );
}

/** "assigned a +2 more" for list rows; the rest of the names on hover. */
export function AssigneeNote({ assignees }: { assignees: ReadonlyArray<string> }): JSX.Element | null {
  if (assignees.length === 0) return null;
  return (
    <span className="dim shrink-0 text-xs">
      assigned <GitHubUser login={assignees[0]!} />
      {assignees.length > 1 ? (
        <Tooltip content={assignees.slice(1).join(', ')}>
          <span className="cursor-default">&nbsp;+{assignees.length - 1} more</span>
        </Tooltip>
      ) : null}
    </span>
  );
}

/** Speech-bubble + count for list rows; hidden when there are no comments. */
export function CommentCount({ count }: { count: number }): JSX.Element {
  return (
    <Tooltip content={`${count} comment${count === 1 ? '' : 's'}`}>
    <span className={`dim flex shrink-0 items-center gap-1 text-xs ${count === 0 ? 'opacity-50' : ''}`}>
      <svg viewBox="0 0 16 16" fill="none" className="size-3.5" aria-hidden>
        <path
          d="M14 10.5a1.5 1.5 0 0 1-1.5 1.5H8l-3 2.5V12H3.5A1.5 1.5 0 0 1 2 10.5v-6A1.5 1.5 0 0 1 3.5 3h9A1.5 1.5 0 0 1 14 4.5v6z"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinejoin="round"
        />
      </svg>
      <span className="tabular-nums">{count}</span>
    </span>
    </Tooltip>
  );
}

/** One `label: value` cell in a detail view's metadata strip. */
export function MetaItem({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <span className="flex items-center gap-1.5 text-[13px]">
      <span className="dim">{label}</span>
      <span>{children}</span>
    </span>
  );
}

export function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : new Date(ts).toLocaleDateString();
}
