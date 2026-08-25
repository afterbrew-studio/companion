#!/usr/bin/env node
// Prove the provenance check can fail, on every drift it claims to catch.
//
// A check whose failing path has never run is an assumption. Each case below
// corresponds to one way a fork can stop being the thing it says it is, and the
// first version of this file covered only three of them -- which is how a
// verifier that accepted `https://github.com@evil.example/o/r.git` passed its
// own suite.
//
// Everything runs against a throwaway clone, so the real tree is never mutated
// to test it.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERIFY = join(ROOT, "scripts", "fork-provenance.mjs");

function run(root, ledger, script = VERIFY) {
  try {
    execFileSync("node", [script], {
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
  cases.push({ name, ok });
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${name} (exit ${actual}, expected ${expected})`);
}

const setUrl = (clone, url) =>
  execFileSync("git", ["-C", clone, "remote", "set-url", "origin", url]);

const tmp = mkdtempSync(join(tmpdir(), "fork-provenance-"));
try {
  const clone = join(tmp, "clone");
  execFileSync("git", ["clone", "-q", "--no-local", ROOT, clone], { stdio: "pipe" });
  const ledgerText = readFileSync(join(ROOT, "fork", "ledger.json"), "utf8");
  const ledger = JSON.parse(ledgerText);
  const OK = `git@github.com:${ledger.origin}.git`;
  setUrl(clone, OK);
  execFileSync("git", ["-C", clone, "remote", "add", "upstream", `https://github.com/${ledger.upstream}.git`]);
  mkdirSync(join(clone, "fork"), { recursive: true });

  const clean = join(tmp, "clean.json");
  writeFileSync(clean, ledgerText);
  check("a clean clone passes", run(clone, clean), 0);

  setUrl(clone, `git@github-personal:${ledger.origin}.git`);
  check("a declared ssh alias still passes", run(clone, clean), 0);

  // The authority spoof: expected owner/repo, entirely different host.
  setUrl(clone, `https://github.com@evil.example/${ledger.origin}.git`);
  check("a userinfo-spoofed http authority fails", run(clone, clean), 1);

  // An ssh host nobody declared.
  setUrl(clone, `git@gitlab.example:${ledger.origin}.git`);
  check("an undeclared ssh host fails", run(clone, clean), 1);

  setUrl(clone, "git@github.com:someone-else/companion.git");
  check("a re-pointed origin fails", run(clone, clean), 1);
  setUrl(clone, OK);

  // Fetch stays correct while push goes elsewhere.
  execFileSync("git", ["-C", clone, "remote", "set-url", "--push", "origin", "git@evil.example:x/y.git"]);
  check("a push url pointing elsewhere fails", run(clone, clean), 1);
  execFileSync("git", ["-C", clone, "remote", "set-url", "--push", "origin", OK]);

  const movedSha = join(tmp, "moved-sha.json");
  writeFileSync(movedSha, JSON.stringify({ ...ledger, base: { ...ledger.base, sha: "0".repeat(40) } }, null, 2));
  check("a base sha that no longer matches the tag fails", run(clone, movedSha), 1);

  const noHosts = join(tmp, "no-hosts.json");
  const { remote_hosts, ...withoutHosts } = ledger;
  writeFileSync(noHosts, JSON.stringify(withoutHosts, null, 2));
  check("a ledger declaring no remote_hosts fails", run(clone, noHosts), 1);

  // An orphan history that still carries the expected tag locally.
  const orphan = join(tmp, "orphan");
  execFileSync("git", ["clone", "-q", "--no-local", ROOT, orphan], { stdio: "pipe" });
  setUrl(orphan, OK);
  execFileSync("git", ["-C", orphan, "remote", "add", "upstream", `https://github.com/${ledger.upstream}.git`]);
  execFileSync("git", ["-C", orphan, "checkout", "-q", "--orphan", "counterfeit"]);
  execFileSync("git", ["-C", orphan, "commit", "-q", "--allow-empty", "-m", "counterfeit"]);
  mkdirSync(join(orphan, "fork"), { recursive: true });
  check("a tree with no ancestry from the recorded base fails", run(orphan, clean), 1);

  // The entry-point guard: a path containing a space must still run main().
  const spaced = join(tmp, "fork review");
  mkdirSync(spaced, { recursive: true });
  cpSync(join(ROOT, "scripts", "fork-provenance.mjs"), join(spaced, "fork-provenance.mjs"));
  setUrl(clone, "git@github.com:someone-else/companion.git");
  check(
    "the verifier still runs from a symlinked path containing a space",
    run(clone, clean, join(spaced, "fork-provenance.mjs")),
    1,
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const failed = cases.filter((c) => !c.ok);
if (failed.length) {
  console.error(`\n${failed.length} of ${cases.length} provenance self-checks failed.`);
  process.exit(1);
}
console.log(`\nall ${cases.length} provenance self-checks passed`);
