import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { expect, test } from "vitest";

const nativeDirectory = new URL("../native/", import.meta.url);
const nativeBuilt =
  existsSync(nativeDirectory) &&
  readdirSync(nativeDirectory).some((file) => file.endsWith(".node"));

test.skipIf(!nativeBuilt).each([undefined, null, {}])(
  "required headers reject %j before create",
  async (headers) => {
    const { JsBoxlite } = await import("../lib/index.js");
    const home = mkdtempSync("/tmp/boxlite-required-node-");
    const rootfs = mkdtempSync("/tmp/boxlite-required-rootfs-");
    const runtime = new JsBoxlite({ homeDir: home });
    try {
      await expect(async () =>
        runtime.create({
          rootfsPath: rootfs,
          secrets: [
            {
              name: "x",
              value: "token",
              hosts: ["api.test.com"],
              headers,
            } as any,
          ],
        }),
      ).rejects.toThrow(/headers/);
    } finally {
      runtime.close();
      rmSync(home, { recursive: true, force: true });
      rmSync(rootfs, { recursive: true, force: true });
    }
  },
);
