import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  JsBoxlite,
  BoxliteRestOptions,
  errorCode,
  type Boxlite,
} from "../lib/index.js";

const snapshot = {
  id: "snap-1",
  box_id: "source",
  name: "cozy-otter",
  status: "ready",
  created_at: 1,
  container_disk_bytes: 1024,
  size_bytes: 256,
};
const box = (box_id: string, status: string) => ({
  box_id,
  status,
  name: "generated-child",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  image: "base",
  cpus: 2,
  memory_mib: 512,
});
type Reply = { status: number; body?: unknown };
let server: Server;
let runtime: Boxlite;
let replies: Map<string, Reply>;
let requests: Array<{ route: string; body: string }>;

beforeEach(async () => {
  replies = new Map([
    [
      "GET /v1/config",
      {
        status: 200,
        body: {
          capabilities: {
            snapshots_enabled: true,
            create_from_snapshot_enabled: true,
          },
        },
      },
    ],
    ["GET /v1/boxes/source", { status: 200, body: box("source", "stopped") }],
    [
      "POST /v1/boxes/source/snapshots",
      { status: 201, body: { ...snapshot, status: "creating" } },
    ],
    [
      "GET /v1/boxes/source/snapshots/cozy-otter",
      { status: 200, body: snapshot },
    ],
    [
      "GET /v1/boxes/source/snapshots",
      { status: 200, body: { snapshots: [snapshot] } },
    ],
    ["GET /v1/snapshots", { status: 200, body: { snapshots: [snapshot] } }],
    ["GET /v1/snapshots/snap-1", { status: 200, body: snapshot }],
    [
      "POST /v1/snapshots/snap-1/boxes",
      { status: 201, body: box("child", "configured") },
    ],
    ["GET /v1/boxes/child", { status: 200, body: box("child", "running") }],
    [
      "POST /v1/boxes/source/snapshots/snap-1/restore",
      { status: 202, body: { id: "restore-1", status: "pending" } },
    ],
    [
      "GET /v1/boxes/source/restores/restore-1",
      { status: 200, body: { id: "restore-1", status: "succeeded" } },
    ],
    [
      "DELETE /v1/snapshots/protected",
      { status: 403, body: { message: "denied" } },
    ],
    ["DELETE /v1/snapshots/snap-1", { status: 204 }],
  ]);
  requests = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const route = `${req.method} ${req.url}`;
      requests.push({ route, body: Buffer.concat(chunks).toString() });
      const reply = replies.get(route) ?? {
        status: 404,
        body: { message: "missing" },
      };
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(
        reply.body === undefined ? undefined : JSON.stringify(reply.body),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  runtime = JsBoxlite.rest(
    new BoxliteRestOptions({
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    }),
  );
});

afterEach(async () => {
  runtime.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("snapshot scopes, generated names and startup cross the native binding", async () => {
  const source = (await runtime.get("source"))!;
  const snap = await source.snapshot.create();
  expect([snap.id, snap.name, snap.status, snap.boxId, snap.sizeBytes]).toEqual(
    ["snap-1", "cozy-otter", "ready", "source", 256],
  );
  replies.set("POST /v1/boxes/source/snapshots", {
    status: 201,
    body: { ...snapshot, name: "explicit" },
  });
  expect((await source.snapshot.create("explicit", {})).name).toBe("explicit");
  expect(
    requests
      .filter((r) => r.route === "POST /v1/boxes/source/snapshots")
      .map((r) => JSON.parse(r.body)),
  ).toEqual([{ name: "" }, { name: "explicit" }]);
  expect(await source.snapshot.list()).toHaveLength(1);
  expect(await source.snapshot.get("missing")).toBeNull();
  expect((await runtime.snapshots.get(snap.id)).status).toBe("ready");
  expect(await runtime.snapshots.list()).toHaveLength(1);
  await expect(runtime.snapshots.get("missing")).rejects.toThrow();
  const child = await runtime.createFromSnapshot(snap.id, { cpus: 2 });
  expect(child.id).toBe("child");
  await source.snapshot.restore(snap.id);
  await runtime.snapshots.remove("missing", true);
  await expect(runtime.snapshots.remove("protected", true)).rejects.toThrow();
  await runtime.snapshots.remove(snap.id);
  const creates = requests.filter(
    (r) => r.route === "POST /v1/snapshots/snap-1/boxes",
  );
  expect(creates).toHaveLength(1);
  const payload = JSON.parse(creates[0].body);
  expect(payload.options.cpus).toBe(2);
  expect(payload.options).not.toHaveProperty("image");
}, 15000);

test("snapshot creation rejects an explicit image and reports startup failure", async () => {
  await expect(
    runtime.createFromSnapshot("snap-1", { image: "alpine:latest" }),
  ).rejects.toThrow();
  expect(requests).toHaveLength(0);
  replies.set("GET /v1/boxes/child", {
    status: 200,
    body: box("child", "unknown"),
  });
  try {
    await runtime.createFromSnapshot("snap-1");
    throw new Error("creation unexpectedly succeeded");
  } catch (err) {
    expect(errorCode(err)).toBe("invalid_state");
    expect((err as Error).message).toContain("child");
  }
});
