"""Optional sync dependencies must not hide native or async SSH tests."""

import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

import boxlite


@pytest.mark.parametrize("without_native", [False, True])
@pytest.mark.parametrize("greenlet_state", ["installed", "missing", "broken"])
def test_ssh_collection_without_optional_dependencies(
    tmp_path, without_native, greenlet_state
):
    package_root = Path(boxlite.__file__).resolve().parent.parent
    if without_native:
        shutil.copytree(
            package_root / "boxlite",
            tmp_path / "boxlite",
            ignore=shutil.ignore_patterns("__pycache__", "*.so"),
        )
        package_root = tmp_path
    tests = Path(__file__).resolve().parent
    if greenlet_state == "broken":
        (tmp_path / "greenlet.py").write_text(
            "raise ImportError('greenlet stand-in failed to load')\n"
        )
    env = dict(
        os.environ, PYTHONPATH=os.pathsep.join([str(tmp_path), str(package_root)])
    )
    env.pop("BOXLITE_REQUIRE_NATIVE", None)
    command = [
        sys.executable,
        "-c",
        "import sys; "
        + ("sys.modules['greenlet'] = None; " if greenlet_state == "missing" else "")
        + "import pytest; raise SystemExit(pytest.main(sys.argv[1:]))",
        "--collect-only",
        "--import-mode=importlib",
        "-o",
        "addopts=",
        "-q",
        str(tests / "test_ssh.py"),
        str(tests / "test_ssh_native_rest.py"),
    ]
    result = subprocess.run(
        command,
        check=False,
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    output = result.stdout + result.stderr
    for node in (
        "TestNativeConstruction::test_defaults_are_empty_credentials",
        "TestNativeReprRedaction::test_ca_repr_redacts_key_and_principal",
        "test_ssh.py::test_public_exports",
        "TestAsyncSshOverRest::test_status_reads_every_field_with_full_generation",
        "TestAsyncSshErrorsKeepTheirClass::test_configure_surfaces_invalid_argument",
        "TestRequireNativeGate::test_an_absent_extension_fails_the_run",
    ):
        assert node in output, output
    assert result.returncode == 0, output

    command.remove("--collect-only")
    command[command.index("-q")] = "-v"
    result = subprocess.run(
        command,
        check=False,
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )
    output = result.stdout + result.stderr
    if greenlet_state == "broken":
        assert result.returncode == 1, output
        assert "greenlet stand-in failed to load" in output, output
    else:
        assert result.returncode == 0, output
    assert "test_an_absent_extension_fails_the_run PASSED" in output, output
    native_absent = (
        without_native or importlib.util.find_spec("boxlite.boxlite") is None
    )
    native_result = "SKIPPED" if native_absent else "PASSED"
    for test in (
        "test_defaults_are_empty_credentials",
        "test_ca_repr_redacts_key_and_principal",
        "test_status_reads_every_field_with_full_generation",
    ):
        assert f"{test} {native_result}" in output, output
    sync_absent = (
        greenlet_state == "missing" or importlib.util.find_spec("greenlet") is None
    )
    sync_result = (
        "ERROR"
        if greenlet_state == "broken"
        else ("SKIPPED" if sync_absent else "PASSED")
    )
    assert f"test_sync_ssh_handle_is_exported_at_top_level {sync_result}" in output, (
        output
    )
    if greenlet_state == "broken" and not native_absent:
        assert "test_a_sync_box_manages_ssh_and_caches_its_handle FAILED" in output, (
            output
        )
