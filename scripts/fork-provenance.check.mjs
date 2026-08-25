#!/usr/bin/env node
// Prove the provenance check can fail.
//
// A check whose failing path has never run is an assumption. This exercises the
// two drifts that actually happen -- a re-pointed remote and a base commit that
// no longer matches the ledger -- against a throwaway clone, so the real working
// tree is never mutated to test it.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERIFY = join(ROOT, "scripts", "fork-provenance.mjs");

/** Exit code of the verifier against a given tree and ledger. */
function run(root, ledger) {
  try {
    execFileSync("node", [VERIFY], {
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, FORK_PROVENANCE_ROOT: root, FORK_PROVENANCE_LEDGER: ledger },
    });
    return 0;
  } catch (err) {
    return err.status ?? 1;
  }
}

const cases = [];
function check(name, actual, expected) {
  const ok = actual === expected;
  cases.push({ name, ok, actual, expected });
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name} (exit ${actual}, expected ${expected})`);
}

const tmp = mkdtempSync(join(tmpdir(), "fork-provenance-"));
try {
  // A throwaway clone with the same remotes and the same base tag.
  const clone = join(tmp, "clone");
  execFileSync("git", ["clone", "-q", "--no-local", ROOT, clone], { stdio: "pipe" });
  const ledgerText = readFileSync(join(ROOT, "fork", "ledger.json"), "utf8");
  const ledger = JSON.parse(ledgerText);
  execFileSync("git", ["-C", clone, "remote", "set-url", "origin", `git@github.com:${ledger.origin}.git`]);
  execFileSync("git", ["-C", clone, "remote", "add", "upstream", `https://github.com/${ledger.upstream}.git`]);
  mkdirSync(join(clone, "fork"), { recursive: true });

  const clean = join(tmp, "clean.json");
  writeFileSync(clean, ledgerText);
  check("a clean clone passes", run(clone, clean), 0);

  // An SSH alias is a legitimate way to address the same fork, so it must pass.
  execFileSync("git", ["-C", clone, "remote", "set-url", "origin", `git@github-personal:${ledger.origin}.git`]);
  check("an ssh-alias origin still passes", run(clone, clean), 0);

  // Drift 1: the remote is re-pointed at a different repository.
  execFileSync("git", ["-C", clone, "remote", "set-url", "origin", "git@github.com:someone-else/companion.git"]);
  check("a re-pointed origin fails", run(clone, clean), 1);
  execFileSync("git", ["-C", clone, "remote", "set-url", "origin", `git@github.com:${ledger.origin}.git`]);

  // Drift 2: the recorded base sha no longer matches what the tag names. This is
  // the quiet one -- the tag still resolves, so nothing else notices.
  const movedSha = join(tmp, "moved-sha.json");
  writeFileSync(
    movedSha,
    JSON.stringify({ ...ledger, base: { ...ledger.base, sha: "0".repeat(40) } }, null, 2),
  );
  check("a base sha that no longer matches the tag fails", run(clone, movedSha), 1);

  // Drift 3: the upstream remote is gone, so there is nothing to diverge from.
  execFileSync("git", ["-C", clone, "remote", "remove", "upstream"]);
  check("a missing upstream remote fails", run(clone, clean), 1);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = cases.filter((c) => !c.ok);
if (failed.length) {
  console.error(`\n${failed.length} of ${cases.length} provenance self-checks failed.`);
  process.exit(1);
}
console.log(`\nall ${cases.length} provenance self-checks passed`);
