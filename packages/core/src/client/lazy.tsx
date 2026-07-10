import { lazy, type ComponentType } from 'react';
import type { RouteProps } from './index.js';

/**
 * Lazy page loading that survives a stale chunk after a redeploy. React.lazy
 * caches a rejected import forever, so a hash-named chunk that 404s (the tab was
 * open across a deploy) would brick that route with a "Try again" the boundary
 * can't fix. Here a failed import triggers ONE full reload to fetch the fresh
 * HTML + chunk map (guarded against a reload loop); a success clears the guard.
 */
const RELOAD_KEY = 'companion.chunk-reloaded';

function withReload<T>(factory: () => Promise<T>): () => Promise<T> {
  return () =>
    factory().then(
      (v) => {
        sessionStorage.removeItem(RELOAD_KEY);
        return v;
      },
      (err) => {
        if (!sessionStorage.getItem(RELOAD_KEY)) {
          sessionStorage.setItem(RELOAD_KEY, '1');
          location.reload();
        }
        throw err;
      },
    );
}

/** React.lazy over a route component factory, with stale-chunk reload recovery. */
export function lazyView(factory: () => Promise<{ default: ComponentType<RouteProps> }>): ComponentType<RouteProps> {
  return lazy(withReload(factory));
}

/** Lazy-load a NAMED page export, widened to the RouteProps contract. */
export function page(load: () => Promise<ComponentType<RouteProps>>): ComponentType<RouteProps> {
  return lazyView(async () => ({ default: await load() }));
}
