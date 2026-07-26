import { describe, expect, test, vi } from "vitest";

vi.mock("../lib/native.js", () => ({
  getJsBoxlite: () => ({
    withDefaultConfig: () => ({
      create: async () => ({ id: "unused" }),
      getOrCreate: async () => ({ box: { id: "unused" }, created: false }),
    }),
  }),
}));

describe("SimpleBox port bindings", () => {
  test("returns resolved bindings from the native box", async () => {
    const { SimpleBox } = await import("../lib/simplebox.js");
    const expected = [
      {
        hostPort: 49152,
        guestPort: 3000,
        protocol: "tcp",
        hostIp: "127.0.0.1",
      },
    ];
    const nativePortBindings = vi.fn(async () => expected);
    const box = new SimpleBox({ image: "alpine:latest" }) as SimpleBox & {
      _box: { portBindings: typeof nativePortBindings };
    };
    box._box = { portBindings: nativePortBindings };

    await expect(box.portBindings()).resolves.toEqual(expected);
    expect(nativePortBindings).toHaveBeenCalledOnce();
  });
});
