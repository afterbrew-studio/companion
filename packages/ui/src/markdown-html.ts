import { createElement, Fragment, type ReactNode } from 'react';

/**
 * The subset of raw HTML that GitHub allows in issue and PR bodies, parsed into
 * React elements.
 *
 * No string ever becomes markup here. An element is built only when its tag is
 * in ALLOWED, every attribute must appear in that tag's own list and survive a
 * validator, and anything else is left inside the surrounding text run, which
 * React escapes on render. A tag we do not allow is therefore shown as the
 * characters the author wrote, the way GitHub shows it, rather than vanishing.
 *
 * Markdown is applied to text runs by the caller (see `RenderText`), so this
 * module never imports the markdown renderer and the two cannot recurse.
 */

/** Tag -> the attributes it may carry. A tag that is not a key here is not an element. */
const ALLOWED = new Map<string, readonly string[]>([
  ['a', ['href', 'title', 'rel']],
  ['img', ['src', 'alt', 'title', 'width', 'height', 'align']],
  ['picture', []],
  ['source', ['media', 'srcset', 'type']],
  ['details', ['open']],
  ['summary', []],
  ['b', []],
  ['strong', []],
  ['i', []],
  ['em', []],
  ['code', []],
  ['kbd', []],
  ['sub', []],
  ['sup', []],
  ['br', []],
  ['hr', []],
  ['del', []],
  ['ins', []],
  ['p', ['align']],
  ['blockquote', []],
  ['ul', []],
  ['ol', ['start']],
  ['li', []],
  ['h1', ['align']],
  ['h2', ['align']],
  ['h3', ['align']],
  ['h4', ['align']],
  ['h5', ['align']],
  ['h6', ['align']],
  ['table', ['align']],
  ['thead', []],
  ['tbody', []],
  ['tr', []],
  ['th', ['align', 'colspan', 'rowspan']],
  ['td', ['align', 'colspan', 'rowspan']],
  // `div` and `span` are structural only: `align` is an enumerated attribute
  // with a closed value set, and there is nothing else they may carry. `class`
  // would let a commenter borrow the app's utility classes and restyle the
  // page, `id` would collide with the app's own ids, `style` is CSS injection.
  ['div', ['align']],
  ['span', []],
]);

const VOID = new Set(['img', 'br', 'hr', 'source']);

/** Containers whose text children are flow content, so markdown blocks may appear in them. */
const FLOW = new Set(['details', 'div', 'blockquote', 'li', 'td', 'th']);

/** Tags that begin an HTML block; the rest stay inline, as in CommonMark. */
const BLOCK = new Set([
  'details',
  'summary',
  'div',
  'p',
  'blockquote',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
]);

/** HTML attribute name -> React prop name, for the few that differ. */
const PROP = new Map([
  ['srcset', 'srcSet'],
  ['colspan', 'colSpan'],
  ['rowspan', 'rowSpan'],
]);

const URL_SCHEMES = new Set(['http', 'https', 'mailto']);
const ALIGN = new Set(['left', 'center', 'right', 'justify', 'top', 'middle', 'bottom']);
const REL_TOKENS = new Set(['nofollow', 'noreferrer', 'noopener', 'external', 'ugc']);

/**
 * `http`, `https`, `mailto` and in-app `#/` routes. Everything else, including
 * a relative or protocol-relative URL, is rejected.
 *
 * The value arrives with its entities already decoded, and the normalisation
 * below is the one a browser applies before it looks at a URL at all: tab,
 * newline and carriage return removed anywhere, C0 controls and spaces removed
 * at either end. So the scheme tested here is the scheme the browser would act
 * on, and `jav&#97;script:`, `java\tscript:` and ` JavaScript:` all reduce to
 * the same rejected string instead of slipping past a prefix test.
 */
export function safeUrl(raw: string): string | null {
  const url = raw.replace(/[\t\n\r]/g, '').replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  if (scheme) return URL_SCHEMES.has(scheme[1]!.toLowerCase()) ? url : null;
  return url.startsWith('#/') ? url : null;
}

/** Every candidate URL must pass; one bad entry drops the whole attribute. */
function safeSrcset(raw: string): string | null {
  for (const candidate of raw.split(',')) {
    const url = candidate.trim().split(/\s+/)[0] ?? '';
    if (url === '' || safeUrl(url) === null) return null;
  }
  return raw;
}

/** `target="_blank"` is added below, and `opener` must not be able to undo it. */
function safeRel(raw: string): string | null {
  const tokens = raw
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => REL_TOKENS.has(token));
  return tokens.length > 0 ? tokens.join(' ') : null;
}

