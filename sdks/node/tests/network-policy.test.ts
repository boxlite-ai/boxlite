import { describe, expect, test, vi } from "vitest";
import type { JsBox } from "../lib/native-contracts.js";
import { NetworkHandle, SimpleBox } from "../lib/simplebox.js";

vi.mock("../lib/native.js", () => ({
  getJsBoxlite: () => ({ withDefaultConfig: () => ({}) }),
}));

describe("network policy updates", () => {
  test("replace one direction and pass backend rejection through", async () => {
    const updateInbound = vi.fn().mockResolvedValue(undefined);
    const updateOutbound = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("unsupported"));
    const existing = vi.fn(
      () =>
        ({ network: { updateInbound, updateOutbound } }) as unknown as JsBox,
    );
    const network = new NetworkHandle(vi.fn(), existing);
    await network.updateInbound({ mode: "enabled" });
    await network.updateOutbound({
      mode: "enabled",
      allowNet: ["*.example.com"],
    });
    expect(updateInbound).toHaveBeenCalledWith({ mode: "enabled" });
    expect(updateOutbound).toHaveBeenCalledWith({
      mode: "enabled",
      allowNet: ["*.example.com"],
    });
    await expect(network.updateOutbound({ mode: "enabled" })).rejects.toThrow(
      "unsupported",
    );
    expect(updateOutbound).toHaveBeenLastCalledWith({ mode: "enabled" });
  });

  test("invalid input never creates a box", async () => {
    const ensure = vi.fn();
    const network = new NetworkHandle(ensure, ensure);
    await expect(
      network.updateInbound({ mode: "enabled", allowNet: ["example.com"] }),
    ).rejects.toThrow("allowNet");
    await expect(
      network.updateOutbound({ mode: "disabled", allowNet: ["example.com"] }),
    ).rejects.toThrow("allowNet");
    await expect(
      network.updateOutbound({ mode: "enabled", allowNet: [""] }),
    ).rejects.toThrow("allowNet");
    expect(ensure).not.toHaveBeenCalled();
  });

  test("update requires an existing box", async () => {
    const box = new SimpleBox({ image: "alpine" });
    await expect(
      box.network.updateOutbound({ mode: "enabled" }),
    ).rejects.toThrow("Box not yet created");
  });
});
