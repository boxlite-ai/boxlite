import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test } from "vitest";

const nativeDirectory = new URL("../native/", import.meta.url);
const nativeBuilt =
  existsSync(nativeDirectory) &&
  readdirSync(nativeDirectory).some((file) => file.endsWith(".node"));

describe.skipIf(!nativeBuilt)("secret headers native boundary", () => {
  test("secret headers survive the REST request", async () => {
    const { JsBoxlite, BoxliteRestOptions } = await import("../lib/index.js");
    const requests: Record<string, any>[] = [];
    const metadata: unknown[] = [];
    const server = createServer(async (request, response) => {
      metadata.push([
        request.method,
        request.url,
        request.headers["content-type"],
      ]);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          box_id: "secret-test",
          name: null,
          status: "configured",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
          pid: null,
          image: "alpine:latest",
          cpus: 1,
          memory_mib: 512,
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const runtime = JsBoxlite.rest(
      new BoxliteRestOptions({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      }),
    );
    const templates = { Authorization: "Bot {value}", "X-Key": "{value}" };
    try {
      for (const headers of [{ Authorization: "Bearer {value}" }, templates]) {
        const secret = {
          name: "bot",
          value: "token",
          hosts: ["api.example.com"],
          ...(headers === undefined ? {} : { headers }),
        };
        await runtime.create({ image: "alpine:latest", secrets: [secret] });
      }
      expect(requests).toHaveLength(2);
      expect(metadata).toEqual(
        Array(2).fill(["POST", "/v1/boxes", "application/json"]),
      );
      expect(requests[0].secrets[0].headers).toEqual({
        Authorization: "Bearer {value}",
      });
      expect(requests[1].secrets[0].headers).toEqual(templates);
      delete requests[0].secrets[0].headers;
      delete requests[1].secrets[0].headers;
      expect(requests[1]).toEqual(requests[0]);
    } finally {
      runtime.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test.each([{}, "", ["{value}"], { "Bad Header": "{value}" }])(
    "secret headers reject invalid input %j",
    async (headers) => {
      const { JsBoxlite } = await import("../lib/index.js");
      const home = mkdtempSync("/tmp/boxlite-headers-node-");
      const rootfs = mkdtempSync("/tmp/boxlite-headers-rootfs-");
      const runtime = new JsBoxlite({ homeDir: home });
      try {
        const secret = {
          name: "bad",
          value: "token",
          hosts: ["api.example.com"],
          headers,
        };
        await expect(async () => {
          await runtime.create({
            rootfsPath: rootfs,
            secrets: [secret as any],
          });
        }).rejects.toThrow(/header/i);
      } finally {
        runtime.close();
        rmSync(home, { recursive: true, force: true });
        rmSync(rootfs, { recursive: true, force: true });
      }
    },
  );
});
