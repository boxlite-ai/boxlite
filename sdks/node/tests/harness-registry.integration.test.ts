import { isIP } from "node:net";
import { expect, test } from "vitest";
import { testRegistries } from "./test-registries.js";

const upstream = process.env.BOXLITE_TEST_REGISTRIES === "upstream";

function onThisMachine(host: string) {
  const bare = host.replace(/:\d+$/, "");
  return isIP(bare) === 4 && bare.startsWith("127.");
}

// Every box built from a tag asks its registry for that tag again, so a host
// off this machine puts the internet into every box start.
test.skipIf(upstream)("harness registries stay on this machine", () => {
  for (const registry of testRegistries()) {
    expect(
      onThisMachine(registry.host),
      `${registry.host} is not an address on this machine`,
    ).toBe(true);
  }
});

// In upstream mode make runs the suite without the local registry, so the
// harness lists the public mirrors it used before.
test.runIf(upstream)("upstream mode lists the public mirrors", () => {
  expect(testRegistries().map((registry) => registry.host)).toEqual([
    "docker.m.daocloud.io",
    "docker.xuanyuan.me",
    "docker.1ms.run",
    "docker.io",
  ]);
});
