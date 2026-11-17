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


POOL_TOOL = """#!/usr/bin/env python3
import json
import os
import subprocess
import sys
from pathlib import Path

path = Path(os.environ["FAKE_VM_STATE"])
state = json.loads(path.read_text())
name = os.environ["GCP_INSTANCE"]
vm = state["vms"][name]
tool = Path(sys.argv[0]).name
args = sys.argv[1:]

def save():
    path.write_text(json.dumps(state))

if tool == "sleep":
    vm["sleeps"].append(int(args[0]))
    save()
elif tool == "gh":
    if any("registration-token" in a for a in args):
        print("reg-token")
    else:
        result = subprocess.run(["jq", "-r", args[args.index("--jq") + 1]],
            input=json.dumps({"runners": state.get("runners", [])}), text=True)
        sys.exit(result.returncode)
elif tool == "curl":
    assert "/zones/" + os.environ["GCP_ZONE"] + "/instances/" + name + "/" in args[-1]
    data = json.load(sys.stdin)
    if vm.get("metadata_error") or (vm.get("cleanup_error") and not data["items"]):
        sys.exit(22)
    vm["metadata"] = data
    save()
elif args[:2] == ["auth", "print-access-token"]:
    print("access-token")
elif args[:2] == ["compute", "instances"]:
    assert args[3] == name
    assert args[args.index("--zone") + 1] == vm["zone"]
    verb = args[2]
    if vm.get("auth_error"):
        sys.exit(9)
    if verb == "describe" and "--format=json" in args:
        print(json.dumps({"metadata": dict(vm["metadata"], fingerprint="f")}))
    elif verb == "describe":
        print(vm["status"])
    elif verb == "start":
        vm["starts"] += 1
        if vm.get("start_error"):
            save()
            print(vm["start_error"], file=sys.stderr)
            sys.exit(vm.get("start_exit", 1))
        if vm["starts"] > vm["rejected_starts"]:
            vm["status"] = vm.get("start_status", "RUNNING")
        save()
    elif verb == "stop":
        vm["stops"] += 1
        vm["status"] = "TERMINATED"
        save()
    else:
        sys.exit("unexpected verb: " + verb)
else:
    sys.exit("unexpected tool call: " + tool)
"""


