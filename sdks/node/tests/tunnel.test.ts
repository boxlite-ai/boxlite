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

  test("uri returns the remote URL without consuming the tunnel", async () => {
    const { SimpleBox } = await import("../lib/simplebox.js");
    const uri = vi.fn(() => "https://3000-box.proxy.example.test");
    const connection = { read: vi.fn(), write: vi.fn(), close: vi.fn() };
    const nativeTunnel = { uri, connect: vi.fn(async () => connection) };
    const tunnelNative = vi.fn(async () => nativeTunnel);
    const box = new SimpleBox({ image: "alpine:latest" }) as SimpleBox & {
      _box: { network: { tunnel: typeof tunnelNative } };
    };
    box._box = { network: { tunnel: tunnelNative } };

    const tunnel = await box.network.tunnel(3000);
    expect(tunnel.uri()).toBe("https://3000-box.proxy.example.test");
    expect(tunnelNative).toHaveBeenCalledWith(3000);
    expect(nativeTunnel.connect).not.toHaveBeenCalled();

    // Reading the address must leave the tunnel usable, not consume it.
    await expect(tunnel.connect()).resolves.toBe(connection);
  });

  test("uri is null for a local tunnel, which is reached by connecting", async () => {
    const { SimpleBox } = await import("../lib/simplebox.js");
    const nativeTunnel = { uri: vi.fn(() => null), connect: vi.fn() };
    const tunnelNative = vi.fn(async () => nativeTunnel);
    const box = new SimpleBox({ image: "alpine:latest" }) as SimpleBox & {
      _box: { network: { tunnel: typeof tunnelNative } };
    };
    box._box = { network: { tunnel: tunnelNative } };

    const tunnel = await box.network.tunnel(3000);
    expect(tunnel.uri()).toBeNull();
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
    const nativeTunnel = { uri: vi.fn(), connect };
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

  test("forward delegates address and lifecycle operations", async () => {
    const { SimpleBox } = await import("../lib/simplebox.js");
    const listen = { type: "tcp" as const, port: 0 };
    const nativeForwarder = {
      localAddr: vi.fn(() => ({
        type: "tcp" as const,
        host: "127.0.0.1",
        port: 49152,
      })),
      wait: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const forward = vi.fn(async () => nativeForwarder);
    const nativeTunnel = { uri: vi.fn(), connect: vi.fn(), forward };
    const box = new SimpleBox({ image: "alpine:latest" }) as SimpleBox & {
      _box: { network: { tunnel: () => Promise<typeof nativeTunnel> } };
    };
    box._box = { network: { tunnel: async () => nativeTunnel } };

    const tunnel = await box.network.tunnel(3000);
    const forwarder = await tunnel.forward(listen);
    expect(forward).toHaveBeenCalledWith(listen);
    expect(forwarder.localAddr()).toEqual({
      type: "tcp",
      host: "127.0.0.1",
      port: 49152,
    });
    await forwarder.wait();
    await forwarder.close();
    expect(nativeForwarder.wait).toHaveBeenCalledOnce();
    expect(nativeForwarder.close).toHaveBeenCalledOnce();
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
