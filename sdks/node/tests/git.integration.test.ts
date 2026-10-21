/**
 * Integration tests for SimpleBox.git.
 *
 * Same contract as the Python and Go git integration tests: configure_user /
 * set_config / get_config reach guest git config through the native binding.
 * Writes go through box.git; observations go through guest `git config` /
 * `git log` (or the reverse for getConfig).
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SimpleBox } from "../lib/simplebox.js";

describe("git config namespace", { timeout: 120_000 }, () => {
  let box: SimpleBox;
  let gitInstalled = false;

  beforeAll(async () => {
    box = new SimpleBox({ image: "alpine:latest" });
    const warmup = await box.exec("true");
    expect(warmup.exitCode).toBe(0);

    const installed = await box.exec("sh", "-c", "apk add --no-cache git");
    gitInstalled = installed.exitCode === 0;
    if (!gitInstalled) {
      console.warn(`apk add git failed: ${installed.stderr}`);
    }
  });

  afterAll(async () => {
    await box.stop();
  });

  test("local scope without path names the missing argument", async () => {
    await expect(
      box.git.setConfig("user.email", "local@boxlite.ai", "local"),
    ).rejects.toThrow(/path/);
    await expect(box.git.getConfig("user.email", "local")).rejects.toThrow(
      /path/,
    );
    await expect(
      box.git.configureUser("BoxLite Bot", "bot@boxlite.ai", "local"),
    ).rejects.toThrow(/path/);
  });

  test("unknown scope is rejected with the allowed values", async () => {
    await expect(box.git.setConfig("user.email", "x", "file")).rejects.toThrow(
      /global/,
    );
    await expect(box.git.getConfig("user.email", "file")).rejects.toThrow(
      /global/,
    );
    await expect(
      box.git.configureUser("BoxLite Bot", "x@boxlite.ai", "file"),
    ).rejects.toThrow(/global/);
  });

  test("configureUser writes global identity into the guest", async ({
    skip,
  }) => {
    if (!gitInstalled) {
      skip("apk add git failed");
    }

    await box.git.configureUser("BoxLite Bot", "bot@boxlite.ai");
    const email = await box.exec(
      "sh",
      "-c",
      "git config --global --get user.email",
    );
    expect(email.exitCode).toBe(0);
    expect(email.stdout.trim()).toBe("bot@boxlite.ai");
    const name = await box.exec(
      "sh",
      "-c",
      "git config --global --get user.name",
    );
    expect(name.exitCode).toBe(0);
    expect(name.stdout.trim()).toBe("BoxLite Bot");
  });

  test("commit records the configured author", async ({ skip }) => {
    if (!gitInstalled) {
      skip("apk add git failed");
    }

    await box.git.configureUser("BoxLite Bot", "bot@boxlite.ai");
    const init = await box.exec(
      "sh",
      "-c",
      [
        "set -e",
        "git init /tmp/git-commit",
        "echo hi > /tmp/git-commit/README",
        "git -C /tmp/git-commit add README",
        "git -C /tmp/git-commit -c commit.gpgsign=false commit -m init",
        "git -C /tmp/git-commit log -1 --format='%an <%ae>'",
      ].join("\n"),
    );
    expect(init.exitCode).toBe(0);
    expect(init.stdout).toContain("BoxLite Bot <bot@boxlite.ai>");
  });

  test("getConfig reads guest global config", async ({ skip }) => {
    if (!gitInstalled) {
      skip("apk add git failed");
    }

    const written = await box.exec(
      "sh",
      "-c",
      "git config --global user.email other@boxlite.ai",
    );
    expect(written.exitCode).toBe(0);
    expect(await box.git.getConfig("user.email")).toBe("other@boxlite.ai");
    await box.git.configureUser("BoxLite Bot", "bot@boxlite.ai");
  });

  test("local setConfig does not change global", async ({ skip }) => {
    if (!gitInstalled) {
      skip("apk add git failed");
    }

    await box.git.configureUser("BoxLite Bot", "bot@boxlite.ai");
    const init = await box.exec("git", "init", "/tmp/git-local");
    expect(init.exitCode).toBe(0);

    await box.git.setConfig(
      "user.email",
      "local@boxlite.ai",
      "local",
      "/tmp/git-local",
    );
    const local = await box.exec(
      "sh",
      "-c",
      "git -C /tmp/git-local config --local --get user.email",
    );
    expect(local.exitCode).toBe(0);
    expect(local.stdout.trim()).toBe("local@boxlite.ai");
    expect(
      await box.git.getConfig("user.email", "local", "/tmp/git-local"),
    ).toBe("local@boxlite.ai");
    const globalEmail = await box.exec(
      "sh",
      "-c",
      "git config --global --get user.email",
    );
    expect(globalEmail.exitCode).toBe(0);
    expect(globalEmail.stdout.trim()).toBe("bot@boxlite.ai");
    expect(await box.git.getConfig("user.email")).toBe("bot@boxlite.ai");
  });
});
