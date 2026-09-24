import { describe, expect, test, vi } from "vitest";
const native = vi.hoisted(() => ({
  configure: vi.fn(async () => ({ generation: 18446744073709551615n })),
  status: vi.fn(async () => ({ generation: 18446744073709551615n })),
  disable: vi.fn(async () => ({ enabled: false })),
}));
const create = vi.hoisted(() =>
  vi.fn(async () => ({ id: "ssh", ssh: native })),
);
vi.mock("../lib/native.js", () => ({
  getJsBoxlite: () => ({
    withDefaultConfig: () => ({
      create,
      getOrCreate: async () => ({ box: await create(), created: true }),
    }),
  }),
}));

describe("SSH", () => {
  test("SimpleBox initializes only when an operation is called and forwards config", async () => {
    const { SimpleBox } = await import("../lib/simplebox.js");
    const box = new SimpleBox({ image: "alpine" });
    const ssh = box.ssh;
    expect(create).not.toHaveBeenCalled();
    const config = {
      listenAddress: "addr",
      hostPrivateKey: "private",
      accounts: [
        {
          login: "alice",
          authorizedKeys: ["key"],
          ca: { publicKey: "ca", principal: "alice" },
        },
      ],
    };
    expect((await ssh.configure(config)).generation).toBe(
      18446744073709551615n,
    );
    expect(native.configure).toHaveBeenCalledWith(config);
    expect((await ssh.status()).generation).toBe(18446744073709551615n);
    expect((await ssh.disable()).enabled).toBe(false);
  });
});
