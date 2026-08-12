/**
 * Client addressing behind a reverse proxy. The socket peer is the only address
 * Companion can verify, so X-Forwarded-For is honoured exclusively when that
 * peer is an operator-declared trusted proxy (COMPANION_TRUSTED_PROXIES);
 * from any other peer the header is ignored outright. With a trusted peer the
 * client is the rightmost X-Forwarded-For hop that is not itself a trusted
 * proxy (the standard algorithm), so a client prepending fake hops cannot
 * spoof its address: the hop its own proxy appended is reached first.
 */

interface TrustedNet {
  /** Address bytes in the 16-byte IPv6 space (IPv4 mapped to ::ffff:a.b.c.d). */
  readonly bytes: Uint8Array;
  /** Prefix length in that space (an IPv4 /n becomes /(96+n)). */
  readonly prefix: number;
}

export class TrustedProxies {
  private readonly nets: readonly TrustedNet[];

  /** Throws on a malformed entry: a typo that silently dropped trust would fail open. */
  constructor(entries: readonly string[]) {
    this.nets = entries.map(parseNet);
  }

  has(address: string): boolean {
    const ip = parseIp(address);
    if (!ip) return false;
    return this.nets.some((net) => prefixMatches(ip.bytes, net));
  }
}

/**
 * The address login throttling (and anything else identifying the caller)
 * should use for this connection. `forwardedFor` is the raw header value;
 * repeated headers arrive as an array and are treated as one list.
 */
export function clientAddressFrom(
  socketAddress: string,
  forwardedFor: string | readonly string[] | undefined,
  trusted: TrustedProxies,
): string {
  if (!trusted.has(socketAddress)) return socketAddress;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : ((forwardedFor as string | undefined) ?? '');
  const hops = header
    .split(',')
    .map((hop) => normalizeHop(hop.trim()))
    .filter((hop) => hop !== '');
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!trusted.has(hops[i]!)) return hops[i]!;
  }
  // Every hop is a trusted proxy (the proxy called on its own behalf): the
  // leftmost entry is the origin; no header at all means the proxy itself.
  return hops[0] ?? socketAddress;
}

/**
 * Whether the browser reached the edge over HTTPS. Only a trusted proxy may
 * assert this: from any other peer X-Forwarded-Proto is attacker-controlled,
 * and a client must not be allowed to steer cookie policy with its own header.
 * The leftmost hop is the one the client actually spoke, so a proxy chain
 * re-terminating on http cannot downgrade the answer.
 */
export function forwardedHttps(
  socketAddress: string,
  forwardedProto: string | readonly string[] | undefined,
  trusted: TrustedProxies,
): boolean {
  if (!trusted.has(socketAddress)) return false;
  const header = Array.isArray(forwardedProto)
    ? (forwardedProto[0] ?? '')
    : ((forwardedProto as string | undefined) ?? '');
  return header.split(',')[0]!.trim().toLowerCase() === 'https';
}

/** Loopback socket peer: 127.0.0.0/8, ::1, and the IPv4-mapped forms. */
export function isLoopbackAddress(address: string): boolean {
  const ip = parseIp(address);
  if (!ip) return false;
  if (isMappedV4(ip.bytes)) return ip.bytes[12] === 127;
  return ip.bytes.slice(0, 15).every((b) => b === 0) && ip.bytes[15] === 1;
}

// ---------- parsing ----------------------------------------------------------

/** Strip the port/bracket decorations proxies put on X-Forwarded-For hops. */
function normalizeHop(hop: string): string {
  if (hop.startsWith('[')) {
    const end = hop.indexOf(']');
    if (end > 0) return hop.slice(1, end);
  }
  const v4WithPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(hop);
  return v4WithPort ? v4WithPort[1]! : hop;
}

function parseNet(entry: string): TrustedNet {
  const invalid = (): never => {
    throw new Error(`COMPANION_TRUSTED_PROXIES entry '${entry}' is not an IP address or CIDR`);
  };
  const parts = entry.split('/');
  if (parts.length > 2) invalid();
  const ip = parseIp(parts[0] ?? '');
  if (!ip) invalid();
  const max = ip!.v4 ? 32 : 128;
  let prefix = max;
  if (parts.length === 2) {
    if (!/^\d{1,3}$/.test(parts[1]!)) invalid();
    prefix = Number(parts[1]);
    if (prefix > max) invalid();
  }
  return { bytes: ip!.bytes, prefix: ip!.v4 ? 96 + prefix : prefix };
}

interface ParsedIp {
  readonly bytes: Uint8Array;
  /** The literal was dotted IPv4 (drives CIDR prefix width). */
  readonly v4: boolean;
}

function parseIp(raw: string): ParsedIp | null {
  const zone = raw.indexOf('%');
  const literal = zone >= 0 ? raw.slice(0, zone) : raw;
  if (literal.includes(':')) {
    const bytes = parseIpv6(literal);
    return bytes ? { bytes, v4: false } : null;
  }
  const v4 = parseIpv4Bytes(literal);
  if (!v4) return null;
  const bytes = new Uint8Array(16);
  bytes[10] = 0xff;
  bytes[11] = 0xff;
  bytes.set(v4, 12);
  return { bytes, v4: true };
}

function parseIpv4Bytes(s: string): Uint8Array | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!match) return null;
  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const octet = Number(match[i + 1]);
    if (octet > 255) return null;
    bytes[i] = octet;
  }
  return bytes;
}

function parseIpv6(s: string): Uint8Array | null {
  // An embedded IPv4 tail becomes its two hex groups, then one hex-only pass.
  if (s.includes('.')) {
    const at = s.lastIndexOf(':');
    const tail = parseIpv4Bytes(s.slice(at + 1));
    if (!tail) return null;
    s = `${s.slice(0, at + 1)}${hexGroup(tail[0]!, tail[1]!)}:${hexGroup(tail[2]!, tail[3]!)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const left = hexGroups(halves[0]!);
  const right = halves.length === 2 ? hexGroups(halves[1]!) : [];
  if (!left || !right) return null;
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length > 7) return null;
  const bytes = new Uint8Array(16);
  left.forEach((group, i) => {
    bytes[i * 2] = group >> 8;
    bytes[i * 2 + 1] = group & 0xff;
  });
  right.forEach((group, i) => {
    const at = 16 - (right.length - i) * 2;
    bytes[at] = group >> 8;
    bytes[at + 1] = group & 0xff;
  });
  return bytes;
}

function hexGroups(part: string): number[] | null {
  if (part === '') return [];
  const groups = part.split(':');
  const out: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    out.push(parseInt(group, 16));
  }
  return out;
}

const hexGroup = (hi: number, lo: number): string => ((hi << 8) | lo).toString(16);

function isMappedV4(bytes: Uint8Array): boolean {
  return bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
}

function prefixMatches(bytes: Uint8Array, net: TrustedNet): boolean {
  const wholeBytes = net.prefix >> 3;
  for (let i = 0; i < wholeBytes; i++) {
    if (bytes[i] !== net.bytes[i]) return false;
  }
  const remainder = net.prefix & 7;
  if (remainder === 0) return true;
  const mask = (0xff << (8 - remainder)) & 0xff;
  return ((bytes[wholeBytes]! ^ net.bytes[wholeBytes]!) & mask) === 0;
}
