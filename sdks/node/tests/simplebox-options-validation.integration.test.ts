/**
 * E2E: SimpleBox option validation against the REAL built native module
 * (no mock). Proves the unsupported-parameter guard fires in the shipped SDK,
 * not just under a stubbed runtime.
 *
 * Requires the native binary (`npm run build:native`).
 */

import { describe, test, expect } from "vitest";
import { SimpleBox } from "../lib/simplebox.js";

describe("SimpleBox option validation (real native)", () => {
  test("unsupported option throws and names it", () => {
    expect(
      () =>
        new SimpleBox({ image: "alpine:latest", auto_delete_minutes: 5 } as never),
    ).toThrow(/auto_delete_minutes/);
  });

  test("valid options construct without throwing", () => {
    // Construction is lazy (no VM boot), but this still exercises the real
    // getJsBoxlite() + runtime handle, so a false-positive rejection would surface.
    expect(
      () => new SimpleBox({ image: "alpine:latest", autoRemove: false }),
    ).not.toThrow();
  });
});
