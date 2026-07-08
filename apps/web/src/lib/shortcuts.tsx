import { useEffect, useState } from 'react';

/**
 * Global keyboard shortcuts. GitHub-style two-key chords: press `g` then a
 * module key to jump. `/` focuses the nearest search box, `?` shows the
 * cheatsheet. Chords are ignored while typing in inputs.
 */

export interface ShortcutTarget {
  readonly key: string;
  readonly label: string;
  readonly hash: string;
}

const CHORD_TIMEOUT_MS = 1500;

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable
  );
}

export function useAppShortcuts(targets: readonly ShortcutTarget[]): {
  helpOpen: boolean;
  setHelpOpen: (open: boolean) => void;
  chordPending: boolean;
} {
  const [helpOpen, setHelpOpen] = useState(false);
  const [chordPending, setChordPending] = useState(false);

  useEffect(() => {
    let pending = false;
    let timer: number | undefined;

    const clearChord = (): void => {
      pending = false;
      setChordPending(false);
      window.clearTimeout(timer);
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;

      if (e.key === 'Escape') {
        setHelpOpen(false);
        clearChord();
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        setHelpOpen((v) => !v);
        clearChord();
        return;
      }
      if (e.key === '/') {
        const search = document.querySelector<HTMLInputElement>('[data-shortcut="search"]');
        if (search) {
          e.preventDefault();
          search.focus();
          search.select();
        }
        clearChord();
        return;
      }
      if (pending) {
        const target = targets.find((t) => t.key === e.key.toLowerCase());
        if (target) {
          e.preventDefault();
          location.hash = target.hash;
        }
        clearChord();
        return;
      }
      if (e.key === 'g') {
        pending = true;
        setChordPending(true);
        window.clearTimeout(timer);
        timer = window.setTimeout(clearChord, CHORD_TIMEOUT_MS);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.clearTimeout(timer);
    };
  }, [targets]);

  return { helpOpen, setHelpOpen, chordPending };
}

export function ShortcutHelp({
  targets,
  onClose,
  onReplayTour,
}: {
  targets: readonly ShortcutTarget[];
  onClose: () => void;
  onReplayTour?: () => void;
}): JSX.Element {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border border-zinc-200 bg-white p-5 shadow-xl dark:border-zinc-700 dark:bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">Keyboard shortcuts</h2>
          <button className="btn-ghost" onClick={onClose} aria-label="Close shortcuts help">
            Esc
          </button>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {targets.map((t) => (
            <ShortcutRow key={t.hash} keys={['g', t.key]} label={`Go to ${t.label}`} />
          ))}
          <ShortcutRow keys={['/']} label="Focus search" />
          <ShortcutRow keys={['?']} label="Toggle this help" />
          <ShortcutRow keys={['Esc']} label="Close dialogs" />
        </dl>
        {onReplayTour ? (
          <div className="mt-4 border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <button className="linkish text-sm" onClick={onReplayTour}>
              Replay the welcome tour
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ShortcutRow({ keys, label }: { keys: string[]; label: string }): JSX.Element {
  return (
    <>
      <dt className="flex gap-1">
        {keys.map((k) => (
          <kbd
            key={k}
            className="rounded border border-zinc-300 bg-zinc-100 px-1.5 py-0.5 font-mono text-[11px] dark:border-zinc-600 dark:bg-zinc-800"
          >
            {k}
          </kbd>
        ))}
      </dt>
      <dd className="text-zinc-600 dark:text-zinc-300">{label}</dd>
    </>
  );
}
