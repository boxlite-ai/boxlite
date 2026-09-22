import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { getJsBoxlite } from "../lib/native.js";

test("SSH local native configure status disable and restart", async () => {
  const keys = mkdtempSync("/tmp/boxlite-node-ssh-");
  const runtime = getJsBoxlite().withDefaultConfig();
  const box = await runtime.create({ image: "alpine:3.19", autoRemove: false });
  try {
    for (const name of ["host", "user"])
      execFileSync("ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        `${keys}/${name}`,
      ]);
    const config = {
      listenAddress: "0.0.0.0:2222",
      hostPrivateKey: readFileSync(`${keys}/host`, "utf8"),
      accounts: [
        {
          login: "alice",
          authorizedKeys: [readFileSync(`${keys}/user.pub`, "utf8")],
        },
      ],
    };
    expect((await box.ssh.status()).generation).toBe(0n);
    expect((await box.ssh.configure(config)).enabled).toBe(true);
    expect((await box.ssh.configure(config)).generation).toBe(2n);
    expect((await box.ssh.disable()).enabled).toBe(false);
    await box.stop();
    const fresh = (await runtime.get(box.id))!;
    expect((await fresh.ssh.status()).generation).toBe(0n);
  } finally {
    await runtime.remove(box.id, true);
    rmSync(keys, { recursive: true, force: true });
  }
});
