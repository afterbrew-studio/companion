import { Fragment, type ReactNode } from 'react';
import { highlightCode } from './highlight.js';

/**
 * Small, safe GitHub-flavored-ish markdown renderer. Emits React nodes (never
 * raw HTML), so untrusted issue/PR bodies cannot inject markup — the one
 * exception is fenced code, which goes through highlight.js (it escapes all
 * source text; only its own span markup is injected). Supports: headings,
 * paragraphs, fenced code (highlighted), inline code, bold/italic/strike,
 * links, images (rendered as links), blockquotes, hr, ordered/unordered/task
 * lists.
 */

function CodeBlock({ lang, code }: { lang: string; code: string }): JSX.Element {
  const html = highlightCode(code, lang);
  if (html !== null) {
    return (
      <pre className="md-code">
        <code dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    );
  }
  return (
    <pre className="md-code">
      <code>{code}</code>
    </pre>
  );
}

export function Markdown({ text }: { text: string }): JSX.Element {
  return <div className="markdown">{renderBlocks(text)}</div>;
}

function renderBlocks(text: string): ReactNode[] {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === '') {
      i++;
      continue;
    }

    // fenced code block
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        buf.push(lines[i]!);
        i++;
      }
      i++; // closing fence
      out.push(<CodeBlock key={key++} lang={(fence[1] ?? '').toLowerCase()} code={buf.join('\n')} />);
      continue;
    }

    // heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1]!.length;
      const Tag = `h${Math.min(level + 1, 6)}` as 'h2';
      out.push(<Tag key={key++}>{renderInline(heading[2]!)}</Tag>);
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(<hr key={key++} />);
      i++;
      continue;
    }

    // Link reference definition. GitHub hides these, and bots abuse them as a
    // payload channel (vercel's `[vc]: #<base64>`), so rendering one is both
    // wrong and ugly. Only at block start, like CommonMark — a definition
    // cannot interrupt a paragraph.
    if (LINK_DEFINITION_RE.test(line)) {
      i++;
      continue;
    }

    // GFM table: a header row followed by the `---|---` separator row
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR_RE.test(lines[i + 1]!)) {
      const header = splitRow(line);
      const aligns = splitRow(lines[i + 1]!).map((cell) =>
        /^:-+:$/.test(cell) ? 'center' : /^-+:$/.test(cell) ? 'right' : undefined,
      );
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      out.push(
        <div key={key++} className="overflow-x-auto">
          <table>
            <thead>
              <tr>
                {header.map((cell, c) => (
                  <th key={c} style={aligns[c] ? { textAlign: aligns[c] } : undefined}>
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {header.map((_, c) => (
                    <td key={c} style={aligns[c] ? { textAlign: aligns[c] } : undefined}>
                      {renderInline(row[c] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    // blockquote
    if (line.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('>')) {
        buf.push(lines[i]!.replace(/^>\s?/, ''));
        i++;
      }
      out.push(<blockquote key={key++}>{renderBlocks(buf.join('\n'))}</blockquote>);
      continue;
    }

    // list (ul / ol / tasks)
    const listMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+/);
    if (listMatch) {
      const ordered = /\d/.test(listMatch[2]!);
      const items: ReactNode[] = [];
      let li = 0;
      while (i < lines.length) {
        const m = lines[i]!.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m) break;
        let body = m[3]!;
        // continuation lines (indented) fold into the item
        const cont: string[] = [];
        i++;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]!) && !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!)) {
          cont.push(lines[i]!.trim());
          i++;
        }
        if (cont.length > 0) body += ' ' + cont.join(' ');
        const task = body.match(/^\[( |x|X)\]\s+(.*)$/);
        items.push(
          <li key={li++}>
            {task ? (
              <>
                <input type="checkbox" checked={task[1] !== ' '} readOnly aria-hidden className="mr-1.5 align-middle" />
                {renderInline(task[2]!)}
              </>
            ) : (
              renderInline(body)
            )}
          </li>,
        );
      }
      out.push(ordered ? <ol key={key++}>{items}</ol> : <ul key={key++}>{items}</ul>);
      continue;
    }

    // paragraph: gather until blank/blocky line (tables end a paragraph too)
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s|\s*(-{3,}|\*{3,})\s*$|\s*\|)/.test(lines[i]!)
    ) {
      buf.push(lines[i]!);
      i++;
    }
    out.push(<p key={key++}>{renderInline(buf.join(' '))}</p>);
  }
  return out;
}

const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

/** `[label]: destination "optional title"` — up to 3 leading spaces, per CommonMark. */
const LINK_DEFINITION_RE = /^ {0,3}\[[^\]]+\]:\s*\S+(\s+(".*"|'.*'|\(.*\)))?\s*$/;

/** `| a | b |` → ['a', 'b'] (leading/trailing pipes optional). */
function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

// ---------- inline ------------------------------------------------------------------

const INLINE_RE =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)|(~~[^~]+~~)|(!?\[[^\]]*\]\([^)\s]+\))|(https?:\/\/[^\s<>)]+)/g;

function renderInline(text: string): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE_RE)) {
    const idx = match.index ?? 0;
    if (idx > last) parts.push(<Fragment key={key++}>{text.slice(last, idx)}</Fragment>);
    parts.push(<Fragment key={key++}>{renderToken(match[0])}</Fragment>);
    last = idx + match[0].length;
  }
  if (last < text.length) parts.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  return parts;
}

function renderToken(token: string): ReactNode {
  if (token.startsWith('`')) return <code>{token.slice(1, -1)}</code>;
  if (token.startsWith('**') || token.startsWith('__')) {
    return <strong>{renderInline(token.slice(2, -2))}</strong>;
  }
  if (token.startsWith('~~')) return <del>{renderInline(token.slice(2, -2))}</del>;
  if (token.startsWith('*') || token.startsWith('_')) {
    return <em>{renderInline(token.slice(1, -1))}</em>;
  }
  const link = token.match(/^(!?)\[([^\]]*)\]\(([^)\s]+)\)$/);
  if (link) {
    const href = safeHref(link[3]!);
    const label = link[2] || link[3]!;
    if (!href) return label;
    // In-app hash links (#/runs/x) navigate the SPA; external ones open a tab.
    const external = !href.startsWith('#/');
    return (
      <a href={href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined}>
        {link[1] === '!' ? `🖼 ${label}` : renderInline(label)}
      </a>
    );
  }
  const href = safeHref(token);
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {token}
      </a>
    );
  }
  return token;
}

/** http(s) and in-app `#/` routes only — javascript:/data: render as plain text. */
function safeHref(raw: string): string | null {
  return /^https?:\/\//i.test(raw) || /^#\//.test(raw) ? raw : null;
}
