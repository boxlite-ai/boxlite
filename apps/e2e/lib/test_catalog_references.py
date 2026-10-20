"""Exercise catalog E2E reference setup without starting SDK or VM fixtures."""

from __future__ import annotations

import os
from pathlib import Path
import runpy
import sys
import unittest
from unittest.mock import MagicMock, patch

CATALOG_CASE = Path(__file__).resolve().parents[1] / "cases/test_images_catalog.py"


class CatalogReferencesTest(unittest.TestCase):
    def test_catalog_constants_preserve_registry_ports(self) -> None:
        cases = [
            ("registry.local:5000/acme/app", "registry.local:5000/acme/app"),
            ("registry.local:5000/acme/app:v1", "registry.local:5000/acme/app"),
            ("registry.local:5000/acme/app@sha256:abcd", "registry.local:5000/acme/app"),
            ("registry.local:5000/acme/app:v1@sha256:abcd", "registry.local:5000/acme/app"),
            ("[::1]:5000/acme/app", "[::1]:5000/acme/app"),
            ("quay.io/acme/app", "quay.io/acme/app"),
            ("quay.io/acme/app:v1", "quay.io/acme/app"),
        ]
        # Only module setup runs. These dependencies define live E2E fixtures;
        # the reference constants and the image helper remain production code.
        fixtures = {name: MagicMock() for name in (
            "boxlite", "pytest", "pytest_asyncio", "catalog_boxes", "e2e_auth"
        )}
        for image, repository in cases:
            with self.subTest(image=image):
                with patch.dict(os.environ, {"BOXLITE_E2E_CATALOG_IMAGE": image}):
                    with patch.dict(sys.modules, fixtures):
                        configured = runpy.run_path(str(CATALOG_CASE))
                self.assertEqual(configured["CATALOG_NAME"], repository)
                expected_missing = repository.rsplit("/", 1)[0] + "/boxlite-e2e-does-not-exist:v1"
                self.assertEqual(configured["UNPULLABLE_IMAGE"], expected_missing)


if __name__ == "__main__":
    unittest.main()
