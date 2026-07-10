import type { ReactNode } from 'react';

/** The shared stroke style every sidebar icon draws with (thin, round). */
const NAV_ICON_STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/**
 * The 24×24 sidebar-icon frame. Modules pass just the inner shapes
 * (`<path>`/`<circle>`/…); the viewBox, size, and stroke are shared here so a
 * nav icon is one line instead of the svg-plus-stroke boilerplate repeated in
 * every module's nav.tsx.
 */
export function NavIcon({ children }: { children: ReactNode }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden {...NAV_ICON_STROKE}>
      {children}
    </svg>
  );
}
