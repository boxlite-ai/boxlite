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

const LOGIN_ID = "0aaa0000-0000-4000-8000-000000000001";
const PASSWORD = "not-a-real-token";
const LOGIN = {
  id: LOGIN_ID,
  registry_host: "ghcr.io",
  repository_prefix: "acme/",
  username: "acme-bot",
  created_by: null,
  created_at: "2026-09-01T00:00:00Z",
};

async function failureOf(call: Promise<unknown>): Promise<Error> {
  try {
    await call;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to fail");
}

describe("registry logins on a local runtime", () => {
  test("the handle is unsupported and names the local option", async () => {
    const homeDir = mkdtempSync("/tmp/boxlite-test-node-registries-");
    const runtime = new JsBoxlite({ homeDir });
    try {
      let err: unknown;
      try {
        void runtime.registries;
      } catch (caught) {
        err = caught;
      }

      expect(errorCode(err)).toBe("unsupported");
      expect((err as Error).message).toContain("image_registries");
    } finally {
      await runtime.shutdown();
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

type Reply = { status: number; body?: unknown };

// A loopback server answers the box API's registry routes, so what the test
// reads back, and what the server saw, crossed the REST client and the binding.
describe("registry logins on a REST runtime", () => {
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

  test("list reads each login", async () => {
    replies.set("GET /v1/registries", {
      status: 200,
      body: { registries: [LOGIN] },
    });

    const logins = await runtime.registries.list();

    expect(logins).toEqual([
      {
        id: LOGIN_ID,
        registryHost: "ghcr.io",
        repositoryPrefix: "acme/",
        username: "acme-bot",
        createdAt: "2026-09-01T00:00:00+00:00",
      },
    ]);
    expect(logins[0]).not.toHaveProperty("createdBy");
  });

  test("create sends the login and hands back no password", async () => {
    // A broken server that echoed the password back.
    replies.set("POST /v1/registries", {
      status: 201,
      body: { ...LOGIN, password: PASSWORD },
    });

    const created = await runtime.registries.create({
      registryHost: "ghcr.io",
      repositoryPrefix: "acme/",
      username: "acme-bot",
      password: PASSWORD,
    });

    expect(JSON.parse(requests[0].body)).toEqual({
      registry_host: "ghcr.io",
      repository_prefix: "acme/",
      username: "acme-bot",
      password: PASSWORD,
    });
    expect(created.id).toBe(LOGIN_ID);
    expect(JSON.stringify(created)).not.toContain(PASSWORD);
  });

  test("a second login for a held prefix is already_exists", async () => {
    replies.set("POST /v1/registries", {
      status: 409,
      body: {
        message: "A credential for ghcr.io/ already exists",
        code: "already_exists",
      },
    });

    const err = await failureOf(
      runtime.registries.create({
        registryHost: "ghcr.io",
        username: "acme-bot",
        password: PASSWORD,
      }),
    );

    expect(errorCode(err)).toBe("already_exists");
    // Without a prefix, none is sent: the login covers the whole registry.
    expect(JSON.parse(requests[0].body)).not.toHaveProperty(
      "repository_prefix",
    );
  });

  test("remove deletes the login by id", async () => {
    replies.set(`DELETE /v1/registries/${LOGIN_ID}`, { status: 204 });

    await runtime.registries.remove(LOGIN_ID);

    expect(requests.map((request) => request.route)).toEqual([
      `DELETE /v1/registries/${LOGIN_ID}`,
    ]);
  });

  test("remove of a login in use is invalid_state naming the box", async () => {
    replies.set(`DELETE /v1/registries/${LOGIN_ID}`, {
      status: 409,
      body: {
        message: "cannot be removed while 1 box(es) pull through it: box-1",
      },
    });

    const err = await failureOf(runtime.registries.remove(LOGIN_ID));

    expect(errorCode(err)).toBe("invalid_state");
    expect(err.message).toContain("box-1");
  });

  test("remove refuses an id that is not a UUID without a request", async () => {
    const err = await failureOf(runtime.registries.remove("../images"));

    expect(errorCode(err)).toBe("invalid_argument");
    expect(requests).toEqual([]);
  });
});
