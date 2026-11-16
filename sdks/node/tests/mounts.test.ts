import { existsSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test, vi } from "vitest";
import type { JsMountRequest, JsMountInfo, JsMountsHandle } from "../lib/index.js";
import type { JsBox } from "../lib/native-contracts.js";

// A consumer supplies the native boundary; unit mode never loads the extension.
describe("public mount contracts", () => {
  test("consumer can add, inspect, list and remove through the box namespace", async () => {
    const request: JsMountRequest = { source: "/host/project", target: "/workspace", readOnly: true };
    const info: JsMountInfo = { ...request, state: "mounted" };
    const mounts: JsMountsHandle = {
      add: vi.fn().mockResolvedValue(info),
      get: vi.fn().mockResolvedValue(info),
      list: vi.fn().mockResolvedValue([info]),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    const box: Pick<JsBox, "mounts"> = { mounts };
    expect(await box.mounts.add(request)).toEqual(info);
    expect(mounts.add).toHaveBeenCalledWith(request);
    expect(await box.mounts.get(request.target)).toEqual(info);
    expect(await box.mounts.list()).toEqual([info]);
    await box.mounts.remove(request.target);
    expect(mounts.remove).toHaveBeenCalledWith(request.target);
  });

  test("absence and backend errors retain their consumer meanings", async () => {
    const failure = new Error("native-vmm is required");
    const mounts: JsMountsHandle = {
      add: vi.fn().mockRejectedValue(failure),
      remove: vi.fn().mockRejectedValue(failure),
      list: vi.fn().mockRejectedValue(failure),
      get: vi.fn().mockResolvedValue(null),
    };
    expect(await mounts.get("/absent")).toBeNull();
    await expect(mounts.add({ source: "/host", target: "/guest", readOnly: false })).rejects.toBe(failure);
    await expect(mounts.remove("/guest")).rejects.toBe(failure);
    await expect(mounts.list()).rejects.toBe(failure);
  });
});

const nativeDirectory = new URL("../native/", import.meta.url);
const nativeBuilt = existsSync(nativeDirectory) && readdirSync(nativeDirectory).some((file) => file.endsWith(".node"));

describe.skipIf(!nativeBuilt)("mounts native consumer", () => {
  test("public box namespace forwards mount operations and preserves absent get", async () => {
    // The platform-specific native module is absent in extension-free CI;
    // importing it statically would fail before skipIf can select the suite.
    const { JsBoxlite, BoxliteRestOptions } = await import("../lib/index.js");
    const calls: string[] = [];
    const info = { source: "/host", target: "/a &b", read_only: true, state: "mounted" };
    const server = createServer(async (request, response) => {
      calls.push(`${request.method} ${request.url}`);
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/v1/boxes") {
        response.end(JSON.stringify({ box_id: "mount-test", name: null, status: "running", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z", pid: null, image: "alpine:latest", cpus: 1, memory_mib: 512 }));
      } else if (request.method === "POST") {
        expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ source: "/host", target: "/a &b", read_only: true });
        response.writeHead(201); response.end(JSON.stringify(info));
      } else if (request.method === "DELETE") {
        response.writeHead(204); response.end();
      } else if (request.url?.includes("by-target")) {
        response.writeHead(404); response.end(JSON.stringify({ error: { message: "absent", code: "not_found" } }));
      } else {
        response.end(JSON.stringify({ mounts: [info] }));
      }
    });
    // Node 18 is supported; Promise.withResolvers is unavailable there.
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const runtime = JsBoxlite.rest(new BoxliteRestOptions({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
      const box = await runtime.create({ image: "alpine:latest" });
      const added = await box.mounts.add({ source: "/host", target: "/a &b", readOnly: true });
      expect(added).toEqual({ source: "/host", target: "/a &b", readOnly: true, state: "mounted" });
      expect(await box.mounts.list()).toEqual([added]);
      expect(await box.mounts.get("/a &b")).toBeNull();
      await box.mounts.remove("/a &b");
      expect(calls.slice(1)).toEqual(["POST /v1/boxes/mount-test/mounts", "GET /v1/boxes/mount-test/mounts", "GET /v1/boxes/mount-test/mounts/by-target?target=%2Fa+%26b", "DELETE /v1/boxes/mount-test/mounts/by-target?target=%2Fa+%26b"]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
