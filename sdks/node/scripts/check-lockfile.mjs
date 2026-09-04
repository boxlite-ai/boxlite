#!/usr/bin/env node
// Guards the two ways package-lock.json goes wrong in a commit: a stale lock,
// and the npm/<target> workspace entries the artifacts flow adds locally.
//
// CI installs the lock with `npm ci`, which resolves nothing on its own and
// refuses to run when the lock and package.json disagree — so either mistake
// is a red matrix leg, not a slow drift.
//
// `make lint:node` runs this; the pre-commit hook reaches that through
// `make lint:fix` and the lint workflow runs it directly. There is no
// "am I the entry point" guard on purpose: this file only ever runs as one, so
// it cannot silently exit 0 without checking. The classification it prints
// lives in ./lockfile-problems.mjs, which the unit tests import.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { findLockfileProblems } from "./lockfile-problems.mjs";

const SDK_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

const REMEDIES = {
  "missing-root": () => [
    "package-lock.json has no root entry — regenerate it with `npm install`.",
  ],
  "generated-workspaces": ({ entries }) => [
    `generated workspace entries are committed: ${entries.join(", ")}`,
    "`npm run artifacts` creates npm/<target>/, which the workspaces glob pulls",
    "into the tree, so a later `npm install` writes these in. They do not exist",
    "in a fresh checkout, where `npm ci` then fails. Drop just those entries —",
    "regenerate the lock from a tree with no sdks/node/npm/ directory.",
  ],
  "manifest-drift": ({ fields }) => [
    `package.json and package-lock.json disagree on: ${fields.join(", ")}`,
    "Regenerate the lock under Node 18 — the floor of engines.node, and the",
    "only resolution every CI leg can run (see sdks/node/CLAUDE.md):",
    "  cd sdks/node && npm install",
  ],
};

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    console.error("❌ Node SDK lockfile check failed.");
    console.error(`   cannot read ${path}: ${cause.message}`);
    process.exit(1);
  }
}

const problems = findLockfileProblems({
  manifest: readJson(join(SDK_DIR, "package.json")),
  lock: readJson(join(SDK_DIR, "package-lock.json")),
});

if (problems.length === 0) {
  console.log(
    "✅ package-lock.json matches package.json and carries no generated workspaces.",
  );
} else {
  console.error("❌ Node SDK lockfile check failed.");
  for (const problem of problems) {
    for (const line of REMEDIES[problem.kind](problem)) {
      console.error(`   ${line}`);
    }
  }
  process.exit(1);
}
