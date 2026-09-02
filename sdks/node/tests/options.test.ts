/**
 * Unit tests for SimpleBoxOptions interface (no VM required).
 *
 * Tests the type structure and expected properties for box options.
 */

import { describe, test, expect, vi } from "vitest";
import type { Secret, SimpleBoxOptions } from "../lib/simplebox.js";

vi.mock("../lib/native.js", () => ({
  getJsBoxlite: () => ({
    withDefaultConfig: () => ({}),
  }),
}));

describe("SimpleBoxOptions", () => {
  test("cmd defaults to undefined", () => {
    const opts: SimpleBoxOptions = {};
    expect(opts.cmd).toBeUndefined();
  });

  test("user defaults to undefined", () => {
    const opts: SimpleBoxOptions = {};
    expect(opts.user).toBeUndefined();
  });

  test("capability policy defaults to undefined", async () => {
    const { SimpleBox } = await import("../lib/simplebox.js");
    const box = new SimpleBox();
    const nativeOptions = (box as any)._boxOpts;

    expect(nativeOptions.advanced).toBeUndefined();
  });

  test("forwards custom capability lists", async () => {
    const { SimpleBox } = await import("../lib/simplebox.js");
    const box = new SimpleBox({
      advanced: {
        capabilities: {
          add: ["NET_ADMIN", "SYS_PTRACE"],
          drop: ["MKNOD", "NET_RAW"],
        },
      },
    });
    const nativeOptions = (box as any)._boxOpts;

    expect(nativeOptions.advanced.capabilities.add).toEqual([
      "NET_ADMIN",
      "SYS_PTRACE",
    ]);
    expect(nativeOptions.advanced.capabilities.drop).toEqual([
      "MKNOD",
      "NET_RAW",
    ]);
  });

  test("accepts cmd array", () => {
    const opts: SimpleBoxOptions = {
      image: "docker:dind",
      cmd: ["--iptables=false"],
    };
    expect(opts.cmd).toEqual(["--iptables=false"]);
  });

  test("accepts user string with uid:gid", () => {
    const opts: SimpleBoxOptions = {
      image: "alpine:latest",
      user: "1000:1000",
    };
    expect(opts.user).toBe("1000:1000");
  });

  test("accepts cmd with multiple arguments", () => {
    const opts: SimpleBoxOptions = {
      image: "python:slim",
      cmd: ["-m", "http.server", "8080"],
    };
    expect(opts.cmd).toEqual(["-m", "http.server", "8080"]);
  });

  test("accepts empty cmd array", () => {
    const opts: SimpleBoxOptions = {
      image: "alpine:latest",
      cmd: [],
    };
    expect(opts.cmd).toEqual([]);
  });

  test("accepts user with uid only", () => {
    const opts: SimpleBoxOptions = {
      image: "alpine:latest",
      user: "1000",
    };
    expect(opts.user).toBe("1000");
  });

  test("accepts user with username", () => {
    const opts: SimpleBoxOptions = {
      image: "nginx:latest",
      user: "nginx",
    };
    expect(opts.user).toBe("nginx");
  });

  test("accepts security options", () => {
    const opts: SimpleBoxOptions = {
      security: {
        jailerEnabled: true,
        seccompEnabled: true,
        maxOpenFiles: 1024,
      },
    };

    expect(opts.security?.jailerEnabled).toBe(true);
    expect(opts.security?.seccompEnabled).toBe(true);
    expect(opts.security?.maxOpenFiles).toBe(1024);
  });

  test("cmd and user can be combined with other options", () => {
    const opts: SimpleBoxOptions = {
      image: "python:slim",
      memoryMib: 1024,
      cpus: 2,
      cmd: ["--flag"],
      user: "1000:1000",
      env: { FOO: "bar" },
      workingDir: "/app",
    };

    expect(opts.cmd).toEqual(["--flag"]);
    expect(opts.user).toBe("1000:1000");
    expect(opts.memoryMib).toBe(1024);
    expect(opts.cpus).toBe(2);
  });

  test("diskSizeGb defaults to undefined", () => {
    const opts: SimpleBoxOptions = {};
    expect(opts.diskSizeGb).toBeUndefined();
  });

  test("accepts diskSizeGb number", () => {
    const opts: SimpleBoxOptions = {
      image: "python:slim",
      diskSizeGb: 10,
    };
    expect(opts.diskSizeGb).toBe(10);
  });

  test("accepts fractional diskSizeGb", () => {
    const opts: SimpleBoxOptions = {
      image: "alpine:latest",
      diskSizeGb: 5.5,
    };
    expect(opts.diskSizeGb).toBe(5.5);
  });

  test("diskSizeGb can be combined with other options", () => {
    const opts: SimpleBoxOptions = {
      image: "python:slim",
      memoryMib: 1024,
      cpus: 2,
      diskSizeGb: 20,
      env: { FOO: "bar" },
    };

    expect(opts.diskSizeGb).toBe(20);
    expect(opts.memoryMib).toBe(1024);
    expect(opts.cpus).toBe(2);
  });

  test("accepts structured network allowlist", () => {
    const opts: SimpleBoxOptions = {
      network: {
        outbound: {
          mode: "enabled",
          allowNet: ["example.com", "*.openai.com"],
        },
      },
    };

    expect(opts.network?.outbound?.mode).toBe("enabled");
    expect(opts.network?.outbound?.allowNet).toEqual([
      "example.com",
      "*.openai.com",
    ]);
  });

  test("accepts disabled network mode", () => {
    const opts: SimpleBoxOptions = {
      network: {
        outbound: {
          mode: "disabled",
        },
      },
    };

    expect(opts.network?.outbound?.mode).toBe("disabled");
  });

  test("accepts the deprecated flat network shape", async () => {
    const { SimpleBox } = await import("../lib/simplebox.js");
    const box = new SimpleBox({
      network: { mode: "enabled", allowNet: ["example.com"] },
    } as any);

    // Passed through to the native layer, which folds it into outbound.
    expect((box as any)._boxOpts.network).toEqual({
      mode: "enabled",
      allowNet: ["example.com"],
    });
  });

  test("rejects mixing the flat shape with outbound", async () => {
    const { SimpleBox } = await import("../lib/simplebox.js");

    expect(
      () =>
        new SimpleBox({
          network: { mode: "enabled", outbound: { mode: "disabled" } },
        } as any),
    ).toThrow("cannot mix outbound with the deprecated mode/allowNet");
  });

  test("still accepts the flat shape alongside inbound", async () => {
    const { SimpleBox } = await import("../lib/simplebox.js");
    const box = new SimpleBox({
      network: { mode: "enabled", inbound: { mode: "disabled" } },
    } as any);

    expect((box as any)._boxOpts.network).toEqual({
      mode: "enabled",
      inbound: { mode: "disabled" },
    });
  });

  test.each([
    [
      "mode",
      { mode: 42 },
      'SimpleBoxOptions.network.mode must be "enabled" or "disabled"',
    ],
    [
      "allowNet",
      { allowNet: "example.com" },
      "SimpleBoxOptions.network.allowNet must be an array",
    ],
  ])(
    "rejects malformed deprecated network.%s",
    async (_field, network, message) => {
      const { SimpleBox } = await import("../lib/simplebox.js");

      expect(() => new SimpleBox({ network } as any)).toThrow(message);
    },
  );

  test.each([
    ["array", []],
    ["number", 42],
    ["boolean", true],
  ])("rejects malformed network %s", async (_name, network) => {
    const { SimpleBox } = await import("../lib/simplebox.js");

    expect(() => new SimpleBox({ network } as any)).toThrow(
      "SimpleBoxOptions.network must be an object",
    );
  });

  test("rejects empty network objects", async () => {
    const { SimpleBox } = await import("../lib/simplebox.js");

    expect(() => new SimpleBox({ network: {} } as any)).toThrow(
      "SimpleBoxOptions.network must include outbound or inbound",
    );
  });

  test.each([
    ["outbound", { outbound: [] }],
    ["inbound", { inbound: [] }],
  ])("rejects array-valued network.%s", async (field, network) => {
    const { SimpleBox } = await import("../lib/simplebox.js");

    expect(() => new SimpleBox({ network } as any)).toThrow(
      `SimpleBoxOptions.network.${field} must be an object`,
    );
  });

  // Without a mode check here an empty `{}` reaches lazy native creation and
  // fails with a napi deserialization error that never names the field.
  test.each([
    ["outbound", { outbound: {} }],
    ["inbound", { inbound: {} }],
    ["outbound", { outbound: { allowNet: ["api.openai.com"] } }],
  ])("rejects network.%s without mode", async (field, network) => {
    const { SimpleBox } = await import("../lib/simplebox.js");

    expect(() => new SimpleBox({ network } as any)).toThrow(
      `SimpleBoxOptions.network.${field}.mode is required`,
    );
  });

  test("accepts managed volume mounts by id and by name", async () => {
    const { SimpleBox } = await import("../lib/simplebox.js");
    const box = new SimpleBox({
      volumes: [
        { managedVolume: "vol_01K2EXAMPLE", guestPath: "/data" },
        { managedVolume: "my-data", guestPath: "/cache" },
      ],
    });
    const nativeOptions = (box as any)._boxOpts;

    expect(nativeOptions.volumes).toEqual([
      { managedVolume: "vol_01K2EXAMPLE", guestPath: "/data" },
      { managedVolume: "my-data", guestPath: "/cache" },
    ]);
  });

  test("accepts secrets", () => {
    const secret: Secret = {
      name: "openai",
      value: "sk-test",
      hosts: ["api.openai.com"],
    };
    const opts: SimpleBoxOptions = {
      secrets: [secret],
    };

    expect(opts.secrets).toEqual([secret]);
  });

  test("accepts custom secret placeholder", () => {
    const opts: SimpleBoxOptions = {
      secrets: [
        {
          name: "anthropic",
          value: "test-value",
          placeholder: "<CUSTOM_SECRET>",
        },
      ],
    };

    expect(opts.secrets?.[0].placeholder).toBe("<CUSTOM_SECRET>");
  });
});
