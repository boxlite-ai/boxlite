import { describe, expect, test } from "vitest";
import { JsBoxlite, BoxliteRestOptions } from "../lib/index.js";

// Regression: lib/index.ts adapted the native positional `rest`
// (url, credential?, prefix?) to the public `BoxliteRestOptions` bag by
// reassigning the static onto the native napi-rs class. napi-rs marks
// class statics non-writable, so the assignment threw
// `TypeError: Cannot assign to read only property 'rest'` at module
// import — breaking every consumer of `../lib/index.js`.
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
