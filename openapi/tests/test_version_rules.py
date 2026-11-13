import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
from pathlib import Path
import unittest
import yaml

MODULE = Path(__file__).resolve().parents[1] / "generate_version_rules.py"
loader = importlib.util.spec_from_file_location("version_rules", MODULE)
rules = importlib.util.module_from_spec(loader)
loader.loader.exec_module(rules)


def contract():
    return {"paths": {"/{prefix}/boxes": {"post": {
        "operationId": "createBox",
        "requestBody": {"content": {"application/json": {"schema": {
            "$ref": "#/components/schemas/Request"
        }}}},
    }}}, "components": {"schemas": {"Request": {
        "type": "object", "properties": {"image": {"type": "string"}}
    }}}}


class VersionRulesTests(unittest.TestCase):
    def setUp(self):
        self.spec = contract()
        self.schema = self.spec["components"]["schemas"]["Request"]
        self.op = self.spec["paths"]["/{prefix}/boxes"]["post"]

    def compile(self):
        return rules.Contract(self.spec).operations()[0]

    def test_reference_sibling_and_nested_allof(self):
        self.schema["properties"]["advanced"] = {"allOf": [{"type": "object", "properties": {
            "privileged": {"$ref": "#/components/schemas/Flag", rules.MINIMUM: "0.13.0",
                           rules.CONDITION: "non-default"}
        }}]}
        self.spec["components"]["schemas"]["Flag"] = {"type": "boolean", "default": False}
        rule = self.compile()["rules"][0]
        self.assertEqual(rule["path"], ["advanced", "privileged"])
        self.assertIs(rule["default"], False)

    def test_reference_sibling_properties_do_not_erase_inherited_rules(self):
        self.schema["properties"]["image"].update({rules.MINIMUM: "0.13.0", rules.CONDITION: "present"})
        body = self.op["requestBody"]["content"]["application/json"]["schema"]
        body["properties"] = {"name": {"type": "string"}}
        operation = self.compile()
        self.assertEqual(operation["rules"][0]["path"], ["image"])
        self.assertIn(("body", "image"), operation["fields"])
        self.assertIn(("body", "name"), operation["fields"])

    def test_rejects_bad_defaults_conditions_and_versions(self):
        cases = [
            {rules.MINIMUM: "1.2"},
            {rules.MINIMUM: "0.13.0", rules.CONDITION: "typo"},
            {rules.MINIMUM: "0.13.0", rules.CONDITION: "non-default"},
            {rules.MINIMUM: "0.13.0", rules.CONDITION: "non-default", "default": "false"},
            {rules.CONDITION: "present"},
        ]
        for extra in cases:
            with self.subTest(extra=extra):
                self.schema["properties"]["flag"] = {"type": "boolean", **extra}
                with self.assertRaises(ValueError):
                    self.compile()

    def test_parameter_references_overrides_and_types(self):
        self.spec["components"]["parameters"] = {"Flag": {
            "in": "query", "name": "flag", "schema": {"type": "boolean", "default": False},
            rules.MINIMUM: "0.13.0", rules.CONDITION: "non-default"
        }}
        self.spec["paths"]["/{prefix}/boxes"]["parameters"] = [{"$ref": "#/components/parameters/Flag"}]
        self.assertEqual(self.compile()["rules"][0]["type"], "boolean")
        self.op["parameters"] = [{"in": "query", "name": "flag", "schema": {"type": "boolean"}}]
        self.assertEqual(self.compile()["rules"], [])

    def test_unsupported_descendants_fail_instead_of_disappearing(self):
        annotation = {"type": "string", rules.MINIMUM: "0.13.0", rules.CONDITION: "present"}
        for parent in [{"items": annotation}, {"oneOf": [annotation]}, {"anyOf": [annotation]},
                       {"additionalProperties": annotation}]:
            with self.subTest(parent=parent):
                self.schema["properties"]["value"] = parent
                with self.assertRaisesRegex(ValueError, "unsupported"):
                    self.compile()

    def test_present_on_whole_array_is_supported(self):
        self.schema["properties"]["values"] = {"type": "array", "items": {"type": "string"},
            rules.MINIMUM: "0.13.0", rules.CONDITION: "present"}
        self.assertEqual(self.compile()["rules"][0]["path"], ["values"])

    def test_parameter_content_and_non_json_annotations_are_rejected(self):
        annotation = {"type": "string", rules.MINIMUM: "0.13.0", rules.CONDITION: "present"}
        self.op["parameters"] = [{"name": "filter", "in": "query", "content": {
            "application/json": {"schema": annotation}
        }}]
        with self.assertRaisesRegex(ValueError, "parameter content"):
            self.compile()
        del self.op["parameters"]
        self.schema["properties"]["new"] = annotation
        self.op["requestBody"]["content"]["application/octet-stream"] = self.op["requestBody"]["content"].pop("application/json")
        with self.assertRaisesRegex(ValueError, "JSON properties"):
            self.compile()

    def test_response_field_becoming_writable_requires_a_gate(self):
        self.schema["properties"]["result"] = {"type": "string", "readOnly": True}
        before = copy.deepcopy(self.spec)
        del self.schema["properties"]["result"]["readOnly"]
        with self.assertRaisesRegex(ValueError, "new request field"):
            rules.check_additions(before, self.spec, "0.12.0")

    def test_cycles_and_missing_references_fail(self):
        for ref in ["Request", "Missing"]:
            self.schema["properties"]["loop"] = {"$ref": f"#/components/schemas/{ref}"}
            with self.assertRaises((ValueError, KeyError)):
                self.compile()

    def test_ambiguous_routes_and_duplicate_ids_fail(self):
        for path, name in [("/{other}/boxes", "other"), ("/elsewhere", "createBox")]:
            spec = contract()
            spec["paths"][path] = {"post": {"operationId": name}}
            with self.assertRaises(ValueError):
                rules.render(spec)

    def test_static_route_can_overlap_template(self):
        self.spec["paths"]["/{prefix}/{resource}"] = {"post": {"operationId": "other"}}
        self.assertEqual(len(rules.Contract(self.spec).operations()), 2)

    def test_new_operation_requires_future_release(self):
        before = copy.deepcopy(self.spec)
        for minimum in [None, "0.12.0", "0.12.0+new", "0.12.0-rc.1"]:
            self.spec["paths"]["/new"] = {"get": {"operationId": "new"}}
            if minimum:
                self.spec["paths"]["/new"]["get"][rules.MINIMUM] = minimum
            with self.assertRaisesRegex(ValueError, "new operation"):
                rules.check_additions(before, self.spec, "0.12.0")
        self.spec["paths"]["/new"]["get"][rules.MINIMUM] = "0.12.1"
        rules.check_additions(before, self.spec, "0.12.0")

    def test_new_nested_field_requires_future_declaration(self):
        before = copy.deepcopy(self.spec)
        self.schema["properties"]["new"] = {"type": "string"}
        with self.assertRaisesRegex(ValueError, "new request field"):
            rules.check_additions(before, self.spec, "0.12.0")
        self.schema["properties"]["new"].update({rules.MINIMUM: "0.13.0", rules.CONDITION: "present"})
        rules.check_additions(before, self.spec, "0.12.0")
        self.schema["properties"]["new"][rules.MINIMUM] = "0.12.0"
        with self.assertRaises(ValueError):
            rules.check_additions(before, self.spec, "0.12.0")

    def test_response_only_and_readonly_fields_do_not_require_gates(self):
        before = copy.deepcopy(self.spec)
        self.schema["properties"]["result"] = {"readOnly": True, "properties": {"x": {"type": "string"}}}
        self.op["responses"] = {"200": {"content": {"application/json": {"schema": {
            "properties": {"new": {"type": "string"}}
        }}}}}
        rules.check_additions(before, self.spec, "0.12.0")

    def test_new_parent_gate_covers_subtree(self):
        before = copy.deepcopy(self.spec)
        self.schema["properties"]["new"] = {"type": "object", rules.MINIMUM: "0.13.0",
            rules.CONDITION: "present", "properties": {"child": {"type": "string"}}}
        rules.check_additions(before, self.spec, "0.12.0")

    def test_semver_precedence(self):
        versions = ["0.12.0-alpha", "0.12.0-alpha.2", "0.12.0-alpha.11", "0.12.0-rc.1", "0.12.0", "0.12.1"]
        self.assertEqual(sorted(versions, key=rules.version), versions)
        self.assertEqual(rules.version("0.12.0+build"), rules.version("0.12.0"))
        for invalid in ["0.12", "v0.12.0", "0.12.0-01", "01.0.0", True, "1.0.0+", "1.0.0\n"]:
            with self.assertRaises(ValueError):
                rules.version(invalid)

    def pending_spec(self):
        self.spec["info"] = {"version": "next-release"}
        for name, minimum in [("old", "0.11.0"), ("next", "next-release"), ("unknown", "unplanned")]:
            self.schema["properties"][name] = {
                "type": "string", rules.MINIMUM: minimum, rules.CONDITION: "present"
            }
        return self.spec

    def test_pending_generation_uses_workspace_version_and_preserves_unplanned(self):
        spec = self.pending_spec()
        identity = rules.api_version(spec, "0.12.0")
        self.assertEqual(identity, "0.12.0")
        generated = json.loads(rules.render(spec, "0.12.0"))[0]["rules"]
        self.assertEqual(generated[0]["minimum"], "0.11.0")
        self.assertEqual(generated[1]["minimum"], identity)
        self.assertNotIn("exact", generated[1])
        self.assertEqual(generated[2]["minimum"], "unplanned")
        self.assertNotIn("exact", generated[2])
        self.assertEqual(rules.api_version(copy.deepcopy(spec), "0.12.0"), identity)
        self.op["description"] = "changed contract"
        self.assertEqual(rules.api_version(spec, "0.12.0"), identity)

    def test_pending_operation_and_field_minima_preserve_workspace_version(self):
        spec = self.pending_spec()
        self.op[rules.MINIMUM] = "next-release"
        for workspace in ["0.12.0", "0.13.0+build.7", "0.13.0-rc.1+build.7"]:
            with self.subTest(workspace=workspace):
                operation = json.loads(rules.render(spec, workspace))[0]
                self.assertEqual(rules.api_version(spec, workspace), workspace)
                self.assertEqual(operation["minimum"], workspace)
                self.assertEqual(operation["rules"][1]["minimum"], workspace)
                self.assertNotIn("exact", operation)
                self.assertNotIn("exact", operation["rules"][1])

    def test_bump_finalizes_only_next_release_and_preserves_format(self):
        source = yaml.safe_dump(self.pending_spec()) + "# retained comment\n"
        finalized = rules.finalize(source, "0.13.0", "0.12.0")
        spec = yaml.safe_load(finalized)
        fields = spec["components"]["schemas"]["Request"]["properties"]
        self.assertEqual(spec["info"]["version"], "0.13.0")
        self.assertEqual(fields["next"][rules.MINIMUM], "0.13.0")
        self.assertEqual(fields["old"][rules.MINIMUM], "0.11.0")
        self.assertEqual(fields["unknown"][rules.MINIMUM], "unplanned")
        self.assertTrue(finalized.endswith("# retained comment\n"))
        self.assertEqual(rules.validate_release(spec, "0.13.0", releasing=True), "0.13.0")
        self.assertNotIn('"exact":true', rules.render(spec, "0.13.0"))
        for invalid in ["0.12.0", "0.11.0", "0.13.0-rc.1"]:
            with self.assertRaises(ValueError):
                rules.finalize(source, invalid, "0.12.0")

    def test_release_refuses_pending_and_development_refuses_future_numeric_floor(self):
        spec = self.pending_spec()
        with self.assertRaisesRegex(ValueError, "next-release"):
            rules.validate_release(spec, "0.12.0", releasing=True)
        self.op[rules.MINIMUM] = "1.0.0"
        with self.assertRaisesRegex(ValueError, "newer than workspace"):
            rules.render(spec, "0.12.0")
        del self.op[rules.MINIMUM]
        spec["info"]["version"] = "0.12.0"
        with self.assertRaisesRegex(ValueError, "next-release requires"):
            rules.render(spec, "0.12.0")
        with self.assertRaisesRegex(ValueError, "must match"):
            rules.validate_release(spec, "0.13.0")

    def test_additions_accept_both_pending_states(self):
        before = copy.deepcopy(self.spec)
        for pending in ["next-release", "unplanned"]:
            self.op[rules.MINIMUM] = pending
            self.schema["properties"]["new"] = {"type": "string"}
            rules.check_additions(before, self.spec, "0.12.0")
            self.spec["paths"]["/new"] = {"get": {"operationId": "new", rules.MINIMUM: pending}}
            rules.check_additions(before, self.spec, "0.12.0")

    def test_finalization_preserves_pending_anchors_and_rejects_released_alias_rewrites(self):
        spec = self.pending_spec()
        source = yaml.safe_dump({"info": spec["info"], **spec}, sort_keys=False)
        source = source.replace("  version: next-release", "  version: &pending next-release")
        source = source.replace(f"{rules.MINIMUM}: next-release", f"{rules.MINIMUM}: *pending")
        finalized = rules.finalize(source, "0.13.0", "0.12.0")
        self.assertIn('&pending "0.13.0"', finalized)
        self.assertIn(f"{rules.MINIMUM}: *pending", finalized)
        source = source.replace("&pending next-release", "&pending 0.11.0")
        with self.assertRaisesRegex(ValueError, "shared YAML anchor"):
            rules.finalize(source, "0.13.0", "0.12.0")

    def test_cli_bump_and_release_checks_use_the_real_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "openapi").mkdir()
            (root / "src/boxlite/src/rest").mkdir(parents=True)
            (root / "openapi/generate_version_rules.py").write_text(MODULE.read_text())
            spec = root / "openapi/box.openapi.yaml"
            spec.write_text(yaml.safe_dump(self.pending_spec()))
            manifest = root / "Cargo.toml"
            manifest.write_text('[workspace.package]\nversion = "0.12.0"\n')
            def git(*args):
                return subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True)
            git("init")
            git("add", ".")
            git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base")
            def run(*args):
                return subprocess.run([sys.executable, "openapi/generate_version_rules.py", *args],
                                      cwd=root, capture_output=True, text=True)
            original_spec = spec.read_text()
            self.assertEqual(run().returncode, 0)
            self.assertEqual(spec.read_text(), original_spec)
            identity = root / "src/boxlite/src/rest/api_version.json"
            self.assertEqual(json.loads(identity.read_text()), "0.12.0")
            self.assertEqual(run("--check").returncode, 0)
            self.assertNotEqual(run("--check", "--release").returncode, 0)
            self.assertNotEqual(run("--finalize").returncode, 0)
            self.assertNotEqual(run("--finalize", "--base", "HEAD").returncode, 0)
            manifest.write_text('[workspace.package]\nversion = "0.13.0"\n')
            finalized = run("--finalize", "--base", "HEAD")
            self.assertEqual(finalized.returncode, 0, finalized.stderr)
            self.assertEqual(run("--check", "--release", "--tag", "v0.13.0").returncode, 0)
            self.assertNotEqual(run("--check", "--release", "--tag", "v0.12.0").returncode, 0)
            self.assertEqual(json.loads(identity.read_text()), "0.13.0")
            self.assertIn("unplanned", spec.read_text())
            identity.write_text('"0.12.0"\n')
            self.assertNotEqual(run("--check", "--release").returncode, 0)


if __name__ == "__main__":
    unittest.main()
