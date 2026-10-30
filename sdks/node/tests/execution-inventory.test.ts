import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../lib/native.js", () => ({
  getJsBoxlite: () => ({ withDefaultConfig: () => ({ create: mocks.create }) }),
}));

import { SimpleBox } from "../lib/simplebox.js";

describe("SimpleBox.listExecutions", () => {
  beforeEach(() => vi.clearAllMocks());

  test("does not create or boot a fresh box", async () => {
    const box = new SimpleBox({ image: "alpine:latest" });
    await expect(box.listExecutions()).resolves.toEqual([]);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
