/**
 * A minimal Prometheus metrics registry with a hand-written text exposition,
 * so observability does not cost a dependency. The kernel owns one instance;
 * the router feeds `companion_http_requests_total` into it, the app adds the
 * process and WebSocket gauges, and modules may register their own counters
 * through `ctx.metrics`. Serving (and its access policy) is the HTTP server's
 * concern; the registry only accumulates and renders.
 */

export interface Counter {
  inc(labels?: Readonly<Record<string, string>>, by?: number): void;
}

interface CounterState {
  readonly kind: 'counter';
  readonly help: string;
  readonly series: Map<string, { readonly labels: Readonly<Record<string, string>>; value: number }>;
  readonly handle: Counter;
}

interface GaugeState {
  readonly kind: 'gauge';
  readonly help: string;
  collect: () => number;
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, CounterState | GaugeState>();

  /**
   * Get-or-create: counters are process-cumulative, so a module that disables
   * and re-enables keeps its series instead of resetting them. A name clash
   * across kinds is a bug and throws.
   */
  counter(name: string, help: string): Counter {
    const existing = this.metrics.get(name);
    if (existing) {
      if (existing.kind !== 'counter') throw new Error(`metric '${name}' is already registered as a ${existing.kind}`);
      return existing.handle;
    }
    const series: CounterState['series'] = new Map();
    const handle: Counter = {
      inc: (labels = {}, by = 1) => {
        const key = seriesKey(labels);
        const entry = series.get(key);
        if (entry) entry.value += by;
        else series.set(key, { labels, value: by });
      },
    };
    this.metrics.set(name, { kind: 'counter', help, series, handle });
    return handle;
  }

  /**
   * Sampled at scrape time. Re-registering the same name replaces the
   * collector, so a re-enabled owner binds the gauge to its live closure.
   */
  gauge(name: string, help: string, collect: () => number): void {
    const existing = this.metrics.get(name);
    if (existing) {
      if (existing.kind !== 'gauge') throw new Error(`metric '${name}' is already registered as a ${existing.kind}`);
      existing.collect = collect;
      return;
    }
    this.metrics.set(name, { kind: 'gauge', help, collect });
  }

  /** Prometheus text exposition format (0.0.4). */
  render(): string {
    const lines: string[] = [];
    for (const [name, metric] of this.metrics) {
      lines.push(`# HELP ${name} ${escapeHelp(metric.help)}`);
      lines.push(`# TYPE ${name} ${metric.kind}`);
      if (metric.kind === 'gauge') {
        let value: number;
        try {
          value = metric.collect();
        } catch {
          // A failing collector must not take the whole scrape down.
          continue;
        }
        lines.push(`${name} ${value}`);
        continue;
      }
      for (const { labels, value } of metric.series.values()) {
        lines.push(`${name}${renderLabels(labels)} ${value}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }
}

/** Standard process gauges, sampled at scrape (the lag by a 1s unref'd timer). */
export function registerProcessMetrics(registry: MetricsRegistry): void {
  registry.gauge('process_resident_memory_bytes', 'Resident set size in bytes', () => process.memoryUsage.rss());
  registry.gauge('nodejs_heap_size_used_bytes', 'V8 heap used in bytes', () => process.memoryUsage().heapUsed);
  registry.gauge('nodejs_heap_size_total_bytes', 'V8 heap total in bytes', () => process.memoryUsage().heapTotal);
  const intervalMs = 1_000;
  let lagSeconds = 0;
  let last = process.hrtime.bigint();
  const timer = setInterval(() => {
    const now = process.hrtime.bigint();
    lagSeconds = Math.max(0, Number(now - last) / 1e9 - intervalMs / 1_000);
    last = now;
  }, intervalMs);
  timer.unref();
  registry.gauge(
    'nodejs_eventloop_lag_seconds',
    'Delay of a 1s sampling timer beyond its interval',
    () => lagSeconds,
  );
}

function seriesKey(labels: Readonly<Record<string, string>>): string {
  return Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join('\u0000');
}

function renderLabels(labels: Readonly<Record<string, string>>): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return '';
  return `{${keys.map((key) => `${key}="${escapeLabel(labels[key] ?? '')}"`).join(',')}}`;
}

const escapeHelp = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');

const escapeLabel = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
