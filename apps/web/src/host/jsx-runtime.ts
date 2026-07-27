/**
 * `react/jsx-runtime`: what the automatic JSX transform emits an import for.
 * Listed, not starred, for the reason in `host/react.ts`.
 *
 * There is no `react/jsx-dev-runtime` entry. A module must be built for
 * production, which is what an author ships anyway, and an accidental dev build
 * then fails to resolve loudly instead of dragging React's development runtime
 * into a production page.
 */
export { jsx, jsxs, Fragment } from 'react/jsx-runtime';
