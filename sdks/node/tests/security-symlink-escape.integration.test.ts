/**
 * Regression test for GHSA-f396-4rp4-7v2j (OCI layer symlink escape).
 *
 * A crafted OCI layer with a symlink pointing outside the extraction root
 * (e.g. `escape -> /tmp`) followed by a file entry at `escape/<path>` must
 * NOT be allowed to write through to the host filesystem. The v0.9.0 fix
 * enforces this via SafeRoot containment in the Rust extractor; this Node
 * test exercises the same defense through the napi-rs binding by loading
 * a malicious local OCI layout via `SimpleBox({ rootfsPath })`.
 *
 * Node-SDK counterpart of sdks/python/tests/test_symlink_escape.py and the
 * unit test src/boxlite/src/images/archive/extractor.rs::test_cve_symlink_escape_blocked.
 *
 * Requires:
 *  - make dev:node (build Node SDK)
 *  - VM runtime for integration tests (libkrun / Hypervisor.framework)
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SimpleBox } from "../lib/simplebox.js";

const TARGET_FILE = "/tmp/boxlite_host_escape_node/pwned.txt";

// ── Minimal USTAR tar builder ─────────────────────────────────────────────────
// Hand-rolled to avoid adding a tar dependency for a single security regression
// test. Matches the GNU/USTAR header format the Rust extractor parses.

type EntryType = "file" | "dir" | "symlink";

interface TarEntry {
  name: string;
  type: EntryType;
  linkname?: string;
  data?: Buffer;
  mode?: number;
}

function tarHeader(entry: TarEntry, mtime: number): Buffer {
  const buf = Buffer.alloc(512);
  buf.write(entry.name.slice(0, 100), 0, "utf8");
  const mode =
    entry.mode ??
    (entry.type === "symlink" ? 0o777 : entry.type === "dir" ? 0o755 : 0o644);
  buf.write(mode.toString(8).padStart(7, "0") + "\0", 100);
  buf.write("0000000\0", 108); // uid
  buf.write("0000000\0", 116); // gid
  const size = entry.type === "file" ? entry.data!.length : 0;
  buf.write(size.toString(8).padStart(11, "0") + "\0", 124);
  buf.write(mtime.toString(8).padStart(11, "0") + "\0", 136);
  // chksum: placeholder spaces while computing
  buf.fill(0x20, 148, 156);
  const typeflag =
    entry.type === "file" ? "0" : entry.type === "symlink" ? "2" : "5";
  buf.write(typeflag, 156);
  if (entry.linkname) buf.write(entry.linkname.slice(0, 100), 157, "utf8");
  buf.write("ustar\0", 257);
  buf.write("00", 263);

  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return buf;
}

function buildTar(entries: TarEntry[]): Buffer {
  const mtime = Math.floor(Date.now() / 1000);
  const chunks: Buffer[] = [];
  for (const e of entries) {
    chunks.push(tarHeader(e, mtime));
    if (e.type === "file" && e.data && e.data.length > 0) {
      chunks.push(e.data);
      const pad = (512 - (e.data.length % 512)) % 512;
      if (pad > 0) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(1024)); // two zero blocks = end of archive
  return Buffer.concat(chunks);
}

// ── Malicious OCI layout: tar entries [symlink "escape" -> /tmp/...] +
//    file "escape/<...>/pwned.txt"; the second entry resolves through the
//    symlink and would land on the host without containment. ────────────────

function buildMaliciousOciLayout(layoutDir: string): void {
  mkdirSync(join(layoutDir, "blobs", "sha256"), { recursive: true });

  // The exact PoC shape: symlink pointing to /tmp + a file path that
  // dereferences through it. We aim the escape at /tmp/boxlite_host_escape_node
  // (distinct from the Python test's /tmp/boxlite_host_escape so the two
  // tests don't share state).
  const payload = Buffer.from(
    `===== BOXLITE NODE SDK SYMLINK ESCAPE PoC =====\nTarget: ${TARGET_FILE}\n`,
  );

  const layer = buildTar([
    { name: "escape", type: "symlink", linkname: "/tmp" },
    { name: "escape/boxlite_host_escape_node", type: "dir" },
    {
      name: "escape/boxlite_host_escape_node/pwned.txt",
      type: "file",
      data: payload,
    },
    {
      name: "etc/os-release",
      type: "file",
      data: Buffer.from("ID=alpine\nVERSION_ID=3.19.0\n"),
    },
  ]);

  const writeBlob = (data: Buffer): { digest: string; size: number } => {
    const digest = createHash("sha256").update(data).digest("hex");
    writeFileSync(join(layoutDir, "blobs", "sha256", digest), data);
    return { digest, size: data.length };
  };

  const layerBlob = writeBlob(layer);
  const config = Buffer.from(
    JSON.stringify({
      architecture: "amd64",
      os: "linux",
      config: { Cmd: ["/bin/sh"] },
      rootfs: { type: "layers", diff_ids: [`sha256:${layerBlob.digest}`] },
    }),
  );
  const cfgBlob = writeBlob(config);

  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: `sha256:${cfgBlob.digest}`,
        size: cfgBlob.size,
      },
      layers: [
        {
          mediaType: "application/vnd.oci.image.layer.v1.tar",
          digest: `sha256:${layerBlob.digest}`,
          size: layerBlob.size,
        },
      ],
    }),
  );
  const mfBlob = writeBlob(manifest);

  writeFileSync(
    join(layoutDir, "index.json"),
    JSON.stringify({
      schemaVersion: 2,
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: `sha256:${mfBlob.digest}`,
          size: mfBlob.size,
          annotations: { "org.opencontainers.image.ref.name": "latest" },
        },
      ],
    }),
  );
  writeFileSync(
    join(layoutDir, "oci-layout"),
    JSON.stringify({ imageLayoutVersion: "1.0.0" }),
  );
}

describe(
  "GHSA-f396-4rp4-7v2j: OCI layer symlink escape",
  { timeout: 180_000 },
  () => {
    let layoutDir: string;

    beforeAll(() => {
      // Pre-clean any state from a previous run.
      rmSync(TARGET_FILE, { force: true });
      rmSync("/tmp/boxlite_host_escape_node", { recursive: true, force: true });
      layoutDir = mkdtempSync(join(tmpdir(), "malicious-oci-node-"));
      buildMaliciousOciLayout(layoutDir);
    });

    afterAll(() => {
      rmSync(layoutDir, { recursive: true, force: true });
      // Best-effort: if the test failed and the host file exists, leave it for
      // post-mortem; the assertion message points at it.
    });

    test("rootfsPath of malicious OCI layout cannot write through escape symlink", async () => {
      expect(
        existsSync(TARGET_FILE),
        "host file must not exist before exploit attempt",
      ).toBe(false);

      const box = new SimpleBox({ rootfsPath: layoutDir });
      try {
        // Box may fail to start (incomplete rootfs) — that's fine; the
        // vulnerability fires during layer extraction, before VM launch.
        await box.exec("sh", "-c", "echo ok").catch(() => {});
      } finally {
        await box.stop().catch(() => {});
      }

      // The advisory's exploit oracle: if this host file now exists, the
      // sandbox was escaped during OCI extraction.
      expect(
        existsSync(TARGET_FILE),
        `GHSA-f396-4rp4-7v2j: host file written via escape symlink at ${TARGET_FILE} — SafeRoot containment failed`,
      ).toBe(false);
    });
  },
);
