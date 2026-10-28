import { describe, expect, test, vi } from "vitest";
import type { AgentHandle } from "../lib/agents.js";
import { SimpleBox } from "../lib/simplebox.js";

describe("agent namespace", () => {
  test("namespace calls reject without creating a Box", async () => {
    const create = vi.fn();
    const box = new SimpleBox({
      image: "alpine:latest",
      runtime: { create } as never,
    });
    const agents: AgentHandle = box.agents;
    await expect(
      agents.create("agent", { config: { model: "model" } }),
    ).rejects.toThrow("agents.create is not implemented");
    await expect(agents.get("session")).rejects.toThrow(
      "agents.get is not implemented",
    );
    expect(create).not.toHaveBeenCalled();
  });
});
