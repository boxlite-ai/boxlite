import { describe, expect, test, vi } from "vitest";
import type { JsBox } from "../lib/native-contracts.js";
import { NetworkHandle, SimpleBox } from "../lib/simplebox.js";

vi.mock("../lib/native.js", () => ({
  getJsBoxlite: () => ({ withDefaultConfig: () => ({}) }),
}));

describe("network policy setters", () => {
  test("replace one direction and pass backend rejection through", async () => {
    const setInbound = vi.fn().mockResolvedValue(undefined);
    const setOutbound = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("unsupported"));
    const existing = vi.fn(
      () => ({ network: { setInbound, setOutbound } }) as unknown as JsBox,
    );
    const network = new NetworkHandle(vi.fn(), existing);
    await network.setInbound({ mode: "enabled" });
    await network.setOutbound({ mode: "enabled", allowNet: ["*.example.com"] });
    expect(setInbound).toHaveBeenCalledWith({ mode: "enabled" });
    expect(setOutbound).toHaveBeenCalledWith({
      mode: "enabled",
      allowNet: ["*.example.com"],
    });
    await expect(network.setOutbound({ mode: "enabled" })).rejects.toThrow(
      "unsupported",
    );
    expect(setOutbound).toHaveBeenLastCalledWith({ mode: "enabled" });
  });

  test("invalid input never creates a box", async () => {
    const ensure = vi.fn();
    const network = new NetworkHandle(ensure, ensure);
    await expect(
      network.setInbound({ mode: "enabled", allowNet: ["example.com"] }),
    ).rejects.toThrow("allowNet");
    await expect(
      network.setOutbound({ mode: "disabled", allowNet: ["example.com"] }),
    ).rejects.toThrow("allowNet");
    await expect(
      network.setOutbound({ mode: "enabled", allowNet: [""] }),
    ).rejects.toThrow("allowNet");
    expect(ensure).not.toHaveBeenCalled();
  });

  test("setter requires an existing box", async () => {
    const box = new SimpleBox({ image: "alpine" });
    await expect(box.network.setOutbound({ mode: "enabled" })).rejects.toThrow(
      "Box not yet created",
    );
  });
});
