import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { wrapAgents, type NativeAgents } from "../lib/agents.js";

const directory = process.env.BOXLITE_AGENT_FIXTURE_DIR;

test.skipIf(!directory)(
  "agent numbers cross the native JavaScript boundary",
  async () => {
    const library =
      process.platform === "darwin"
        ? "libagent_record_fixture.dylib"
        : process.platform === "win32"
          ? "agent_record_fixture.dll"
          : "libagent_record_fixture.so";
    const addon = { exports: {} };
    process.dlopen(addon, join(directory!, library));
    const { seedAgent } = addon.exports as {
      seedAgent: (
        home: string,
        token: string,
      ) => ReturnType<NativeAgents["get"]>;
    };
    const home = mkdtempSync(join(tmpdir(), "boxlite-js-agent-"));
    try {
      for (const [index, token] of [
        "18446744073709551616",
        "1e-999",
        "0.125",
      ].entries()) {
        const agent = await seedAgent(join(home, String(index)), token);
        const namespace = wrapAgents({
          get: async () => agent,
          create: async () => agent,
        });
        const turn = await (await namespace.get("agent-1")).getTurn("turn-1");
        if (token === "0.125") {
          expect((await turn.wait()).data).toBe(0.125);
        } else {
          await expect(turn.wait()).rejects.toThrow(/numeric range/);
          expect(() => turn.state).toThrow(/numeric range/);
        }
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);
