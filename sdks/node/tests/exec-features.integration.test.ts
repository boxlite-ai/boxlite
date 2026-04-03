/**
 * Integration tests for execution features: resizeTty, signal.
 *
 * Requires VM support (KVM on Linux, Hypervisor.framework on macOS).
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SimpleBox } from "../lib/simplebox.js";

describe("execution features integration", { timeout: 120_000 }, () => {
  let box: SimpleBox;

  beforeAll(async () => {
    box = new SimpleBox({ image: "alpine:latest" });
    await box.exec("true");
  });

  afterAll(async () => {
    await box.stop();
  });

  test("resizeTty on TTY-enabled run does not error", async () => {
    const nativeBox = await (box as any)._ensureBox();
    // Start a TTY command
    const run = await nativeBox.exec("sh", [], undefined, true);

    // Resize should succeed on a TTY run
    await expect(run.resizeTty(24, 80)).resolves.not.toThrow();

    // Clean up: kill the shell
    await run.kill();
    await run.wait();
  });

  test("resizeTty on non-TTY run should error", async () => {
    const nativeBox = await (box as any)._ensureBox();
    const run = await nativeBox.exec("sleep", ["5"], undefined, false);

    await expect(run.resizeTty(24, 80)).rejects.toThrow();

    await run.kill();
    await run.wait();
  });

  test("signal(15) terminates running process", async () => {
    const nativeBox = await (box as any)._ensureBox();
    const run = await nativeBox.exec("sleep", ["60"], undefined, false);

    // Send SIGTERM (15)
    await run.signal(15);
    const result = await run.wait();
    expect(result.exitCode).not.toBe(0);
  });

  test("signal(10/SIGUSR1) is delivered to the running process", async () => {
    const nativeBox = await (box as any)._ensureBox();
    const run = await nativeBox.exec("sleep", ["60"], undefined, false);

    await run.signal(10);
    const result = await run.wait();
    expect(result.exitCode).toBe(-10);
  });
});
