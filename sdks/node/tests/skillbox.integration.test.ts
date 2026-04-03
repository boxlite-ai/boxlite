/**
 * Integration tests for SkillBox constructor and pre-start guards.
 *
 * These tests instantiate SkillBox (which loads the native binary)
 * but do not require a running VM.
 */

import { describe, test, expect } from "vitest";
import { SkillBox } from "../lib/skillbox.js";

describe("SkillBox constructor defaults", { timeout: 120_000 }, () => {
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

  test("network spec and secrets are forwarded to SimpleBox options", () => {
    const box = new SkillBox({
      oauthToken: "tok",
      network: {
        mode: "enabled",
        allowNet: ["example.com"],
      },
      secrets: [{ name: "api", value: "secret", hosts: ["example.com"] }],
    });
    const opts = (box as any)._boxOpts;
    expect(opts.network).toEqual({
      mode: "enabled",
      allowNet: ["example.com"],
    });
    expect(opts.secrets).toEqual([
      { name: "api", value: "secret", hosts: ["example.com"] },
    ]);
  });
});

describe("SkillBox OAuth token handling", { timeout: 120_000 }, () => {
  test("uses provided oauthToken option", () => {
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

describe("SkillBox pre-start guards", { timeout: 120_000 }, () => {
  test("call() throws when not started", async () => {
    const box = new SkillBox({ oauthToken: "tok" });
    await expect(box.call("hello")).rejects.toThrow("not started");
  });

  test("installSkill() throws when not started", async () => {
    const box = new SkillBox({ oauthToken: "tok" });
    await expect(box.installSkill("owner/repo")).rejects.toThrow("not started");
  });
});
