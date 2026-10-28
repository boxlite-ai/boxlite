import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test, vi } from "vitest";
import type { Agents } from "../lib/agents.js";
import { BoxliteRestOptions, JsBoxlite } from "../lib/index.js";
import { getNativeModule } from "../lib/native.js";
import { SimpleBox } from "../lib/simplebox.js";

describe("agent namespace", () => {
  test("namespace calls reject without creating a Box", async () => {
    const create = vi.fn();
    const box = new SimpleBox({
      image: "alpine:latest",
      runtime: { create } as never,
    });
    const agents: Agents = box.agents;
    await expect(
      agents.create("agent", { config: { model: "model" } }),
    ).rejects.toThrow("agents.create is not implemented");
    await expect(agents.get("agent")).rejects.toThrow(
      "agents.get is not implemented",
    );
    expect(create).not.toHaveBeenCalled();
  });

  test("native Box exposes a namespace without sending agent requests", async () => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      if (request.method !== "GET" || request.url !== "/v1/boxes/agent-box") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          box_id: "agent-box",
          name: null,
          status: "running",
          created_at: "2026-07-14T00:00:00Z",
          updated_at: "2026-07-14T00:00:00Z",
          pid: 42,
          image: "alpine:latest",
          cpus: 1,
          memory_mib: 512,
          auto_resume: true,
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    const runtime = JsBoxlite.rest(
      new BoxliteRestOptions({ url: `http://127.0.0.1:${port}` }),
    );
    try {
      const box = await runtime.get("agent-box");
      expect(box).not.toBeNull();
      const agents = box!.agents;
      expect(agents).toBeInstanceOf(getNativeModule().Agents);
      await expect(agents.create("agent")).rejects.toThrow(
        "agents.create is not implemented",
      );
      await expect(agents.get("agent")).rejects.toThrow(
        "agents.get is not implemented",
      );
      expect(requests).toEqual(["GET /v1/boxes/agent-box"]);
    } finally {
      runtime.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test.each(["plain object", "prototype only"])(
    "native methods reject a %s receiver before entering the operation",
    async (kind) => {
      const agents = new (getNativeModule().Agents)();
      const receiver =
        kind === "plain object"
          ? {}
          : Object.create(Object.getPrototypeOf(agents));
      const error = await Promise.resolve()
        .then(() => Reflect.apply(agents.get, receiver, ["agent"]))
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(
        "agents.get is not implemented",
      );
    },
  );
});
