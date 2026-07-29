#!/usr/bin/env node
/**
 * Scaffold a Companion module package under `modules/<id>/` with the standard
 * three-entry layout (`/manifest` + `/contract` + `/api` + `/client`), the
 * dual tsconfig (NodeNext emit for the daemon; bundler+source typecheck for
 * Vite), and empty `define*` barrels. Fill in `api/` and `client/` afterwards.
 *
 *   node scripts/create-module.mjs <id> --title "Code" [--required] [--deps a,b,c]
 *
 * Remember to add one registry line to apps/api/src/modules.ts and
 * apps/web/src/modules.ts (the two hand-maintained loaders).
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const id = args[0];
if (!id || id.startsWith('--')) {
  console.error('usage: create-module <id> --title "Title" [--required] [--deps a,b,c]');
  process.exit(1);
}
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : undefined;
};
const title = opt('title') ?? id[0].toUpperCase() + id.slice(1);
const required = args.includes('--required');
const deps = (opt('deps') ?? '').split(',').filter(Boolean);

const dir = join(root, 'modules', id);
if (existsSync(dir)) {
  console.error(`modules/${id} already exists`);
  process.exit(1);
}

const write = (rel, content) => {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content.endsWith('\n') ? content : content + '\n');
};

write(
  'package.json',
  JSON.stringify(
    {
      name: `@companion/module-${id}`,
      private: true,
      version: '0.1.0',
      type: 'module',
      exports: {
        './manifest': { types: './dist/module.d.ts', default: './dist/module.js' },
        './contract': {
          source: './src/contract/index.ts',
          types: './dist/contract/index.d.ts',
          default: './dist/contract/index.js',
        },
        './api': { types: './dist/api/index.d.ts', default: './dist/api/index.js' },
        './client': { source: './src/client/index.tsx' },
      },
      scripts: {
        build: 'tsc -p tsconfig.build.json',
        dev: 'tsc -p tsconfig.build.json --watch --preserveWatchOutput',
        typecheck: 'tsc -p tsconfig.json',
      },
      dependencies: {
        '@moxxy/companion-contracts': 'workspace:*',
        '@moxxy/companion-core': 'workspace:*',
        '@moxxy/companion-services': 'workspace:*',
        '@moxxy/companion-types': 'workspace:*',
        zod: '^3.24.0',
      },
      devDependencies: {
        '@types/node': '^22.10.0',
        '@types/react': '^18.3.12',
        react: '^18.3.1',
        typescript: '^5.8.0',
      },
    },
    null,
    2,
  ),
);

write(
  'tsconfig.build.json',
  JSON.stringify(
    {
      extends: '../../tsconfig.base.json',
      compilerOptions: { outDir: 'dist', rootDir: 'src', lib: ['ES2022'], types: ['node'] },
      include: ['src/module.ts', 'src/contract', 'src/api'],
      exclude: ['src/client'],
    },
    null,
    2,
  ),
);

write(
  'tsconfig.json',
  JSON.stringify(
    {
      extends: '../../tsconfig.base.json',
      compilerOptions: {
        noEmit: true,
        module: 'ESNext',
        moduleResolution: 'bundler',
        customConditions: ['source'],
        jsx: 'react-jsx',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        types: ['node'],
      },
      include: ['src'],
    },
    null,
    2,
  ),
);

const manifestFields = [
  `  id: '${id}',`,
  `  title: '${title}',`,
  `  version: '0.1.0',`,
  ...(required ? ['  required: true,'] : []),
  ...(deps.length ? [`  dependsOn: [${deps.map((d) => `'${d}'`).join(', ')}],`] : []),
];
write(
  'src/module.ts',
  `import { defineManifest } from '@moxxy/companion-core';\n\nexport default defineManifest({\n${manifestFields.join('\n')}\n});\n`,
);

write('src/contract/index.ts', `// module-${id} contract slice: DTOs + \`declare module '@moxxy/companion-contracts'\` augmentations.\nexport {};\n`);

write(
  'src/api/index.ts',
  `import { defineApiModule } from '@moxxy/companion-core/server';\nimport manifest from '../module.js';\n\nexport default defineApiModule({\n  manifest,\n});\n`,
);

write(
  'src/client/index.tsx',
  `import { defineClientModule } from '@moxxy/companion-core/client';\nimport manifest from '../module.js';\n\nexport default defineClientModule({\n  manifest,\n});\n`,
);

console.log(`created modules/${id} (@companion/module-${id})`);
