"""SDK boundary checks; real runner behavior is make test:runner-ci:cache."""

import importlib.util
import tempfile
import unittest

import pytest

import boxlite
from boxlite.errors import UnsupportedError

if importlib.util.find_spec("boxlite.boxlite") is None:
    pytest.skip("native extension module not built", allow_module_level=True)
from boxlite.boxlite import Boxlite, BoxOptions  # noqa: F401 - validate native exports


class CacheVolumeContract(unittest.IsolatedAsyncioTestCase):
    async def test_cache_volume_local_rejection_creates_no_box(self):
        with tempfile.TemporaryDirectory() as home:
            runtime = boxlite.Boxlite(boxlite.Options(home_dir=home))
            with self.assertRaises(UnsupportedError):
                await runtime.create(
                    boxlite.BoxOptions(
                        image="alpine:3.23",
                        volumes=[{"cache_volume": "build", "guest_path": "/cache"}],
                    )
                )
            self.assertEqual(await runtime.list_info(), [])

    def test_cache_volume_requires_one_writable_origin(self):
        for extra in [
            {"host_path": "/tmp"},
            {"managed_volume": "data"},
            {"read_only": True},
        ]:
            with self.subTest(extra=extra), self.assertRaises(RuntimeError):
                boxlite.BoxOptions(
                    volumes=[{"cache_volume": "build", "guest_path": "/cache", **extra}]
                )
