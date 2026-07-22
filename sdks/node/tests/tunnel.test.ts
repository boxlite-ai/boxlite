import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sockets: [] as object[],
  socketConstructor: vi.fn(() => {
    const socket = {};
    mocks.sockets.push(socket);
    return socket;
  }),
}));

vi.mock("node:net", () => ({
  Socket: class {
    constructor(options: unknown) {
      mocks.socketConstructor(options);
      return mocks.sockets.at(-1);
    }
  },
}));

vi.mock("../lib/native.js", () => ({
  getJsBoxlite: () => ({
    withDefaultConfig: () => ({
      create: async () => ({ id: "unused" }),
      getOrCreate: async () => ({ box: { id: "unused" }, created: false }),
    }),
  }),
}));

describe("SimpleBox tunnels", () => {
  afterEach(() => {
    mocks.sockets.length = 0;
    mocks.socketConstructor.mockClear();
    vi.restoreAllMocks();
  });

  test("endpoint returns the prepared local file descriptor", async () => {
    const { SimpleBox } = await import("../lib/simplebox.js");
    const endpoint = vi.fn(() => 42);
    const nativeTunnel = { endpoint, _connectFd: vi.fn(async () => 42) };
    const tunnelNative = vi.fn(async () => nativeTunnel);
    const box = new SimpleBox({ image: "alpine:latest" }) as SimpleBox & {
      _box: { network: { tunnel: typeof tunnelNative } };
    };
    box._box = { network: { tunnel: tunnelNative } };

    const tunnel = await box.network.tunnel(3000);
    expect(tunnel.endpoint()).toBe(42);
    expect(tunnelNative).toHaveBeenCalledWith(3000);
    expect(nativeTunnel._connectFd).not.toHaveBeenCalled();
  });

  test("connect consumes the tunnel once", async () => {
    const { SimpleBox } = await import("../lib/simplebox.js");
    const connectFd = vi
      .fn()
      .mockResolvedValueOnce(42)
      .mockRejectedValueOnce(
        new Error("tunnel connection has already been consumed"),
      );
    const nativeTunnel = { endpoint: vi.fn(), _connectFd: connectFd };
    const box = new SimpleBox({ image: "alpine:latest" }) as SimpleBox & {
      _box: { network: { tunnel: () => Promise<typeof nativeTunnel> } };
    };
    box._box = { network: { tunnel: async () => nativeTunnel } };

    const tunnel = await box.network.tunnel(3000);
    const first = await tunnel.connect();
    await expect(tunnel.connect()).rejects.toThrow("already been consumed");
    expect(connectFd).toHaveBeenCalledTimes(2);
    expect(mocks.socketConstructor).toHaveBeenNthCalledWith(1, {
      fd: 42,
      readable: true,
      writable: true,
    });
  });
});
