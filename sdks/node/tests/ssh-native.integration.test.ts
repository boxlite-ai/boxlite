import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test } from "vitest";
import { JsBoxlite, BoxliteRestOptions } from "../lib/index.js";

test("SSH native REST binding preserves bigint and nested credentials", async () => {
  const requests: { path: string; body: unknown }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url!, body: body ? JSON.parse(body) : null });
    res.setHeader("Content-Type", "application/json");
    if (req.url!.includes("/ssh")) {
      res.end(
        '{"enabled":true,"generation":18446744073709551615,"listen_address":"addr","host_public_key":"key","host_key_fingerprint":"fp"}',
      );
    } else {
      res.end(
        JSON.stringify({
          box_id: "box-test",
          name: null,
          status: "running",
          created_at: "2026-07-14T00:00:00Z",
          updated_at: "2026-07-14T00:00:00Z",
          pid: null,
          image: "alpine",
          cpus: 1,
          memory_mib: 512,
        }),
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const rt = JsBoxlite.rest(
    new BoxliteRestOptions({ url: `http://127.0.0.1:${address.port}` }),
  );
  try {
    const box = (await rt.get("box-test"))!;
    const config = {
      listenAddress: "addr",
      hostPrivateKey: "private",
      accounts: [
        {
          login: "alice",
          authorizedKeys: ["key"],
          ca: { publicKey: "ca", principal: "alice" },
        },
      ],
    };
    expect((await box.ssh.configure(config)).generation).toBe(
      18446744073709551615n,
    );
    expect((await box.ssh.status()).hostPublicKey).toBe("key");
    expect((await box.ssh.disable()).generation).toBe(18446744073709551615n);
    expect(requests[1].body).toEqual({
      listen_address: "addr",
      host_private_key: "private",
      accounts: [
        {
          login: "alice",
          authorized_keys: ["key"],
          ca: { public_key: "ca", principal: "alice" },
        },
      ],
    });
    expect(requests.map((r) => r.path)).toEqual([
      "/v1/boxes/box-test",
      "/v1/boxes/box-test/ssh/configure",
      "/v1/boxes/box-test/ssh",
      "/v1/boxes/box-test/ssh/disable",
    ]);
  } finally {
    rt.close();
    server.close();
    await once(server, "close");
  }
}, 15000);

test("SSH native async receiver survives GC and is released after concurrent calls", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  await promisify(execFile)(
    process.execPath,
    [
      "--expose-gc",
      fileURLToPath(new URL("./fixtures/ssh-lifetime.mjs", import.meta.url)),
    ],
    { timeout: 15000 },
  );
}, 20000);
