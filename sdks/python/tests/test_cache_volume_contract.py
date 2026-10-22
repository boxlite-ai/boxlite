"""SDK boundary checks; real runner behavior is make test:runner-ci:cache."""

import tempfile
import unittest

import boxlite
from boxlite.errors import UnsupportedError


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
