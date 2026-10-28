import { createServer } from "node:http";
import { SocketAddress, type AddressInfo } from "node:net";
import { describe, expect, test } from "vitest";
import { BoxliteRestOptions, JsBoxlite } from "../lib/index.js";
import type { TunnelOptions } from "../lib/index.js";

describe("native tunnel address and options contract", () => {
  test("prepares typed targets and refuses the old port and boolean arguments", async () => {
    const requests: string[] = [];
    const server = createServer(async (req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/v1/boxes/box1") {
        res.end(
          JSON.stringify({
            box_id: "box1",
            status: "running",
            image: "alpine",
            created_at: "2026-10-27T00:00:00Z",
            updated_at: "2026-10-27T00:00:00Z",
            cpus: 1,
            memory_mib: 256,
          }),
        );
      } else if (req.url === "/v1/config") {
        res.end(
          JSON.stringify({ capabilities: { private_tunnels_enabled: true } }),
        );
      } else if (
        req.method === "POST" &&
        req.url === "/v1/boxes/box1/network/tunnel?port=3000"
      ) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        requests.push(body);
        const isPublic = body === "" || JSON.parse(body).isPublic !== false;
        res.end(
          JSON.stringify({
            uri: "https://3000-box1.proxy.test",
            isPublic,
            token: isPublic ? null : "blt_created_token",
          }),
        );
      } else {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const runtime = JsBoxlite.rest(
      new BoxliteRestOptions({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      }),
    );
    try {
      const box = (await runtime.get("box1"))!;
      const target = new SocketAddress({ address: "127.0.0.1", port: 3000 });
      for (const options of [
        undefined,
        {},
        { isPublic: true },
        { isPublic: false },
      ]) {
        const tunnel = await box.network.tunnel(target, options);
        expect(tunnel.isPublic()).toBe(options?.isPublic !== false);
        expect(tunnel.token()).toBe(
          options?.isPublic === false ? "blt_created_token" : null,
        );
      }
      expect(requests).toEqual(["", "", "", '{"isPublic":false}']);

      const ipv6 = new SocketAddress({
        address: "::1",
        family: "ipv6",
        port: 3000,
      });
      expect((await box.network.tunnel(ipv6)).isPublic()).toBe(true);
      for (const invalid of [
        { type: "tcp", host: "localhost", port: 3000 },
        new SocketAddress({ port: 0 }),
        new SocketAddress({ address: "10.0.0.5", port: 3000 }),
        new SocketAddress({
          address: "::1",
          family: "ipv6",
          port: 3000,
          flowlabel: 1,
        }),
        { address: "127.0.0.1", family: "ipv4", port: 1.5, flowlabel: 0 },
        { address: "127.0.0.1", family: "ipv4", port: 65536, flowlabel: 0 },
        { address: "127.0.0.1", family: "ipv6", port: 3000, flowlabel: 0 },
      ]) {
        await expect(async () =>
          box.network.tunnel(invalid as unknown as SocketAddress),
        ).rejects.toThrow();
      }

      await expect(async () =>
        box.network.tunnel(3000 as unknown as SocketAddress),
      ).rejects.toThrow();
      await expect(async () =>
        box.network.tunnel(target, false as unknown as TunnelOptions),
      ).rejects.toThrow();
      expect(requests).toHaveLength(5);
    } finally {
      runtime.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
