/**
 * `react-dom`: what a module needs to render outside its own subtree. Listed,
 * not starred, for the same reason as `host/react.ts`. `createRoot` is absent on
 * purpose: the host owns the root, and a module mounting a second one would
 * detach itself from the app's context and live state.
 */
export { createPortal, flushSync, version, default as default } from 'react-dom';
