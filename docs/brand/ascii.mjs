/**
 * Rasterize the Companion mark to ASCII straight from its geometry, so the arc
 * is a real arc at any size instead of a hand-drawn approximation. The output
 * is pasted into the CLI as a constant; nothing rasterizes at runtime.
 *
 *   node docs/brand/ascii.mjs [cols] [ramp]
 *
 * Same numbers as mark.svg, in the 32-unit space: arc centred at (15.5, 16)
 * with R 10 and a 3.2 stroke, an 80° gap facing east with round caps, and the
 * dot at (25.4, 16) with r 2.6. The dot is emitted in emerald, the one colour
 * the mark is allowed to carry, because in this product green already means AI.
 */

const CX = 15.5;
const CY = 16;
const R = 10;
const HALF = 1.6; // half of the 3.2 stroke
const GAP = 40; // half of the 80° opening
const RAD = Math.PI / 180;
const CAPS = [
  [CX + R * Math.cos(GAP * RAD), CY - R * Math.sin(GAP * RAD)],
  [CX + R * Math.cos(GAP * RAD), CY + R * Math.sin(GAP * RAD)],
];
const DOT = [25.4, 16, 2.6];

const GREEN = '\x1b[38;5;42m';
const RESET = '\x1b[0m';

function inDot(x, y) {
  return Math.hypot(x - DOT[0], y - DOT[1]) <= DOT[2];
}

/** The arc body plus its two round caps; the dot is tracked separately. */
function inArc(x, y) {
  for (const [capX, capY] of CAPS) if (Math.hypot(x - capX, y - capY) <= HALF) return true;
  const r = Math.hypot(x - CX, y - CY);
  if (r < R - HALF || r > R + HALF) return false;
  return Math.abs(Math.atan2(-(y - CY), x - CX) / RAD) > GAP;
}

/**
 * @param cols grid width. Rows come out at half of it, because a terminal cell
 *             is about twice as tall as it is wide and the mark must stay round.
 * @param ramp coverage characters, lightest first.
 */
export function render(cols, ramp = ' ..::##') {
  const rows = Math.round(cols / 2);
  const SS = 4; // supersamples per axis, for anti-aliased edges
  const lines = [];
  for (let r = 0; r < rows; r += 1) {
    let line = '';
    let colored = false;
    for (let c = 0; c < cols; c += 1) {
      let arc = 0;
      let dot = 0;
      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = (32 * (c + (sx + 0.5) / SS)) / cols;
          const y = (32 * (r + (sy + 0.5) / SS)) / rows;
          if (inDot(x, y)) dot += 1;
          else if (inArc(x, y)) arc += 1;
        }
      }
      // One colour per cell, so a cell touching both belongs to whichever
      // covers it more. Arc and dot never meet, so this only decides edges.
      const isDot = dot > arc;
      if (isDot !== colored) {
        line += isDot ? GREEN : RESET;
        colored = isDot;
      }
      line += ramp[Math.min(ramp.length - 1, Math.round(((dot + arc) / (SS * SS)) * (ramp.length - 1)))];
    }
    if (colored) line += RESET;
    lines.push(line.replace(/\s+$/, ''));
  }
  return lines.filter((line) => line.trim()).join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(`${render(Number(process.argv[2] ?? 40), process.argv[3] ?? ' ..::##')}\n`);
}
