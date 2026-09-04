// Classifies what is wrong with a package.json / package-lock.json pair.
// Pure and filesystem-free so every branch is testable; check-lockfile.mjs is
// the CLI that reads the files and prints the remedies.

// Everything `npm install` copies from the manifest into the lock's root entry.
// A mismatch in any of them means the lock was not regenerated.
const MIRRORED_FIELDS = [
  "name",
  "version",
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "optionalDependencies",
];

// npm writes the lock's dependency maps in sorted key order regardless of how
// package.json orders them, so compare by value, not by serialization.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

function equalIgnoringKeyOrder(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * @param {{manifest: object, lock: object}} pair
 * @returns {Array<{kind: string, fields?: string[], entries?: string[]}>}
 */
export function findLockfileProblems({ manifest, lock }) {
  const root = lock?.packages?.[""];
  if (!root) return [{ kind: "missing-root" }];

  const problems = [];

  // `npm run artifacts` creates npm/<target>/, which `workspaces: ["npm/*"]`
  // pulls into the tree, so a later `npm install` writes them into the lock.
  // They do not exist in a fresh checkout, where `npm ci` then fails.
  const entries = Object.keys(lock.packages).filter((name) =>
    name.startsWith("npm/"),
  );
  if (entries.length > 0)
    problems.push({ kind: "generated-workspaces", entries });

  const fields = MIRRORED_FIELDS.filter(
    (field) => !equalIgnoringKeyOrder(manifest[field], root[field]),
  );
  if (fields.length > 0) problems.push({ kind: "manifest-drift", fields });

  return problems;
}
