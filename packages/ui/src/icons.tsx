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

/** Check mark for successful states and completed steps. */
export function CheckIcon({ className = 'size-4' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={`shrink-0 ${className}`} aria-hidden>
      <path d="m3.5 8.2 3 3 6-6.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Friendly success face for completed flows and positive empty states. */
export function SmileIcon({ className = 'size-4' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={`shrink-0 ${className}`} aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="9" cy="10" r="1" fill="currentColor" />
      <circle cx="15" cy="10" r="1" fill="currentColor" />
      <path d="M8 14c1 1.5 2.3 2.2 4 2.2s3-.7 4-2.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/** Clock face for pending or in-progress states. */
export function ClockIcon({ className = 'size-4' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={`shrink-0 ${className}`} aria-hidden>
      <circle cx="8" cy="8" r="5.8" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.7V8l2.3 1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Question mark for states whose outcome could not be determined. */
export function QuestionIcon({ className = 'size-4' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={`shrink-0 ${className}`} aria-hidden>
      <path
        d="M5.9 5.9A2.2 2.2 0 0 1 8.1 4c1.3 0 2.3.8 2.3 2 0 1.6-2.4 1.8-2.4 3.3"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="8" cy="12" r=".8" fill="currentColor" />
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

/** Flask — experiments and dry runs (the Playground's mark). */
export function FlaskIcon({ className = 'size-4' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={`shrink-0 ${className}`} aria-hidden>
      <path
        d="M6.5 2h3M7 2.2v3.6l-3.2 6A1.4 1.4 0 0 0 5 13.8h6a1.4 1.4 0 0 0 1.2-2l-3.2-6V2.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M5.2 10.5h5.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
