#!/usr/bin/env python3
"""Build the E2E MinIO image from checksum-locked official release artifacts."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DOCKERFILE = ROOT / "apps/e2e/Minio.Dockerfile"


def _locked_inputs():
    lock = json.loads((ROOT / "apps/e2e/dependencies.json").read_text())["minio"]
    machine = platform.machine().lower()
    architecture = {"x86_64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(machine)
    if architecture is None:
        raise RuntimeError(f"Unsupported MinIO host architecture: {machine}")
    for name, checksum in (("binary", lock["sha256"][architecture]),
                           ("license", lock["license_sha256"])):
        if len(checksum) != 64 or any(c not in "0123456789abcdef" for c in checksum):
            raise RuntimeError(f"Invalid locked MinIO {name} SHA-256: {checksum!r}")
    return lock, architecture


def _identity(lock, architecture):
    inputs = [architecture, lock["release"], lock["sha256"][architecture], lock["license_sha256"]]
    digest = hashlib.sha256(json.dumps(inputs, separators=(",", ":")).encode())
    digest.update(b"\0")
    digest.update(DOCKERFILE.read_bytes())
    return digest.hexdigest()


def image_ref() -> str:
    lock, architecture = _locked_inputs()
    return f"localhost/boxlite-e2e-minio:{_identity(lock, architecture)}"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download_verified(url: str, path: Path, expected_sha: str, attempts: int = 3):
    path = Path(path)
    if path.exists():
        actual = _sha256(path)
        if actual != expected_sha:
            raise RuntimeError(f"Cached SHA-256 mismatch for {path}: expected {expected_sha}, got {actual}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    failure = "no attempt made"
    for attempt in range(1, attempts + 1):
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=path.parent, prefix=f".{path.name}.", delete=False) as stream:
                temporary = Path(stream.name)
                digest = hashlib.sha256()
                with urllib.request.urlopen(url, timeout=120) as response:
                    declared = response.headers.get("Content-Length")
                    received = 0
                    for block in iter(lambda: response.read(1024 * 1024), b""):
                        stream.write(block)
                        digest.update(block)
                        received += len(block)
                actual = digest.hexdigest()
            if declared is not None and received != int(declared):
                failure = f"Truncated download of {url}: received {received} of {declared} bytes"
            elif actual != expected_sha:
                failure = f"SHA-256 mismatch for {url}: expected {expected_sha}, got {actual}"
            else:
                temporary.replace(path)
                return
        except (OSError, urllib.error.URLError) as exc:
            failure = f"Cannot download {url} to {path}: {exc}"
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        print(f"MinIO download attempt {attempt}/{attempts} failed: {failure}", file=sys.stderr)
    raise RuntimeError(failure)


def _place(source: Path, target: Path):
    """Materialize a cached artifact into the build context without invalidating the cache."""
    if target.exists() and _sha256(target) == _sha256(source):
        return
    target.unlink(missing_ok=True)
    try:
        os.link(source, target)
    except OSError:
        shutil.copyfile(source, target)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state-dir", type=Path, required=True)
    args = parser.parse_args()
    lock, architecture = _locked_inputs()
    state = args.state_dir.resolve()
    cache = state / "minio-cache"
    binary = cache / lock["sha256"][architecture]
    release = lock["release"]
    binary_url = f"https://github.com/minio/minio/releases/download/{release}/minio.linux-{architecture}.{release}"
    license_url = f"https://raw.githubusercontent.com/minio/minio/{release}/LICENSE"
    download_verified(binary_url, binary, lock["sha256"][architecture])
    license_file = cache / lock["license_sha256"]
    download_verified(license_url, license_file, lock["license_sha256"])
    context = state / "minio" / _identity(lock, architecture)
    context.mkdir(parents=True, exist_ok=True)
    _place(binary, context / "minio")
    _place(license_file, context / "LICENSE")
    (context / "minio").chmod(0o755)
    subprocess.run(["docker", "build", "-t", image_ref(), "-f", str(DOCKERFILE),
                    "--build-arg", f"MINIO_RELEASE={release}", str(context)], check=True)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as exc:
        print(f"MinIO image build failed: {exc}", file=sys.stderr)
        sys.exit(1)
