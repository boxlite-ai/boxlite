"""Check the synchronous execution wire contract."""
import unittest
from pathlib import Path

import yaml

SPEC = yaml.safe_load((Path(__file__).resolve().parents[1] / "box.openapi.yaml").read_text())
SCHEMAS = SPEC["components"]["schemas"]
EXEC_PATH = "/{prefix}/boxes/{box_id}/exec"


class ExecSyncSpecTests(unittest.TestCase):
    def test_route_and_error_responses(self):
        path = SPEC["paths"][f"{EXEC_PATH}/sync"]
        self.assertEqual(path["parameters"], SPEC["paths"][EXEC_PATH]["parameters"])
        post = path["post"]
        self.assertEqual(post["operationId"], "execSync")
        self.assertEqual(post["tags"], ["Execution"])
        self.assertEqual(post.get("security", SPEC["security"]), [{"BearerAuth": []}])
        body = post["requestBody"]
        self.assertTrue(body["required"])
        self.assertEqual(body["content"]["application/json"]["schema"], {
            "$ref": "#/components/schemas/SyncExecRequest",
        })
        responses = post["responses"]
        self.assertEqual(responses["200"]["content"]["application/json"]["schema"], {
            "$ref": "#/components/schemas/SyncExecResponse",
        })
        for status, name in {
            "400": "BadRequestError", "401": "UnauthorizedError", "404": "NotFoundError",
            "408": "RequestTimeoutError", "409": "ConflictError", "500": "InternalError",
        }.items():
            with self.subTest(status=status):
                self.assertEqual(responses[status], {"$ref": f"#/components/responses/{name}"})
                self.assertIn(name, SPEC["components"]["responses"])

    def test_request_fields_and_limits(self):
        request = SCHEMAS["SyncExecRequest"]
        self.assertEqual(request["required"], ["command"])
        fields = request["properties"]
        self.assertEqual(set(fields), {
            "command", "args", "env", "timeout_seconds", "working_dir", "user", "max_output_bytes",
        })
        self.assertEqual(fields["command"], {"type": "string", "minLength": 1})
        self.assertEqual(fields["args"]["items"], {"type": "string"})
        self.assertEqual(fields["env"]["additionalProperties"], {"type": "string"})
        for name, expected in {
            "timeout_seconds": ("number", 0.1, 300, 30),
            "max_output_bytes": ("integer", 1024, 10485760, 1048576),
        }.items():
            with self.subTest(field=name):
                field = fields[name]
                self.assertEqual(tuple(field[k] for k in ("type", "minimum", "maximum", "default")), expected)

    def test_response_required_fields(self):
        response = SCHEMAS["SyncExecResponse"]
        self.assertCountEqual(response["required"], [
            "exit_code", "stdout", "stderr", "stdout_truncated", "stderr_truncated",
        ])
        self.assertEqual({k: v["type"] for k, v in response["properties"].items()}, {
            "exit_code": "integer", "stdout": "string", "stderr": "string",
            "stdout_truncated": "boolean", "stderr_truncated": "boolean", "error_message": "string",
        })
