/** Shared stroked glyphs. One drawing per concept — pages must not re-trace these paths. */

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

/** Small stroked padlock — marks private workspaces. */
export function LockIcon({ className = 'size-3.5' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden className={`shrink-0 ${className}`}>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** ✦ sparkle — the mark for anything AI-driven. Pair with `aiAccentClass`. */
export function SparkleIcon({ className = 'size-4' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={`shrink-0 ${className}`} aria-hidden>
      <path
        d="M10 2.5l1.7 4.3 4.3 1.7-4.3 1.7L10 14.5 8.3 10.2 4 8.5l4.3-1.7L10 2.5z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M15.5 12.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Close ✕ for modals, panels, and dismissable chrome. */
export function CloseIcon({ className = 'size-4' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={`shrink-0 ${className}`} aria-hidden>
      <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** Magnifier for search inputs and search-triggering buttons. */
export function SearchIcon({ className = 'size-4' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={`shrink-0 ${className}`} aria-hidden>
      <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** ⋯ overflow trigger for row-level quick actions. */
export function KebabIcon({ className = 'size-4' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className={`shrink-0 fill-current ${className}`} aria-hidden>
      <circle cx="3" cy="8" r="1.4" />
      <circle cx="8" cy="8" r="1.4" />
      <circle cx="13" cy="8" r="1.4" />
    </svg>
  );
}
