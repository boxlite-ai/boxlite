/**
 * Integration tests for SimpleBox.copyIn / copyOut.
 *
 * These tests require VM support (KVM on Linux, Hypervisor.framework on macOS).
 * They spin up a real alpine:latest container and exercise round-trip file copies.
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SimpleBox } from "../lib/simplebox.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("copyIn / copyOut integration", { timeout: 120_000 }, () => {
  let box: SimpleBox;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "boxlite-copy-test-"));
    box = new SimpleBox({ image: "alpine:latest" });
    // Warm up: create the box eagerly
    await box.exec("true");
  });

  afterAll(async () => {
    await box.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("round-trip a single file", async () => {
    const content = "hello boxlite\n";
    const hostSrc = path.join(tmpDir, "input.txt");
    const hostDst = path.join(tmpDir, "output.txt");
    fs.writeFileSync(hostSrc, content);

    // Copy in, verify via exec, copy out and compare
    await box.copyIn(hostSrc, "/root/input.txt");
    const result = await box.exec("cat", "/root/input.txt");
    expect(result.stdout).toBe(content);

    await box.copyOut("/root/input.txt", hostDst);
    expect(fs.readFileSync(hostDst, "utf-8")).toBe(content);
  });

  test("round-trip a directory", async () => {
    const dirSrc = path.join(tmpDir, "dir-in");
    fs.mkdirSync(dirSrc);
    fs.writeFileSync(path.join(dirSrc, "a.txt"), "aaa\n");
    fs.writeFileSync(path.join(dirSrc, "b.txt"), "bbb\n");

    // Default includeParent=true wraps contents under the source dir name,
    // so copy to /root/ to get /root/dir-in/{a,b}.txt.
    await box.copyIn(dirSrc, "/root", { recursive: true });

    const lsResult = await box.exec("ls", "/root/dir-in");
    expect(lsResult.stdout).toContain("a.txt");
    expect(lsResult.stdout).toContain("b.txt");

    const dirDst = path.join(tmpDir, "dir-out");
    // copyOut also wraps under dir-in/ by default
    await box.copyOut("/root/dir-in", dirDst, { recursive: true });

    expect(fs.readFileSync(path.join(dirDst, "dir-in", "a.txt"), "utf-8")).toBe(
      "aaa\n",
    );
    expect(fs.readFileSync(path.join(dirDst, "dir-in", "b.txt"), "utf-8")).toBe(
      "bbb\n",
    );
  });

  test("overwrite existing file", async () => {
    const hostFile = path.join(tmpDir, "overwrite.txt");
    fs.writeFileSync(hostFile, "original\n");

    await box.copyIn(hostFile, "/root/overwrite.txt");

    // Overwrite with new content
    fs.writeFileSync(hostFile, "updated\n");
    await box.copyIn(hostFile, "/root/overwrite.txt", { overwrite: true });

    const result = await box.exec("cat", "/root/overwrite.txt");
    expect(result.stdout).toBe("updated\n");
  });

  test("error on nonexistent host path for copyIn", async () => {
    const badPath = path.join(tmpDir, "does-not-exist.txt");
    await expect(box.copyIn(badPath, "/root/nope.txt")).rejects.toThrow();
  });

  test("error on nonexistent container path for copyOut", async () => {
    const hostDst = path.join(tmpDir, "out-nope.txt");
    await expect(
      box.copyOut("/root/nonexistent-file-xyz", hostDst),
    ).rejects.toThrow();
  });
});
