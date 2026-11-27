import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { JsBoxlite, BoxliteRestOptions, errorCode } from "../lib/index.js";

const boxId = "source-box";
const boxPath = `/v1/boxes/${boxId}`;
const exportPath = `${boxPath}/export`;
const archiveBytes = Buffer.from([0x00, 0xff, 0x42]);

describe("public box.export over REST", () => {
  test.each([
    ["rejects includeMemory before sending an HTTP request", true],
    ["downloads a disk-only archive when options are omitted", false],
  ])("%s", async (_name, includeMemory) => {
    const requests: unknown[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push([
        request.method,
        request.url,
        Buffer.concat(chunks).toString(),
      ]);

      if (request.method === "GET" && request.url === boxPath) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            box_id: boxId,
            name: null,
            status: "stopped",
            created_at: "2026-08-07T00:00:00Z",
            updated_at: "2026-08-07T00:00:00Z",
            pid: null,
            image: "alpine:latest",
            cpus: 1,
            memory_mib: 256,
          }),
        );
      } else if (request.method === "GET" && request.url === "/v1/config") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({ capabilities: { export_enabled: true } }),
        );
      } else if (request.method === "POST" && request.url === exportPath) {
        response.writeHead(200, { "Content-Type": "application/octet-stream" });
        response.end(archiveBytes);
      } else {
        response.writeHead(404).end();
      }
    });

    const directory = mkdtempSync(join(tmpdir(), "boxlite-export-rest-"));
    try {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const { port } = server.address() as AddressInfo;
      const runtime = JsBoxlite.rest(
        new BoxliteRestOptions({ url: `http://127.0.0.1:${port}` }),
      );
      try {
        const box = await runtime.get(boxId);
        expect(box).not.toBeNull();
        const dest = join(directory, "backup.boxlite");
        if (includeMemory) {
          await expect(
            box!.export(dest, { includeMemory: true }),
          ).rejects.toSatisfy(
            (err: unknown) => errorCode(err) === "unsupported",
          );
          expect(requests).toEqual([["GET", boxPath, ""]]);
          expect(existsSync(dest)).toBe(false);
        } else {
          await expect(box!.export(dest)).resolves.toBe(dest);
          expect(requests).toEqual([
            ["GET", boxPath, ""],
            ["GET", "/v1/config", ""],
            ["POST", exportPath, "{}"],
          ]);
          expect(readFileSync(dest)).toEqual(archiveBytes);
        }
      } finally {
        runtime.close();
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
