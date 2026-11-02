import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, test } from "vitest";
import { JsBoxlite, BoxliteRestOptions, errorCode } from "../lib/index.js";

// `lib/index.ts` exposes the cross-SDK `BoxliteRestOptions` bag while the
// native binding takes its own `BoxliteRestOptions` class (the
// positional→bag adaptation lives in Rust — `sdks/node/src/options.rs`,
// mirroring the Python SDK). It is exported via an ES subclass that
// restates `rest` over the bag and inherits `new` / `withDefaultConfig`
// / `initDefault` from the native class. Regression history: an earlier
// approach mutated the non-writable napi static (threw
// `TypeError: Cannot assign to read only property 'rest'` at import).
describe("JsBoxlite.rest options-bag adapter", () => {
  test("exposes a callable rest static after module load", () => {
    expect(typeof JsBoxlite.rest).toBe("function");
  });

  test("adapts the BoxliteRestOptions bag to the native runtime", () => {
    const runtime = JsBoxlite.rest(
      new BoxliteRestOptions({ url: "http://127.0.0.1:1", pathPrefix: "acme" }),
    );
    try {
      expect(runtime).toBeDefined();
    } finally {
      runtime.close();
    }
  });
});

// The bag `rest` is supplied by subclassing the native napi-rs class.
// napi-rs class subclassing is historically fragile (napi-rs #1164), so
// assert the inherited construct + static paths actually work.
describe("native-class subclassing", () => {
  test("inherits the withDefaultConfig static factory", () => {
    const runtime = JsBoxlite.withDefaultConfig();
    try {
      expect(runtime).toBeDefined();
    } finally {
      runtime.close();
    }
  });

  test("inherits the native constructor via super()", () => {
    const home = mkdtempSync("/tmp/boxlite-test-subclass-");
    try {
      const runtime = new JsBoxlite({ homeDir: home });
      try {
        expect(runtime).toBeDefined();
      } finally {
        runtime.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

// What `errorCode` reads is the message the binding rejects with, so check it
// on a rejection that really crossed the binding: a REST runtime refuses
// `pull` before sending anything, since it pulls when a box is created.
describe("errors thrown by the binding", () => {
  test("carry the code errorCode reads", async () => {
    const runtime = JsBoxlite.rest(
      new BoxliteRestOptions({ url: "http://127.0.0.1:1" }),
    );
    try {
      let thrown: unknown;
      try {
        await runtime.images.pull("alpine:latest");
      } catch (err) {
        thrown = err;
      }
      expect(errorCode(thrown)).toBe("unsupported");
    } finally {
      runtime.close();
    }
  });
});

describe("native box privilege metadata", () => {
  test.each([false, true, undefined])(
    "preserves %s through info, getInfo and listInfo",
    async (privileged) => {
      const boxId = "privilege-metadata";
      const metadata = {
        box_id: boxId,
        name: null,
        status: "configured",
        created_at: "2026-07-14T00:00:00Z",
        updated_at: "2026-07-14T00:00:00Z",
        pid: null,
        image: "alpine:latest",
        cpus: 1,
        memory_mib: 512,
        privileged,
      };
      const server = createServer((request, response) => {
        if (
          request.method !== "GET" ||
          !["/v1/boxes", `/v1/boxes/${boxId}`].includes(request.url ?? "")
        ) {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify(
            request.url === "/v1/boxes" ? { boxes: [metadata] } : metadata,
          ),
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const { port } = server.address() as AddressInfo;
      const runtime = JsBoxlite.rest(
        new BoxliteRestOptions({ url: `http://127.0.0.1:${port}` }),
      );
      try {
        const box = await runtime.get(boxId);
        expect(box).not.toBeNull();
        const infos = [
          await runtime.getInfo(boxId),
          ...(await runtime.listInfo()),
          await box!.info(),
        ];
        expect(infos).toHaveLength(3);
        for (const info of infos) {
          expect(info).not.toBeNull();
          expect(Reflect.get(info!, "privileged")).toBe(privileged);
        }
      } finally {
        runtime.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
