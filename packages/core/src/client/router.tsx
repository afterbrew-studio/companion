import type { ClientRoute } from './index.js';

/**
 * The data-driven route matcher that replaces the App.tsx if-ladder. Matching
 * is by WHOLE path segments, and candidates are sorted by specificity once —
 * `/runners` vs `/runs` is decided by segment equality, never by declaration
 * order, so the legacy "detail regexes before prefixes, /runners before /runs"
 * ordering hazard is structurally impossible.
 */

export interface RouteHit {
  readonly route: ClientRoute;
  readonly params: Record<string, string>;
}

const segments = (path: string): string[] => path.split('/').filter(Boolean);

/** Specificity class: exact (2) > regex (1) > prefix (0); more segments win within a class. */
function specificity(route: ClientRoute): readonly [number, number] {
  const m = route.match;
  if ('exact' in m) return [2, segments(m.exact).length];
  if ('regex' in m) return [1, 0];
  return [0, segments(m.prefix).length];
}

/** Sort once (stable) so `matchRoute` returns the most specific hit first. */
export function compileRoutes(routes: readonly ClientRoute[]): readonly ClientRoute[] {
  return [...routes].sort((a, b) => {
    const [ca, sa] = specificity(a);
    const [cb, sb] = specificity(b);
    return cb - ca || sb - sa;
  });
}

/** Match a hash path (`/repos/acme/app/prs/12`) against compiled routes. */
export function matchRoute(compiled: readonly ClientRoute[], path: string): RouteHit | null {
  const parts = segments(path);
  for (const route of compiled) {
    const m = route.match;
    if ('exact' in m) {
      const want = segments(m.exact);
      if (want.length === parts.length && want.every((s, i) => s === parts[i])) {
        return { route, params: {} };
      }
    } else if ('regex' in m) {
      const hit = m.regex.exec(path);
      if (hit) return { route, params: m.params(hit) };
    } else {
      const want = segments(m.prefix);
      if (want.length <= parts.length && want.every((s, i) => s === parts[i])) {
        return { route, params: {} };
      }
    }
  }
  return null;
}
