/**
 * The `react` the import map hands to out-of-tree module chunks.
 *
 * This is an entry point of the SAME Vite build as the app, so Rollup puts React
 * in a shared chunk that both this file and the app import. That is the whole
 * trick: a separately built "vendor bundle" would be a second React, and two
 * Reacts make hooks throw from inside the renderer with a stack pointing nowhere
 * near the cause.
 *
 * The API is listed rather than starred because React is CommonJS: Rollup cannot
 * enumerate `export * from 'react'` statically and silently emits an entry with
 * only a default export. Listing it also makes this an ABI like any other, so a
 * module reaching for an unlisted API fails at build time instead of at runtime.
 */
export {
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version,
  default as default,
} from 'react';
