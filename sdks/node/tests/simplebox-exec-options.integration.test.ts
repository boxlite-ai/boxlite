/**
 * Integration tests for SimpleBox exec() options parameter.
 *
 * Tests the new overload: exec(cmd, args[], env, options)
 * where options = { cwd, user, timeoutSecs }.
 *
 * Requires VM support (KVM on Linux, Hypervisor.framework on macOS).
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SimpleBox } from "../lib/simplebox.js";

describe("SimpleBox exec options", { timeout: 120_000 }, () => {
  let box: SimpleBox;

  beforeAll(async () => {
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
  });

  test("cwd changes working directory", async () => {
    const result = await box.exec("pwd", [], undefined, { cwd: "/tmp" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("/tmp");
  });

  test("user runs as specified user", async () => {
    const result = await box.exec("whoami", [], undefined, { user: "nobody" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("nobody");
  });

  test("timeoutSecs kills long command", async () => {
    const result = await box.exec("sleep", ["60"], undefined, {
      timeoutSecs: 2,
    });
    expect(result.exitCode).not.toBe(0);
  });

  test("combined options (cwd + user)", async () => {
    const result = await box.exec(
      "sh",
      ["-c", "echo dir=$(pwd) user=$(whoami)"],
      undefined,
      { cwd: "/tmp", user: "nobody" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("dir=/tmp");
    expect(result.stdout).toContain("user=nobody");
  });

  test("variadic form still works (regression)", async () => {
    const result = await box.exec("echo", "hello");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  test("env and options together", async () => {
    const result = await box.exec(
      "sh",
      ["-c", "echo $FOO from $(pwd)"],
      { FOO: "bar" },
      { cwd: "/tmp" },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("bar from /tmp");
  });
});
