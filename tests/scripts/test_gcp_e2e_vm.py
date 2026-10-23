"""Exercise gcp-e2e-vm.sh start against a zone that lacks capacity."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/ci/gcp-e2e-vm.sh"

# Model the VM at the gcloud/gh/curl boundary. A rejected start (as on
# ZONE_RESOURCE_POOL_EXHAUSTED) leaves the VM TERMINATED; the controller cannot
# read the failed operation, only the instance status.
FAKE_TOOL = """#!/usr/bin/env python3
import json
import os
import sys
from pathlib import Path

state_path = Path(os.environ["FAKE_VM_STATE"])
state = json.loads(state_path.read_text())
tool = Path(sys.argv[0]).name
args = sys.argv[1:]

def save():
    state_path.write_text(json.dumps(state))

if tool == "sleep":
    pass
elif tool == "gh":
    print("reg-token" if any("registration-token" in a for a in args) else "false")
elif tool == "curl":
    state["metadata"]["items"] = json.load(sys.stdin)["items"]
    save()
elif args[:2] == ["auth", "print-access-token"]:
    print("access-token")
elif args[:2] == ["compute", "instances"]:
    verb = args[2]
    if verb == "describe" and "--format=json" in args:
        print(json.dumps({"metadata": dict(state["metadata"], fingerprint="f")}))
    elif verb == "describe":
        print(state["status"])
    elif verb == "start":
        state["starts"] += 1
        if state["starts"] > state["rejected_starts"]:
            state["status"] = "RUNNING"
        save()
    else:
        sys.exit("unexpected gcloud verb: " + verb)
else:
    sys.exit("unexpected call: " + tool + " " + " ".join(args))
"""


class StartRetryTest(unittest.TestCase):
    def run_start(self, rejected_starts):
        with tempfile.TemporaryDirectory() as scratch:
            tools = Path(scratch) / "bin"
            tools.mkdir()
            for name in ("gcloud", "gh", "curl", "sleep"):
                executable = tools / name
                executable.write_text(FAKE_TOOL)
                executable.chmod(0o755)
            state = Path(scratch) / "vm.json"
            state.write_text(json.dumps({
                "status": "TERMINATED",
                "starts": 0,
                "rejected_starts": rejected_starts,
                "metadata": {"items": []},
            }))

            env = os.environ.copy()
            env["PATH"] = str(tools) + os.pathsep + env["PATH"]
            env.update(
                FAKE_VM_STATE=str(state),
                GCP_PROJECT="p",
                GCP_ZONE="z",
                GCP_INSTANCE="vm",
                RUNNER_LABEL="gcp-e2e",
                REPO="o/r",
            )
            result = subprocess.run(
                ["bash", str(SCRIPT), "start"],
                check=False,
                capture_output=True,
                text=True,
                env=env,
                timeout=60,
            )
            return result, json.loads(state.read_text())

    def test_retries_a_start_the_zone_rejected(self):
        result, vm = self.run_start(rejected_starts=1)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(vm["starts"], 2)
        self.assertEqual(vm["status"], "RUNNING")

    def test_gives_up_when_every_start_is_rejected(self):
        result, vm = self.run_start(rejected_starts=100)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(vm["starts"], 6)
        self.assertIn("could not start vm after 6 attempts", result.stderr)


if __name__ == "__main__":
    unittest.main()
