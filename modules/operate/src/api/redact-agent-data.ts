import type { AskRequest, HistorySegment, MoxxyEvent } from '@moxxy/companion-types';

const REDACTED = '[redacted]';
const SECRET_KEY = /(^|_)(authorization|cookie|credentials?|password|passwd|secret|token|api_key)($|_)/;

/** Agent tool payloads are useful evidence, but runtimes may place ephemeral
 * credentials in commands, headers or results. Scrub the client projection;
 * the backend keeps the original event for execution and audit continuity. */
export function redactAgentEvent(event: MoxxyEvent): MoxxyEvent {
  return redactValue(event) as MoxxyEvent;
}

export function redactAgentAsk(ask: AskRequest): AskRequest {
  return redactValue(ask) as AskRequest;
}

export function redactAgentHistory(history: HistorySegment): HistorySegment {
  return {
    events: history.events.map(redactAgentEvent),
    prevCursor: history.prevCursor,
  };
}

function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 16 || seen.has(value)) return REDACTED;
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1, seen));

  // Object.fromEntries defines own data properties, including `__proto__`,
  // without invoking Object.prototype's legacy setter. Besides keeping the
  // clone faithful, this avoids turning an untrusted runtime key into a
  // prototype mutation while the event is projected to the browser.
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSecretKey(key) ? REDACTED : redactValue(item, depth + 1, seen),
    ]),
  );
}

function isSecretKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-.]/g, '_').toLowerCase();
  return SECRET_KEY.test(normalized);
}

function redactText(value: string): string {
  return value
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`)
    .replace(/(\b(?:token|access[_-]?token|api[_-]?key|password|passwd|secret)\b["']?\s*[:=]\s*)(["'])(.*?)\2/gi, `$1$2${REDACTED}$2`)
    .replace(/(\b(?:token|access[_-]?token|api[_-]?key|password|passwd|secret)\b\s*[:=]\s*)[^\s,;}\]]+/gi, `$1${REDACTED}`)
    .replace(/(\bCookie\s*:\s*)[^"'\r\n]+/gi, `$1${REDACTED}`)
    .replace(/(https?:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi, `$1${REDACTED}$2`)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, REDACTED);
}
