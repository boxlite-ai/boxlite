import copy
import importlib.util
from pathlib import Path
import unittest

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


if __name__ == "__main__":
    unittest.main()
