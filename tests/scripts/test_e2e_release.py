"""Exercise release client installation at the download/process/filesystem boundary."""

import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/ci/install-e2e-release.sh"
TAG = "v0.13.1"

FAKE_TOOL = r'''
import json
import os
from pathlib import Path
import shutil
import sys

tool = Path(sys.argv[0]).name
args = sys.argv[1:]
with open(os.environ["CALL_LOG"], "a") as log:
    log.write(json.dumps({"tool": tool, "args": args, "cwd": os.getcwd(),
                          "target": os.environ.get("CARGO_TARGET_DIR")}) + "\n")
if os.environ.get("FAIL_TOOL") == tool:
    sys.exit(19)
if tool == "gh":
    if args[:2] == ["release", "view"]:
        print(os.environ.get("PUBLISHED_TAG", args[2]))
    else:
        name = args[args.index("--pattern") + 1]
        destination = Path(args[args.index("--dir") + 1])
        shutil.copyfile(Path(os.environ["ASSETS"]) / name, destination / name)
elif tool in ("cc", "go"):
    Path(args[args.index("-o") + 1]).write_text("compiled driver")
elif tool == "cargo":
    output = Path(os.environ["CARGO_TARGET_DIR"]) / "debug/domain-rust"
    output.parent.mkdir(parents=True)
    output.write_text("compiled Rust driver")
'''


