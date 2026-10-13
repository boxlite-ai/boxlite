/**
 * Unit tests for BoxLite error types (no VM required).
 *
 * Tests the error hierarchy and exception behavior.
 */

import { readFileSync } from "node:fs";
import { describe, test, expect } from "vitest";
import {
  BoxliteError,
  ExecError,
  TimeoutError,
  ParseError,
  errorCode,
} from "../lib/errors.js";

describe("BoxliteError", () => {
  test("is an Error instance", () => {
    const err = new BoxliteError("test error");
    expect(err).toBeInstanceOf(Error);
  });

  test("can be thrown and caught", () => {
    expect(() => {
      throw new BoxliteError("test error");
    }).toThrow(BoxliteError);
  });

  test("stores message correctly", () => {
    const err = new BoxliteError("test message");
    expect(err.message).toBe("test message");
  });

  test("has correct name property", () => {
    const err = new BoxliteError("test");
    expect(err.name).toBe("BoxliteError");
  });

  test("has stack trace", () => {
    const err = new BoxliteError("test");
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain("BoxliteError");
  });
});

describe("ExecError", () => {
  test("inherits from BoxliteError", () => {
    const err = new ExecError("ls -la", 1, "file not found");
    expect(err).toBeInstanceOf(BoxliteError);
    expect(err).toBeInstanceOf(Error);
  });

  test("stores command, exitCode, and stderr", () => {
    const err = new ExecError("cat /nonexistent", 2, "No such file");
    expect(err.command).toBe("cat /nonexistent");
    expect(err.exitCode).toBe(2);
    expect(err.stderr).toBe("No such file");
  });

  test("formats message correctly", () => {
    const err = new ExecError("cat /nonexistent", 2, "No such file");
    expect(err.message).toContain("cat /nonexistent");
    expect(err.message).toContain("2");
    expect(err.message).toContain("No such file");
  });

  test("has correct name property", () => {
    const err = new ExecError("cmd", 1, "error");
    expect(err.name).toBe("ExecError");
  });

  test("can be caught as BoxliteError", () => {
    try {
      throw new ExecError("cmd", 1, "error");
    } catch (e) {
      expect(e).toBeInstanceOf(BoxliteError);
    }
  });

  test("handles negative exit code (signal termination)", () => {
    const err = new ExecError("sleep 100", -9, "killed");
    expect(err.exitCode).toBe(-9);
  });

  test("handles empty stderr", () => {
    const err = new ExecError("false", 1, "");
    expect(err.stderr).toBe("");
  });
});

describe("TimeoutError", () => {
  test("inherits from BoxliteError", () => {
    const err = new TimeoutError("operation timed out");
    expect(err).toBeInstanceOf(BoxliteError);
    expect(err).toBeInstanceOf(Error);
  });

  test("can be thrown and caught", () => {
    expect(() => {
      throw new TimeoutError("timeout");
    }).toThrow(TimeoutError);
  });

  test("has correct name property", () => {
    const err = new TimeoutError("test");
    expect(err.name).toBe("TimeoutError");
  });

  test("can be caught as BoxliteError", () => {
    try {
      throw new TimeoutError("timeout");
    } catch (e) {
      expect(e).toBeInstanceOf(BoxliteError);
    }
  });
});

describe("ParseError", () => {
  test("inherits from BoxliteError", () => {
    const err = new ParseError("invalid JSON output");
    expect(err).toBeInstanceOf(BoxliteError);
    expect(err).toBeInstanceOf(Error);
  });

  test("can be thrown and caught", () => {
    expect(() => {
      throw new ParseError("parse error");
    }).toThrow(ParseError);
  });

  test("has correct name property", () => {
    const err = new ParseError("test");
    expect(err.name).toBe("ParseError");
  });

  test("can be caught as BoxliteError", () => {
    try {
      throw new ParseError("parse error");
    } catch (e) {
      expect(e).toBeInstanceOf(BoxliteError);
    }
  });
});

describe("Error Hierarchy", () => {
  test("all errors inherit from BoxliteError", () => {
    expect(new ExecError("cmd", 1, "")).toBeInstanceOf(BoxliteError);
    expect(new TimeoutError("timeout")).toBeInstanceOf(BoxliteError);
    expect(new ParseError("parse")).toBeInstanceOf(BoxliteError);
  });

  test("catch all boxlite errors with base class", () => {
    const errors = [
      new BoxliteError("base"),
      new ExecError("cmd", 1, "err"),
      new TimeoutError("timeout"),
      new ParseError("parse"),
    ];

    for (const error of errors) {
      try {
        throw error;
      } catch (e) {
        expect(e).toBeInstanceOf(BoxliteError);
      }
    }
  });
});

// The prefix each variant's Display starts with and the code
// `BoxliteError::http()` gives it, read out of the Rust source so `errorCode`
// is checked against what the runtime emits rather than against a copy.
const RUST_ERRORS = readFileSync(
  new URL("../../../src/shared/src/errors.rs", import.meta.url),
  "utf8",
);

function runtimeVariants(): Array<{
  name: string;
  display: string;
  code?: string;
}> {
  const codes = new Map<string, string>();
  const http = RUST_ERRORS.slice(RUST_ERRORS.indexOf("pub fn http("));
  for (const arm of http.matchAll(
    /((?:BoxliteError::\w+(?:\(_\))?\s*\|?\s*)+)=>\s*\{?\s*\(\d+,\s*"\w+",\s*"(\w+)"\)/g,
  )) {
    for (const variant of arm[1].matchAll(/BoxliteError::(\w+)/g)) {
      codes.set(variant[1], arm[2]);
    }
  }
  return [...RUST_ERRORS.matchAll(/#\[error\("([^"]*)"\)\]\s*(\w+)/g)].map(
    ([, display, name]) => ({
      name,
      display: display.replace("{0}", ""),
      code: codes.get(name),
    }),
  );
}

describe("errorCode", () => {
  test("reads the code of every failure the runtime reports", () => {
    const variants = runtimeVariants();
    expect(variants).toHaveLength(21);

    for (const { name, display, code } of variants) {
      expect(code, `${name} has no arm in http()`).toBeDefined();
      expect(errorCode(new Error(`${display}detail`)), name).toBe(code);
    }
  });

  test("is undefined for anything the runtime did not report", () => {
    expect(errorCode(new Error("boom"))).toBeUndefined();
    expect(errorCode("not found: a string, not an Error")).toBeUndefined();
    expect(errorCode(undefined)).toBeUndefined();
  });
});
