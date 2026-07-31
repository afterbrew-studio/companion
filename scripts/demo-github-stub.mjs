#!/usr/bin/env node
/**
 * A GitHub API stand-in for the demo instance the README screenshots are taken
 * from, pointed at with COMPANION_GITHUB_API_URL (the same knob GitHub
 * Enterprise uses):
 *
 *   node scripts/demo-github-stub.mjs
 *   COMPANION_HOME=/tmp/companion-demo/.companion \
 *     COMPANION_GITHUB_API_URL=http://127.0.0.1:8902 node apps/api/dist/index.js
 *
 * Why it exists: repository access is graded from what GitHub reports for the
 * resolving token, so a seeded row alone reads as "no access" and every
 * issue/PR view hides its contents. This answers the one question that gate
 * asks (what may this token do here) and returns empty feeds for everything
 * else, because sync only ever upserts and so leaves the seeded rows standing.
 *
 * It is a fixture, not a GitHub implementation: it grants whatever it is asked
 * about. Only ever point a throwaway instance at it.
 */

import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 8902);
const LOGIN = 'acme-bot';

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const json = (body) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const repo = pathname.match(/^\/repos\/([\w.-]+)\/([\w.-]+)$/);
  if (repo) {
    const [, owner, name] = repo;
    return json({
      id: hash(`${owner}/${name}`),
      name,
      full_name: `${owner}/${name}`,
      private: true,
      default_branch: 'main',
      owner: { login: owner, type: 'Organization' },
      permissions: { admin: false, maintain: true, push: true, triage: true, pull: true },
    });
  }

  // The feeds: empty, so a sync neither fails the repo nor overwrites the seed.
  if (/^\/repos\/[\w.-]+\/[\w.-]+\/(issues|pulls|commits|labels|milestones|hooks)$/.test(pathname)) return json([]);
  if (pathname === '/user') return json({ login: LOGIN, id: 1, type: 'User' });
  if (pathname === '/rate_limit') return json({ resources: {}, rate: { limit: 5000, remaining: 5000, reset: 0 } });

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ message: 'Not Found' }));
});

server.listen(PORT, '127.0.0.1', () => console.log(`demo GitHub stub on http://127.0.0.1:${PORT}`));

function hash(value) {
  let out = 0;
  for (const char of value) out = (out * 31 + char.charCodeAt(0)) % 1_000_000;
  return out;
}
