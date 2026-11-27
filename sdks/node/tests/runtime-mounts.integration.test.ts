import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { text } from "node:stream/consumers";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  BoxliteRestOptions,
  JsBoxlite,
  SimpleBox,
  errorCode,
  type Boxlite,
  type MountState,
} from "../lib/index.js";

const boxId = "runtime-mounts-box";
const target = "/workspace/a & b";
const collection = `/v1/boxes/${boxId}/mounts`;
const detail = `${collection}/by-target?target=%2Fworkspace%2Fa+%26+b`;
const start = `/v1/boxes/${boxId}/start`;
// Every state the wire answers; `configured` is saved for a stopped box's
// next start.
const states: MountState[] = [
  "configured",
  "preparing",
  "mounted",
  "detaching",
];
const boxInfo = {
  box_id: boxId,
  status: "running",
  image: "alpine:latest",
  cpus: 1,
  memory_mib: 256,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  privileged: false, // read back before a SimpleBox may reuse the box
};

type Reply = { status: number; body?: unknown };

// A loopback server answers the box API's mount routes, so what the test
// reads back, and what the server saw, crossed the REST client and the binding.
describe("runtime mounts on a REST runtime", () => {
  let server: Server;
  let replies: Map<string, Reply>;
  let requests: Array<{ route: string; body: string }>;
  let runtime: Boxlite;

  beforeEach(async () => {
    replies = new Map();
    requests = [];
    server = createServer(async (req, res) => {
      const route = `${req.method} ${req.url}`;
      requests.push({ route, body: await text(req) });
      const { status, body } = replies.get(route) ?? { status: 404, body: {} };
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    runtime = JsBoxlite.rest(
      new BoxliteRestOptions({ url: `http://127.0.0.1:${port}` }),
    );
  });

  afterEach(async () => {
    runtime.close();
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });

  test("runtime mounts share the Node and SimpleBox REST contract", async () => {
    const request = { source: "/host/project", target };
    const mount = { ...request, read_only: false, state: "mounted" };
    const config = { runtime_mounts_enabled: true };
    replies.set("GET /v1/config", {
      status: 200,
      body: { capabilities: config },
    });
    replies.set(`GET /v1/boxes/${boxId}`, { status: 200, body: boxInfo });
    replies.set(`POST ${collection}`, { status: 201, body: mount });
    replies.set(`GET ${collection}`, {
      status: 200,
      body: { mounts: [mount] },
    });
    replies.set(`GET ${detail}`, { status: 200, body: mount });
    replies.set(`DELETE ${detail}`, { status: 204 });

    const simple = new SimpleBox({
      image: "alpine:latest",
      runtime,
      name: boxId,
      reuseExisting: true,
    });
    expect(() => simple.mount).toThrow("Box has not been created");
    expect(await simple.getId()).toBe(boxId);
    const box = (await runtime.get(boxId))!;
    expect(await simple.mount.add(request)).toEqual({
      ...request,
      readOnly: false,
      state: "mounted",
    });
    const posted = requests.filter(
      ({ route }) => route === `POST ${collection}`,
    );
    expect(posted.map(({ body }) => JSON.parse(body))).toEqual([
      { ...request, read_only: false },
    ]);
    for (const expected of states) {
      mount.state = expected;
      expect((await box.mount.get(target))?.state).toBe(expected);
      expect(await simple.mount.list()).toEqual([
        { ...request, readOnly: false, state: expected },
      ]);
    }
    await simple.mount.remove(target);
    replies.set(`GET ${detail}`, { status: 200, body: null });
    replies.set(`GET ${collection}`, { status: 200, body: { mounts: [] } });
    replies.set(`DELETE ${detail}`, {
      status: 404,
      body: { error: { code: "not_found", message: "no mount" } },
    });
    expect(await box.mount.get(target)).toBeNull();
    expect(await box.mount.list()).toEqual([]);
    await expect(box.mount.remove(target).catch(errorCode)).resolves.toBe(
      "not_found",
    );
    config.runtime_mounts_enabled = false;
    await expect(box.mount.get(target).catch(errorCode)).resolves.toBe(
      "unsupported",
    );
    const routes = requests.map(({ route }) => route);
    expect(routes).toContain(`GET ${detail}`);
    expect(routes).toContain(`DELETE ${detail}`);
  });

  test("a stopped box saves a configured mount without starting", async () => {
    const request = { source: "/host/project", target };
    const saved = { ...request, read_only: false, state: "configured" };
    replies.set("GET /v1/config", {
      status: 200,
      body: { capabilities: { runtime_mounts_enabled: true } },
    });
    replies.set(`GET /v1/boxes/${boxId}`, {
      status: 200,
      body: { ...boxInfo, status: "stopped" },
    });
    replies.set(`POST ${collection}`, { status: 201, body: saved });
    replies.set(`GET ${collection}`, {
      status: 200,
      body: { mounts: [saved] },
    });
    replies.set(`GET ${detail}`, { status: 200, body: saved });
    replies.set(`DELETE ${detail}`, { status: 204 });

    const simple = new SimpleBox({
      image: "alpine:latest",
      runtime,
      name: boxId,
      reuseExisting: true,
    });
    expect(await simple.getId()).toBe(boxId);
    const box = (await runtime.get(boxId))!;
    const expected = { ...request, readOnly: false, state: "configured" };
    expect(await simple.mount.add(request)).toEqual(expected);
    expect(await box.mount.get(target)).toEqual(expected);
    expect(await simple.mount.list()).toEqual([expected]);
    await box.mount.remove(target);
    replies.set(`GET ${detail}`, { status: 200, body: null });
    replies.set(`GET ${collection}`, { status: 200, body: { mounts: [] } });
    expect(await box.mount.get(target)).toBeNull();
    expect(await simple.mount.list()).toEqual([]);
    expect(requests.map(({ route }) => route)).not.toContain(`POST ${start}`);
  });
});
