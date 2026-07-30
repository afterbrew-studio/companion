# Brand

The Companion mark is an open arc with a dot standing in its gap: the arc is
work in progress, the dot is the companion that stays beside it. It is the
default identity only. Any instance can replace it by setting `branding.logo`,
and when it does, the mark disappears from the app chrome entirely.

## Files

| File | Use |
| --- | --- |
| `mark.svg` | The mark alone, `currentColor`. Inline use, docs, slides. |
| `mark-readme.svg`, `mark-readme-dark.svg` | The same mark with a literal colour, one per theme. An SVG loaded through `<img>` inherits no colour, so `currentColor` renders black there and disappears on a dark page; pair these in a `<picture>` with `prefers-color-scheme`, which GitHub honours. |
| `mark-tile.svg` | Knocked out of a zinc-950 tile. npm, app icon, anything on an unknown background or a renderer that drops `<picture>`. |
| `og.html` | Source of the 1200×630 link-preview card. It renders to `apps/web/public/og.png`; the header comment holds the command. |
| `ascii.mjs` | Rasterizes the mark to ASCII from the same geometry, for the CLI banner: `node docs/brand/ascii.mjs [cols]`. Paste the output into `apps/companion-cli/src/index.ts`; nothing rasterizes at runtime. |

In the app, import the components instead of the files:

```tsx
import { BrandMark, BrandTile } from '@moxxy/companion-ui';
```

The favicon is the same tile inlined as a data URI in `apps/web/index.html`;
`lib/auth.tsx` swaps in the instance logo over it once branding loads.

## Construction

Drawn on a 32 grid, the same family as the 24 grid every nav icon uses.

| | |
| --- | --- |
| Arc centre | `15.5, 16` (offset left so the mark plus dot is optically centred) |
| Radius | `10` |
| Stroke | `3.2`, round cap. 1.88× the nav-icon stroke, because the mark stands alone |
| Gap | `80°`, always facing east |
| Dot | `Ø 5.2` at `x 25.4`, 1.63× the stroke, so it reads as a peer and not as a period |
| Clear space | one dot diameter on every side |
| Lockup gap | `0.33` × mark height, measured off the drawn mark and not the SVG box, which carries 12% empty margin |
| Wordmark cap height | `0.70` × mark height |
| Minimum size | 20 px for the stroke mark, 16 px for the tile. Below 20 px always use the tile |

## Colour

Monochrome, always: zinc-950 on light, zinc-50 on dark, zinc-500 when muted.
No gradient, no brand hue, no shadow, and never rotated.

The exceptions live inside the product: the dot may take a status colour,
because colour here already means status and nothing else (emerald for an
active agent, amber for waiting on a person, red for a failed run), and the CLI
banner draws it in emerald for the same reason. Outside the product the dot is
always the stroke colour.

## Wordmark

Set in Geist Sans 600 at -3.5% tracking. The face has to be openly licensed and
self-hostable because Companion is deployed air-gapped; the UI itself stays on
`system-ui` and does not ship a webfont.
