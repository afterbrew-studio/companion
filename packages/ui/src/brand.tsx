/** The Companion mark. Instance branding overrides it everywhere — see `branding.logo`. */

/**
 * Open arc with the companion dot standing in its gap. Stroke 3.2 on the 32
 * grid: heavier than the 1.7 nav icons because the mark has to hold on its own.
 */
export function BrandMark({ className = 'size-4' }: { className?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 32 32" fill="none" className={`shrink-0 ${className}`} aria-hidden>
      <path d="M23.16 9.57A10 10 0 1 0 23.16 22.43" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="25.4" cy="16" r="2.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** The mark inverted into its tile — the instance avatar when nothing is branded. */
export function BrandTile({ className = 'size-7 rounded-lg' }: { className?: string }): JSX.Element {
  return (
    <div
      className={`flex shrink-0 items-center justify-center bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 ${className}`}
    >
      <BrandMark className="size-[62%]" />
    </div>
  );
}
