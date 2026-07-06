import { jsonrepair } from 'jsonrepair';

/**
 * Parse a JSON object out of a model's final message. Models drift despite
 * strict instructions: fenced blocks, prose around the object, and small
 * structural slips (unclosed arrays, trailing commas). Extraction + jsonrepair
 * make the pipeline tolerant without loosening the zod validation that follows.
 */
export function extractModelJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced?.[1]?.trim() ?? sliceJson(text);
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return JSON.parse(jsonrepair(raw)) as unknown;
  }
}

function sliceJson(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start !== -1 && end > start ? text.slice(start, end + 1) : text.trim();
}