class PoolTest(unittest.TestCase):
    def run_pool(self, primary=None, backup=None, runners=None):
        with tempfile.TemporaryDirectory() as scratch:
            directory = Path(scratch)
            for name in ("gcloud", "gh", "curl", "sleep"):
                executable = directory / name
                executable.write_text(POOL_TOOL)
                executable.chmod(0o755)

            def instance(zone, overrides):
                return dict({"zone": zone, "status": "TERMINATED", "starts": 0,
                             "stops": 0, "rejected_starts": 0, "sleeps": [],
                             "metadata": {"items": []}}, **(overrides or {}))

            state = directory / "state.json"
            state.write_text(json.dumps({
                "vms": {"primary": instance("us-east5-a", primary),
                        "backup": instance("us-east4-a", backup)},
                "runners": runners or [],
            }))
            output = directory / "output"
            output.touch()
            env = dict(os.environ, PATH=str(directory) + os.pathsep + os.environ["PATH"],
                       FAKE_VM_STATE=str(state), GCP_PROJECT="p", GCP_ZONE="us-east5-a",
                       GCP_INSTANCE="primary", GCP_FALLBACK_ZONE="us-east4-a",
                       GCP_FALLBACK_INSTANCE="backup", RUNNER_LABEL="gcp-e2e", REPO="o/r",
                       GITHUB_OUTPUT=str(output))
            result = subprocess.run(["bash", str(SCRIPT), "start-pool"], env=env,
                                    capture_output=True, text=True, timeout=60)
            outputs = dict(line.split("=", 1) for line in output.read_text().splitlines())
            return result, json.loads(state.read_text())["vms"], outputs

    def test_first_rejected_primary_uses_backup_and_clears_primary_token(self):
        result, vms, output = self.run_pool(primary={"rejected_starts": 100})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(vms["primary"]["starts"], 1)
        self.assertEqual(vms["primary"]["sleeps"], [5] * 11)
        self.assertEqual(vms["primary"]["metadata"]["items"], [])
        self.assertEqual(vms["backup"]["starts"], 1)
        self.assertEqual(vms["backup"]["status"], "RUNNING")
        self.assertEqual(output, {"zone": "us-east4-a", "instance": "backup"})

    def test_explicit_capacity_error_selects_backup_without_waiting(self):
        for error in (
            "ERROR: ZONE_RESOURCE_POOL_EXHAUSTED",
            "ERROR: [ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS] CPU capacity",
            "The zone 'projects/p/zones/us-east5-a' does not have enough resources available to fulfill the request.",
            "The zone 'projects/p/zones/us-east5-a' does not have\n enough resources available to fulfill the request.",
        ):
            with self.subTest(error=error):
                result, vms, output = self.run_pool(primary={"start_error": error})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(error, result.stderr)
                self.assertEqual(vms["primary"]["starts"], 1)
                self.assertEqual(vms["primary"]["sleeps"], [])
                self.assertEqual(vms["primary"]["metadata"]["items"], [])
                self.assertEqual(vms["backup"]["starts"], 1)
                self.assertEqual(output, {"zone": "us-east4-a", "instance": "backup"})

    def test_other_start_errors_fail_without_retry_or_fallback(self):
        for error in ("PERMISSION_DENIED", "QUOTA_EXCEEDED", "Connection reset",
                      "ZONE_RESOURCE_POOL_EXHAUSTED_UNKNOWN", "Unknown failure"):
            with self.subTest(error=error):
                result, vms, output = self.run_pool(primary={"start_error": error, "start_exit": 9})
                self.assertEqual(result.returncode, 9, result.stderr)
                self.assertIn(error, result.stderr)
                self.assertEqual(vms["primary"]["starts"], 1)
                self.assertEqual(vms["primary"]["sleeps"], [])
                self.assertEqual(vms["backup"]["starts"], 0)
                self.assertEqual(output, {"zone": "us-east5-a", "instance": "primary"})

    def test_pending_primary_boot_does_not_select_backup(self):
        result, vms, output = self.run_pool(primary={"start_status": "PROVISIONING"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("did not reach RUNNING within 5 minutes", result.stderr)
        self.assertEqual(vms["primary"]["starts"], 1)
        self.assertEqual(vms["primary"]["sleeps"], [5] * 60)
        self.assertEqual(vms["backup"]["starts"], 0)
        self.assertEqual(output, {"zone": "us-east5-a", "instance": "primary"})

    def test_backup_retains_six_attempts_for_explicit_capacity_errors(self):
        result, vms, output = self.run_pool(
            primary={"start_error": "ZONE_RESOURCE_POOL_EXHAUSTED"},
            backup={"start_error": "ZONE_RESOURCE_POOL_EXHAUSTED"})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(vms["primary"]["starts"], 1)
        self.assertEqual(vms["primary"]["sleeps"], [])
        self.assertEqual(vms["backup"]["starts"], 6)
        self.assertEqual(vms["backup"]["sleeps"], [60] * 5)
        self.assertEqual(output, {"zone": "us-east4-a", "instance": "backup"})

    def test_primary_success_does_not_touch_a_retained_debug_backup(self):
        result, vms, output = self.run_pool(backup={"status": "RUNNING"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(vms["primary"]["starts"], 1)
        self.assertEqual(vms["backup"]["starts"], 0)
        self.assertEqual(vms["backup"]["stops"], 0)
        self.assertEqual(vms["backup"]["status"], "RUNNING")
        self.assertEqual(output, {"zone": "us-east5-a", "instance": "primary"})

    def test_both_exhausted_preserves_backup_cleanup_identity(self):
        result, vms, output = self.run_pool(
            primary={"rejected_starts": 100}, backup={"rejected_starts": 100})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(vms["primary"]["metadata"]["items"], [])
        self.assertEqual(vms["backup"]["starts"], 6)
        self.assertEqual(output, {"zone": "us-east4-a", "instance": "backup"})

    def test_authentication_and_metadata_errors_do_not_select_backup(self):
        for error in ("auth_error", "metadata_error", "cleanup_error"):
            with self.subTest(error=error):
                result, vms, output = self.run_pool(primary={error: True, "rejected_starts": 100})
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(vms["backup"]["starts"], 0)
                self.assertEqual(output, {"zone": "us-east5-a", "instance": "primary"})

    def test_other_online_runner_does_not_skip_primary_registration(self):
        result, vms, _ = self.run_pool(primary={"status": "RUNNING"}, runners=[
            {"name": "backup", "status": "online", "labels": [{"name": "gcp-e2e"}]},
        ])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(vms["primary"]["stops"], 1)
        self.assertEqual(vms["primary"]["starts"], 1)

    def test_reuses_the_selected_online_runner(self):
        result, vms, _ = self.run_pool(primary={"status": "RUNNING"}, runners=[
            {"name": "primary", "status": "online", "labels": [{"name": "gcp-e2e"}]},
        ])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(vms["primary"]["stops"], 0)
        self.assertEqual(vms["primary"]["starts"], 0)
        self.assertEqual(vms["backup"]["starts"], 0)


if __name__ == "__main__":
    unittest.main()
