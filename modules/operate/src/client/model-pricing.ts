/**
 * ⚠️ THE pricing table — the ONE place model prices live. Anthropic list
 * prices in USD per million tokens, sourced from the claude-api skill's
 * model table (cached 2026-06-24). Update HERE when prices change; nothing
 * else in the codebase may carry a price.
 *
 * Deliberate simplifications, surfaced on the dashboard card as footnotes:
 *  - Estimates ignore prompt caching — cache read/write tokens aren't
 *    tracked in the runs table, and cached reads bill at ~0.1× input.
 *  - Sonnet 5 uses the $3/$15 sticker, not the $2/$10 intro price that runs
 *    through 2026-08-31 — estimates lean conservative (slightly high).
 *  - Models not in the table (legacy Claude, non-Anthropic ids) price as
 *    null: the UI shows "—" and marks the total as partial. Never guess a
 *    price for them here.
 */

export interface ModelPricing {
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

/** Matched by substring so dated/provider-prefixed ids (e.g. `anthropic.claude-opus-4-8`,
 *  `claude-haiku-4-5-20251001`) still price. No key is a substring of a
 *  DIFFERENTLY-priced key — check before adding one. */
const CLAUDE_PRICES: ReadonlyArray<readonly [string, ModelPricing]> = [
  ['claude-fable-5', { inputPerMTok: 10, outputPerMTok: 50 }],
  ['claude-mythos-5', { inputPerMTok: 10, outputPerMTok: 50 }],
  ['claude-opus-4-8', { inputPerMTok: 5, outputPerMTok: 25 }],
  ['claude-opus-4-7', { inputPerMTok: 5, outputPerMTok: 25 }],
  ['claude-opus-4-6', { inputPerMTok: 5, outputPerMTok: 25 }],
  ['claude-sonnet-5', { inputPerMTok: 3, outputPerMTok: 15 }],
  ['claude-sonnet-4-6', { inputPerMTok: 3, outputPerMTok: 15 }],
  ['claude-haiku-4-5', { inputPerMTok: 1, outputPerMTok: 5 }],
];

/** List price for a run's model id; null = unknown (show "—", total is partial). */
export function priceFor(model: string | null): ModelPricing | null {
  if (model === null) return null;
  const id = model.toLowerCase();
  for (const [key, price] of CLAUDE_PRICES) {
    if (id.includes(key)) return price;
  }
  return null;
}

/** Estimated spend in USD for a token count at a model's list price; null when unpriced. */
export function estimateUsd(model: string | null, inputTokens: number, outputTokens: number): number | null {
  const price = priceFor(model);
  if (price === null) return null;
  return (inputTokens / 1_000_000) * price.inputPerMTok + (outputTokens / 1_000_000) * price.outputPerMTok;
}

/** Compact dollars for the dashboard card: cents under $100, whole dollars above. */
export function formatUsd(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01';
  if (n >= 100) return `$${Math.round(n).toLocaleString()}`;
  return `$${n.toFixed(2)}`;
}
