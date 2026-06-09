/**
 * Unit tests for SimpleBoxOptions interface (no VM required).
 *
 * Tests the type structure and expected properties for cmd/user options.
 */

import { describe, test, expect } from "vitest";
import type { Secret, SimpleBoxOptions } from "../lib/simplebox.js";

describe("SimpleBoxOptions", () => {
  test("cmd defaults to undefined", () => {
    const opts: SimpleBoxOptions = {};
    expect(opts.cmd).toBeUndefined();
  });

  test("user defaults to undefined", () => {
    const opts: SimpleBoxOptions = {};
    expect(opts.user).toBeUndefined();
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

  test("accepts all SecurityOptions fields", () => {
    const opts: SimpleBoxOptions = {
      security: {
        jailerEnabled: true,
        seccompEnabled: true,
        uid: 1000,
        gid: 1000,
        newPidNs: true,
        newNetNs: false,
        chrootBase: "/srv/boxlite",
        chrootEnabled: true,
        closeFds: true,
        sanitizeEnv: true,
        envAllowlist: ["PATH", "HOME"],
        maxOpenFiles: 256,
        maxFileSize: 1073741824,
        maxProcesses: 10,
        maxMemory: 536870912,
        maxCpuTime: 60,
        networkEnabled: true,
        sandboxProfile: "/etc/boxlite/sandbox.sb",
      },
    };

    expect(opts.security?.uid).toBe(1000);
    expect(opts.security?.gid).toBe(1000);
    expect(opts.security?.newPidNs).toBe(true);
    expect(opts.security?.newNetNs).toBe(false);
    expect(opts.security?.chrootBase).toBe("/srv/boxlite");
    expect(opts.security?.chrootEnabled).toBe(true);
    expect(opts.security?.closeFds).toBe(true);
    expect(opts.security?.sanitizeEnv).toBe(true);
    expect(opts.security?.envAllowlist).toEqual(["PATH", "HOME"]);
    expect(opts.security?.maxOpenFiles).toBe(256);
    expect(opts.security?.maxFileSize).toBe(1073741824);
    expect(opts.security?.maxProcesses).toBe(10);
    expect(opts.security?.maxMemory).toBe(536870912);
    expect(opts.security?.maxCpuTime).toBe(60);
    expect(opts.security?.networkEnabled).toBe(true);
    expect(opts.security?.sandboxProfile).toBe("/etc/boxlite/sandbox.sb");
  });

  test("security options defaults to undefined", () => {
    const opts: SimpleBoxOptions = {};
    expect(opts.security).toBeUndefined();
  });

  test("security jailerEnabled defaults to undefined", () => {
    const opts: SimpleBoxOptions = { security: {} };
    expect(opts.security?.jailerEnabled).toBeUndefined();
  });

  test("sanitizeEnv with empty envAllowlist", () => {
    const opts: SimpleBoxOptions = {
      security: {
        sanitizeEnv: true,
        envAllowlist: [],
      },
    };
    expect(opts.security?.sanitizeEnv).toBe(true);
    expect(opts.security?.envAllowlist).toEqual([]);
  });

  test("security options combine with other box options", () => {
    const opts: SimpleBoxOptions = {
      image: "alpine:latest",
      memoryMib: 512,
      cpus: 2,
      security: {
        jailerEnabled: true,
        maxOpenFiles: 512,
      },
    };
    expect(opts.security?.jailerEnabled).toBe(true);
    expect(opts.security?.maxOpenFiles).toBe(512);
    expect(opts.memoryMib).toBe(512);
    expect(opts.cpus).toBe(2);
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
        mode: "enabled",
        allowNet: ["example.com", "*.openai.com"],
      },
    };

    expect(opts.network?.mode).toBe("enabled");
    expect(opts.network?.allowNet).toEqual(["example.com", "*.openai.com"]);
  });

  test("accepts disabled network mode", () => {
    const opts: SimpleBoxOptions = {
      network: {
        mode: "disabled",
      },
    };

    expect(opts.network?.mode).toBe("disabled");
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
