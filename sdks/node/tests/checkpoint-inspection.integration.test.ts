import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { JsBoxlite } from "../lib/index.js";

test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "checkpoint inspection preserves native 64-bit inode values",
  async () => {
    const runtime = JsBoxlite.withDefaultConfig();
    const directory = await mkdtemp("/tmp/boxlite-node-checkpoint-");
    const box = await runtime.create({
      image: "alpine:latest",
      cpus: 1,
      memoryMib: 256,
      diskSizeGb: 1,
      entrypoint: ["sleep"],
      cmd: ["300"],
      autoRemove: false,
    });
    try {
      await box.start();
      await box.pause();
      const pair = join(directory, "pair");
      await box.exportCheckpoint(pair);
      const inspected = JsBoxlite.inspectCheckpoint(pair);
      expect(inspected.shares.length).toBeGreaterThan(0);
      for (const share of inspected.shares) {
        const state = share.state as Record<string, unknown>;
        expect(state.next_synthetic_ino).toBe(1n << 63n);
      }
    } finally {
      try {
        await runtime.remove(box.id, true);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
  240_000,
);
