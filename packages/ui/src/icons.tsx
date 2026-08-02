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

/** Plus — the mark on any "create a new thing" primary button. */
export function PlusIcon({ className = 'size-4' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={`shrink-0 ${className}`} aria-hidden>
      <path d="M8 3.4v9.2M3.4 8h9.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Two figures — a pool of workers/people and its capacity. */
export function WorkersIcon({ className = 'size-4' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={`shrink-0 ${className}`} aria-hidden>
      <circle cx="6" cy="5.6" r="2.4" stroke="currentColor" strokeWidth="1.3" />
      <path d="M2.4 13.2c0-2 1.6-3.4 3.6-3.4s3.6 1.4 3.6 3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M10.7 3.5a2.4 2.4 0 0 1 0 4.2M11.5 9.7c1.3.4 2.1 1.7 2.1 3.1" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** Fork of nodes — an automated flow branching into its outcomes. */
export function FlowIcon({ className = 'size-4' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={`shrink-0 ${className}`} aria-hidden>
      <circle cx="3.4" cy="8" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12.6" cy="4.2" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="12.6" cy="11.8" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M5.1 8h2.3c1 0 1.8-.8 1.8-1.8 0-1 .8-1.9 1.8-2M5.1 8h2.3c1 0 1.8.8 1.8 1.8 0 1 .8 1.9 1.8 2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Cog: the way into instance configuration. */
export function GearIcon({ className = 'size-4' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={`shrink-0 ${className}`} aria-hidden>
      <circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M13 8c0-.33-.03-.65-.09-.96l1.3-1-1.3-2.26-1.53.62a5 5 0 0 0-1.66-.96L9.46 1.8H6.54l-.26 1.64a5 5 0 0 0-1.66.96l-1.53-.62-1.3 2.26 1.3 1a5 5 0 0 0 0 1.92l-1.3 1 1.3 2.26 1.53-.62c.49.43 1.05.76 1.66.96l.26 1.64h2.92l.26-1.64a5 5 0 0 0 1.66-.96l1.53.62 1.3-2.26-1.3-1c.06-.31.09-.63.09-.96z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Open eye: this entry shows in the sidebar. */
export function EyeIcon({ className = 'size-4' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={`shrink-0 ${className}`} aria-hidden>
      <path d="M1.6 8S4 3.9 8 3.9 14.4 8 14.4 8 12 12.1 8 12.1 1.6 8 1.6 8z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <circle cx="8" cy="8" r="1.9" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/** Struck-through eye: this entry is hidden from the sidebar (still reachable). */
export function EyeOffIcon({ className = 'size-4' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={`shrink-0 ${className}`} aria-hidden>
      <path
        d="M6.3 4.2A6.4 6.4 0 0 1 8 3.9c4 0 6.4 4.1 6.4 4.1a12 12 0 0 1-2 2.4M4 5.4A11.7 11.7 0 0 0 1.6 8S4 12.1 8 12.1c.75 0 1.44-.14 2.06-.37"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="m2.6 2.6 10.8 10.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** Sliders: the sidebar's customize affordance. */
export function SlidersIcon({ className = 'size-4' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" className={`shrink-0 ${className}`} aria-hidden>
      <path d="M2.5 5h7M12.5 5h1M2.5 11h1M6.5 11h7" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="11" cy="5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="5" cy="11" r="1.6" stroke="currentColor" strokeWidth="1.3" />
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
