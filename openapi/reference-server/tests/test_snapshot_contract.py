"""The reference adapter must call the SDK's keyword-only snapshot API."""

from types import SimpleNamespace
from unittest import IsolatedAsyncioTestCase
from unittest.mock import patch

from test_handle_cache import SERVER


class SnapshotAdapterTests(IsolatedAsyncioTestCase):
    def test_snapshot_metadata_matches_sdk(self):
        # SnapshotInfo exposes the container disk only, never guest_disk_bytes.
        info = SimpleNamespace(
            id="s", box_id="b", name="checkpoint", created_at=0,
            snapshot_type="filesystem", is_mock=False,
            container_disk_bytes=1, size_bytes=1,
        )
        result = SERVER.snapshot_info_to_dict(info)
        self.assertEqual(result["container_disk_bytes"], 1)
        self.assertNotIn("guest_disk_bytes", result)

    async def test_snapshot_create_uses_sdk_keyword_contract(self):
        calls = []

        class SnapshotHandle:
            async def create(self, *, name, options=None):
                calls.append((name, options))
                return SimpleNamespace(
                    id="s", box_id="b", name=name, created_at=0,
                    snapshot_type="filesystem", is_mock=False,
                    container_disk_bytes=1, size_bytes=1,
                )

        source = SimpleNamespace(snapshot=SnapshotHandle())
        with patch.object(SERVER, "get_box_or_404", return_value=source):
            result = await SERVER.create_snapshot(
                "org", "b", SERVER.CreateSnapshotRequest(name="checkpoint"), {}
            )
        self.assertEqual(result.status_code, 201)
        self.assertEqual(calls[0][0], "checkpoint")

    async def test_memory_capability_is_false(self):
        response = await SERVER.get_config()
        self.assertFalse(response["capabilities"]["memory_snapshots_enabled"])