/** `null` drops the attribute; `true` is a boolean attribute. */
function attrValue(name: string, raw: string): string | true | null {
  switch (name) {
    case 'href':
    case 'src':
      return safeUrl(raw);
    case 'srcset':
      return safeSrcset(raw);
    case 'width':
    case 'height':
      return /^\d{1,5}%?$/.test(raw) ? raw : null;
    case 'colspan':
    case 'rowspan':
    case 'start':
      return /^\d{1,4}$/.test(raw) ? raw : null;
    case 'align':
      return ALIGN.has(raw.toLowerCase()) ? raw.toLowerCase() : null;
    case 'type':
      return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(raw) ? raw : null;
    case 'rel':
      return safeRel(raw);
    case 'open':
      return true;
    // Only `title`, `alt` and `media` reach here, because the per-tag list ran
    // first. All three are inert text: React sets them with setAttribute, and a
    // media query has nothing to execute.
    default:
      return raw;
  }
}

const NAMED = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', '\u00a0'],
]);

/**
 * One pass, so `&amp;#106;` yields the text `&#106;` and cannot be decoded a
 * second time into `j`. Attribute values are decoded exactly here and text runs
 * exactly at the React leaf, so nothing is ever decoded twice.
 */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g, (whole, body: string) => {
    if (!body.startsWith('#')) return NAMED.get(body.toLowerCase()) ?? whole;
    const hex = body[1] === 'x' || body[1] === 'X';
    const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
    if (code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
    return String.fromCodePoint(code);
  });
}

// ---------- parse ------------------------------------------------------------------

type Props = Record<string, string | boolean>;
interface ElementNode {
  kind: 'element';
  tag: string;
  props: Props;
  children: HtmlNode[];
}
interface TextNode {
  kind: 'text';
  text: string;
}
type HtmlNode = ElementNode | TextNode;

/** Bounds the tree the renderer has to walk; past it, tags render flat instead of nesting. */
const MAX_DEPTH = 32;

const NAME_RE = /[a-zA-Z][a-zA-Z0-9-]*/y;
const ATTR_NAME_RE = /[^\s"'>/=]+/y;
const UNQUOTED_RE = /[^\s>]*/y;

function isSpace(char: string | undefined): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f';
}

function appendText(parent: ElementNode, text: string): void {
  if (text === '') return;
  const last = parent.children[parent.children.length - 1];
  if (last && last.kind === 'text') last.text += text;
  else parent.children.push({ kind: 'text', text });
}

interface OpenTag {
  attrs: Map<string, string>;
  selfClosing: boolean;
  end: number;
}

/**
 * A tag that reaches the end of the input without closing. HTML5 drops it and
 * stops tokenising, and so do we: retrying from the next `<` inside it would
 * re-walk the same characters for every `<` a truncated body contains.
 */
const EOF_IN_TAG = Symbol('eof-in-tag');

/** `null` means "this is not a tag", so the `<` stays literal text. */
function parseOpenTag(source: string, at: number): OpenTag | null | typeof EOF_IN_TAG {
  const attrs = new Map<string, string>();
  let i = at;
  for (;;) {
    while (isSpace(source[i])) i++;
    const char = source[i];
    if (char === undefined) return EOF_IN_TAG;
    if (char === '>') return { attrs, selfClosing: false, end: i + 1 };
    if (char === '/' && source[i + 1] === '>') return { attrs, selfClosing: true, end: i + 2 };
    ATTR_NAME_RE.lastIndex = i;
    const name = ATTR_NAME_RE.exec(source);
    if (!name) return null;
    i = ATTR_NAME_RE.lastIndex;
    let value = '';
    let after = i;
    while (isSpace(source[after])) after++;
    if (source[after] === '=') {
      after++;
      while (isSpace(source[after])) after++;
      const quote = source[after];
      if (quote === '"' || quote === "'") {
        const close = source.indexOf(quote, after + 1);
        if (close === -1) return EOF_IN_TAG;
        value = source.slice(after + 1, close);
        i = close + 1;
      } else {
        UNQUOTED_RE.lastIndex = after;
        value = UNQUOTED_RE.exec(source)?.[0] ?? '';
        i = UNQUOTED_RE.lastIndex;
      }
    }
    attrs.set(name[0].toLowerCase(), value);
  }
}

function propsFor(tag: string, attrs: Map<string, string>): Props {
  const allowed = ALLOWED.get(tag) ?? [];
  const props: Props = {};
  for (const [name, raw] of attrs) {
    // No allowlist contains an `on*` name, so this cannot fire today. It stays
    // as the invariant a future entry must not be able to break.
    if (name.startsWith('on') || !allowed.includes(name)) continue;
    const value = attrValue(name, decodeEntities(raw));
    if (value === null) continue;
    props[PROP.get(name) ?? name] = value;
  }
  return props;
}

/**
 * Scans from `from` and returns the nodes plus the index it stopped at. With
 * `stopAtLineEnd` the scan ends at the first newline reached outside any open
 * element, which is where an HTML block ends; a block whose tag is never closed
 * runs to the end of the input, as it does on GitHub.
 */
