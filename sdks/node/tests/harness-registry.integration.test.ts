import { isIP } from "node:net";
import { expect, test } from "vitest";
import { testRegistries } from "./test-registries.js";

// Every box built from a tag asks its registry for that tag again, so a host
// off this machine puts the internet into every box start.
test("harness registries stay on this machine", () => {
  for (const registry of testRegistries()) {
    const host = registry.host.replace(/:\d+$/, "");
    expect(
      isIP(host) === 4 && host.startsWith("127."),
      `${registry.host} is not an address on this machine`,
    ).toBe(true);
  }
});
