import { readFileSync } from 'node:fs';

interface ProductManifest {
  readonly version?: unknown;
}

/**
 * Read the product version from the package people actually install.
 *
 * The first location covers source and the standalone API build. The second
 * covers the bundled npm package and Docker image, where server.js sits beside
 * the runtime package.json. Both manifests are generated from
 * apps/companion-cli/package.json, so there is still one source of truth.
 */
export const COMPANION_VERSION = readFirstVersion([
  new URL('../../companion-cli/package.json', import.meta.url),
  new URL('../package.json', import.meta.url),
]);

function readFirstVersion(manifests: readonly URL[]): string {
  for (const manifest of manifests) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as ProductManifest;
      if (typeof parsed.version === 'string' && parsed.version.trim() !== '') return parsed.version;
    } catch {
      // Delivery layouts differ; the next candidate is the same product manifest.
    }
  }
  throw new Error('Cannot read the Companion version from the product package.json');
}
