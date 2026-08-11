import { connect as connectTcp, isIP, type Socket } from 'node:net';
import { connect as connectTls, type ConnectionOptions } from 'node:tls';
import { lookup } from 'node:dns/promises';
import type { ResolveAddresses } from '@moxxy/companion-sdk/server';
import { isPublicAddress, type DeliveryOutcome } from './delivery.js';

/**
 * Minimal SMTP submission client over node:net/node:tls.
 *
 * Hand-rolled rather than a mail dependency because the module needs exactly
 * one shape of message (plain text, one connection's recipients) and the house
 * delivery rules (pinned addresses, bounded timeouts, one retry on transient)
 * have to be enforced here anyway. EHLO, STARTTLS, AUTH PLAIN/LOGIN,
 * MAIL FROM/RCPT TO/DATA with dot-stuffing, QUIT.
 */

/** One attempt gets this long before it is abandoned as unreachable. */
const ATTEMPT_TIMEOUT_MS = 10_000;
/** A transient failure is retried once, after this pause. */
const RETRY_DELAY_MS = 2_000;
const CRLF = '\r\n';
/** SMTP caps a text line at 1000 bytes including CRLF. */
const MAX_LINE = 998;
const EHLO_NAME = 'companion';

export interface EmailMessage {
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
}

export interface SmtpEndpoint {
  /** Hostname, used for TLS verification (SNI) and diagnostics. */
  readonly host: string;
  /** Validated IP the socket actually dials, so DNS cannot be re-answered
   * differently between the public-address check and the connect. */
  readonly address: string;
  readonly port: number;
  /** true is implicit TLS (SMTPS); false requires the server to offer STARTTLS. */
  readonly secure: boolean;
  readonly username: string | null;
  readonly password: string | null;
}

export interface SmtpOptions {
  readonly timeoutMs?: number;
  readonly retryDelayMs?: number;
  /** Test seam only: lets a scripted mock server speak plaintext end to end. */
  readonly allowPlaintext?: boolean;
  /** Test seam only. Production callers leave this unset. */
  readonly tls?: ConnectionOptions;
}

/** SMTP semantics are inverted from HTTP: 4xx is the server having a moment
 * (mailbox busy, greylisting), 5xx is us being wrong. */
class SmtpFailure extends Error {
  constructor(
    readonly code: number | null,
    readonly transient: boolean,
    message: string,
  ) {
    super(message);
    this.name = 'SmtpFailure';
  }
}

/** Dot-atom local part plus a hostname-shaped domain. Pragmatically narrower
 * than RFC 5321, but everything it refuses (whitespace, control characters,
 * angle brackets, separators) is exactly what could smuggle an extra SMTP
 * command or header out of a config field. */
const EMAIL_ADDRESS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

export function assertEmailAddress(value: string, label: string): string {
  const address = value.trim();
  if (!EMAIL_ADDRESS.test(address)) throw new Error(`${label} is not a plain email address`);
  return address;
}

/**
 * SMTP is a raw socket, so it gets the same posture as the module's HTTP
 * destinations: never a private, local, metadata or reserved address. Mirrors
 * `assertPublicHttpTarget` for a bare hostname.
 */
export function assertPlausibleSmtpHost(value: string): string {
  const host = value.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || /[\s/\\@:]/.test(host)) throw new Error('SMTP host must be a plain hostname');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa')
  ) {
    throw new Error('SMTP host must be publicly reachable');
  }
  if (isIP(host) !== 0 && !isPublicAddress(host)) {
    throw new Error('SMTP host must be a public address');
  }
  return host;
}

const resolveAddresses: ResolveAddresses = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/** Resolve once, reject anything non-public, and return the addresses so the
 * connection dials what was validated rather than re-asking DNS. */
export async function assertPublicSmtpHost(
  value: string,
  resolve: ResolveAddresses = resolveAddresses,
): Promise<readonly string[]> {
  const host = assertPlausibleSmtpHost(value);
  if (isIP(host) !== 0) return [host];
  const addresses = await resolve(host);
  if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
    throw new Error('SMTP host must resolve only to public addresses');
  }
  return addresses;
}

