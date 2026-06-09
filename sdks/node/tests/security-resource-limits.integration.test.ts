/**
 * Integration tests for SecurityOptions enforcement inside a live box.
 *
 * These tests verify that security options passed at box creation are
 * actually enforced by the guest environment — not just accepted at the
 * API boundary.
 *
 * Node-SDK counterpart of:
 *  - sdks/python/tests/test_resource_limits.py
 *  - sdks/go/security_resource_limits_integration_test.go
 *
 * Requires:
 *  - make dev:node  (build Node SDK)
 *  - VM runtime for integration tests (libkrun / Hypervisor.framework)
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { SimpleBox } from "../lib/simplebox.js";

// ── max_open_files ────────────────────────────────────────────────────────────

describe(
  "SecurityOptions: max_open_files enforcement",
  { timeout: 180_000 },
  () => {
    const MAX_FILES = 64;
    let box: SimpleBox;

    beforeAll(async () => {
      box = new SimpleBox({
        image: "alpine:latest",
        autoRemove: false,
        security: {
          maxOpenFiles: MAX_FILES,
        },
      });
      await box.exec("true");
    });

    afterAll(async () => {
      await box.stop();
    });

    test("ulimit -n does not exceed configured maxOpenFiles", async () => {
      const result = await box.exec("sh", ["-c", "ulimit -n"]);
      expect(result.exitCode, `ulimit -n failed: ${result.stderr}`).toBe(0);

      const reported = parseInt(result.stdout.trim(), 10);
      expect(
        isNaN(reported),
        `ulimit -n returned non-numeric output: ${JSON.stringify(result.stdout)}`,
      ).toBe(false);
      expect(
        reported,
        `max_open_files not enforced: ulimit -n = ${reported}, want ≤ ${MAX_FILES}`,
      ).toBeLessThanOrEqual(MAX_FILES);
    });
  },
);

// ── max_processes ─────────────────────────────────────────────────────────────

describe(
  "SecurityOptions: max_processes enforcement",
  { timeout: 180_000 },
  () => {
    const MAX_PROCS = 50;
    let box: SimpleBox;

    beforeAll(async () => {
      box = new SimpleBox({
        image: "alpine:latest",
        autoRemove: false,
        security: {
          maxProcesses: MAX_PROCS,
        },
      });
      await box.exec("true");
    });

    afterAll(async () => {
      await box.stop();
    });

    test("ulimit -u does not exceed configured maxProcesses", async () => {
      const result = await box.exec("sh", ["-c", "ulimit -u"]);
      expect(result.exitCode, `ulimit -u failed: ${result.stderr}`).toBe(0);

      const out = result.stdout.trim();
      expect(
        out,
        "max_processes not enforced: ulimit -u reports 'unlimited'",
      ).not.toBe("unlimited");

      const reported = parseInt(out, 10);
      expect(
        isNaN(reported),
        `ulimit -u returned non-numeric output: ${JSON.stringify(result.stdout)}`,
      ).toBe(false);
      expect(
        reported,
        `max_processes not enforced: ulimit -u = ${reported}, want ≤ ${MAX_PROCS}`,
      ).toBeLessThanOrEqual(MAX_PROCS);
    });
  },
);

// ── sanitize_env ──────────────────────────────────────────────────────────────

describe(
  "SecurityOptions: sanitize_env enforcement",
  { timeout: 180_000 },
  () => {
    let box: SimpleBox;

    beforeAll(async () => {
      box = new SimpleBox({
        image: "alpine:latest",
        autoRemove: false,
        security: {
          sanitizeEnv: true,
          envAllowlist: ["PATH", "HOME", "TERM"],
        },
      });
      await box.exec("true");
    });

    afterAll(async () => {
      await box.stop();
    });

    test("PATH is available in guest (it is in the allowlist)", async () => {
      const result = await box.exec("sh", ["-c", "echo $PATH"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).not.toBe("");
    });

    test("host-only variable is absent from guest env", async () => {
      // This variable is not in envAllowlist and not passed via env:.
      // grep returns exit 1 when there are zero matches — `|| true` keeps exit 0.
      const result = await box.exec("sh", [
        "-c",
        "env | grep -c BOXLITE_SHOULD_NOT_EXIST || true",
      ]);
      expect(result.exitCode).toBe(0);
      const count = result.stdout.trim();
      expect(
        count === "0" || count === "",
        `sanitize_env did not filter unlisted variable: grep count = ${JSON.stringify(count)}`,
      ).toBe(true);
    });
  },
);
