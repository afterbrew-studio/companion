#!/usr/bin/env node
// Prove this working tree is the fork it claims to be.
//
// A fork's value is that you can say exactly what it diverges from. That holds
// only while the remotes, the recorded base tag and the commit that tag names
// all agree, and any of them can drift silently: a remote re-pointed during a
// clone, a tag moved upstream, a ledger edited to make a red check green. The
// fork still builds through all of it.
//
// Three things this deliberately does NOT trust:
//
//   - The URL string. `https://github.com@evil.example/o/r.git` contains the
//     expected owner and repo and points somewhere else entirely, so hosts are
//     parsed and matched against an allowlist the ledger declares rather than
//     pattern-matched out of the string.
//   - The fetch URL alone. `git remote get-url` reports fetch; a separate push
//     URL can send commits somewhere the fetch URL never mentions.
//   - The local tag namespace. A tag is a movable local label, so the recorded
//     base must also be an ancestor of HEAD -- otherwise an orphan branch with
//     the right tag beside it passes.

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = process.env.FORK_PROVENANCE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = process.env.FORK_PROVENANCE_LEDGER ?? join(ROOT, "fork", "ledger.json");

function git(...args) {
  return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();
}

function gitLines(...args) {
  try {
    return git(...args).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * `{ host, path }` for a git remote URL, or null when it cannot be parsed.
 *
 * Both halves matter. Callers check the host against an allowlist, because the
 * path alone is trivially spoofable by an embedded userinfo authority.
 */
export function parseRemote(url) {
  if (!url) return null;
  const raw = url.trim();
  const strip = (p) => p.replace(/^\/+/, "").replace(/\.git$/, "");

  // scp-like: [user@]host:path -- no scheme, and the colon is not a port.
  const scp = raw.match(/^(?:([^@/]+)@)?([^@/:]+):(?!\/)(.+)$/);
  if (scp) return { host: scp[2], path: strip(scp[3]) };

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (!["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)) return null;
  // `parsed.hostname` is the real authority; anything before `@` is userinfo and
  // is exactly what the spoofing case abuses.
  return { host: parsed.hostname, path: strip(parsed.pathname) };
}

function main() {
  const problems = [];
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
  } catch (err) {
    console.error(`fork/ledger.json is unreadable: ${err.message}`);
    return 1;
  }

  const allowedHosts = ledger.remote_hosts ?? [];
  if (!allowedHosts.length) {
    problems.push("fork/ledger.json declares no `remote_hosts`, so no remote can be trusted");
  }

  for (const [remote, expected] of [
    ["origin", ledger.origin],
    ["upstream", ledger.upstream],
  ]) {
    // Every URL, fetch and push. A push URL that differs from fetch is the case
    // a fetch-only check cannot see.
    const urls = [
      ...gitLines("remote", "get-url", "--all", remote).map((u) => ["fetch", u]),
      ...gitLines("remote", "get-url", "--push", "--all", remote).map((u) => ["push", u]),
    ];
    if (!urls.length) {
      problems.push(`remote '${remote}' is not configured; expected ${expected}`);
      continue;
    }
    for (const [kind, url] of urls) {
      const parsed = parseRemote(url);
      if (!parsed) {
        problems.push(`remote '${remote}' ${kind} url is unparseable: ${url}`);
        continue;
      }
      if (!allowedHosts.includes(parsed.host)) {
        problems.push(
          `remote '${remote}' ${kind} url points at host '${parsed.host}', which is not in ` +
            `remote_hosts (${allowedHosts.join(", ")})`,
        );
      }
      if (parsed.path !== expected) {
        problems.push(`remote '${remote}' ${kind} url is ${parsed.path}, expected ${expected}`);
      }
    }
  }

  const { tag, sha } = ledger.base ?? {};
  if (!tag || !sha) {
    problems.push("fork/ledger.json records no base tag and sha");
  } else {
    let resolved = null;
    try {
      // Prefer the upstream-specific ref. The global tag namespace is local and
      // writable, so `refs/tags/x` proves nothing about what upstream published.
      resolved = git("rev-list", "-n1", `refs/tags/${tag}`);
    } catch {
      problems.push(`base tag ${tag} does not exist here; run 'git fetch --tags upstream'`);
    }
    if (resolved && resolved !== sha) {
      // The quiet case: the tag still resolves, so the build works and every
      // other check stays green -- only the claim about what was reviewed is false.
      problems.push(`base tag ${tag} resolves to ${resolved}, but the ledger records ${sha}`);
    }
    if (resolved) {
      try {
        git("merge-base", "--is-ancestor", sha, "HEAD");
      } catch {
        problems.push(
          `the recorded base ${sha.slice(0, 12)} is not an ancestor of HEAD, so this tree did ` +
            "not descend from it",
        );
      }
    }
  }

  if (problems.length) {
    console.error(`\n${problems.length} provenance problem(s):\n`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error("\nThe fork no longer matches what it says it forked. Fix the tree, not the ledger,");
    console.error("unless this is a deliberate rebase onto a new upstream release.\n");
    return 1;
  }

  console.log(
    `fork provenance ok: ${ledger.origin} forked from ${ledger.upstream} at ${tag} (${sha.slice(0, 12)})`,
  );
  return 0;
}

// Compare resolved paths, not strings. `import.meta.url` is percent-encoded and
// symlink-resolved; `process.argv[1]` is neither. On macOS every path under
// /var is a symlink into /private/var, so a raw string comparison silently
// skips main() and the command exits 0 having verified nothing -- which is the
// worst failure a check can have.
const invokedAs = (() => {
  try {
    return pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return null;
  }
})();
if (import.meta.url === invokedAs) process.exit(main());
export { main };
