import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SshConfig, SshStatus } from "../lib/simplebox.js";

// The mocked runtime is complete enough for lazy creation: `create` returns
// a box whose ssh handle is the shared mock, so fresh-box flows run for real
// up to the native boundary.
const mocks = vi.hoisted(() => ({
  create: vi.fn<() => Promise<unknown>>(),
  configure: vi.fn<() => Promise<SshStatus>>(),
  status: vi.fn<() => Promise<SshStatus>>(),
  disable: vi.fn<() => Promise<SshStatus>>(),
}));

vi.mock("../lib/native.js", () => ({
  getJsBoxlite: () => ({
    withDefaultConfig: () => ({ create: mocks.create }),
  }),
}));

import { SimpleBox } from "../lib/simplebox.js";

function disabledStatus(): SshStatus {
  return {
    enabled: false,
    generation: 0n,
    listenAddress: "",
    hostPublicKey: "",
    hostKeyFingerprint: "",
  };
}

describe("SimpleBox.ssh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockImplementation(async () => ({ ssh: mocks }));
    mocks.configure.mockImplementation(async () => disabledStatus());
    mocks.status.mockImplementation(async () => disabledStatus());
    mocks.disable.mockImplementation(async () => disabledStatus());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("accessing the handle does not create the box", () => {
    const box = new SimpleBox({ image: "alpine:latest" }) as SimpleBox & {
      _box: unknown;
    };
    expect(box.ssh).toBeDefined();
    expect(box._box).toBeNull();
  });

  test("status on a fresh box creates it once and observes disabled", async () => {
    const box = new SimpleBox({ image: "alpine:latest" });

    await expect(box.ssh.status()).resolves.toEqual(disabledStatus());

    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.status).toHaveBeenCalledTimes(1);
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(mocks.disable).not.toHaveBeenCalled();
  });

  test("status observes through the box without extra wrapping", async () => {
    const status = vi.fn(async () => disabledStatus());
    const disable = vi.fn(async () => disabledStatus());
    const configure = vi.fn(async () => disabledStatus());
    const box = new SimpleBox({ image: "alpine:latest" }) as SimpleBox & {
      _box: {
        ssh: {
          configure: typeof configure;
          status: typeof status;
          disable: typeof disable;
        };
      };
    };
    box._box = { ssh: { configure, status, disable } };

    await expect(box.ssh.status()).resolves.toEqual(disabledStatus());
    await expect(box.ssh.disable()).resolves.toEqual(disabledStatus());
    expect(status).toHaveBeenCalledTimes(1);
    expect(disable).toHaveBeenCalledTimes(1);
    expect(configure).not.toHaveBeenCalled();
  });

  test("configure passes the configuration object through unchanged", async () => {
    const enabled: SshStatus = {
      enabled: true,
      generation: 3n,
      listenAddress: "0.0.0.0:2222",
      hostPublicKey: "ssh-ed25519 AAAA host",
      hostKeyFingerprint: "SHA256:abc",
    };
    const configure = vi.fn(async () => enabled);
    const box = new SimpleBox({ image: "alpine:latest" }) as SimpleBox & {
      _box: { ssh: { configure: typeof configure } };
    };
    box._box = { ssh: { configure } };

    const config: SshConfig = {
      listenAddress: "0.0.0.0:2222",
      hostPrivateKey: "private key material",
      accounts: [
        {
          login: "alice",
          authorizedKeys: ["ssh-ed25519 AAAA alice"],
          ca: { publicKey: "ssh-ed25519 AAAA ca", principal: "alice" },
        },
      ],
    };
    await expect(box.ssh.configure(config)).resolves.toBe(enabled);
    expect(configure).toHaveBeenCalledWith(config);
  });
});
