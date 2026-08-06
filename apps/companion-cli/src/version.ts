import { readFileSync } from 'node:fs';

interface ProductManifest {
  readonly version?: unknown;
}

/** The published Companion package is the product version's single source. */
export const COMPANION_VERSION = readVersion(new URL('../package.json', import.meta.url));

function readVersion(manifest: URL): string {
  const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as ProductManifest;
  if (typeof parsed.version !== 'string' || parsed.version.trim() === '') {
    throw new Error(`Companion package manifest has no version: ${manifest.pathname}`);
  }
  return parsed.version;
}
