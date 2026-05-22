/**
 * Unit tests for CopyOutPair / CopyOutOutcome TypeScript interfaces
 * exposed by the Node SDK. End-to-end behavior of Box.copyOutMany is
 * covered by the Rust-side parser tests; integration coverage that
 * requires a running box is gated by *.integration.test.ts files
 * elsewhere in this directory.
 */

import { describe, test, expect } from "vitest";
import type { CopyOutOutcome, CopyOutPair } from "../lib/copy.js";

describe("CopyOutPair", () => {
  test("interface has containerSrc and hostDst", () => {
    const pair: CopyOutPair = {
      containerSrc: "/etc/a.txt",
      hostDst: "/host/a.txt",
    };

    expect(pair.containerSrc).toBe("/etc/a.txt");
    expect(pair.hostDst).toBe("/host/a.txt");
  });

  test("array of pairs is valid input shape", () => {
    const pairs: CopyOutPair[] = [
      { containerSrc: "/etc/a.txt", hostDst: "/host/a.txt" },
      { containerSrc: "/etc/b.txt", hostDst: "/host/b.txt" },
    ];

    expect(pairs).toHaveLength(2);
    expect(pairs[0].containerSrc).toBe("/etc/a.txt");
    expect(pairs[1].hostDst).toBe("/host/b.txt");
  });
});

describe("CopyOutOutcome", () => {
  test("interface allows null error for success", () => {
    const ok: CopyOutOutcome = {
      containerSrc: "/etc/a.txt",
      hostDst: "/host/a.txt",
      error: null,
    };

    expect(ok.error).toBeNull();
  });

  test("interface allows string error for failure", () => {
    const failed: CopyOutOutcome = {
      containerSrc: "/etc/missing.txt",
      hostDst: "/host/missing.txt",
      error: "copy: file not found",
    };

    expect(failed.error).toBe("copy: file not found");
  });
});
