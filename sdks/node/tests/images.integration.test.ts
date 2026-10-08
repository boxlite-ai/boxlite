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

const testRegistries = [
  { host: "docker.m.daocloud.io", search: true },
  { host: "docker.xuanyuan.me", search: true },
  { host: "docker.1ms.run", search: true },
  { host: "docker.io", search: true },
];

function newIsolatedRuntime() {
  const homeDir = mkdtempSync("/tmp/boxlite-test-node-images-");
  const runtime = new JsBoxlite({ homeDir, imageRegistries: testRegistries });
  return { homeDir, runtime };
}

describe("runtime image handle integration", { timeout: 120_000 }, () => {
  test("REST runtime refuses pull: it pulls when a box is created", async () => {
    const runtime = JsBoxlite.rest(
      new BoxliteRestOptions({ url: "http://localhost:1" }),
    );

    await expect(runtime.images.pull("alpine:latest")).rejects.toThrow(
      /pulls an image when a box is created/,
    );
  });

  test("pull returns image metadata", async () => {
    const runtime = JsBoxlite.withDefaultConfig();
    const result = await runtime.images.pull("alpine:latest");

    expect(result.reference).toBe("alpine:latest");
    expect(result.configDigest).toMatch(/^sha256:/);
    expect(result.layerCount).toBeGreaterThan(0);
  });

  test("list returns cached images", async () => {
    const runtime = JsBoxlite.withDefaultConfig();
    await runtime.images.pull("alpine:latest");

    const images = await runtime.images.list();

    expect(Array.isArray(images)).toBe(true);
    expect(images.length).toBeGreaterThan(0);

    const alpine = images.find(
      (info) => info.repository.includes("alpine") && info.tag === "latest",
    );
    expect(alpine).toBeDefined();
    expect(alpine?.id).toMatch(/^sha256:/);
    expect(alpine?.cachedAt).toEqual(expect.any(String));
  });

  test("cached image handle rejects operations after shutdown", async () => {
    const { homeDir, runtime } = newIsolatedRuntime();

    try {
      const images = runtime.images;
      await runtime.shutdown();

      await expect(images.pull("alpine:latest")).rejects.toThrow(/shut down/);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});

async function failureOf(call: Promise<unknown>): Promise<Error> {
  try {
    await call;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the call to fail");
}

// An empty cache answers get, remove and usage without a pull or a VM.
describe("image catalog on a local cache", () => {
  let homeDir: string;
  let runtime: Boxlite;

  beforeEach(() => {
    ({ homeDir, runtime } = newIsolatedRuntime());
  });

  afterEach(async () => {
    await runtime.shutdown();
    rmSync(homeDir, { recursive: true, force: true });
  });

  test("get of a name the cache does not hold is not_found", async () => {
    const err = await failureOf(runtime.images.get("quay.io/acme/app"));

    expect(errorCode(err)).toBe("not_found");
    expect(err.message).toContain("quay.io/acme/app");
  });

  test("remove of a name the cache does not hold is not_found", async () => {
    const err = await failureOf(runtime.images.remove("quay.io/acme/app"));

    expect(errorCode(err)).toBe("not_found");
  });

  test("a tagged reference is refused with the name to pass", async () => {
    const err = await failureOf(runtime.images.remove("quay.io/acme/app:v1"));

    expect(errorCode(err)).toBe("invalid_argument");
    expect(err.message).toContain("such as 'quay.io/acme/app'");
  });

  test("usage is unsupported", async () => {
    const err = await failureOf(runtime.images.usage());

    expect(errorCode(err)).toBe("unsupported");
  });
});

const CATALOG_ROUTES: Record<string, unknown> = {
  "/v1/images/quay.io%2Facme%2Fapp": {
    name: "quay.io/acme/app",
    tags: ["v2", "v1"],
    curated: false,
    versions: [
      {
        digest: "sha256:bb",
        size_bytes: null,
        source_ref: "quay.io/acme/app:v2",
        recorded_at: "2026-09-02T00:00:00Z",
      },
      {
        digest: "sha256:aa",
        size_bytes: 4096,
        source_ref: "quay.io/acme/app:v1",
        recorded_at: "2026-09-01T00:00:00Z",
      },
    ],
  },
  "/v1/images/usage": { count: 3, limit: 20, known_bytes: 8192 },
};

// A loopback server answers the box API's image routes with fixed bodies, so
// what the test reads back came through the REST client and the binding.
describe("image catalog on a REST runtime", () => {
  let server: Server;
  let requests: string[];
  let runtime: Boxlite;

  beforeEach(async () => {
    requests = [];
    server = createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      if (req.method === "DELETE") {
        res.writeHead(204).end();
        return;
      }
      const body = CATALOG_ROUTES[req.url ?? ""];
      res.writeHead(body ? 200 : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body ?? { error: { message: req.url } }));
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

  test("get reads the name and its versions, newest first", async () => {
    const detail = await runtime.images.get("quay.io/acme/app");

    expect(detail).toEqual({
      name: "quay.io/acme/app",
      tags: ["v2", "v1"],
      curated: false,
      versions: [
        {
          digest: "sha256:bb",
          sourceRef: "quay.io/acme/app:v2",
          recordedAt: "2026-09-02T00:00:00+00:00",
        },
        {
          digest: "sha256:aa",
          sizeBytes: 4096,
          sourceRef: "quay.io/acme/app:v1",
          recordedAt: "2026-09-01T00:00:00+00:00",
        },
      ],
    });
    expect(detail.versions[0]).not.toHaveProperty("sizeBytes");
  });

  test("usage reads count, limit and known bytes", async () => {
    const usage = await runtime.images.usage();

    expect(usage).toEqual({ count: 3, limit: 20, knownBytes: 8192 });
  });

  test("remove deletes the name as one path segment", async () => {
    await runtime.images.remove("quay.io/acme/app");

    expect(requests).toEqual(["DELETE /v1/images/quay.io%2Facme%2Fapp"]);
  });
});
