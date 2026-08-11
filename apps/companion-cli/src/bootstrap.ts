import { assertSupportedNode } from './preflight.js';
import { COMPANION_VERSION } from './version.js';

const argv = process.argv.slice(2);

if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) {
  process.stdout.write(`${COMPANION_VERSION}\n`);
} else {
  try {
    assertSupportedNode();
    // Kept as a computed URL so the tiny preflight stays a separate file from
    // the Node 24 application bundle. Older Node releases must reach the clear
    // version error before they parse imports such as node:sqlite.
    await import(new URL('main.js', import.meta.url).href);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
