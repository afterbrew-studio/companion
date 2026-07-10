import type { ReactNode } from 'react';

/** Form building blocks so every module's forms share one rhythm. */

/**
 * Labeled form field: dim caption above the control (the `text-sm` sibling of
 * FilterField). The control keeps its own class (`input`, `input input-sm`, …).
 */
export function Field({
  label,
  hint,
  children,
  className = '',
}: {
  label: string;
  /** Dim helper line under the control. */
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <label className={`flex flex-col gap-1 text-sm ${className}`}>
      <span className="dim">{label}</span>
      {children}
      {hint ? <span className="dim text-xs">{hint}</span> : null}
    </label>
  );
}

/**
 * Right-aligned action row closing a form or modal (Cancel + primary).
 * `divider` adds the top rule used by larger modals.
 */
export function FormActions({
  children,
  divider,
  className = '',
}: {
  children: ReactNode;
  divider?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <div
      className={`flex flex-wrap items-center justify-end gap-2 ${
        divider ? 'mt-5 border-t border-zinc-200 pt-4 dark:border-zinc-800' : ''
      } ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * Custom square checkbox (anchor-safe: a span, not a button, so it can sit
 * inside row links). Clicks toggle without activating the row.
 */
export function Checkbox({
  checked,
  onToggle,
  label,
  className = '',
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  className?: string;
}): JSX.Element {
  return (
    <span
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      tabIndex={0}
      className={`flex size-4 shrink-0 cursor-pointer items-center justify-center rounded border transition-opacity ${
        checked
          ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
          : 'border-zinc-300 text-transparent hover:border-zinc-500 dark:border-zinc-600 dark:hover:border-zinc-400'
      } ${className}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          onToggle();
        }
      }}
    >
      <svg viewBox="0 0 16 16" fill="none" className="size-3" aria-hidden>
        <path d="m3.5 8.5 3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/** List-page search box; `data-shortcut` wires the global `/` focus shortcut. */
export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…  ( / )',
  ariaLabel = 'Search',
  className = 'w-56',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
}): JSX.Element {
  return (
    <input
      className={`input ${className}`}
      type="search"
      placeholder={placeholder}
      aria-label={ariaLabel}
      data-shortcut="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/**
 * Settings row: title + dim description on the left, the control on the right.
 * Container-agnostic — wrap in `card` or a ListCard row for padding.
 */
export function SettingRow({
  title,
  description,
  children,
  className = '',
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={`flex flex-wrap items-center gap-3 ${className}`}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{title}</div>
        {description ? <p className="dim mt-0.5">{description}</p> : null}
      </div>
      {children}
    </div>
  );
}

/** Render-if-present error line; `role="alert"` so screen readers announce it. */
export function ErrorBar({ error, className = '' }: { error: string | null | undefined; className?: string }): JSX.Element | null {
  if (!error) return null;
  return (
    <p role="alert" className={`error-bar ${className}`}>
      {error}
    </p>
  );
}
