import { createServer } from "node:http";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, test } from "vitest";

// These contracts need the real NAPI boundary, but never start a VM.
const nativeDirectory = new URL("../native/", import.meta.url);
const nativePresent =
  existsSync(nativeDirectory) &&
  readdirSync(nativeDirectory).some((name) => name.endsWith(".node"));
const sdk = nativePresent ? await import("../lib/index.js") : undefined;
const savedBox = {
  box_id: "nested-node-box",
  name: "named",
  status: "configured",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  image: "alpine:latest",
  cpus: 1,
  memory_mib: 512,
};

async function endpoint() {
  const requests: { method: string; path: string; type?: string; body: any }[] =
    [];
  const replies = new Map<string, [number, unknown]>();
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    requests.push({
      method: req.method!,
      path: req.url!,
      type: req.headers["content-type"],
      body: body ? JSON.parse(body) : undefined,
    });
    const [status, reply] = replies.get(`${req.method} ${req.url}`) ?? [
      404,
      {},
    ];
    const payload = JSON.stringify(reply);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("missing HTTP address");
  const runtime = sdk!.JsBoxlite.rest(
    new sdk!.BoxliteRestOptions({ url: `http://127.0.0.1:${address.port}` }),
  );
  return {
    runtime,
    replies,
    requests,
    async close() {
      runtime.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

describe.skipIf(!nativePresent)(
  "nested virtualization native contracts",
  () => {
    test.each([false, true])(
      "SimpleBox lazy reuse=%s preserves nested intent",
      async (reuseExisting) => {
        for (const requested of [undefined, false, true]) {
          const e = await endpoint();
          try {
            e.replies.set("GET /v1/config", [
              200,
              { capabilities: { nested_virtualization_enabled: true } },
            ]);
            e.replies.set("POST /v1/boxes", [
              201,
              {
                ...savedBox,
                advanced: { nested_virtualization: requested ?? false },
              },
            ]);
            const box = new sdk!.SimpleBox({
              image: "alpine:latest",
              name: "lazy-nested",
              runtime: e.runtime,
              reuseExisting,
              advanced:
                requested === undefined
                  ? undefined
                  : { nestedVirtualization: requested },
            });
            expect(await box.getId()).toBe(savedBox.box_id);
            const creates = e.requests.filter(
              (request) => request.method === "POST",
            );
            expect(creates).toHaveLength(1);
            if (requested === true) {
              expect(creates[0].body.advanced?.nested_virtualization).toBe(
                true,
              );
            } else {
              expect(creates[0].body).not.toHaveProperty("advanced");
            }
          } finally {
            await e.close();
          }
        }
      },
    );

    test("omitted and false preserve the default HTTP request", async () => {
      const e = await endpoint();
      try {
        e.replies.set("POST /v1/boxes", [201, savedBox]);
        for (const advanced of [
          undefined,
          {},
          { nestedVirtualization: false },
        ]) {
          await e.runtime.create({ image: "alpine:latest", advanced });
        }
        expect(e.requests).toHaveLength(3);
        expect(e.requests[0]).toEqual(e.requests[1]);
        expect(e.requests[0]).toEqual(e.requests[2]);
        expect(e.requests[0]).toMatchObject({
          method: "POST",
          path: "/v1/boxes",
          type: "application/json",
        });
        expect(e.requests[0].body).not.toHaveProperty("advanced");
      } finally {
        await e.close();
      }
    });

    test("true crosses NAPI and HTTP, keeps empty capabilities, and rechecks opt-in", async () => {
      const e = await endpoint();
      try {
        e.replies.set("GET /v1/config", [
          200,
          {
            capabilities: {
              nested_virtualization_enabled: true,
              linux_capabilities_enabled: true,
            },
          },
        ]);
        const saved = {
          ...savedBox,
          advanced: { nested_virtualization: true },
        };
        e.replies.set("POST /v1/boxes", [201, saved]);
        e.replies.set("GET /v1/boxes/nested-node-box", [200, saved]);
        const options = {
          image: "alpine:latest",
          advanced: { nestedVirtualization: true, capabilities: {} },
        };
        const box = await e.runtime.create(options);
        expect(e.requests.map((req) => `${req.method} ${req.path}`)).toEqual([
          "GET /v1/config",
          "GET /v1/config",
          "POST /v1/boxes",
        ]);
        expect(e.requests[2].body.advanced).toEqual({
          nested_virtualization: true,
          capabilities: { add: [], drop: [] },
        });
        expect((await box.info()).advanced?.nestedVirtualization).toBe(true);
        e.replies.set("GET /v1/config", [200, { capabilities: {} }]);
        const before = e.requests.length;
        await expect(
          e.runtime.create({ advanced: { nestedVirtualization: true } }),
        ).rejects.toThrow(/nested virtualization/);
        expect(e.requests.slice(before).map((req) => req.method)).toEqual([
          "GET",
        ]);
      } finally {
        await e.close();
      }
    });

    test("missing or false saved confirmation fails without cleanup or retry", async () => {
      const e = await endpoint();
      try {
        e.replies.set("GET /v1/config", [
          200,
          { capabilities: { nested_virtualization_enabled: true } },
        ]);
        for (const advanced of [undefined, { nested_virtualization: false }]) {
          e.replies.set("POST /v1/boxes", [201, { ...savedBox, advanced }]);
          const before = e.requests.length;
          await expect(
            e.runtime.create({ advanced: { nestedVirtualization: true } }),
          ).rejects.toThrow(/nested-node-box/);
          expect(e.requests.slice(before).map((req) => req.method)).toEqual([
            "GET",
            "POST",
          ]);
        }
      } finally {
        await e.close();
      }
    });

    test("local authorization is explicit and saved metadata is observable", async () => {
      const previous = process.env.BOXLITE_EXPERIMENTAL;
      process.env.BOXLITE_EXPERIMENTAL = "nested-virtualization";
      try {
        for (const authorized of [false, true]) {
          const home = mkdtempSync(join(tmpdir(), "boxlite-nested-node-"));
          const runtime = new sdk!.JsBoxlite({
            homeDir: home,
            experimentalFeatures: authorized ? ["nested-virtualization"] : [],
          });
          try {
            const request = runtime.create({
              image: "alpine:latest",
              advanced: { nestedVirtualization: true },
            });
            if (authorized)
              expect(
                (await (await request).info()).advanced?.nestedVirtualization,
              ).toBe(true);
            else
              await expect(request).rejects.toThrow(
                /RC feature and is disabled/,
              );
            const ordinary = await runtime.create({ image: "alpine:latest" });
            expect((await ordinary.info()).advanced?.nestedVirtualization).toBe(
              false,
            );
          } finally {
            await runtime.shutdown();
            runtime.close();
            rmSync(home, { recursive: true, force: true });
          }
        }
      } finally {
        if (previous === undefined) delete process.env.BOXLITE_EXPERIMENTAL;
        else process.env.BOXLITE_EXPERIMENTAL = previous;
      }
    });

    test.each([null, "true", 0, 1, [], {}])(
      "does not coerce nested boolean %j",
      async (value) => {
        const e = await endpoint();
        try {
          expect(() =>
            e.runtime.create({
              advanced: { nestedVirtualization: value as boolean },
            }),
          ).toThrow(/bool/);
          expect(e.requests).toHaveLength(0);
        } finally {
          await e.close();
        }
      },
    );

    test.each([
      "unknown",
      "nested-virtualization,custom-kernel",
      "nested-virtualization\0",
    ])("rejects feature element %j", (name) => {
      const home = mkdtempSync(join(tmpdir(), "boxlite-nested-invalid-"));
      try {
        expect(
          () =>
            new sdk!.JsBoxlite({ homeDir: home, experimentalFeatures: [name] }),
        ).toThrow(/feature/);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });

    test("initDefault retains authorization in an isolated process", () => {
      const home = mkdtempSync(join(tmpdir(), "boxlite-nested-default-"));
      try {
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
        import { JsBoxlite } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
        JsBoxlite.initDefault({ homeDir: process.argv[1], experimentalFeatures: ["nested-virtualization"] });
        const rt = JsBoxlite.withDefaultConfig();
        const box = await rt.create({ image: "alpine:latest", advanced: { nestedVirtualization: true } });
        if ((await box.info()).advanced?.nestedVirtualization !== true) throw new Error("lost authorization");
        await rt.shutdown(); rt.close();
      `,
            home,
          ],
          { timeout: 15_000, stdio: "pipe" },
        );
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    });
  },
);
