/**
 * Integration tests for guest SSH control.
 *
 * Requires VM support (Hypervisor.framework on macOS, KVM on Linux) and a
 * working `ssh-keygen`. Mirrors the Rust journey in `src/cli/tests/ssh_rest.rs`:
 * configure/status/repeated disable/reconfigure plus the startup restrictions
 * owned by the core.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SimpleBox } from "../lib/simplebox.js";
import type { SshConfig, SshStatus } from "../lib/simplebox.js";

const keyDir = mkdtempSync("/tmp/boxlite-ssh-node-");
let privateKey: string;
let publicKey: string;

beforeAll(() => {
  const keyPath = join(keyDir, "host_key");
  execFileSync("ssh-keygen", [
    "-q",
    "-t",
    "ed25519",
    "-N",
    "",
    "-C",
    "boxlite-node-ssh-test",
    "-f",
    keyPath,
  ]);
  privateKey = readFileSync(keyPath, "utf8");
  publicKey = readFileSync(`${keyPath}.pub`, "utf8").trim();
});

afterAll(() => {
  rmSync(keyDir, { recursive: true, force: true });
});

function config(): SshConfig {
  return {
    listenAddress: "0.0.0.0:2222",
    hostPrivateKey: privateKey,
    accounts: [{ login: "alice", authorizedKeys: [publicKey] }],
  };
}

function expectDisabled(status: SshStatus, generation = 0n) {
  expect(status.enabled).toBe(false);
  expect(status.generation).toBe(generation);
  expect(status.listenAddress).toBe("");
  expect(status.hostPublicKey).toBe("");
  expect(status.hostKeyFingerprint).toBe("");
}

describe("SimpleBox.ssh", { timeout: 240_000 }, () => {
  let box: SimpleBox;

  afterAll(async () => {
    await box?.stop();
  });

  test("status and disable never start the box", async () => {
    box = new SimpleBox({ image: "alpine:latest", autoRemove: false });

    expectDisabled(await box.ssh.status());
    expectDisabled(await box.ssh.disable());
    expectDisabled(await box.ssh.status());

    const info = await box.info();
    expect(info.state.status).toBe("configured");
    expect(info.state.pid).toBeUndefined();
  });

  test("configure, reconfigure, and disable change the reported status", async () => {
    const first = await box.ssh.configure(config());
    expect(first.enabled).toBe(true);
    expect(typeof first.generation).toBe("bigint");
    expect(first.generation).toBeGreaterThanOrEqual(1n);
    expect(first.listenAddress).toBe("0.0.0.0:2222");
    expect(first.hostPublicKey).toMatch(/^ssh-/);
    expect(first.hostKeyFingerprint).toMatch(/^SHA256:/);

    const second = await box.ssh.configure(config());
    expect(second.generation).toBeGreaterThan(first.generation);

    expect(await box.ssh.status()).toEqual(second);

    // Disable is idempotent and preserves the last generation while clearing
    // the listener identity.
    expectDisabled(await box.ssh.disable(), second.generation);
    expectDisabled(await box.ssh.disable(), second.generation);
    expectDisabled(await box.ssh.status(), second.generation);
  });

  test("rejected configuration reports no credential material", async () => {
    const secret = "TESTKEY-LEAK-SENTINEL";
    const invalid: SshConfig = {
      listenAddress: "0.0.0.0:2222",
      hostPrivateKey: secret,
      accounts: [],
    };
    // Exercise rejection against a live listener, then prove it survives.
    const before = await box.ssh.configure(config());
    expect(before.enabled).toBe(true);
    let message = "";
    try {
      await box.ssh.configure(invalid);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toBeTruthy();
    expect(message).not.toContain(secret);
    expect(await box.ssh.status()).toEqual(before);
  });
});

describe(
  "SimpleBox.ssh with an explicit main command",
  { timeout: 240_000 },
  () => {
    let box: SimpleBox;

    afterAll(async () => {
      await box?.stop();
    });

    test("configure is refused until the box runs; status never starts it", async () => {
      box = new SimpleBox({
        image: "alpine:latest",
        cmd: ["sleep", "300"],
        autoRemove: false,
      });

      // Observations work and leave the box untouched.
      expectDisabled(await box.ssh.status());
      let info = await box.info();
      expect(info.state.status).toBe("configured");
      expect(info.state.pid).toBeUndefined();

      // The core refuses implicit startup for an explicit main command.
      await expect(box.ssh.configure(config())).rejects.toBeTruthy();
      info = await box.info();
      expect(info.state.status).toBe("configured");
      expect(info.state.pid).toBeUndefined();

      // Once running, configuration is allowed again. SimpleBox has no public
      // start(); exec also refuses implicit startup, so start the box handle
      // SimpleBox already created (the earlier status() created it).
      const holder = box as SimpleBox & { _box: { start(): Promise<void> } };
      await holder._box.start();
      const enabled = await box.ssh.configure(config());
      expect(enabled.enabled).toBe(true);
      expect(typeof enabled.generation).toBe("bigint");
    });
  },
);
