#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const productManifest = 'apps/companion-cli/package.json';
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function manifestAt(revision) {
  const raw = git('show', `${revision}:${productManifest}`);
  const manifest = JSON.parse(raw);
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error(`${productManifest} at ${revision} has no package name or version`);
  }
  if (!semverPattern.test(manifest.version)) {
    throw new Error(`${manifest.version} is not a releaseable semantic version`);
  }
  return { name: manifest.name, version: manifest.version };
}

try {
  const requestedHead = argument('--head', 'HEAD');
  const head = git('rev-parse', '--verify', `${requestedHead}^{commit}`);
  const product = manifestAt(head);
  const manifestChanges = git(
    'rev-list',
    '--first-parent',
    head,
    '--',
    productManifest,
  )
    .split('\n')
    .filter(Boolean);

  // The publish workflow also runs on ordinary main pushes. Pin the tag to the
  // earliest first-parent commit carrying this product version, rather than to
  // whichever later commit happened to trigger an idempotent backfill.
  let target;
  for (const revision of manifestChanges) {
    const candidate = manifestAt(revision);
    if (candidate.version === product.version) {
      target = revision;
      continue;
    }
    if (target) break;
  }

  if (!target) {
    throw new Error(`could not locate the commit that introduced ${product.version}`);
  }

  console.log(`package=${product.name}`);
  console.log(`version=${product.version}`);
  console.log(`tag=v${product.version}`);
  console.log(`target=${target}`);
  console.log(`prerelease=${product.version.includes('-')}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`release-target: ${message}`);
  process.exitCode = 1;
}
