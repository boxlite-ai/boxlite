/**
 * Unit tests for SimpleBox constructor option validation (no VM / native required).
 *
 * The native loader is mocked so construction does not touch the real runtime;
 * this lets us observe that an UNSUPPORTED option fails loudly at the boundary
 * instead of being silently dropped by the napi conversion.
 */

import { describe, test, expect, vi } from "vitest";

// Mock the native loader: SimpleBox's only runtime import from ./native.js is
// getJsBoxlite(). Returning a stub runtime lets valid construction succeed
// without the prebuilt .node binary, so the only thing under test is the
// constructor's own input validation.
vi.mock("../lib/native.js", () => ({
  getJsBoxlite: () => ({
    withDefaultConfig: () => ({}),
  }),
}));

import { SimpleBox } from "../lib/simplebox.js";

describe("SimpleBox option validation", () => {
  test("rejects an unknown option and names it", () => {
    expect(
      () => new SimpleBox({ image: "alpine:latest", bogusOption: 1 } as never),
    ).toThrow(TypeError);
    expect(
      () => new SimpleBox({ image: "alpine:latest", bogusOption: 1 } as never),
    ).toThrow(/bogusOption/);
  });

  test("rejects removed lifecycle params (auto_stop / auto_delete)", () => {
    // These were never wired into the SDK; passing them must error, not be ignored.
    expect(() => new SimpleBox({ autoStopMinutes: 5 } as never)).toThrow(
      /autoStopMinutes/,
    );
    expect(() => new SimpleBox({ autoDeleteMinutes: 5 } as never)).toThrow(
      /autoDeleteMinutes/,
    );
  });

  test("lists every unknown key when several are passed", () => {
    let message = "";
    try {
      new SimpleBox({ foo: 1, bar: 2 } as never);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("foo");
    expect(message).toContain("bar");
  });

  test("accepts the full set of supported options without throwing", () => {
    expect(
      () =>
        new SimpleBox({
          image: "alpine:latest",
          cpus: 1,
          memoryMib: 256,
          autoRemove: false,
          detach: false,
          workingDir: "/tmp",
          env: { A: "1" },
          name: "ok-box",
          reuseExisting: true,
        }),
    ).not.toThrow();
  });

  test("preserves the specific migration error for the removed allowNet option", () => {
    expect(() => new SimpleBox({ allowNet: [] } as never)).toThrow(
      /allowNet was removed/,
    );
  });
});
