import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test, vi } from "vitest";
import type { Agents } from "../lib/agents.js";
import { BoxliteRestOptions, JsBoxlite } from "../lib/index.js";
import { getNativeModule } from "../lib/native.js";
import { SimpleBox } from "../lib/simplebox.js";

describe("agent namespace", () => {
  test("SimpleBox lazily creates a Box when an agent is requested", async () => {
    const get = vi.fn().mockRejectedValue(new Error("core lookup failed"));
    const create = vi.fn().mockResolvedValue({ agents: { get } });
    const box = new SimpleBox({
      image: "alpine:latest",
      runtime: { create } as never,
    });
    const agents: Agents = box.agents;
    expect(create).not.toHaveBeenCalled();
    await expect(agents.get("agent")).rejects.toThrow("core lookup failed");
    expect(create).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith("agent");
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
        "supported: opencode",
      );
      await expect(agents.get("agent")).rejects.toThrow(
        "agents require a local runtime",
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
