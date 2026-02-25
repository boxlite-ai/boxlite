/**
 * Integration tests for SimpleBox.metrics().
 *
 * Requires VM support (KVM on Linux, Hypervisor.framework on macOS).
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SimpleBox } from "../lib/simplebox.js";

describe("metrics integration", { timeout: 120_000 }, () => {
  let box: SimpleBox;

  beforeAll(async () => {
    box = new SimpleBox({ image: "alpine:latest" });
    await box.exec("true");
  });

  afterAll(async () => {
    await box.stop();
  });

  test("metrics() returns object with expected fields", async () => {
    const m = await box.metrics();
    expect(m).toHaveProperty("commandsExecutedTotal");
    expect(m).toHaveProperty("execErrorsTotal");
    expect(m).toHaveProperty("bytesSentTotal");
    expect(m).toHaveProperty("bytesReceivedTotal");
    expect(m).toHaveProperty("totalCreateDurationMs");
  });

  test("metrics after running a command show non-zero commandsExecutedTotal", async () => {
    // We already ran "true" in beforeAll, so at least 1 command was executed
    await box.exec("echo", "metric-test");
    const m = await box.metrics();
    expect(m.commandsExecutedTotal).toBeGreaterThan(0);
  });
});
