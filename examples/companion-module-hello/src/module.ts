import { defineManifest } from '@moxxy/companion-sdk';

/**
 * The metafile: pure data, imported eagerly at boot, so it must stay cheap.
 * `id` must equal `moxxy.id` in package.json, which must equal the directory
 * the module installs into under $COMPANION_HOME/modules.
 */
export default defineManifest({
  id: 'hello',
  title: 'Hello World',
  version: '0.1.0',
  permissions: ['hello:greet'],
  // Land as "Available" after `companion module add` + restart; the operator
  // adopts it with `companion module install hello`.
  autoInstall: false,
});
