import { describe, expect, test } from "vitest";
import { SimpleBox } from "../lib/simplebox.js";

class InventoryBox extends SimpleBox {
  nativeBox() {
    return this._ensureBox();
  }
}

describe("live execution inventory integration", { timeout: 120_000 }, () => {
  test("native and convenience inventory share canonical guest IDs", async () => {
    const box = new InventoryBox({ image: "alpine:latest" });
    try {
      const native = await box.nativeBox();
      const before = await native.info();
      await expect(native.listExecutions()).resolves.toEqual([]);
      expect((await native.info()).state.status).toBe(before.state.status);
      await native.start();
      const execution = await native.exec("sleep", ["300"], undefined, true);
      const id = await execution.id();
      const inventory = await box.listExecutions();
      expect(inventory.some((info) => info.isMain)).toBe(true);
      const info = inventory.find((item) => item.executionId === id);
      expect(info).toMatchObject({
        executionId: id,
        argv: ["sleep", "300"],
        tty: true,
        isMain: false,
      });
      expect(info!.pid).toBeGreaterThan(0);
      expect(info!.startedAt).toBeGreaterThan(0);
      const control = await box.getExecution(id);
      await control.kill();
      await control.wait();
      expect(
        (await native.listExecutions()).some((item) => item.executionId === id),
      ).toBe(false);
    } finally {
      await box.stop();
    }
  });
  test("recovers the listed main session's output", async () => {
    const box = new InventoryBox({
      image: "alpine:latest",
      autoRemove: false,
      cmd: [
        "sh",
        "-c",
        "while true; do echo recovered-wrapper; sleep 0.1; done",
      ],
    });
    try {
      const native = await box.nativeBox();
      await native.start();
      const main = (await box.listExecutions()).find((info) => info.isMain)!;
      const reader = await box.attach(main.executionId, false);
      const stdout = await reader.stdout();
      let text = "";
      while (!text.includes("recovered-wrapper")) {
        const chunk = await stdout.next();
        if (chunk === null) break;
        text += chunk;
      }
      expect(text).toContain("recovered-wrapper");
    } finally {
      await box.stop();
    }
  });
});
