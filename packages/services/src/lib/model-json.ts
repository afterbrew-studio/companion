import { jsonrepair } from 'jsonrepair';

/**
 * Parse a JSON object out of a model's final message. Models drift despite
 * strict instructions: fenced blocks, prose around the object, and small
 * structural slips (unclosed arrays, trailing commas). Extraction + jsonrepair
 * make the pipeline tolerant without loosening the zod validation that follows.
 *
 * Ordering matters: the whole message is tried as JSON first, and the
 * balanced-brace scanner is string-aware — a ``` fence *inside* a JSON string
 * value (e.g. a review body suggesting a yaml snippet) must never split the
 * object, which is exactly what a naive fence regex used to do.
 */
export function extractModelJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  // The entire message is one fenced block (```json ... ``` or bare fences).
  const outerFence = trimmed.match(/^```[\w-]*[ \t]*\n([\s\S]*?)\n?```$/);
  if (outerFence?.[1]) candidates.push(outerFence[1].trim());

  // Prose around the payload: scan from the first "{" with string/escape
  // awareness to the matching "}".
  const balanced = sliceBalancedJson(trimmed);
  if (balanced) candidates.push(balanced);

  // Last-ditch slice: first "{" to last "}".
  const naive = sliceJson(trimmed);
  candidates.push(naive);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // try the next shape
    }
  }
  return JSON.parse(jsonrepair(balanced ?? naive)) as unknown;
}

/** Extract the first balanced {...} respecting JSON strings and escapes. */
function sliceBalancedJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function sliceJson(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start !== -1 && end > start ? text.slice(start, end + 1) : text.trim();
}
