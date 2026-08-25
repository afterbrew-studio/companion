#!/usr/bin/env node
// Prove this working tree is the fork it claims to be.
//
// A fork's value is that you can say exactly what it diverges from. That only
// holds while three things agree: the remotes, the recorded base tag, and the
// commit that tag names. Any one of them can drift silently -- a remote
// re-pointed during a clone-and-rename, a tag moved upstream, a ledger edited to
// make a failing check pass -- and the fork still builds, still tests green, and
// no longer means anything.
//
// Remote URLs are compared as `owner/repo`, not as strings. The same fork is
// legitimately `git@github.com:o/r.git`, `https://github.com/o/r.git` or an SSH
// alias like `git@github-personal:o/r.git`, and a literal comparison would fail
// on a correct clone while a normalising one still catches a re-pointed remote.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.FORK_PROVENANCE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = process.env.FORK_PROVENANCE_LEDGER ?? join(ROOT, "fork", "ledger.json");

function git(...args) {
  return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();
}

/** `owner/repo` for any URL form GitHub accepts, or null when it is not one. */
export function normaliseRemote(url) {
  if (!url) return null;
  const m = url
    .trim()
    .replace(/\.git$/, "")
    .match(/^(?:https?:\/\/[^/]+\/|ssh:\/\/[^/]+\/|[^@]+@[^:]+:)(.+)$/);
  if (!m) return null;
  const path = m[1].replace(/^\/+/, "");
  return path.split("/").length === 2 ? path : null;
}

function remoteUrl(name) {
  try {
    return git("remote", "get-url", name);
  } catch {
    return null;
  }
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

  for (const [remote, expected] of [
    ["origin", ledger.origin],
    ["upstream", ledger.upstream],
  ]) {
    const url = remoteUrl(remote);
    if (url === null) {
      problems.push(`remote '${remote}' is not configured; expected ${expected}`);
      continue;
    }
    const actual = normaliseRemote(url);
    if (actual !== expected) {
      problems.push(`remote '${remote}' is ${actual ?? url}, expected ${expected}`);
    }
  }

  const { tag, sha } = ledger.base ?? {};
  if (!tag || !sha) {
    problems.push("fork/ledger.json records no base tag and sha");
  } else {
    let resolved = null;
    try {
      resolved = git("rev-list", "-n1", tag);
    } catch {
      problems.push(`base tag ${tag} does not exist here; fetch tags from upstream`);
    }
    if (resolved && resolved !== sha) {
      // The dangerous case: the tag still exists, so everything looks fine, but
      // it names a different commit than the one that was reviewed.
      problems.push(`base tag ${tag} resolves to ${resolved}, but the ledger records ${sha}`);
    }
  }

  if (problems.length) {
    console.error(`\n${problems.length} provenance problem(s):\n`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error("\nThe fork no longer matches what it says it forked. Fix the tree, not the ledger,");
    console.error("unless this is a deliberate rebase onto a new upstream release.\n");
    return 1;
  }

  console.log(`fork provenance ok: ${ledger.origin} forked from ${ledger.upstream} at ${tag} (${sha.slice(0, 12)})`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main());
export { main };