interface Reply {
  readonly code: number;
  readonly lines: readonly string[];
}

/**
 * Turns a socket's byte stream into complete (possibly multiline) SMTP replies.
 * Re-attachable, because STARTTLS replaces the socket mid-conversation.
 */
class ReplyStream {
  private buffer = '';
  private lines: string[] = [];
  private queue: Reply[] = [];
  private waiter: { resolve: (reply: Reply) => void; reject: (err: Error) => void } | null = null;
  private failure: Error | null = null;
  private socket: Socket | null = null;

  attach(socket: Socket): void {
    this.detach();
    this.socket = socket;
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  detach(): void {
    this.socket?.off('data', this.onData);
    this.socket?.off('error', this.onError);
    this.socket?.off('close', this.onClose);
    this.socket = null;
  }

  fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.reject(error);
  }

  next(): Promise<Reply> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer += String(chunk);
    let index: number;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      this.lines.push(line);
      if (line.length >= 4 && line[3] === '-') continue;
      const code = Number.parseInt(line.slice(0, 3), 10);
      if (!Number.isFinite(code) || line.length < 3) {
        this.fail(new SmtpFailure(null, true, `malformed SMTP reply: ${line.slice(0, 80)}`));
        return;
      }
      const reply: Reply = { code, lines: this.lines };
      this.lines = [];
      const waiter = this.waiter;
      if (waiter) {
        this.waiter = null;
        waiter.resolve(reply);
      } else {
        this.queue.push(reply);
      }
    }
  };

  private readonly onError = (err: Error): void => this.fail(err);
  private readonly onClose = (): void => this.fail(new SmtpFailure(null, true, 'server closed the connection'));
}

function capabilityLines(reply: Reply): string[] {
  return reply.lines.map((line) => line.slice(4).trim());
}

function hasStartTls(reply: Reply): boolean {
  return capabilityLines(reply).some((line) => line.toUpperCase() === 'STARTTLS');
}

function authMechanisms(reply: Reply): Set<string> {
  for (const line of capabilityLines(reply)) {
    const match = /^AUTH\s+(.+)$/i.exec(line);
    if (match) return new Set(match[1]!.toUpperCase().split(/\s+/));
  }
  return new Set();
}

/** RFC 2047 encoded-word for a header that is not printable ASCII. */
function headerText(value: string): string {
  const clean = value.replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  return `=?utf-8?B?${Buffer.from(clean, 'utf8').toString('base64')}?=`;
}

