import { afterEach, describe, expect, test, vi } from "vitest";
import type { SshConfig, SshStatus } from "../lib/simplebox.js";

vi.mock("../lib/native.js", () => ({
  getJsBoxlite: () => ({
    withDefaultConfig: () => ({}),
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

  test("status rejects asynchronously before box creation", async () => {
    const box = new SimpleBox({ image: "alpine:latest" });
    // _ensureBox calls into the mocked runtime, which returns a plain object
    // without an ssh handle; the rejection crosses the async boundary.
    await expect(box.ssh.status()).rejects.toBeTruthy();
  });
});
