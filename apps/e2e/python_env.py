"""Resolve and prepare the virtual environment used by every managed E2E entry."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def interpreter(value):
    """Resolve PATH names without dereferencing a venv's Python symlink."""
    if "/" not in value:
        found = shutil.which(value)
        if not found:
            raise ValueError("E2E_PYTHON executable was not found on PATH")
        return Path(found).absolute()
    return Path(os.path.abspath(ROOT / value))


def prepare(value):
    """Prepare one isolated interpreter, bootstrapping pip only when absent."""
    python = interpreter(value)
    home = python.parent.parent
    if home.exists() and not (home / "pyvenv.cfg").is_file():
        raise ValueError("E2E_PYTHON must point into a virtual environment")
    if not home.exists():
        supported = {"python", "python3", f"python{sys.version_info.major}.{sys.version_info.minor}"}
        if python.parent.name != "bin" or python.name not in supported:
            raise ValueError("Create the requested virtual environment first with its Python version; "
                             "then set E2E_PYTHON to its existing bin/python executable")
        subprocess.run([sys.executable, "-m", "venv", str(home)], check=True)
    subprocess.run([str(python), "-c",
                    "import sys; sys.exit(0 if sys.version_info >= (3, 11) "
                    "else 'E2E requires Python 3.11+')"], check=True)
    if subprocess.run([str(python), "-m", "pip", "--version"], capture_output=True).returncode:
        subprocess.run([str(python), "-m", "ensurepip", "--upgrade"], check=True)
    version = json.loads((ROOT / "apps/e2e/dependencies.json").read_text())["uv"]
    subprocess.run([str(python), "-m", "pip", "install", "--quiet", f"uv=={version}"], check=True)
    subprocess.run(
        [str(python), "-m", "uv", "sync", "--project", "apps/e2e", "--locked",
         "--inexact", "--no-install-project", "--python", str(python), "--no-python-downloads"],
        cwd=ROOT, env=dict(os.environ, UV_PROJECT_ENVIRONMENT=str(home)), check=True)


if __name__ == "__main__":
    try:
        prepare(sys.argv[1])
    except ValueError as error:
        sys.exit(str(error))
