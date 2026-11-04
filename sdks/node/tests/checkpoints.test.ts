import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  ApiKeyCredential,
  BoxliteRestOptions,
  JsBoxlite,
  getNativeModule,
  errorCode,
  type Boxlite,
  type JsCheckpointInfo,
} from "../lib/index.js";

const prefix = "/base/v1/team";
const saved = {
  id: "checkpoint-1",
  box_id: "source",
  name: "before-upgrade",
  status: "ready",
  error: null,
  created_at: 1,
  cpus: 2,
  memory_bytes: 4096,
  container_disk_bytes: 8192,
  size_bytes: 16384,
};
const box = (box_id: string, status: string) => ({
  box_id,
  name: box_id,
  status,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  image: "base",
  cpus: 2,
  memory_mib: 512,
});
type Reply = { status: number; body?: unknown };
let server: Server;
let runtime: Boxlite;
let options: BoxliteRestOptions;
let replies: Map<string, Reply>;
let requests: Array<{ route: string; body: string; auth?: string }>;

beforeEach(async () => {
  replies = new Map([
    [
      "GET /base/v1/config",
      {
        status: 200,
        body: {
          capabilities: {
            checkpoints_enabled: true,
            checkpoint_management_enabled: true,
          },
        },
      },
    ],
    [
      `GET ${prefix}/boxes/source`,
      { status: 200, body: box("source", "paused") },
    ],
    [`POST ${prefix}/boxes/source/pause`, { status: 204 }],
    [`POST ${prefix}/boxes/source/resume`, { status: 204 }],
    [
      `POST ${prefix}/boxes/source/checkpoints`,
      { status: 201, body: { ...saved, status: "creating" } },
    ],
    [
      `GET ${prefix}/boxes/source/checkpoints/checkpoint-1`,
      { status: 200, body: saved },
    ],
    [
      `GET ${prefix}/boxes/source/checkpoints`,
      { status: 200, body: { checkpoints: [saved] } },
    ],
    [
      `GET ${prefix}/checkpoints`,
      { status: 200, body: { checkpoints: [saved] } },
    ],
    [`GET ${prefix}/checkpoints/checkpoint-1`, { status: 200, body: saved }],
    [
      `POST ${prefix}/checkpoints/checkpoint-1/boxes`,
      { status: 201, body: box("child", "restoring") },
    ],
    [
      `GET ${prefix}/boxes/child`,
      { status: 200, body: box("child", "paused") },
    ],
    [`DELETE ${prefix}/checkpoints/checkpoint-1`, { status: 204 }],
    [`DELETE ${prefix}/boxes/source/checkpoints/checkpoint-1`, { status: 204 }],
    [
      `DELETE ${prefix}/checkpoints/protected`,
      {
        status: 403,
        body: {
          error: {
            message: "denied",
            code: "permission_denied",
            error_type: "PermissionDeniedError",
          },
        },
      },
    ],
    [
      `POST ${prefix}/boxes/source/checkpoint/export`,
      { status: 200, body: Buffer.from("invalid checkpoint bytes") },
    ],
  ]);
  requests = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const route = `${req.method} ${req.url}`;
      requests.push({
        route,
        body: Buffer.concat(chunks).toString(),
        auth: req.headers.authorization,
      });
      const reply = replies.get(route) ?? {
        status: 404,
        body: {
          error: {
            message: "missing",
            code: "not_found",
            error_type: "NotFoundError",
          },
        },
      };
      res.writeHead(reply.status, {
        "Content-Type": Buffer.isBuffer(reply.body)
          ? "application/octet-stream"
          : "application/json",
      });
      res.end(
        Buffer.isBuffer(reply.body)
          ? reply.body
          : reply.body === undefined
            ? undefined
            : JSON.stringify(reply.body),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  options = new BoxliteRestOptions({
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/base`,
    pathPrefix: "team",
    credential: new ApiKeyCredential("checkpoint-test"),
  });
  runtime = JsBoxlite.rest(options);
});

afterEach(async () => {
  runtime.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("checkpoint native handle classes are exported", () => {
  const native = getNativeModule();
  expect(typeof native.JsCheckpointHandle).toBe("function");
  expect(typeof native.JsRuntimeCheckpointHandle).toBe("function");
  expect(typeof JsBoxlite.inspectCheckpoint).toBe("function");
});

test("checkpoint native catalog scopes, defaults and explicit Paused completion", async () => {
  const source = (await runtime.get("source"))!;
  await source.pause();
  await source.pause(null);
  await source.pause({ hostWritersStopped: false });
  await source.pause({ hostWritersStopped: true });
  await source.resume();
  const info: JsCheckpointInfo = await source.checkpoint.create();
  expect([
    info.id,
    info.status,
    info.boxId,
    info.cpus,
    info.memoryBytes,
    info.sizeBytes,
  ]).toEqual(["checkpoint-1", "ready", "source", 2, 4096, 16384]);
  replies.set(`POST ${prefix}/boxes/source/checkpoints`, {
    status: 201,
    body: saved,
  });
  await source.checkpoint.create(null);
  await source.checkpoint.create("before-upgrade");
  expect(await source.checkpoint.list()).toHaveLength(1);
  expect(await source.checkpoint.get("missing")).toBeNull();
  const catalog = runtime.checkpoints();
  expect(await catalog.list()).toHaveLength(1);
  expect((await catalog.get(info.id)).name).toBe(info.name);
  await expect(catalog.get("missing")).rejects.toThrow();
  for (const options of [undefined, null, {}, { name: "restored-child" }]) {
    const child = await runtime.createFromCheckpoint(info.id, options);
    expect([child.id, (await child.info()).state.status]).toEqual([
      "child",
      "paused",
    ]);
  }
  await source.checkpoint.remove(info.id);
  await catalog.remove("missing", true);
  await expect(catalog.remove("protected", true)).rejects.toThrow();
  await catalog.remove(info.id);
  const bodies = (route: string) =>
    requests
      .filter((request) => request.route === route)
      .map((request) => JSON.parse(request.body));
  expect(bodies(`POST ${prefix}/boxes/source/checkpoints`)).toEqual([
    {},
    {},
    { name: "before-upgrade" },
  ]);
  expect(bodies(`POST ${prefix}/checkpoints/checkpoint-1/boxes`)).toEqual([
    {},
    {},
    {},
    { name: "restored-child" },
  ]);
  expect(bodies(`POST ${prefix}/boxes/source/pause`)).toEqual([
    { host_writers_stopped: false },
    { host_writers_stopped: false },
    { host_writers_stopped: false },
    { host_writers_stopped: true },
  ]);
  expect(
    requests.every((request) => request.auth === "Bearer checkpoint-test"),
  ).toBe(true);
}, 15000);

test("checkpoint Running restore is rejected without resubmission", async () => {
  replies.set(`POST ${prefix}/checkpoints/checkpoint-1/boxes`, {
    status: 201,
    body: box("child", "running"),
  });
  try {
    await runtime.createFromCheckpoint("checkpoint-1");
    throw new Error("unexpected restore success");
  } catch (error) {
    expect(errorCode(error)).toBe("invalid_state");
    expect((error as Error).message).toContain("child");
  }
  expect(
    requests.filter((request) => request.route.startsWith("POST")),
  ).toHaveLength(1);
});

test("checkpoint failed capture preserves the error without resubmission", async () => {
  replies.set(`GET ${prefix}/boxes/source/checkpoints/checkpoint-1`, {
    status: 200,
    body: { ...saved, status: "failed", error: "capture storage failed" },
  });
  const source = (await runtime.get("source"))!;
  try {
    await source.checkpoint.create();
    throw new Error("unexpected capture success");
  } catch (error) {
    expect(errorCode(error)).toBe("invalid_state");
    expect((error as Error).message).toContain("checkpoint-1");
    expect((error as Error).message).toContain("capture storage failed");
  }
  expect(
    requests.filter((request) => request.route.startsWith("POST")),
  ).toHaveLength(1);
});

test("checkpoint old capability rejects submissions before HTTP mutation", async () => {
  replies.set("GET /base/v1/config", {
    status: 200,
    body: { capabilities: {} },
  });
  for (const action of [
    () => runtime.checkpoints().list(),
    () => runtime.importCheckpoint("caller-only", { name: "restored" }),
  ]) {
    try {
      await action();
      throw new Error("unexpected capability success");
    } catch (error) {
      expect(errorCode(error)).toBe("unsupported");
    }
  }
  expect(requests.some((request) => request.route.startsWith("POST"))).toBe(
    false,
  );
});

test("checkpoint pair paths remain caller-local and failed export is unpublished", async () => {
  const directory = await mkdtemp(join(tmpdir(), "boxlite-node-checkpoint-"));
  try {
    const missing = join(directory, "caller-only");
    await expect(
      runtime.importCheckpoint(missing, { name: "restored" }),
    ).rejects.toThrow();
    expect(() => JsBoxlite.inspectCheckpoint(missing)).toThrow();
    expect(
      requests.some((request) => request.route.includes("/checkpoint/import")),
    ).toBe(false);
    const source = (await runtime.get("source"))!;
    const destination = join(directory, "exported");
    await expect(source.exportCheckpoint(destination)).rejects.toThrow();
    await expect(access(destination)).rejects.toThrow();
    expect(
      requests
        .filter((request) => request.route.startsWith("POST"))
        .map((request) => request.route),
    ).toEqual([`POST ${prefix}/boxes/source/checkpoint/export`]);
    expect(requests.every((request) => !request.body.includes(directory))).toBe(
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkpoint metadata preserves safe JavaScript integers", async () => {
  replies.set(`GET ${prefix}/checkpoints/checkpoint-1`, {
    status: 200,
    body: { ...saved, size_bytes: Number.MAX_SAFE_INTEGER },
  });
  expect((await runtime.checkpoints().get("checkpoint-1")).sizeBytes).toBe(
    Number.MAX_SAFE_INTEGER,
  );
});

test.each([
  ["size_bytes", Number.MAX_SAFE_INTEGER + 1],
  ["memory_bytes", Number.MAX_SAFE_INTEGER + 1],
  ["container_disk_bytes", Number.MAX_SAFE_INTEGER + 1],
  ["created_at", Number.MAX_SAFE_INTEGER + 1],
  ["created_at", -Number.MAX_SAFE_INTEGER - 1],
])("checkpoint metadata refuses unsafe %s (%s)", async (field, value) => {
  replies.set(`GET ${prefix}/checkpoints/checkpoint-1`, {
    status: 200,
    body: { ...saved, [field]: value },
  });
  try {
    await runtime.checkpoints().get("checkpoint-1");
    throw new Error("unexpected lossy conversion");
  } catch (error) {
    expect(errorCode(error)).toBe("invalid_argument");
    expect((error as Error).message).toContain("safe integer");
  }
});
