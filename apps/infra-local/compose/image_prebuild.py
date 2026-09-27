"""Prepare L1 OCI image disks before starting any infra-local Box."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from .config import InfraConfig
from .services import SERVICES

_RESULT_PREFIX = "BOXLITE_IMAGE_DISKS="
_ROOT_BUILD_BATCH_SIZE = 3


def _run_image_tool(home: Path, mode: str, references: list[str]) -> dict[str, str]:
    tool = InfraConfig.load().repo_root / ".apps-local" / "bin" / "boxlite-infra-image"
    result = subprocess.run(
        [str(tool), "--home", str(home), "--mode", mode, *references],
        env=os.environ.copy(),
        stdout=subprocess.PIPE,
        text=True,
        timeout=1800,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(f"internal image tool failed (exit {result.returncode}); see stderr above")
    line = next((line for line in result.stdout.splitlines() if line.startswith(_RESULT_PREFIX)), None)
    if line is None:
        raise RuntimeError("internal image tool returned no disk paths")
    paths = json.loads(line[len(_RESULT_PREFIX):])
    if not isinstance(paths, dict) or set(paths) != set(references) or not all(
        isinstance(path, str) for path in paths.values()
    ):
        raise RuntimeError("internal image tool returned invalid disk paths")
    return paths


def _install_exports(expected: dict[str, Path], exported: dict[str, str]) -> None:
    if set(exported) != set(expected):
        raise RuntimeError("root builder returned a different image set")
    for reference, cache_path in expected.items():
        source = Path(exported[reference])
        if source.name != cache_path.name or not source.is_file():
            raise RuntimeError(f"root builder returned an invalid disk for {reference}")
        if source.stat().st_uid != os.getuid():
            raise RuntimeError(f"root builder did not transfer ownership of {reference}")

    for reference, cache_path in expected.items():
        source = Path(exported[reference])
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        fd, staged_name = tempfile.mkstemp(prefix=".image-disk-", dir=cache_path.parent)
        os.close(fd)
        staged = Path(staged_name)
        staged.unlink()
        try:
            try:
                os.link(source, staged)
            except OSError as exc:
                raise RuntimeError(
                    "image export and BoxLite cache must be on the same filesystem"
                ) from exc
            os.replace(staged, cache_path)
        finally:
            staged.unlink(missing_ok=True)


def _run_root_builder(references: list[str], cfg: InfraConfig) -> dict[str, str]:
    if not shutil.which("sudo"):
        raise RuntimeError("sudo is required to build missing OCI image disks")
    print(f"[infra-local] building {len(references)} missing image disk(s) as root...", flush=True)
    result = subprocess.run(
        ["sudo", "-E", sys.executable, "-m", "compose.image_prebuild", "--root-build", *references],
        cwd=cfg.repo_root / "apps" / "infra-local",
        env=os.environ.copy(),
        stdout=subprocess.PIPE,
        text=True,
        timeout=1800,
        check=False,
    )
    if result.returncode:
        raise RuntimeError(f"root image build failed (exit {result.returncode}); see stderr above")
    line = next((line for line in result.stdout.splitlines() if line.startswith(_RESULT_PREFIX)), None)
    if line is None:
        raise RuntimeError("root image build returned no disk paths")
    exported = json.loads(line[len(_RESULT_PREFIX):])
    if not isinstance(exported, dict) or not all(
        isinstance(reference, str) and isinstance(path, str)
        for reference, path in exported.items()
    ):
        raise RuntimeError("root image build returned invalid disk paths")
    return exported


def ensure_l1_image_disks(cfg: InfraConfig) -> None:
    """Pull as the developer; elevate only the OCI-to-ext4 cache misses."""
    references = list(dict.fromkeys(spec.image for spec in SERVICES.values()))
    print(f"[infra-local] checking {len(references)} L1 image disk(s)...", flush=True)
    paths = _run_image_tool(cfg.boxlite_home, "path", references)
    missing = {
        reference: Path(path)
        for reference, path in paths.items()
        if not Path(path).is_file()
    }
    if not missing:
        print("[infra-local] all L1 image disks cached; no root build needed")
        return
    if os.geteuid() == 0:
        _run_image_tool(cfg.boxlite_home, "prepare", list(missing))
        return

    exported = _run_root_builder(list(missing), cfg)
    try:
        _install_exports(missing, exported)
    finally:
        parents = {Path(path).parent for path in exported.values()}
        for parent in parents:
            if (parent.name.startswith("boxlite-image-export-")
                    and not parent.is_symlink()
                    and parent.stat().st_uid == os.getuid()):
                shutil.rmtree(parent)


def _root_build(references: list[str]) -> None:
    if os.geteuid() != 0:
        raise RuntimeError("image disk builder must run as root")
    uid = int(os.environ["SUDO_UID"])
    gid = int(os.environ["SUDO_GID"])
    export_dir = Path(tempfile.mkdtemp(prefix="boxlite-image-export-"))
    try:
        exports = {}
        # One privileged process and authentication, but bounded temporary OCI
        # caches: a full cold start can exceed the free space on a dev laptop.
        total_batches = (len(references) + _ROOT_BUILD_BATCH_SIZE - 1) // _ROOT_BUILD_BATCH_SIZE
        for start in range(0, len(references), _ROOT_BUILD_BATCH_SIZE):
            batch = references[start:start + _ROOT_BUILD_BATCH_SIZE]
            print(
                f"[infra-local] preparing batch {start // _ROOT_BUILD_BATCH_SIZE + 1}/{total_batches} "
                f"({len(batch)} image(s))...",
                file=sys.stderr,
                flush=True,
            )
            with tempfile.TemporaryDirectory(prefix="boxlite-image-root-") as root_dir:
                built = _run_image_tool(Path(root_dir) / "home", "prepare", batch)
                for reference, path in built.items():
                    disk = Path(path)
                    target = export_dir / disk.name
                    if not target.exists():
                        try:
                            os.link(disk, target)
                        except OSError as exc:
                            raise RuntimeError(
                                "root image cache and export directory must be on the same filesystem"
                            ) from exc
                    os.chmod(target, 0o600)
                    os.chown(target, uid, gid)
                    exports[reference] = str(target)
        os.chown(export_dir, uid, gid)
        print(_RESULT_PREFIX + json.dumps(exports, sort_keys=True))
    except BaseException:
        shutil.rmtree(export_dir, ignore_errors=True)
        raise


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root-build", action="store_true", required=True)
    parser.add_argument("references", nargs="+")
    args = parser.parse_args()
    _root_build(args.references)


if __name__ == "__main__":
    main()