class ReleaseInstallTest(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name) / "checkout with spaces"
        script = self.root / "scripts/ci/install-e2e-release.sh"
        script.parent.mkdir(parents=True)
        shutil.copyfile(SCRIPT, script)
        self.script = script
        self.assets = Path(scratch.name) / "assets"
        self.assets.mkdir()
        tools = Path(scratch.name) / "bin"
        tools.mkdir()
        for name in ["gh", "pip", "npm", "npx", "node", "cc", "go", "cargo"]:
            executable = tools / name
            executable.write_text(f"#!{sys.executable}\n" + FAKE_TOOL)
            executable.chmod(0o755)
        self.temp = Path(scratch.name) / "runner temp"
        self.temp.mkdir()
        self.log = Path(scratch.name) / "calls.jsonl"
        self.github_path = Path(scratch.name) / "github-path"
        self.env = {
            **os.environ,
            "PATH": str(tools) + os.pathsep + os.environ["PATH"],
            "ASSETS": str(self.assets),
            "CALL_LOG": str(self.log),
            "RUNNER_TEMP": str(self.temp),
            "RELEASE_TAG": TAG,
            "GITHUB_PATH": str(self.github_path),
        }

    def archive(self, name, files):
        with tarfile.open(self.assets / name, "w:gz") as archive:
            for path, content in files.items():
                content = content.encode()
                member = tarfile.TarInfo(path)
                member.size = len(content)
                archive.addfile(member, io.BytesIO(content))

    def run_install(self, component, *, timeout=30, **environment):
        result = subprocess.run(
            ["bash", str(self.script), component],
            env={**self.env, **environment},
            capture_output=True, text=True, timeout=timeout,
        )
        self.assertEqual(list(self.temp.iterdir()), [], "download directory leaked")
        calls = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        return result, calls

    def test_rejects_invalid_tags_before_any_external_operation(self):
        for tag in ["", "main", "0.13.1", "v01.2.3", "v1.2.3-rc.1", "v1.2.3\n", "$(touch injected)"]:
            with self.subTest(tag=tag):
                result, calls = self.run_install("python", RELEASE_TAG=tag)
                self.assertEqual(result.returncode, 2)
                self.assertIn("stable vX.Y.Z", result.stderr)
                self.assertEqual(calls, [])

    def test_validates_exact_published_release_and_propagates_lookup_failure(self):
        result, calls = self.run_install("validate")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(calls[0]["args"][:3], ["release", "view", TAG])
        result, _ = self.run_install("validate", PUBLISHED_TAG="")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not published", result.stderr)
        result, _ = self.run_install("validate", FAIL_TOOL="gh")
        self.assertEqual(result.returncode, 19)

    def test_installs_matching_python_wheel_without_source_fallback(self):
        abi = f"cp{sys.version_info.major}{sys.version_info.minor}"
        wheel = f"boxlite-0.13.1-{abi}-{abi}-manylinux_2_28_x86_64.whl"
        (self.assets / wheel).write_bytes(b"release wheel")
        result, calls = self.run_install("python")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([call["tool"] for call in calls], ["gh", "pip"])
        self.assertEqual(calls[0]["args"][2], TAG)
        self.assertEqual(calls[0]["args"][calls[0]["args"].index("--pattern") + 1], wheel)
        self.assertIn("--only-binary=:all:", calls[1]["args"])
        self.assertEqual(Path(calls[1]["args"][-1]).name, wheel)

    def test_download_failure_never_falls_back_to_building(self):
        result, calls = self.run_install("python", FAIL_TOOL="gh")
        self.assertEqual(result.returncode, 19)
        self.assertEqual([call["tool"] for call in calls], ["gh"])

    def node_assets(self, manifest=None, javascript="release JavaScript"):
        self.archive("boxlite-ai-boxlite-0.13.1.tgz", {
            "package/package.json": json.dumps(manifest or {"version": "0.13.1"}),
            "package/dist/index.js": javascript,
            "package/native/boxlite.js": "release loader",
        })
        self.archive("boxlite-ai-boxlite-linux-x64-gnu-0.13.1.tgz", {
            "package/boxlite.linux-x64-gnu.node": "release addon",
            "package/package.json": "platform package manifest",
        })

    def test_node_installs_release_files_where_existing_drivers_load_them(self):
        self.node_assets()
        result, calls = self.run_install("node")
        self.assertEqual(result.returncode, 0, result.stderr)
        sdk = self.root / "sdks/node"
        self.assertEqual((sdk / "dist/index.js").read_text(), "release JavaScript")
        self.assertEqual((sdk / "native/boxlite.js").read_text(), "release loader")
        self.assertEqual((sdk / "native/boxlite.linux-x64-gnu.node").read_text(), "release addon")
        self.assertEqual(json.loads((sdk / "package.json").read_text())["version"], "0.13.1")
        configure, npm, npx, node = calls[-4:]
        self.assertEqual(configure["args"], ["pkg", "delete", "optionalDependencies", "devDependencies", "workspaces", "--workspaces=false"])
        self.assertEqual(Path(npm["cwd"]).resolve(), sdk.resolve())
        self.assertIn("--ignore-scripts", npm["args"])
        self.assertIn("--workspaces=false", npm["args"])
        self.assertIn("--save-prod", npm["args"])
        self.assertNotIn("--omit=optional", npm["args"])
        self.assertEqual(npx["args"][:3], ["--no-install", "tsx", "--eval"])
        self.assertEqual(node["tool"], "node")
        self.assertIn('./dist/index.js', node["args"][-1])

    def test_broken_node_addon_fails_installation_instead_of_skipping_tests(self):
        self.node_assets()
        result, calls = self.run_install("node", FAIL_TOOL="node")
        self.assertEqual(result.returncode, 19)
        self.assertEqual(calls[-1]["tool"], "node")

    def test_broken_typescript_tooling_stops_before_loading_sdk(self):
        self.node_assets()
        result, calls = self.run_install("node", FAIL_TOOL="npx")
        self.assertEqual(result.returncode, 19)
        self.assertEqual(calls[-1]["tool"], "npx")

    @unittest.skipUnless(os.environ.get("E2E_RELEASE_REAL_NPM"), "opt-in real npm installation")
    def test_node_tool_installation_with_real_npm_and_sdk_peer_metadata(self):
        # Keep the SDK's actual development/peer overlap and checkout lockfile:
        # npm's resolver can fail before --omit=dev filters the install tree.
        manifest = json.loads((ROOT / "sdks/node/package.json").read_text())
        self.node_assets(manifest, "export class JsBoxlite { static rest() {} }")
        sdk = self.root / "sdks/node"
        sdk.mkdir(parents=True)
        shutil.copyfile(ROOT / "sdks/node/package-lock.json", sdk / "package-lock.json")
        tools = Path(self.env["PATH"].split(os.pathsep)[0])
        for name in ["npm", "npx", "node"]:
            executable = shutil.which(name)
            self.assertIsNotNone(executable, f"real {name} is required")
            (tools / name).unlink()
            (tools / name).symlink_to(executable)
        result, _ = self.run_install("node", timeout=180)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_cli_pins_installer_version_and_publishes_its_path(self):
        (self.assets / "install.sh").write_text(
            'set -eu\nmkdir -p "$BOXLITE_INSTALL_DIR"\n'
            'printf "#!/bin/sh\\necho boxlite-%s\\n" "$BOXLITE_VERSION" > "$BOXLITE_INSTALL_DIR/boxlite"\n'
            'chmod +x "$BOXLITE_INSTALL_DIR/boxlite"\n'
        )
        result, calls = self.run_install("cli")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(TAG, result.stdout)
        self.assertEqual(self.github_path.read_text().strip(), str(self.root / "target/e2e-bin"))
        self.assertEqual(calls[0]["args"][2], TAG)

    def test_c_extracts_release_headers_and_both_library_formats(self):
        prefix = "boxlite-c-v0.13.1-linux-x64-gnu/"
        files = {"include/boxlite.h": "release header", "lib/libboxlite.a": "static", "lib/libboxlite.so": "shared"}
        self.archive(prefix[:-1] + ".tar.gz", {prefix + path: content for path, content in files.items()})
        result, calls = self.run_install("c")
        self.assertEqual(result.returncode, 0, result.stderr)
        for path, content in files.items():
            self.assertEqual((self.root / "target/e2e-c-sdk" / path).read_text(), content)
        self.assertEqual([call["tool"] for call in calls], ["gh"])

    def test_native_drivers_use_release_sdks_with_current_driver_sources(self):
        for language in ["c", "go", "rust"]:
            shutil.copytree(ROOT / "apps/e2e/sdks" / language, self.root / "apps/e2e/sdks" / language)
        library = self.root / "target/e2e-c-sdk/lib/libboxlite.a"
        header = self.root / "target/e2e-c-sdk/include/boxlite.h"
        for path in [library, header]:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("downloaded release SDK")
        makefile = self.root / "Makefile"
        makefile.write_text(f'PROJECT_ROOT := {self.root}\ninclude {ROOT}/make/dev.mk\n')
        result = subprocess.run(
            ["make", "build:e2e:release-drivers"], cwd=self.root, env=self.env,
            capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()]
        self.assertEqual([call["tool"] for call in calls], ["cc", "go", "cargo"])
        cc, go, cargo = calls
        release = self.root / "target/e2e-release"
        self.assertIn(f'-I{header.parent}', cc["args"])
        self.assertIn(f'-L{library.parent}', cc["args"])
        self.assertEqual(Path(go["cwd"]).resolve(), (release / "sdks/go").resolve())
        self.assertNotIn("boxlite_dev", go["args"])
        self.assertEqual((release / "sdks/go/libboxlite.a").read_bytes(), library.read_bytes())
        self.assertEqual(Path(cargo["cwd"]).resolve(), release.resolve())
        self.assertEqual(cargo["target"], str(self.root / "target/e2e-release-rust"))
        self.assertEqual(cargo["args"], ["build", "--locked", "-p", "boxlite-e2e-rust", "--bin", "domain-rust"])
        self.assertEqual(
            (release / "apps/e2e/sdks/rust/e2e_domains.rs").read_bytes(),
            (ROOT / "apps/e2e/sdks/rust/e2e_domains.rs").read_bytes(),
        )
        self.assertEqual((self.root / "target/debug/domain-rust").read_text(), "compiled Rust driver")


if __name__ == "__main__":
    unittest.main()
