/**
 * Regression test for GHSA-g6ww-w5j2-r7x3 (read-only volume remount bypass).
 *
 * A host directory mounted with `readOnly: true` must stay read-only even
 * against a malicious guest that runs `mount -o remount,rw`. Before the
 * v0.9.0 fix the guest could remount the virtiofs share read-write (it had
 * CAP_SYS_ADMIN) and write through to the host.
 *
 * Node-SDK counterpart of:
 *  - sdks/python/tests/test_readonly_volume_remount.py
 *  - src/boxlite/tests/security_enforcement.rs::readonly_volume_blocks_remount
 *
 * Requires:
 *  - make dev:node (build Node SDK)
 *  - VM runtime for integration tests (libkrun / Hypervisor.framework)
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SimpleBox } from "../lib/simplebox.js";

const GUEST_MOUNT = "/mnt/sensitive";
const ORIGINAL = "original content\n";
const ATTACK_PAYLOAD = "modified content";

describe(
  "GHSA-g6ww-w5j2-r7x3: read-only volume remount bypass",
  { timeout: 180_000 },
  () => {
    let hostDir: string;
    let roFile: string;
    let box: SimpleBox;

    beforeAll(async () => {
      hostDir = mkdtempSync(join(tmpdir(), "virtiofs-ro-poc-"));
      roFile = join(hostDir, "read_only.txt");
      writeFileSync(roFile, ORIGINAL);

      box = new SimpleBox({
        image: "alpine:latest",
        volumes: [
          { hostPath: hostDir, guestPath: GUEST_MOUNT, readOnly: true },
        ],
        memoryMib: 512,
        cpus: 1,
        autoRemove: false,
      });
      // Force creation now so the volume is mounted before the test body runs.
      await box.exec("true");
    });

    afterAll(async () => {
      try {
        await box.stop();
      } finally {
        rmSync(hostDir, { recursive: true, force: true });
      }
    });

    test("mount -o remount,rw cannot reach host file", async () => {
      // The share must be exposed read-only to the guest.
      const mounts = await box.exec("sh", [
        "-c",
        "cat /proc/mounts | grep sensitive",
      ]);
      expect(mounts.stdout, `mounts: ${mounts.stdout}`).toContain(" ro,");

      // Direct write is rejected (client-side MS_RDONLY active).
      const write1 = await box.exec("sh", [
        "-c",
        `echo '${ATTACK_PAYLOAD}' > ${GUEST_MOUNT}/read_only.txt 2>&1`,
      ]);
      expect(
        write1.exitCode,
        "initial write to read-only volume should fail",
      ).not.toBe(0);

      // ATTACK: try to remount the share read-write.
      await box.exec("sh", ["-c", `mount -o remount,rw ${GUEST_MOUNT} 2>&1`]);

      // The mount must still be read-only after the remount attempt.
      const after = await box.exec("sh", [
        "-c",
        "cat /proc/mounts | grep sensitive",
      ]);
      expect(after.stdout, `mounts after remount: ${after.stdout}`).toContain(
        " ro,",
      );
      expect(
        after.stdout,
        `mounts after remount: ${after.stdout}`,
      ).not.toContain(" rw,");

      // A post-attack write must still fail.
      const write2 = await box.exec("sh", [
        "-c",
        `echo '${ATTACK_PAYLOAD}' > ${GUEST_MOUNT}/read_only.txt 2>&1`,
      ]);
      expect(
        write2.exitCode,
        "write after remount bypass should still fail",
      ).not.toBe(0);

      // Guest-visible content unchanged.
      const guestView = await box.exec("cat", `${GUEST_MOUNT}/read_only.txt`);
      expect(guestView.stdout).toBe(ORIGINAL);

      // HOST VERIFICATION — the advisory's own exploit oracle: if the host
      // file now reads ATTACK_PAYLOAD the sandbox was escaped.
      const hostContent = readFileSync(roFile, "utf8");
      expect(
        hostContent,
        `read-only volume bypass: host file was modified from inside the sandbox (got ${JSON.stringify(hostContent)})`,
      ).toBe(ORIGINAL);
    });
  },
);
