import { describe, expect, test } from "vitest";
import { SimpleBox } from "../lib/simplebox.js";

describe("SimpleBox network and secrets", { timeout: 180_000 }, () => {
  test("rejects legacy string network", () => {
    expect(
      () =>
        new SimpleBox({ image: "alpine:latest", network: "enabled" } as any),
    ).toThrow("SimpleBoxOptions.network must be an object");
  });

  test("rejects legacy top-level allowNet", () => {
    expect(
      () =>
        new SimpleBox({
          image: "alpine:latest",
          allowNet: ["example.com"],
        } as any),
    ).toThrow("SimpleBoxOptions.allowNet was removed");
  });

  test("disabled network removes eth0", async () => {
    const box = new SimpleBox({
      image: "alpine:latest",
      network: { mode: "disabled" },
      autoRemove: true,
    });

    try {
      const result = await box.exec("sh", [
        "-c",
        "test ! -e /sys/class/net/eth0",
      ]);
      expect(result.exitCode).toBe(0);
    } finally {
      await box.stop();
    }
  });

  test("allowNet permits listed host access", async () => {
    const box = new SimpleBox({
      image: "alpine:latest",
      network: {
        mode: "enabled",
        allowNet: ["example.com"],
      },
      autoRemove: true,
    });

    try {
      const result = await box.exec("wget", [
        "-q",
        "-T",
        "10",
        "-O-",
        "http://example.com",
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toLowerCase()).toContain("example domain");
    } finally {
      await box.stop();
    }
  });

  test("secrets are substituted at the network boundary", async () => {
    const box = new SimpleBox({
      image: "python:slim",
      network: {
        mode: "enabled",
        allowNet: ["httpbin.org"],
      },
      secrets: [
        {
          name: "testkey",
          value: "super-secret-value",
          hosts: ["httpbin.org"],
        },
      ],
      autoRemove: true,
    });

    try {
      const result = await box.exec("python3", [
        "-c",
        [
          "import os, urllib.request",
          "req = urllib.request.Request(",
          "  'https://httpbin.org/headers',",
          "  headers={'Authorization': 'Bearer ' + os.environ['BOXLITE_SECRET_TESTKEY']},",
          ")",
          "print(urllib.request.urlopen(req, timeout=20).read().decode())",
        ].join("\n"),
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("super-secret-value");
      expect(result.stdout).not.toContain("<BOXLITE_SECRET:testkey>");
    } finally {
      await box.stop();
    }
  });
});
