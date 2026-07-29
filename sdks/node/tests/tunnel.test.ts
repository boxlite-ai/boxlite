import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../lib/native.js", () => ({
  getJsBoxlite: () => ({
    withDefaultConfig: () => ({
      create: async () => ({ id: "unused" }),
      getOrCreate: async () => ({ box: { id: "unused" }, created: false }),
    }),
  }),
}));

describe("SimpleBox", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("endpoint returns the prepared local file descriptor", async () => {
    const { SimpleBox } = await import("../lib/simplebox.js");
    const endpoint = vi.fn(() => 42);
    const nativeTunnel = { endpoint, connect: vi.fn() };
    const tunnelNative = vi.fn(async () => nativeTunnel);
    const box = new SimpleBox({ image: "alpine:latest" }) as SimpleBox & {
      _box: { network: { tunnel: typeof tunnelNative } };
    };
    box._box = { network: { tunnel: tunnelNative } };

    const tunnel = await box.network.tunnel(3000);
    expect(tunnel.endpoint()).toBe(42);
    expect(tunnelNative).toHaveBeenCalledWith(3000);
    expect(nativeTunnel.connect).not.toHaveBeenCalled();
  });

  test("connect consumes the tunnel once", async () => {
    const { SimpleBox } = await import("../lib/simplebox.js");
    const connection = { read: vi.fn(), write: vi.fn(), close: vi.fn() };
    const connect = vi
      .fn()
      .mockResolvedValueOnce(connection)
      .mockRejectedValueOnce(
        new Error("tunnel connection has already been consumed"),
      );
    const nativeTunnel = { endpoint: vi.fn(), connect };
    const box = new SimpleBox({ image: "alpine:latest" }) as SimpleBox & {
      _box: { network: { tunnel: () => Promise<typeof nativeTunnel> } };
    };
    box._box = { network: { tunnel: async () => nativeTunnel } };

    const tunnel = await box.network.tunnel(3000);
    const first = await tunnel.connect();
    expect(first).toBe(connection);
    await expect(tunnel.connect()).rejects.toThrow("already been consumed");
    expect(connect).toHaveBeenCalledTimes(2);
  });

  test("info resolves asynchronously", async () => {
    const { SimpleBox } = await import("../lib/simplebox.js");
    const metadata = { id: "box-1" };
    const info = vi.fn(async () => metadata);
    const box = new SimpleBox({ image: "alpine:latest" }) as SimpleBox & {
      _box: { info: typeof info };
    };
    box._box = { info };

    await expect(box.info()).resolves.toBe(metadata);
    expect(info).toHaveBeenCalledOnce();
  });

  test("info rejects asynchronously before box creation", async () => {
    const { SimpleBox } = await import("../lib/simplebox.js");
    const box = new SimpleBox({ image: "alpine:latest" });

    await expect(box.info()).rejects.toThrow("Box not yet created");
  });
});
