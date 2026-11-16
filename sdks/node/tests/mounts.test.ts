import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// The delivery flow needs a running native VM (covered by the KVM suite).
// Here we pin the generated native surface so the TypeScript contracts and
// the actual bindings cannot drift apart.
const bindings = readFileSync(
  new URL("../native/index.d.ts", import.meta.url),
  "utf8",
);
const contracts = readFileSync(
  new URL("../lib/native-contracts.ts", import.meta.url),
  "utf8",
);

describe("mounts surface", () => {
  test("generated bindings expose the delivery handle on a box", () => {
    expect(bindings).toMatch(
      /export declare class JsBox\b[\s\S]*?get mounts\(\): JsMountsHandle/,
    );
    expect(bindings).toContain("export declare class JsMountsHandle");
    for (const operation of [
      "add(request: JsMountRequest)",
      "remove(target: string)",
      "list(): Promise<Array<JsMountInfo>>",
      "get(target: string)",
    ]) {
      expect(bindings).toContain(operation);
    }
  });

  test("generated request and info carry source, target and readOnly", () => {
    expect(bindings).toMatch(
      /interface JsMountRequest \{[\s\S]*?source: string[\s\S]*?target: string[\s\S]*?readOnly: boolean/,
    );
    expect(bindings).toMatch(
      /interface JsMountInfo \{[\s\S]*?readOnly: boolean[\s\S]*?state: string/,
    );
  });

  test("typescript contracts mirror the generated surface", () => {
    expect(contracts).toContain("export interface JsMountRequest");
    expect(contracts).toContain("export interface JsMountsHandle");
    expect(contracts).toMatch(/readonly mounts: JsMountsHandle;/);
  });
});
