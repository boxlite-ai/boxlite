import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test } from "vitest";
import { BoxliteRestOptions, JsBoxlite, errorCode } from "../lib/index.js";

test("resize crosses the native binding and REST transport", async () => {
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET" && request.url === "/v1/boxes/box1") {
      response.end(
        JSON.stringify({
          box_id: "box1",
          status: "running",
          image: "alpine",
          cpus: 1,
          memory_mib: 256,
          created_at: "2026-07-14T00:00:00Z",
          updated_at: "2026-07-14T00:00:00Z",
        }),
      );
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/boxes/box1/resize") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const target = JSON.parse(body);
    requests.push(target);
    if (target.cpus === 1) {
      response.writeHead(400).end(
        JSON.stringify({
          error: {
            message: "cannot shrink",
            type: "InvalidArgumentError",
            code: "invalid_argument",
          },
        }),
      );
      return;
    }
    response.end(
      JSON.stringify({
        cpus: 2,
        memory_mib: 512,
        max_cpus: 8,
        max_memory_mib: 4096,
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("no server address");
  const runtime = JsBoxlite.rest(
    new BoxliteRestOptions({ url: `http://127.0.0.1:${address.port}` }),
  );
  try {
    const box = await runtime.get("box1");
    if (!box) throw new Error("missing box");
    expect(await box.resize({ cpus: 2, memoryMib: 512 })).toEqual({
      cpus: 2,
      memoryMib: 512,
      maxCpus: 8,
      maxMemoryMib: 4096,
    });
    expect(requests).toEqual([{ cpus: 2, memory_mib: 512 }]);
    for (const invalid of [
      { cpus: 2.5 },
      { cpus: 4294967298 },
      { memoryMib: 512.5 },
      { memoryMib: 4294967808 },
      { memoryMib: Number.NaN },
    ]) {
      await expect(box.resize(invalid)).rejects.toThrow(/integer/);
    }
    expect(requests).toHaveLength(1);
    let failure: unknown;
    try {
      await box.resize({ cpus: 1 });
    } catch (error) {
      failure = error;
    }
    expect(errorCode(failure)).toBe("invalid_argument");
  } finally {
    runtime.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
