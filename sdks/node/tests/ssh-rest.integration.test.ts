/**
 * Integration tests for guest SSH control over a REST transport.
 *
 * No VM is needed: a loopback server answers the box read and the SSH routes,
 * so the native binding, the REST client, and `SimpleBox.ssh` all run for
 * real and only the far end is scripted. Mirrors the transport boundary in
 * `src/cli/src/commands/serve/tests/ssh.rs`: what crosses the wire, backend
 * failures kept as themselves, and — the reason this file exists — a malformed
 * configuration rejected at the binding boundary with one fixed message that
 * never echoes the rejected value, before any request is sent.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { JsBoxlite, BoxliteRestOptions, type Boxlite } from "../lib/index.js";
import type { JsBox } from "../lib/native-contracts.js";
import { SimpleBox } from "../lib/simplebox.js";
import type { SshConfig, SshStatus } from "../lib/simplebox.js";

const BOX = "ssh-box";
const SENTINEL = "TESTKEY-NODE-REST-LEAK-SENTINEL";

const BOX_JSON = {
  box_id: BOX,
  name: null,
  status: "running",
  created_at: "2026-07-14T00:00:00Z",
  updated_at: "2026-07-14T00:00:00Z",
  pid: 42,
  image: "alpine:latest",
  cpus: 1,
  memory_mib: 512,
  auto_resume: true,
};

function wireStatus(status: SshStatus): string {
  return JSON.stringify({
    enabled: status.enabled,
    generation: Number(status.generation),
    listen_address: status.listenAddress,
    host_public_key: status.hostPublicKey,
    host_key_fingerprint: status.hostKeyFingerprint,
  });
}

const ENABLED: SshStatus = {
  enabled: true,
  generation: 7n,
  listenAddress: "0.0.0.0:2222",
  hostPublicKey: "public host",
  hostKeyFingerprint: "SHA256:test",
};

const DISABLED: SshStatus = {
  enabled: false,
  generation: 0n,
  listenAddress: "",
  hostPublicKey: "",
  hostKeyFingerprint: "",
};

// One account with every field and one relying on the conversion defaults:
// omitted `authorizedKeys` must travel as `[]` and omitted `ca` as `null`.
function fullConfig(): SshConfig {
  return {
    listenAddress: "0.0.0.0:2222",
    hostPrivateKey: "private sentinel",
    accounts: [
      { login: "alice" },
      {
        login: "bob",
        authorizedKeys: ["bob authorized sentinel"],
        ca: { publicKey: "ca sentinel", principal: "principal sentinel" },
      },
    ],
  };
}

const FULL_CONFIG_WIRE = {
  listen_address: "0.0.0.0:2222",
  host_private_key: "private sentinel",
  accounts: [
    { login: "alice", authorized_keys: [], ca: null },
    {
      login: "bob",
      authorized_keys: ["bob authorized sentinel"],
      ca: { public_key: "ca sentinel", principal: "principal sentinel" },
    },
  ],
};

// Every wrong shape a hand-built configuration can take, each carrying the
// sentinel where the credential fields sit: if the rejection message quoted
// the rejected value, the sentinel would surface in it.
function malformedConfigs(): Array<[string, unknown]> {
  const base = fullConfig();
  return [
    [
      "hostPrivateKey of the wrong type",
      { ...base, hostPrivateKey: { secret: SENTINEL } },
    ],
    ["hostPrivateKey is a number", { ...base, hostPrivateKey: 424242 }],
    [
      "authorizedKeys element of the wrong type",
      {
        ...base,
        accounts: [{ login: "alice", authorizedKeys: [{ secret: SENTINEL }] }],
      },
    ],
    [
      "ca.publicKey of the wrong type",
      {
        ...base,
        accounts: [
          {
            login: "alice",
            ca: { publicKey: { secret: SENTINEL }, principal: "alice" },
          },
        ],
      },
    ],
    [
      "account login of the wrong type",
      { ...base, accounts: [{ login: { secret: SENTINEL } }] },
    ],
    ["configuration is not an object", SENTINEL],
  ];
}

// Invoke a call that may throw synchronously at the native boundary or
// reject its promise, and return the error either way.
async function rejectionOf(call: () => Promise<unknown>): Promise<Error> {
  try {
    await call();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to reject");
}

// The shared stub state: every request so far, and the replies left to hand
// out on the SSH route with their real HTTP status.
let server: Server;
let requests: string[] = [];
let replies: Array<{ status: number; body: string }> = [];
let runtime: Boxlite;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push(`${req.method} ${req.url}`);
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.method === "POST") {
        requests.push(body);
      }
      if (req.url === `/v1/boxes/${BOX}` && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(BOX_JSON));
        return;
      }
      if (req.url === `/v1/boxes/${BOX}/ssh`) {
        const reply = replies.shift();
        if (reply === undefined) {
          res.writeHead(500).end("no scripted reply left");
          return;
        }
        res.writeHead(reply.status, { "Content-Type": "application/json" });
        res.end(reply.body);
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  runtime = JsBoxlite.rest(
    new BoxliteRestOptions({ url: `http://127.0.0.1:${port}` }),
  );
});

afterAll(async () => {
  runtime.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function nativeBox(): Promise<JsBox> {
  const box = await runtime.get(BOX);
  expect(box).not.toBeNull();
  return box!;
}

describe("box.ssh over a REST transport", () => {
  test("configure sends the complete configuration and decodes the status", async () => {
    const box = await nativeBox();
    requests = [];
    replies = [{ status: 200, body: wireStatus(ENABLED) }];

    const status = await box.ssh.configure(fullConfig());

    expect(status).toEqual(ENABLED);
    expect(typeof status.generation).toBe("bigint");
    expect(requests[0]).toBe(`POST /v1/boxes/${BOX}/ssh`);
    expect(JSON.parse(requests[1])).toEqual(FULL_CONFIG_WIRE);
    expect(requests).toHaveLength(2);
  });

  test("status and disable cross the wire and decode without bodies", async () => {
    const box = await nativeBox();
    requests = [];
    replies = [
      { status: 200, body: wireStatus(ENABLED) },
      { status: 200, body: wireStatus(DISABLED) },
    ];

    expect(await box.ssh.status()).toEqual(ENABLED);
    expect(await box.ssh.disable()).toEqual(DISABLED);

    expect(requests).toEqual([
      `GET /v1/boxes/${BOX}/ssh`,
      `DELETE /v1/boxes/${BOX}/ssh`,
    ]);
  });

  for (const [name, config] of malformedConfigs()) {
    test(`a malformed configuration (${name}) is rejected before any request, without echoing it`, async () => {
      const box = await nativeBox();
      requests = [];

      const err = await rejectionOf(() =>
        box.ssh.configure(config as SshConfig),
      );

      expect(err.message).toBe("invalid SSH configuration");
      expect((err as Error & { code?: unknown }).code).toBe("InvalidArg");
      expect(err.message).not.toContain(SENTINEL);
      expect(requests).toEqual([]);
    });
  }

  test("a backend failure keeps its own message and is sent exactly once", async () => {
    const box = await nativeBox();
    requests = [];
    replies = [
      {
        status: 500,
        body: JSON.stringify({
          error: {
            message: "injected configure failure",
            type: "Error",
            code: "internal",
          },
        }),
      },
    ];

    const err = await rejectionOf(() => box.ssh.configure(fullConfig()));

    expect(err.message).toContain("injected configure failure");
    expect(err.message).not.toBe("invalid SSH configuration");
    expect(requests[0]).toBe(`POST /v1/boxes/${BOX}/ssh`);
    expect(JSON.parse(requests[1])).toEqual(FULL_CONFIG_WIRE);
    expect(requests).toHaveLength(2);
  });
});

describe("SimpleBox.ssh over a REST transport", () => {
  function newBox(): SimpleBox {
    return new SimpleBox({
      image: "alpine:latest",
      runtime,
      name: BOX,
      reuseExisting: true,
    });
  }

  test("configure reuses the named box and sends the complete configuration", async () => {
    const box = newBox();
    requests = [];
    replies = [{ status: 200, body: wireStatus(ENABLED) }];

    expect(await box.ssh.configure(fullConfig())).toEqual(ENABLED);

    expect(requests[0]).toBe(`GET /v1/boxes/${BOX}`);
    expect(requests[1]).toBe(`POST /v1/boxes/${BOX}/ssh`);
    expect(JSON.parse(requests[2])).toEqual(FULL_CONFIG_WIRE);
    expect(requests).toHaveLength(3);
  });

  for (const [name, config] of malformedConfigs()) {
    test(`a malformed configuration (${name}) is rejected before any request, without echoing it`, async () => {
      const box = newBox();
      // Create the box handle first so the snapshot covers only configure.
      replies = [{ status: 200, body: wireStatus(ENABLED) }];
      expect(await box.ssh.status()).toEqual(ENABLED);
      requests = [];

      const err = await rejectionOf(() =>
        box.ssh.configure(config as SshConfig),
      );

      expect(err.message).toBe("invalid SSH configuration");
      expect((err as Error & { code?: unknown }).code).toBe("InvalidArg");
      expect(err.message).not.toContain(SENTINEL);
      expect(requests).toEqual([]);
    });
  }
});
