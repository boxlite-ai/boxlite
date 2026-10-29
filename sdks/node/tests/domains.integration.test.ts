import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  JsBoxlite,
  BoxliteRestOptions,
  errorCode,
  type Boxlite,
} from "../lib/index.js";

const BOUND = {
  hostname: "demo1.app.test",
  url: "https://demo1.app.test",
  target: { type: "box", box: "AbCdEf123456", port: 3000 },
};

describe("domains on a local runtime", () => {
  test("the handle is unsupported", async () => {
    const homeDir = mkdtempSync("/tmp/boxlite-test-node-domains-");
    const runtime = new JsBoxlite({ homeDir });
    try {
      let err: unknown;
      try {
        void runtime.domains;
      } catch (caught) {
        err = caught;
      }
      expect(errorCode(err)).toBe("unsupported");
    } finally {
      await runtime.shutdown();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

type Reply = { status: number; body?: unknown };

// A loopback server answers the box API's domain routes, so what the test
// reads back, and what the server saw, crossed the REST client and the binding.
describe("domains on a REST runtime", () => {
  let server: Server;
  let replies: Map<string, Reply>;
  let requests: Array<{ route: string; body: string }>;
  let runtime: Boxlite;

  beforeEach(async () => {
    replies = new Map();
    requests = [];
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const route = `${req.method} ${req.url}`;
        requests.push({ route, body: Buffer.concat(chunks).toString() });
        const reply = replies.get(route) ?? {
          status: 404,
          body: { message: "no route" },
        };
        if (reply.body === undefined) {
          res.writeHead(reply.status).end();
          return;
        }
        res.writeHead(reply.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    runtime = JsBoxlite.rest(
      new BoxliteRestOptions({ url: `http://127.0.0.1:${port}` }),
    );
  });

  afterEach(async () => {
    runtime.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("bind puts the target and reads the bound domain", async () => {
    replies.set("PUT /v1/domains/demo1/target", { status: 200, body: BOUND });

    const bound = await runtime.domains.bind("demo1", {
      type: "box",
      box: "web-a",
      port: 3000,
    });

    expect(JSON.parse(requests[0].body)).toEqual({
      type: "box",
      box: "web-a",
      port: 3000,
    });
    expect(bound).toEqual(BOUND);
    replies.set("PUT /v1/domains/shop1/target", {
      status: 200,
      body: {
        ...BOUND,
        hostname: "shop1.app.test",
        url: "https://shop1.app.test",
        target: { type: "app", app: "shop" },
      },
    });
    const app = await runtime.domains.bind("shop1", {
      type: "app",
      app: "shop",
    });
    expect(JSON.parse(requests[1].body)).toEqual({ type: "app", app: "shop" });
    expect(app.target).toEqual({ type: "app", app: "shop" });
  });

  test("list reads unbound domains and the allowance", async () => {
    replies.set("GET /v1/domains", {
      status: 200,
      body: {
        domains: [
          BOUND,
          {
            ...BOUND,
            hostname: "spare.app.test",
            url: "https://spare.app.test",
            target: null,
          },
          {
            ...BOUND,
            hostname: "shop.app.test",
            url: "https://shop.app.test",
            target: { type: "app", app: "shop" },
          },
        ],
        limit: 3,
        used: 3,
        remaining: 0,
        min_length: 5,
      },
    });

    const held = await runtime.domains.list();

    expect(held.domains.map((domain) => domain.hostname)).toEqual([
      "demo1.app.test",
      "spare.app.test",
      "shop.app.test",
    ]);
    expect(held.domains[1].target ?? null).toBeNull();
    expect(held.minLength).toBe(5);
    expect(held.domains[0]).not.toHaveProperty("name");
    expect(held.domains[2].target).toEqual({ type: "app", app: "shop" });
  });

  test("unbind deletes the target", async () => {
    replies.set("DELETE /v1/domains/demo1.app.test/target", { status: 204 });

    await expect(runtime.domains.unbind("demo1")).rejects.toThrow(
      "full hostname",
    );
    expect(requests).toEqual([]);
    await runtime.domains.unbind("demo1.app.test");

    expect(requests.map((request) => request.route)).toEqual([
      "DELETE /v1/domains/demo1.app.test/target",
    ]);
  });
});
