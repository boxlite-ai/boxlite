/**
 * Integration tests for snapshot, clone, and export/import operations.
 *
 * These tests require VM support (KVM on Linux, Hypervisor.framework on macOS).
 * They spin up a real alpine:latest container and exercise snapshot/clone/export
 * round-trips mirroring boxlite/tests/clone_export_import.rs.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SimpleBox } from "../lib/simplebox.js";
import { JsBoxlite } from "../lib/index.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// TODO: Fix snapshot tests — Rust tests (boxlite/tests/snapshot.rs) stop the
// box before snapshot operations (create_stopped_box pattern). This test file
// creates/removes/restores snapshots on a running box which violates the API
// contract. Needs rewrite to match the Rust test pattern: start → stop → snapshot → start.
describe.skip(
  "snapshot / clone / export integration",
  { timeout: 120_000 },
  () => {
    let box: SimpleBox;
    let tmpDir: string;

    beforeAll(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "boxlite-snap-test-"));
      box = new SimpleBox({
        image: "alpine:latest",
        autoRemove: false,
      });
      // Warm up: eagerly create the box
      const warmup = await box.exec("true");
      expect(warmup.exitCode).toBe(0);
    });

    afterAll(async () => {
      await box.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    // ── Snapshots ───────────────────────────────────────────────────────

    describe("snapshots", () => {
      test("create + list returns snapshot with correct metadata", async () => {
        const nativeBox = await (box as any)._ensureBox();
        const snap = nativeBox.snapshot;

        const info = await snap.create("snap-meta");
        expect(info.name).toBe("snap-meta");
        expect(info.boxId).toBe(nativeBox.id);
        expect(info.id).toBeTruthy();
        expect(info.createdAt).toBeGreaterThan(0);

        const list = await snap.list();
        expect(list.some((s: any) => s.name === "snap-meta")).toBe(true);

        // Cleanup
        await snap.remove("snap-meta");
      });

      test("get by name returns matching info", async () => {
        const nativeBox = await (box as any)._ensureBox();
        const snap = nativeBox.snapshot;

        await snap.create("snap-get");
        const info = await snap.get("snap-get");
        expect(info).not.toBeNull();
        expect(info!.name).toBe("snap-get");

        await snap.remove("snap-get");
      });

      test("get nonexistent returns null", async () => {
        const nativeBox = await (box as any)._ensureBox();
        const snap = nativeBox.snapshot;

        const info = await snap.get("does-not-exist");
        expect(info).toBeNull();
      });

      test("remove deletes snapshot", async () => {
        const nativeBox = await (box as any)._ensureBox();
        const snap = nativeBox.snapshot;

        await snap.create("snap-rm");
        await snap.remove("snap-rm");
        const info = await snap.get("snap-rm");
        expect(info).toBeNull();
      });

      test("restore brings back deleted file", async () => {
        // Write marker file
        const writeResult = await box.exec(
          "sh",
          ["-c", "echo restored > /root/marker.txt"],
          {},
        );
        expect(writeResult.exitCode).toBe(0);

        const nativeBox = await (box as any)._ensureBox();
        const snap = nativeBox.snapshot;
        await snap.create("snap-restore");

        // Delete marker
        await box.exec("rm", "/root/marker.txt");
        const gone = await box.exec("cat", "/root/marker.txt");
        expect(gone.exitCode).not.toBe(0);

        // Restore
        await snap.restore("snap-restore");
        const back = await box.exec("cat", "/root/marker.txt");
        expect(back.stdout).toContain("restored");

        await snap.remove("snap-restore");
      });

      test("multiple snapshots: list returns all", async () => {
        const nativeBox = await (box as any)._ensureBox();
        const snap = nativeBox.snapshot;

        await snap.create("multi-a");
        await snap.create("multi-b");

        const list = await snap.list();
        const names = list.map((s: any) => s.name);
        expect(names).toContain("multi-a");
        expect(names).toContain("multi-b");

        await snap.remove("multi-a");
        await snap.remove("multi-b");
      });
    });

    // ── Clone ───────────────────────────────────────────────────────────

    describe("clone", () => {
      test("cloneBox produces box with different ID", async () => {
        const nativeBox = await (box as any)._ensureBox();
        const cloned = await nativeBox.cloneBox(undefined, "clone-diff-id");
        try {
          expect(cloned.id).not.toBe(nativeBox.id);
        } finally {
          await cloned.stop();
        }
      });

      test("cloned box gets specified name", async () => {
        const nativeBox = await (box as any)._ensureBox();
        const cloned = await nativeBox.cloneBox(undefined, "clone-named");
        try {
          expect(cloned.name).toBe("clone-named");
        } finally {
          await cloned.stop();
        }
      });

      test("cloned box can run commands independently", async () => {
        // Write marker in original
        await box.exec("sh", ["-c", "echo original > /root/origin.txt"], {});

        const nativeBox = await (box as any)._ensureBox();
        const cloned = await nativeBox.cloneBox(undefined, "clone-indep");

        try {
          // Read marker from cloned box via low-level API
          const run = await cloned.exec("cat", ["/root/origin.txt"]);
          const stdout = await run.stdout();
          let output = "";
          while (true) {
            const line = await stdout.next();
            if (line === null) break;
            output += line;
          }
          await run.wait();
          expect(output).toContain("original");
        } finally {
          await cloned.stop();
        }
      });

      test("cloneBox without name creates unnamed clone", async () => {
        const nativeBox = await (box as any)._ensureBox();
        const cloned = await nativeBox.cloneBox();
        try {
          expect(cloned.id).toBeTruthy();
        } finally {
          await cloned.stop();
        }
      });
    });

    // ── Export / Import ─────────────────────────────────────────────────

    describe("export / import", () => {
      test("export creates .boxlite archive file", async () => {
        const nativeBox = await (box as any)._ensureBox();
        const archivePath = await nativeBox.export(tmpDir);
        expect(fs.existsSync(archivePath)).toBe(true);
        expect(archivePath).toMatch(/\.boxlite$/);
      });

      test("import creates new box with specified name", async () => {
        const nativeBox = await (box as any)._ensureBox();
        const archivePath = await nativeBox.export(tmpDir);

        const runtime = JsBoxlite;
        const imported = await runtime.importBox(archivePath, "import-named");
        try {
          expect(imported.name).toBe("import-named");
        } finally {
          await imported.stop();
        }
      });

      test("imported box can start and run commands", async () => {
        const nativeBox = await (box as any)._ensureBox();
        const archivePath = await nativeBox.export(tmpDir);

        const runtime = JsBoxlite;
        const imported = await runtime.importBox(archivePath, "import-run");
        try {
          await imported.start();
          const run = await imported.exec("echo", ["hello"]);
          const stdout = await run.stdout();
          let output = "";
          while (true) {
            const line = await stdout.next();
            if (line === null) break;
            output += line;
          }
          await run.wait();
          expect(output).toContain("hello");
        } finally {
          await imported.stop();
        }
      });

      test("round-trip: write marker → export → import → verify", async () => {
        await box.exec("sh", ["-c", "echo roundtrip > /root/rt.txt"], {});

        const nativeBox = await (box as any)._ensureBox();
        const archivePath = await nativeBox.export(tmpDir);

        const runtime = JsBoxlite;
        const imported = await runtime.importBox(archivePath, "import-rt");
        try {
          await imported.start();
          const run = await imported.exec("cat", ["/root/rt.txt"]);
          const stdout = await run.stdout();
          let output = "";
          while (true) {
            const line = await stdout.next();
            if (line === null) break;
            output += line;
          }
          await run.wait();
          expect(output).toContain("roundtrip");
        } finally {
          await imported.stop();
        }
      });

      test("import without name creates unnamed box", async () => {
        const nativeBox = await (box as any)._ensureBox();
        const archivePath = await nativeBox.export(tmpDir);

        const runtime = JsBoxlite;
        const imported = await runtime.importBox(archivePath);
        try {
          expect(imported.id).toBeTruthy();
        } finally {
          await imported.stop();
        }
      });
    });

    // ── New run params ──────────────────────────────────────────────────

    describe("run params", () => {
      test("workingDir changes cwd for command", async () => {
        const nativeBox = await (box as any)._ensureBox();
        const run = await nativeBox.exec(
          "pwd",
          [],
          undefined,
          false,
          undefined,
          undefined,
          "/tmp",
        );
        const stdout = await run.stdout();
        let output = "";
        while (true) {
          const line = await stdout.next();
          if (line === null) break;
          output += line;
        }
        await run.wait();
        expect(output.trim()).toBe("/tmp");
      });

      test("timeoutSecs kills long-running command", async () => {
        const nativeBox = await (box as any)._ensureBox();
        const run = await nativeBox.exec(
          "sleep",
          ["60"],
          undefined,
          false,
          undefined,
          2, // 2 second timeout
        );
        const result = await run.wait();
        // Timeout should kill the process with a non-zero exit code
        expect(result.exitCode).not.toBe(0);
      });
    });
  },
);
