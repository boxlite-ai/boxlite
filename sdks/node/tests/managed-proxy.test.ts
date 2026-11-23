import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "vitest";
import {
  BoxliteRestOptions,
  JsBoxlite,
  getNativeModule,
} from "../lib/index.js";

let nativeAvailable = true;
try {
  getNativeModule();
} catch {
  nativeAvailable = false;
}

test.skipIf(!nativeAvailable)(
  "managed_proxy native create preserves admission and null",
  async () => {
    const writes: unknown[] = [];
    const server = createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET" && req.url === "/v1/config") {
        res.end(
          JSON.stringify({
            capabilities: { outbound_proxy_registry_enabled: true },
          }),
        );
      } else if (req.method === "POST" && req.url === "/v1/boxes") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        writes.push(body.network?.outbound?.proxy);
        res.writeHead(408).end(
          JSON.stringify({
            code: "outbound_create_admitted",
            boxId: "existing-box",
          }),
        );
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const runtime = JsBoxlite.rest(
      new BoxliteRestOptions({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      }),
    );
    try {
      const result = await runtime.createWithOutboundProxy(
        { image: "alpine" },
        null,
      );
      expect(result.box == null).toBe(true);
      expect(result.error).toMatchObject({
        admission: "admitted",
        boxId: "existing-box",
        httpStatus: 408,
      });
      expect(writes).toEqual([null]);
    } finally {
      runtime.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
