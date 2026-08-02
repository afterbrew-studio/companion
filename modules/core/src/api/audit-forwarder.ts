import { createHmac } from 'node:crypto';
import type { AuditEvent } from '@moxxy/companion-core/server';

/** How often a non-empty buffer is shipped. */
const FLUSH_MS = 10_000;
/** Ship early once this many entries are waiting, so a burst does not sit for 10s. */
const BATCH_SIZE = 200;
/**
 * Hard cap on the buffer. A receiver that is down must cost bounded memory, so
 * past this the OLDEST entries are dropped and counted: the table remains the
 * source of truth and `/api/audit/export` can always backfill, which makes
 * dropping the honest choice over growing until the daemon dies.
 */
const MAX_BUFFERED = 5_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface ForwarderState {
  readonly configured: boolean;
  readonly buffered: number;
  /** Entries dropped because the buffer was full since the daemon started. */
  readonly dropped: number;
  readonly lastError: string | null;
  readonly lastDeliveryAt: number | null;
}

/**
 * Ships audit entries to an external collector (a SIEM, a log pipeline) as
 * NDJSON batches.
 *
 * A stream, not a replacement. `provideAudit` exists for a module that wants to
 * OWN audit storage; almost nobody wants that, because the table is what answers
 * "who tried and was stopped" locally. So this forwards alongside the table and
 * the table stays authoritative.
 *
 * Three properties it is built around:
 *
 * - **It can never fail the request it is describing.** `enqueue` only appends to
 *   an array; every network concern happens on a timer.
 * - **It is bounded.** A dead collector drops oldest and counts, rather than
 *   growing without limit behind an outage nobody noticed.
 * - **Order is preserved within a batch**, and a failed batch is retried once on
 *   the next tick before being dropped, because an audit stream that silently
 *   reorders or loses the middle of a sequence is worse than one with a gap you
 *   can see in the counter.
 */
export class AuditForwarder {
  private buffer: AuditEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private dropped = 0;
  private lastError: string | null = null;
  private lastDeliveryAt: number | null = null;

  constructor(
    private readonly target: () => { url: string | null; secret: string | null },
    private readonly log: (message: string, meta?: Record<string, unknown>) => void = () => {},
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Append only. Called on the request path, so it does no work worth measuring. */
  enqueue(event: AuditEvent): void {
    if (!this.target().url) return;
    if (this.buffer.length >= MAX_BUFFERED) {
      this.buffer.shift();
      this.dropped++;
    }
    this.buffer.push(event);
    if (this.buffer.length >= BATCH_SIZE) void this.flush();
  }

  state(): ForwarderState {
    return {
      configured: this.target().url !== null,
      buffered: this.buffer.length,
      dropped: this.dropped,
      lastError: this.lastError,
      lastDeliveryAt: this.lastDeliveryAt,
    };
  }

  /**
   * Ship one batch. A failure puts the batch BACK at the front of the buffer so
   * the next tick retries it in order; the buffer cap is what stops that from
   * being unbounded.
   */
  async flush(): Promise<void> {
    const { url, secret } = this.target();
    if (!url || this.inFlight || this.buffer.length === 0) return;
    this.inFlight = true;
    const batch = this.buffer.splice(0, BATCH_SIZE);
    const body = `${batch.map((e) => JSON.stringify(e)).join('\n')}\n`;
    try {
      const headers: Record<string, string> = { 'content-type': 'application/x-ndjson' };
      if (secret) {
        headers['x-companion-signature-256'] = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
      }
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`.trim());
      this.lastError = null;
      this.lastDeliveryAt = Date.now();
    } catch (err) {
      this.lastError = String(err instanceof Error ? err.message : err).slice(0, 300);
      // Front, not back: a retry that reorders the trail is its own problem.
      this.buffer.unshift(...batch);
      if (this.buffer.length > MAX_BUFFERED) {
        this.dropped += this.buffer.length - MAX_BUFFERED;
        // The failed batch is the oldest evidence and sits at the front. Drop
        // the newest overflow so the next tick really retries that batch in
        // order, as promised, instead of silently deleting it here.
        this.buffer = this.buffer.slice(0, MAX_BUFFERED);
      }
      this.log('audit forwarding failed', { err: this.lastError, buffered: this.buffer.length });
    } finally {
      this.inFlight = false;
    }
  }
}
