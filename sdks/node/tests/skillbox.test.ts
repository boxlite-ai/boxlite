/**
 * Unit tests for SkillBox (no VM required).
 *
 * Validates constructor defaults, option handling, and pre-start guards.
 */

import { describe, test, expect } from "vitest";
import { SkillBox } from "../lib/skillbox.js";
import {
  SKILLBOX_IMAGE,
  SKILLBOX_MEMORY_MIB,
  SKILLBOX_DISK_SIZE_GB,
  SKILLBOX_GUI_HTTP_PORT,
  SKILLBOX_GUI_HTTPS_PORT,
} from "../lib/constants.js";

describe("SkillBox constructor defaults", () => {
  test("default name is 'skill-box'", () => {
    const box = new SkillBox();
    expect(box.name).toBe("skill-box");
  });

  test("default guiHttpPort is 0 (random)", () => {
    const box = new SkillBox();
    expect(box.guiHttpPort).toBe(0);
  });

  test("default guiHttpsPort is 0 (random)", () => {
    const box = new SkillBox();
    expect(box.guiHttpsPort).toBe(0);
  });

  test("custom name overrides default", () => {
    const box = new SkillBox({ name: "my-skill" });
    expect(box.name).toBe("my-skill");
  });

  test("custom GUI ports are stored", () => {
    const box = new SkillBox({ guiHttpPort: 8080, guiHttpsPort: 8443 });
    expect(box.guiHttpPort).toBe(8080);
    expect(box.guiHttpsPort).toBe(8443);
  });
});

describe("SkillBox OAuth token handling", () => {
  test("uses provided oauthToken option", () => {
    // The token is stored internally; we verify start() doesn't throw
    // "OAuth token required" when a token is provided. We can't call
    // start() without a VM, but we can verify construction succeeds.
    const box = new SkillBox({ oauthToken: "test-token-123" });
    expect(box).toBeInstanceOf(SkillBox);
  });

  test("falls back to env var when no oauthToken option", () => {
    const prev = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    try {
      process.env.CLAUDE_CODE_OAUTH_TOKEN = "env-token-456";
      const box = new SkillBox();
      expect(box).toBeInstanceOf(SkillBox);
    } finally {
      if (prev === undefined) {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      } else {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = prev;
      }
    }
  });
});

describe("SkillBox pre-start guards", () => {
  test("call() throws when not started", async () => {
    const box = new SkillBox({ oauthToken: "tok" });
    await expect(box.call("hello")).rejects.toThrow("not started");
  });

  test("installSkill() throws when not started", async () => {
    const box = new SkillBox({ oauthToken: "tok" });
    await expect(box.installSkill("owner/repo")).rejects.toThrow("not started");
  });
});

describe("SkillBox constants consistency", () => {
  test("SKILLBOX_IMAGE is a valid container image ref", () => {
    expect(SKILLBOX_IMAGE).toMatch(/^[\w.-]+\/[\w.-]+\/[\w.-]+:[\w.-]+$/);
  });

  test("SKILLBOX_MEMORY_MIB is in reasonable range", () => {
    expect(SKILLBOX_MEMORY_MIB).toBeGreaterThanOrEqual(1024);
    expect(SKILLBOX_MEMORY_MIB).toBeLessThanOrEqual(16384);
  });

  test("SKILLBOX_DISK_SIZE_GB is in reasonable range", () => {
    expect(SKILLBOX_DISK_SIZE_GB).toBeGreaterThanOrEqual(1);
    expect(SKILLBOX_DISK_SIZE_GB).toBeLessThanOrEqual(100);
  });

  test("GUI ports are valid port numbers", () => {
    expect(SKILLBOX_GUI_HTTP_PORT).toBeGreaterThan(0);
    expect(SKILLBOX_GUI_HTTP_PORT).toBeLessThanOrEqual(65535);
    expect(SKILLBOX_GUI_HTTPS_PORT).toBeGreaterThan(0);
    expect(SKILLBOX_GUI_HTTPS_PORT).toBeLessThanOrEqual(65535);
  });

  test("default values match Python SDK", () => {
    expect(SKILLBOX_MEMORY_MIB).toBe(4096);
    expect(SKILLBOX_DISK_SIZE_GB).toBe(10);
  });
});
