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
 * Focus frame for text-entry controls. The shared `accent-field` class owns
 * the stable focus ring and optional motion, while the native input keeps its
 * label, ref and validation semantics.
 */
export function AccentField({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return <span className={`accent-field block rounded-lg ${className}`}>{children}</span>;
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
 * A small closed choice as ONE control, in the Tabs shape: use it where a
 * binary setting would otherwise become two competing option cards.
 *
 * Backed by a native radio group rather than a roving-tabindex widget, so the
 * browser supplies arrow-key movement and the "n of m" announcement; the
 * visible segment is a label wrapping its own (screen-reader-only) radio.
 * Shrinks to fit; pass `w-full sm:w-auto` to stack it under a settings row's
 * text on narrow viewports.
 */
export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  label,
  name,
  disabled,
  className = '',
}: {
  value: T;
  onChange: (v: T) => void;
  options: ReadonlyArray<{ value: T; label: string; hint?: string }>;
  /** Names the group for assistive tech (rendered as a hidden legend). */
  label: string;
  /** Radio group name; must be unique within the page. */
  name: string;
  disabled?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <fieldset
      className={`flex gap-1 rounded-lg bg-zinc-100 p-1 dark:bg-zinc-900 ${
        disabled ? 'opacity-60' : ''
      } ${className}`}
    >
      <legend className="sr-only">{label}</legend>
      {options.map((o) => {
        const on = o.value === value;
        // min-w-max, not min-w-0: flex-1 gives a zero basis, so without it an
        // auto-width control sizes below its own labels and truncates them.
        // The height lives here, not on the fieldset: a fieldset lays its
        // children out in an anonymous box that does not take the fieldset's
        // height, so a track-level `h-*` left the segments at text height.
        return (
          <label
            key={o.value}
            title={o.hint}
            className={`flex h-7 min-w-max flex-1 items-center justify-center rounded-md px-4 text-[13px] transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-zinc-500 ${
              disabled ? 'cursor-default' : 'cursor-pointer'
            } ${
              on
                ? 'bg-white font-medium shadow-sm dark:bg-zinc-700'
                : `text-zinc-500 ${disabled ? '' : 'hover:text-zinc-800 dark:hover:text-zinc-200'}`
            }`}
          >
            <input
              type="radio"
              name={name}
              className="sr-only"
              checked={on}
              disabled={disabled}
              onChange={() => onChange(o.value)}
            />
            <span>{o.label}</span>
          </label>
        );
      })}
    </fieldset>
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
