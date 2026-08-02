import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

/**
 * Render outside the DOM subtree, at the end of `<body>`.
 *
 * For an overlay whose ancestor clips it: the app's sidebar is `overflow-hidden`
 * and carries a transform, so neither `overflow-visible` on a child nor
 * `position: fixed` gets a popover out of it. Positioning is the caller's job,
 * because only the caller knows what it is anchored to.
 */
export function Portal({ children }: { children: ReactNode }): ReactNode {
  return createPortal(children, document.body);
}
