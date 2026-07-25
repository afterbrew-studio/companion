/**
 * Pull a string field from an incomplete JSON response without parsing the
 * whole document. Planner discussion runs return strict JSON, but the chat
 * must stream only the human-facing `answer` value rather than raw protocol
 * syntax. The regular backend parser remains the final source of truth.
 */
export function extractStreamingJsonString(source: string, field: string): string {
  const match = new RegExp(`"${escapeRegExp(field)}"\\s*:\\s*"`).exec(source);
  if (!match) return '';

  let cursor = match.index + match[0].length;
  let output = '';
  while (cursor < source.length) {
    const character = source[cursor]!;
    if (character === '"') return output;
    if (character !== '\\') {
      output += character;
      cursor += 1;
      continue;
    }

    if (cursor + 1 >= source.length) return output;
    const escaped = source[cursor + 1]!;
    if (escaped === 'u') {
      const hex = source.slice(cursor + 2, cursor + 6);
      if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) return output;
      output += String.fromCharCode(Number.parseInt(hex, 16));
      cursor += 6;
      continue;
    }

    const decoded: Readonly<Record<string, string>> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    const value = decoded[escaped];
    if (value === undefined) return output;
    output += value;
    cursor += 2;
  }
  return output;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
