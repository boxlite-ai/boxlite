import { mkdtempSync, rmSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { JsBoxlite, BoxliteRestOptions } from "../lib/index.js";

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
      new BoxliteRestOptions({ url: "http://127.0.0.1:1", prefix: "v1" }),
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
