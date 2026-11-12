import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import { JsBoxlite, BoxliteRestOptions } from "../lib/index.js";

test("memory preserves MiB and rejects lossy numbers before sending", async () => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    requests.push(body);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        box_id: "memory",
        status: "configured",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        image: "alpine",
        cpus: 1,
        memory_mib: body.memory_mib ?? 1024,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const runtime = JsBoxlite.rest(
    new BoxliteRestOptions({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    }),
  );
  try {
    for (const memoryMib of [undefined, 256, 257, 513, 768, 1536, 4294967295]) {
      await runtime.create({ image: "alpine", memoryMib });
      expect(requests.at(-1)?.memory_mib).toBe(memoryMib);
    }
    const count = requests.length;
    for (const memoryMib of [256.5, 4294967296, NaN, Infinity, 0, -1, 255]) {
      await expect(
        runtime.create({ image: "alpine", memoryMib }),
      ).rejects.toThrow(/memoryMib|memory_mib/);
    }
    expect(requests).toHaveLength(count);
  } finally {
    runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
