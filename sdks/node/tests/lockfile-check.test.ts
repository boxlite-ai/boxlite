import { describe, expect, it } from "vitest";

// @ts-expect-error - plain .mjs tooling script, no type declarations
import { findLockfileProblems } from "../scripts/lockfile-problems.mjs";

/** A manifest/lock pair that agrees, as `npm install` would leave it. */
function agreeingPair() {
  const manifest = {
    name: "@boxlite-ai/boxlite",
    version: "0.10.0",
    workspaces: ["npm/*"],
    devDependencies: { prettier: "^3.6.2", vitest: "^4.1.8" },
    peerDependencies: { "playwright-core": ">=1.58.0" },
    peerDependenciesMeta: { "playwright-core": { optional: true } },
  };
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": {
        name: manifest.name,
        version: manifest.version,
        license: "Apache-2.0",
        workspaces: manifest.workspaces,
        devDependencies: { ...manifest.devDependencies },
        peerDependencies: { ...manifest.peerDependencies },
        peerDependenciesMeta: { ...manifest.peerDependenciesMeta },
        engines: { node: ">=18.0.0" },
      },
      "node_modules/prettier": { version: "3.9.6" },
    },
  };
  return { manifest, lock };
}

describe("findLockfileProblems", () => {
  it("accepts a lock that mirrors the manifest", () => {
    expect(findLockfileProblems(agreeingPair())).toEqual([]);
  });

  it("accepts dependency maps whose keys are ordered differently", () => {
    // npm always writes the lock's maps sorted; package.json may not be. A
    // serialization-order comparison would reject a freshly generated lock.
    const { manifest, lock } = agreeingPair();
    manifest.devDependencies = { vitest: "^4.1.8", prettier: "^3.6.2" };

    expect(Object.keys(manifest.devDependencies)).not.toEqual(
      Object.keys(lock.packages[""].devDependencies),
    );
    expect(findLockfileProblems({ manifest, lock })).toEqual([]);
  });

  it("reports the field a stale lock disagrees on", () => {
    const { manifest, lock } = agreeingPair();
    manifest.devDependencies = {
      ...manifest.devDependencies,
      "left-pad": "^1.3.0",
    };

    expect(findLockfileProblems({ manifest, lock })).toEqual([
      { kind: "manifest-drift", fields: ["devDependencies"] },
    ]);
  });

  it("names generated npm/<target> workspace entries", () => {
    const { manifest, lock } = agreeingPair();
    lock.packages["npm/linux-x64-gnu"] = { version: "0.10.0" };
    lock.packages["npm/darwin-arm64"] = { version: "0.10.0" };

    expect(findLockfileProblems({ manifest, lock })).toEqual([
      {
        kind: "generated-workspaces",
        entries: ["npm/linux-x64-gnu", "npm/darwin-arm64"],
      },
    ]);
  });

  it("reports both problems when a lock is polluted and stale", () => {
    const { manifest, lock } = agreeingPair();
    lock.packages["npm/linux-x64-gnu"] = { version: "0.10.0" };
    manifest.version = "0.11.0";

    expect(findLockfileProblems({ manifest, lock }).map((p) => p.kind)).toEqual(
      ["generated-workspaces", "manifest-drift"],
    );
  });

  it("reports a lock with no root entry", () => {
    expect(
      findLockfileProblems({ manifest: {}, lock: { packages: {} } }),
    ).toEqual([{ kind: "missing-root" }]);
  });
});
