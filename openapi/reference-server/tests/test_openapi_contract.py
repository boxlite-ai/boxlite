from __future__ import annotations

import unittest
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
OPENAPI_SPEC = REPO_ROOT / "openapi" / "box.openapi.yaml"


class OpenApiContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.schemas = yaml.safe_load(OPENAPI_SPEC.read_text())["components"]["schemas"]

    def test_advanced_capabilities_require_the_complete_response_shape(self) -> None:
        advanced_capabilities = self.schemas["AdvancedBoxInfo"]["properties"][
            "capabilities"
        ]
        self.assertEqual(
            advanced_capabilities["$ref"],
            "#/components/schemas/ContainerCapabilitiesInfo",
        )

        capability_info = self.schemas["ContainerCapabilitiesInfo"]
        self.assertEqual(set(capability_info["required"]), {"add", "drop"})
        self.assertFalse(capability_info["additionalProperties"])
        self.assertEqual(set(capability_info["properties"]), {"add", "drop"})


if __name__ == "__main__":
    unittest.main()
