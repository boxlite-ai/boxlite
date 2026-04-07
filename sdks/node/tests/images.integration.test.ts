import { describe, expect, test } from "vitest";
import { JsBoxlite } from "../lib/index.js";

describe("runtime image handle integration", { timeout: 120_000 }, () => {
  test("REST runtime rejects image handle access", () => {
    const runtime = JsBoxlite.rest({ url: "http://localhost:1" });

    expect(() => runtime.images).toThrow(/Image operations not supported/);
  });

  test("pull returns image metadata", async () => {
    const runtime = JsBoxlite.withDefaultConfig();
    const result = await runtime.images.pull("alpine:latest");

    expect(result.reference).toBe("alpine:latest");
    expect(result.configDigest).toMatch(/^sha256:/);
    expect(result.layerCount).toBeGreaterThan(0);
  });

  test("list returns cached images", async () => {
    const runtime = JsBoxlite.withDefaultConfig();
    await runtime.images.pull("alpine:latest");

    const images = await runtime.images.list();

    expect(Array.isArray(images)).toBe(true);
    expect(images.length).toBeGreaterThan(0);

    const alpine = images.find(
      (info) => info.repository.includes("alpine") && info.tag === "latest",
    );
    expect(alpine).toBeDefined();
    expect(alpine?.id).toMatch(/^sha256:/);
    expect(alpine?.cachedAt).toEqual(expect.any(String));
  });
});
