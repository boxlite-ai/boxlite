"""Check the synchronous execution wire contract on POST /exec."""
import unittest
from pathlib import Path

import yaml

SPEC = yaml.safe_load((Path(__file__).resolve().parents[1] / "box.openapi.yaml").read_text())
SCHEMAS = SPEC["components"]["schemas"]
EXEC_PATH = "/{prefix}/boxes/{box_id}/exec"


class ExecSyncSpecTests(unittest.TestCase):
    def test_route_and_responses(self):
        self.assertNotIn(f"{EXEC_PATH}/sync", SPEC["paths"])
        self.assertNotIn("SyncExecRequest", SCHEMAS)

        post = SPEC["paths"][EXEC_PATH]["post"]
        self.assertEqual(post["operationId"], "startExecution")
        self.assertEqual(post["tags"], ["Execution"])
        self.assertEqual(post.get("security", SPEC["security"]), [{"BearerAuth": []}])

        body = post["requestBody"]
        self.assertTrue(body["required"])
        self.assertEqual(body["content"]["application/json"]["schema"], {
            "$ref": "#/components/schemas/ExecRequest",
        })

        responses = post["responses"]
        self.assertEqual(responses["200"]["content"]["application/json"]["schema"], {
            "$ref": "#/components/schemas/SyncExecResponse",
        })
        self.assertEqual(responses["201"]["content"]["application/json"]["schema"], {
            "$ref": "#/components/schemas/ExecResponse",
        })
        for status, name in {
            "400": "BadRequestError",
            "404": "NotFoundError",
            "408": "RequestTimeoutError",
            "409": "ConflictError",
        }.items():
            with self.subTest(status=status):
                self.assertEqual(responses[status], {"$ref": f"#/components/responses/{name}"})
                self.assertIn(name, SPEC["components"]["responses"])

    def test_exec_request_sync_fields_and_limits(self):
        request = SCHEMAS["ExecRequest"]
        self.assertEqual(request["required"], ["command"])
        fields = request["properties"]
        self.assertIn("sync", fields)
        self.assertEqual(fields["sync"]["type"], "boolean")
        self.assertIs(fields["sync"]["default"], False)

        max_output = fields["max_output_bytes"]
        self.assertEqual(
            tuple(max_output[k] for k in ("type", "minimum", "maximum", "default")),
            ("integer", 1024, 10485760, 1048576),
        )

    def test_response_required_fields(self):
        response = SCHEMAS["SyncExecResponse"]
        self.assertCountEqual(response["required"], [
            "exit_code", "stdout", "stderr", "stdout_truncated", "stderr_truncated",
        ])
        self.assertEqual({k: v["type"] for k, v in response["properties"].items()}, {
            "exit_code": "integer", "stdout": "string", "stderr": "string",
            "stdout_truncated": "boolean", "stderr_truncated": "boolean", "error_message": "string",
        })
