import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from compose import _local_arm64


class LocalSdkTests(unittest.TestCase):
    def test_maturin_uses_project_venv_with_conda_active(self):
        with TemporaryDirectory() as tmp:
            venv = Path(tmp) / "venv"
            maturin = venv / "bin" / "maturin"
            maturin.parent.mkdir(parents=True)
            maturin.touch()
            with (
                patch.object(_local_arm64, "_boxlite_is_local_build", return_value=False),
                patch.object(_local_arm64, "ensure_shared_target"),
                patch.object(_local_arm64, "ensure_submodules"),
                patch.object(_local_arm64.sys, "prefix", str(venv)),
                patch.dict(os.environ, {"CONDA_PREFIX": "/active-conda"}),
                patch.object(_local_arm64.subprocess, "run") as run,
            ):
                _local_arm64.ensure_local_boxlite()

                self.assertEqual(run.call_args.args[0], [str(maturin), "develop"])
                build_env = run.call_args.kwargs["env"]
                self.assertEqual(build_env["VIRTUAL_ENV"], str(venv))
                self.assertIsNone(build_env.get("CONDA_PREFIX"))
                self.assertEqual(os.environ["CONDA_PREFIX"], "/active-conda")
