/** Non-interactive placeholder for a workspace repo the current GitHub accounts cannot read. */
export function RepoUnavailableRow({ repo }: { repo: string }): React.JSX.Element {
  return (
    <div
      className="flex min-h-16 items-center gap-3 border-b border-zinc-200 px-4 py-3 text-zinc-500 last:border-b-0 dark:border-zinc-800 dark:text-zinc-500"
      aria-disabled="true"
      title="Your personal GitHub accounts do not have access to this repository. Ask its owner to grant access."
    >
      <span
        className="flex size-7 shrink-0 items-center justify-center rounded-md border border-zinc-300 dark:border-zinc-700"
        aria-hidden
      >
        <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.4">
          <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
          <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
        </svg>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-zinc-600 dark:text-zinc-400">{repo}</span>
        <span className="mt-0.5 block text-xs">
          None of your connected GitHub accounts can read this repository. Ask the repository owner to grant your
          GitHub account access, then refresh.
        </span>
      </span>
      <span className="shrink-0 text-[11px] font-medium tracking-wide uppercase">no access</span>
    </div>
  );
}
