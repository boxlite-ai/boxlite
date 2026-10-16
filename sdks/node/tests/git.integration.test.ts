/**
 * Integration tests for SimpleBox.git.
 *
 * Same contract as the Python and Go git integration tests: the repo is
 * prepared via exec and observed through box.git.status() / branches().
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { SimpleBox } from "../lib/simplebox.js";

describe("git namespace", { timeout: 120_000 }, () => {
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

  test("status and branches return structured results", async ({ skip }) => {
    if (!gitInstalled) {
      skip("apk add git failed");
    }
    const setup = await box.exec(
      "sh",
      "-c",
      "set -e\n" +
        "git init -q -b main /tmp/st\n" +
        "echo hi > /tmp/st/README.md\n" +
        "git -C /tmp/st add README.md\n" +
        "git -C /tmp/st -c user.name=Bot -c user.email=bot@boxlite.ai -c commit.gpgsign=false commit -qm init\n" +
        "git -C /tmp/st branch feature\n",
    );
    expect(setup.exitCode).toBe(0);
    const clean = await box.git.status("/tmp/st");
    expect(clean.fileStatus).toEqual([]);
    expect(clean.currentBranch).toBe("main");
    expect(clean.branchPublished).toBe(false);

    const dirty = await box.exec(
      "sh",
      "-c",
      "echo x >> /tmp/st/README.md && echo a > '/tmp/st/with space.txt' && git -C /tmp/st add README.md",
    );
    expect(dirty.exitCode).toBe(0);
    const st = await box.git.status("/tmp/st");
    const byPath = Object.fromEntries(st.fileStatus.map((f) => [f.path, f]));
    expect(byPath["README.md"].staged).toBe(true);
    expect(byPath["with space.txt"].untracked).toBe(true);

    const branches = await box.git.branches("/tmp/st");
    expect(branches.current).toBe("main");
    expect([...branches.names].sort()).toEqual(["feature", "main"]);
  });
});