function scan(source: string, from: number, stopAtLineEnd: boolean): { nodes: HtmlNode[]; end: number } {
  const root: ElementNode = { kind: 'element', tag: '', props: {}, children: [] };
  const stack: ElementNode[] = [root];
  let i = from;
  let textFrom = from;

  // A `-->` absent from one offset is absent from every later one, so one miss
  // settles it for the whole scan instead of a fresh search per `<!--`.
  let noCommentEnd = false;

  while (i < source.length) {
    if (source[i] !== '<') {
      if (source[i] === '\n' && stopAtLineEnd && stack.length === 1) {
        i++;
        break;
      }
      i++;
      continue;
    }

    if (source.startsWith('<!--', i)) {
      const close = noCommentEnd ? -1 : source.indexOf('-->', i + 4);
      // Unterminated: keep the `<` as text rather than eating the rest of the body.
      if (close === -1) {
        noCommentEnd = true;
        i++;
        continue;
      }
      appendText(stack[stack.length - 1]!, source.slice(textFrom, i));
      i = close + 3;
      textFrom = i;
      continue;
    }

    const closing = source[i + 1] === '/';
    NAME_RE.lastIndex = i + (closing ? 2 : 1);
    const name = NAME_RE.exec(source);
    if (!name) {
      i++;
      continue;
    }
    const tag = name[0].toLowerCase();

    if (closing) {
      const close = parseCloseTag(source, NAME_RE.lastIndex);
      if (!close) {
        i++;
        continue;
      }
      if (!ALLOWED.has(tag)) {
        i = close.end;
        continue;
      }
      appendText(stack[stack.length - 1]!, source.slice(textFrom, i));
      i = close.end;
      textFrom = i;
      // A close tag with nothing open to match is ignored, as it is in HTML.
      for (let depth = stack.length - 1; depth > 0; depth--) {
        if (stack[depth]!.tag === tag) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }

    const open = parseOpenTag(source, NAME_RE.lastIndex);
    // Everything from here on was inside the unterminated tag; it stays as text
    // so a truncated body still shows what it contained.
    if (open === EOF_IN_TAG) {
      i = source.length;
      break;
    }
    if (!open) {
      i++;
      continue;
    }
    // Not on the allowlist: leave the tag's own source inside the text run, so
    // it renders escaped instead of disappearing.
    if (!ALLOWED.has(tag)) {
      i = open.end;
      continue;
    }
    appendText(stack[stack.length - 1]!, source.slice(textFrom, i));
    i = open.end;
    textFrom = i;
    const element: ElementNode = { kind: 'element', tag, props: propsFor(tag, open.attrs), children: [] };
    stack[stack.length - 1]!.children.push(element);
    if (!VOID.has(tag) && !open.selfClosing && stack.length < MAX_DEPTH) stack.push(element);
  }

  appendText(stack[stack.length - 1]!, source.slice(textFrom, i));
  return { nodes: root.children, end: i };
}

function parseCloseTag(source: string, at: number): { end: number } | null {
  let i = at;
  while (isSpace(source[i])) i++;
  return source[i] === '>' ? { end: i + 1 } : null;
}

// ---------- render -----------------------------------------------------------------

/** Renders a text run as markdown; `asBlocks` asks for block-level markdown. */
export type RenderText = (text: string, asBlocks: boolean) => ReactNode;

const BLANK_LINE = /\n[ \t]*\n/;

function toReact(nodes: readonly HtmlNode[], renderText: RenderText, flow: boolean): ReactNode[] {
  return nodes.map((node, key) => {
    if (node.kind === 'text') {
      return createElement(Fragment, { key }, renderText(node.text, flow && BLANK_LINE.test(node.text)));
    }
    const props: Record<string, string | boolean | number> = { ...node.props, key };
    if (node.tag === 'a' && typeof props.href === 'string' && !props.href.startsWith('#/')) {
      const rel = new Set(String(props.rel ?? '').split(' ').filter(Boolean));
      rel.add('noreferrer');
      props.target = '_blank';
      props.rel = [...rel].join(' ');
    }
    if (node.tag === 'img') {
      props.loading = 'lazy';
      props.referrerPolicy = 'no-referrer';
    }
    if (VOID.has(node.tag)) return createElement(node.tag, props);
    return createElement(node.tag, props, toReact(node.children, renderText, FLOW.has(node.tag)));
  });
}

/** True when `line` opens (or closes) an HTML block, which must not be wrapped in a paragraph. */
export function startsHtmlBlock(line: string): boolean {
  const match = /^ {0,3}<\/?([a-zA-Z][a-zA-Z0-9-]*)[\s/>]/.exec(line);
  return match !== null && BLOCK.has(match[1]!.toLowerCase());
}

/** Inline HTML inside a paragraph, heading, list item or table cell. */
export function renderHtml(source: string, renderText: RenderText): ReactNode[] {
  return toReact(scan(source, 0, false).nodes, renderText, false);
}

/** A block of HTML starting at `from`; `end` is the index the block stopped at. */
export function renderHtmlBlock(
  source: string,
  from: number,
  renderText: RenderText,
): { nodes: ReactNode[]; end: number } {
  const { nodes, end } = scan(source, from, true);
  return { nodes: toReact(nodes, renderText, true), end };
}
