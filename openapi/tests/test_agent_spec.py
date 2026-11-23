"""Validate examples and boundaries in the agent OpenAPI contract."""
import copy
import json
import re
import unittest
from pathlib import Path

import jsonschema
import yaml

ROOT = Path(__file__).resolve().parents[2]
SPEC = yaml.safe_load((ROOT / "openapi/box.openapi.yaml").read_text())
SCHEMAS = SPEC["components"]["schemas"]


def validate(schema, value):
    jsonschema.Draft202012Validator(
        {"$ref": f"#/components/schemas/{schema}", "components": SPEC["components"]}
    ).validate(value)


def dereference(value):
    while "$ref" in value:
        reference = value["$ref"]
        value = SPEC
        for part in reference.split("/")[1:]:
            value = value[part]
    return value


class AgentSpecTest(unittest.TestCase):
    def test_all_agent_operations_present(self):
        operations = {
            operation["operationId"]
            for path, item in SPEC["paths"].items() if "/agents" in path
            for method, operation in item.items()
            if method in ("get", "post", "put", "delete", "patch")
        }
        self.assertEqual(operations, {
            "createAgent", "getAgent", "getAgentTurn", "closeAgent", "sendAgentTurn",
            "getAgentEvents", "respondAgentRequest", "steerAgentTurn", "interruptAgentTurn",
        })

    def test_agent_examples(self):
        count = 0
        for path, item in SPEC["paths"].items():
            if "/agents" not in path:
                continue
            for method in ("get", "post", "put", "delete", "patch"):
                if method not in item:
                    continue
                operation = item[method]
                messages = list(operation.get("responses", {}).values())
                if "requestBody" in operation:
                    messages.append(operation["requestBody"])
                for message in messages:
                    message = dereference(message)
                    for media in message.get("content", {}).values():
                        schema = media.get("schema")
                        if not schema:
                            continue
                        validator = jsonschema.Draft202012Validator(
                            {**schema, "components": SPEC["components"]}
                        )
                        examples = [media["example"]] if "example" in media else []
                        examples += [v["value"] for v in media.get("examples", {}).values()]
                        for example in examples:
                            validator.validate(example)
                            count += 1
        self.assertGreaterEqual(count, 10)

    def test_shared_examples_and_parameters(self):
        components = SPEC["components"]
        for name, response in components["responses"].items():
            if not name.startswith("Agent"):
                continue
            for media in response["content"].values():
                validator = jsonschema.Draft202012Validator(
                    {**media["schema"], "components": components}
                )
                examples = [media["example"]] if "example" in media else []
                examples += [v["value"] for v in media.get("examples", {}).values()]
                self.assertTrue(examples, name)
                for example in examples:
                    validator.validate(example)
        for name in ("agentId", "agentTurnId", "agentIdempotencyKey"):
            parameter = components["parameters"][name]
            jsonschema.Draft202012Validator(parameter["schema"]).validate(parameter["example"])

    def test_create_boundaries(self):
        body = {"agent": "coder", "options": {"cwd": "/workspace", "config": {
            "tools": [], "mcp": [], "permissions": {"allow": False, "count": 0, "nested": [None, {}]}
        }}}
        original = copy.deepcopy(body)
        validate("AgentCreateRequest", body)
        self.assertEqual(body, original)
        for bad in ({"agent": "x", "extra": 1}, {"agent": "x", "options": None},
                    {"agent": "x", "options": {"config": None}},
                    {"agent": "x", "options": {"config": {"unknown": 1}}}):
            with self.subTest(bad=bad), self.assertRaises(jsonschema.ValidationError):
                validate("AgentCreateRequest", bad)
        key = SPEC["components"]["parameters"]["agentIdempotencyKey"]["schema"]
        validator = jsonschema.Draft202012Validator(key)
        for value in ("", "x" * 257, "é", "a b", "x\n"):
            self.assertFalse(validator.is_valid(value), value)
        self.assertTrue(validator.is_valid("x" * 256))

    def test_turn_request_boundaries(self):
        for schema, body in (
            ("AgentSendRequest", {"text": "", "options": {"mode": "queue", "data": {"zero": 0, "empty": [], "null": None}}}),
            ("AgentRespondRequest", {"response": {"type": "permission", "approved": False}}),
            ("AgentRespondRequest", {"response": {"type": "answer", "text": "ok", "data": {}}}),
            ("AgentSteerRequest", {"text": "focus"}),
            ("AgentEmptyRequest", {}),
        ):
            with self.subTest(schema=schema):
                validate(schema, body)

        for schema, body in (
            ("AgentSendRequest", {"text": "x", "options": None}),
            ("AgentSendRequest", {"text": "x", "options": {"mode": "unknown"}}),
            ("AgentRespondRequest", {"response": {"type": "permission", "approved": None}}),
            ("AgentRespondRequest", {"response": {"type": "unknown"}}),
            ("AgentSteerRequest", {"text": "x", "extra": True}),
            ("AgentEmptyRequest", {"extra": True}),
        ):
            with self.subTest(schema=schema, body=body), self.assertRaises(jsonschema.ValidationError):
                validate(schema, body)

    def test_stream_event_example(self):
        path = "/{prefix}/boxes/{box_id}/agents/{agent_id}/events"
        example = SPEC["paths"][path]["get"]["responses"]["200"]["content"]["text/event-stream"]["example"]
        data = next(line[6:] for line in example.splitlines() if line.startswith("data: "))
        validate("AgentEvent", json.loads(data))

    def test_record_fields_and_fractional_retention(self):
        records = (ROOT / "src/boxlite/src/agents/records.rs").read_text()
        functions = dict(re.findall(
            r"pub fn (\w+)\([^\n]*\).*?\n(.*?)(?=\npub fn |\n///|\nfn |\Z)",
            records, re.S,
        ))
        for schema, function in {
            "AgentState": "agent_state", "AgentTurnState": "turn_state",
            "AgentResult": "result", "AgentSteeringReceipt": "receipt",
            "AgentCapabilities": "capabilities", "AgentEvent": "event",
        }.items():
            fields = set(re.findall(r'"(\w+)"\s*:', functions[function]))
            self.assertEqual(set(SCHEMAS[schema]["properties"]), fields, schema)
        config_fields = set(re.findall(r'"(\w+)"\s*:', functions["config"]))
        config_fields.update(re.findall(r'\(\s*"(\w+)"\s*,', functions["config"]))
        self.assertEqual(set(SCHEMAS["AgentConfig"]["properties"]), config_fields)
        request = functions["requests"]
        outer = re.search(r'json!\(\{ "id":.*?\}\)', request).group()
        self.assertEqual(set(SCHEMAS["AgentRequest"]["properties"]),
                         set(re.findall(r'"(\w+)"\s*:', outer)))
        for variant in SCHEMAS["AgentRequest"]["properties"]["kind"]["oneOf"]:
            kind = variant["properties"]["type"]["const"]
            record = re.search(r'json!\(\{ "type": "' + kind + r'".*?\}\)', request).group()
            self.assertEqual(set(variant["properties"]), set(re.findall(r'"(\w+)"\s*:', record)))
        validate("AgentCapabilities", {"operations": [], "input_kinds": [], "max_queued_turns": 0,
                 "max_pending_steering": None, "idempotency_retention_seconds": 0.5})
        self.assertFalse(jsonschema.Draft202012Validator(SCHEMAS["AgentTurnStatus"]).is_valid("bogus"))
        validate("AgentEvent", {"cursor": None, "agent_id": "a", "turn_id": None, "kind": "x", "data": {"nested": None}})

    def test_unsupported_examples_name_unadvertised_operation(self):
        source = (ROOT / "src/boxlite/src/agents/opencode/mod.rs").read_text()
        capabilities = source.split("fn capabilities() -> AgentCapabilities", 1)[1].split(".map(String::from)", 1)[0]
        operations = set(re.findall(r'"([a-z_.]+)"', capabilities))
        checked = 0
        for name, response in SPEC["components"]["responses"].items():
            if not name.startswith("Agent"):
                continue
            for media in response.get("content", {}).values():
                examples = ([media["example"]] if "example" in media else [])
                examples += [v["value"] for v in media.get("examples", {}).values()]
                for example in examples:
                    error = example["error"]
                    if error["code"] == "unsupported":
                        checked += 1
                        operation = error["message"].split()[0]
                        self.assertNotIn(operation, operations)
        self.assertGreater(checked, 0)


if __name__ == "__main__":
    unittest.main()