export function buildEmail(message: EmailMessage, now: () => number = Date.now): string {
  const body = message.text.split(/\r?\n/).flatMap((line) => {
    const parts: string[] = [];
    for (let offset = 0; offset < Math.max(line.length, 1); offset += MAX_LINE) {
      parts.push(line.slice(offset, offset + MAX_LINE));
    }
    return parts;
  });
  return [
    `From: ${message.from}`,
    `To: ${message.to.join(', ')}`,
    `Subject: ${headerText(message.subject)}`,
    `Date: ${new Date(now()).toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    ...body,
  ].join(CRLF);
}

/** A data line starting with '.' is doubled so it cannot terminate DATA early. */
function dotStuff(data: string): string {
  return data
    .split(CRLF)
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join(CRLF);
}

async function attempt(endpoint: SmtpEndpoint, message: EmailMessage, opts: SmtpOptions): Promise<number> {
  const timeoutMs = opts.timeoutMs ?? ATTEMPT_TIMEOUT_MS;
  const replies = new ReplyStream();
  let active: Socket = endpoint.secure
    ? connectTls({ host: endpoint.address, port: endpoint.port, servername: endpoint.host, ...opts.tls })
    : connectTcp({ host: endpoint.address, port: endpoint.port });
  replies.attach(active);
  const timer = setTimeout(() => {
    replies.fail(new SmtpFailure(null, true, `SMTP timed out after ${timeoutMs}ms`));
    active.destroy();
  }, timeoutMs);
  try {
    const expect = async (accept: readonly number[]): Promise<Reply> => {
      const reply = await replies.next();
      if (!accept.includes(reply.code)) {
        const detail = (reply.lines[reply.lines.length - 1] ?? '').slice(4).trim().slice(0, 200);
        throw new SmtpFailure(reply.code, reply.code >= 400 && reply.code < 500, `SMTP ${reply.code}: ${detail}`);
      }
      return reply;
    };
    const command = (line: string, accept: readonly number[]): Promise<Reply> => {
      active.write(line + CRLF);
      return expect(accept);
    };

    await expect([220]);
    let ehlo = await command(`EHLO ${EHLO_NAME}`, [250]);
    if (!endpoint.secure && !opts.allowPlaintext) {
      // Fail closed: an operator who chose STARTTLS gets TLS or nothing, never
      // a silent downgrade that sends the password and the mail in the clear.
      if (!hasStartTls(ehlo)) {
        throw new SmtpFailure(null, false, 'server does not offer STARTTLS; use implicit TLS or a server that does');
      }
      await command('STARTTLS', [220]);
      active = connectTls({ socket: active, servername: endpoint.host, ...opts.tls });
      replies.attach(active);
      ehlo = await command(`EHLO ${EHLO_NAME}`, [250]);
    }
    if (endpoint.username !== null && endpoint.password !== null) {
      const mechanisms = authMechanisms(ehlo);
      if (mechanisms.has('PLAIN')) {
        const token = Buffer.from(`\u0000${endpoint.username}\u0000${endpoint.password}`, 'utf8').toString('base64');
        await command(`AUTH PLAIN ${token}`, [235]);
      } else if (mechanisms.has('LOGIN')) {
        await command('AUTH LOGIN', [334]);
        await command(Buffer.from(endpoint.username, 'utf8').toString('base64'), [334]);
        await command(Buffer.from(endpoint.password, 'utf8').toString('base64'), [235]);
      } else {
        throw new SmtpFailure(null, false, 'server offers neither AUTH PLAIN nor AUTH LOGIN');
      }
    }
    await command(`MAIL FROM:<${message.from}>`, [250]);
    for (const recipient of message.to) await command(`RCPT TO:<${recipient}>`, [250, 251]);
    await command('DATA', [354]);
    const reply = await command(`${dotStuff(buildEmail(message))}${CRLF}.`, [250]);
    // The message is accepted; QUIT is politeness, not part of the outcome.
    await new Promise<void>((resolve) => {
      try {
        active.end(`QUIT${CRLF}`, resolve);
      } catch {
        resolve();
      }
    });
    return reply.code;
  } finally {
    clearTimeout(timer);
    replies.detach();
    active.destroy();
  }
}

/**
 * Send one message, retrying once on a transient failure. Never throws: a
 * destination being down is data to record, not an exception to propagate into
 * the operation that raised the notification. `httpStatus` carries the SMTP
 * reply code of the final attempt, which the delivery history renders the same
 * way it renders an HTTP status.
 */
export async function deliverEmail(
  endpoint: SmtpEndpoint,
  message: EmailMessage,
  opts: SmtpOptions = {},
): Promise<DeliveryOutcome> {
  let last: DeliveryOutcome = { ok: false, httpStatus: null, error: 'not attempted', attempts: 0 };
  for (let attemptNo = 1; attemptNo <= 2; attemptNo++) {
    try {
      const code = await attempt(endpoint, message, opts);
      return { ok: true, httpStatus: code, error: null, attempts: attemptNo };
    } catch (err) {
      const failure = err instanceof SmtpFailure ? err : null;
      last = {
        ok: false,
        httpStatus: failure?.code ?? null,
        error: String(err instanceof Error ? err.message : err).slice(0, 300),
        attempts: attemptNo,
      };
      if (failure && !failure.transient) return last;
    }
    if (attemptNo === 1) await new Promise((resolve) => setTimeout(resolve, opts.retryDelayMs ?? RETRY_DELAY_MS));
  }
  return last;
}
