import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { BoxliteRestOptions, JsBoxlite } from "../lib/index.js";

test("checkpoint native methods reject an unwrapped receiver", async () => {
  const runtime = JsBoxlite.rest(
    new BoxliteRestOptions({ url: "http://127.0.0.1:1" }),
  );
  const list = runtime.checkpoints.list;
  await expect(async () => await list.call({})).rejects.toThrow(
    "Illegal invocation",
  );
});

test("checkpoint native REST calls preserve configuration inheritance and result identity", async () => {
  const requests: Array<{ method?: string; path?: string; body?: unknown }> =
    [];
  const checkpoint = {
    id: "checkpoint-1",
    name: "base",
    source_box_id: "source-1",
    created_at: "2026-11-06T00:00:00Z",
    size_bytes: 4096,
    state: "ready",
  };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks).toString();
    requests.push({
      method: request.method,
      path: request.url,
      body: bytes ? JSON.parse(bytes) : undefined,
    });
    response.setHeader("Content-Type", "application/json");
    if (request.method === "DELETE") {
      response.writeHead(204).end();
      return;
    }
    const body = request.url?.startsWith("/v1/boxes")
      ? {
          box_id: "target-1",
          name: "worker",
          status: "stopped",
          image: "alpine:latest",
          cpus: 2,
          memory_mib: 512,
          created_at: checkpoint.created_at,
          updated_at: checkpoint.created_at,
        }
      : request.method === "GET" && request.url === "/v1/checkpoints"
        ? { checkpoints: [checkpoint] }
        : checkpoint;
    response.end(
      JSON.stringify(
        request.method === "GET" &&
          request.url === "/v1/checkpoints/checkpoint-1"
          ? {
              ...checkpoint,
              state: "failed",
              error_reason: "archive upload failed",
            }
          : body,
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const runtime = JsBoxlite.rest(new BoxliteRestOptions({ url }));
    const captured = await runtime.checkpoints.create("source-1", "base");
    expect(captured).toMatchObject({
      id: "checkpoint-1",
      sourceBoxId: "source-1",
      sizeBytes: 4096,
      state: "ready",
    });
    expect((await runtime.checkpoints.list())[0].id).toBe("checkpoint-1");
    expect(await runtime.checkpoints.get("checkpoint-1")).toMatchObject({
      name: "base",
      state: "failed",
      errorReason: "archive upload failed",
    });
    expect("importBox" in runtime.checkpoints).toBe(false);
    const target = await runtime.create(
      { checkpoint: "checkpoint-1" },
      "worker",
    );
    expect(target.id).toBe("target-1");
    await runtime.checkpoints.remove("checkpoint-1", true);
    await runtime.checkpoints.remove("checkpoint-1");
    await runtime.checkpoints.remove("checkpoint-1", false);
    await runtime.checkpoints.create("source-1");
    await runtime.create({ checkpoint: "checkpoint-1" });
    for (const overridden of [
      { checkpoint: "checkpoint-1", cpus: 2 },
      { checkpoint: "checkpoint-1", image: "alpine:latest" },
      { checkpoint: "checkpoint-1", rootfsPath: "/tmp/rootfs" },
    ]) {
      await expect(runtime.create(overridden)).rejects.toThrow();
    }
    expect(requests).toEqual([
      {
        method: "POST",
        path: "/v1/checkpoints",
        body: { source_box_id: "source-1", name: "base" },
      },
      { method: "GET", path: "/v1/checkpoints", body: undefined },
      { method: "GET", path: "/v1/checkpoints/checkpoint-1", body: undefined },
      {
        method: "POST",
        path: "/v1/boxes",
        body: { checkpoint_id: "checkpoint-1", name: "worker" },
      },
      {
        method: "DELETE",
        path: "/v1/checkpoints/checkpoint-1?force=true",
        body: undefined,
      },
      {
        method: "DELETE",
        path: "/v1/checkpoints/checkpoint-1",
        body: undefined,
      },
      {
        method: "DELETE",
        path: "/v1/checkpoints/checkpoint-1",
        body: undefined,
      },
      {
        method: "POST",
        path: "/v1/checkpoints",
        body: { source_box_id: "source-1" },
      },
      {
        method: "POST",
        path: "/v1/boxes",
        body: { checkpoint_id: "checkpoint-1" },
      },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
