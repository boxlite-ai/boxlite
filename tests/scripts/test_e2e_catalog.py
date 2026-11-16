"""Exercise catalog case orchestration without claiming SDK/runner coverage."""

import runpy
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

E2E = Path(__file__).resolve().parents[2] / "apps/e2e"
SDK_ERRORS = runpy.run_path(str(E2E.parents[1] / "sdks/python/boxlite/errors.py"))
BoxliteError = SDK_ERRORS["BoxliteError"]
NotFoundError = SDK_ERRORS["NotFoundError"]
InvalidStateError = SDK_ERRORS["InvalidStateError"]


class CaseFailed(BaseException):
    pass


def fail(message):
    raise CaseFailed(message)


def fixture(**_kwargs):
    return lambda function: function


class Catalog:
    def __init__(self, names=()):
        self.names = set(names)
        self.removed = []
        self.held_attempts = 0

    async def list(self):
        return [SimpleNamespace(repository=name) for name in self.names]

    async def usage(self):
        return SimpleNamespace(count=len(self.names), limit=20)

    async def remove(self, name):
        self.removed.append(name)
        if name not in self.names:
            raise NotFoundError(name)
        if self.held_attempts:
            self.held_attempts -= 1
            raise InvalidStateError("previous box is still being destroyed")
        self.names.remove(name)


class Runtime:
    def __init__(self, images):
        self.images = images
        self.boxes = {}
        self.pulls = []
        self.removed = []
        self.record_failed_pull = False
        self.boots = False
        self.failure = None

    async def create(self, options, name=None):
        if (await self.images.usage()).count >= 20:
            raise BoxliteError("This organization already holds its limit of 20 images")
        self.pulls.append(options.image)
        box = SimpleNamespace(id="box-id", name=name or "untracked-box")
        self.boxes[box.id] = box
        if self.record_failed_pull:
            self.images.names.add(options.image.rsplit(":", 1)[0])
        if self.boots:
            return box
        raise BoxliteError(self.failure or f"failed to pull {options.image}")

    async def get_info(self, name):
        return next(
            (box for box in self.boxes.values() if name in (box.id, box.name)), None
        )

    async def remove(self, name, *, force):
        assert force
        self.removed.append(name)
        box = await self.get_info(name)
        if box is None:
            raise NotFoundError(name)
        del self.boxes[box.id]


class CatalogCaseTest(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        sdk = SimpleNamespace(
            BoxOptions=lambda **kwargs: SimpleNamespace(**kwargs),
            BoxliteError=BoxliteError,
            NotFoundError=NotFoundError,
            InvalidStateError=InvalidStateError,
        )
        pytest = SimpleNamespace(
            mark=SimpleNamespace(asyncio=lambda function: function),
            fail=fail,
            skip=lambda message: self.skipTest(message),
        )
        self.wait = AsyncMock(return_value=[])
        dependencies = {
            "boxlite": sdk,
            "pytest": pytest,
            "pytest_asyncio": SimpleNamespace(fixture=fixture),
            "conftest": SimpleNamespace(wait_until_unlisted=self.wait),
        }
        with (
            patch.object(sys, "path", [str(E2E / "lib"), *sys.path]),
            patch.dict(sys.modules, dependencies),
        ):
            helpers = runpy.run_path(str(E2E / "lib/catalog_boxes.py"))
            with patch.dict(sys.modules, {"catalog_boxes": SimpleNamespace(**helpers)}):
                loaded = runpy.run_path(str(E2E / "cases/test_images_catalog.py"))
        self.case = loaded["test_a_pull_that_fails_records_nothing"]
        self.scope = self.case.__globals__

        async def report_once(check):
            await check()

        async def poll_three_times(read):
            for _ in range(3):
                result = await read()
                if result is not None:
                    return result
            return None

        self.scope["hold_through_report_window"] = report_once
        self.scope["until_reported"] = poll_three_times
        self.catalog_name = self.scope["CATALOG_NAME"]
        self.missing_name = self.scope["UNPULLABLE_NAME"]

    async def test_full_catalog_releases_only_its_own_entry_and_reaches_pull(self):
        unrelated = {f"quay.io/other/image-{n}" for n in range(19)}
        images = Catalog(unrelated | {self.catalog_name})
        images.held_attempts = 2
        runtime = Runtime(images)
        await self.case(runtime, images)
        self.assertEqual(runtime.pulls, [self.scope["UNPULLABLE_IMAGE"]])
        self.assertEqual(images.names, unrelated)
        self.assertEqual(set(images.removed), {self.catalog_name})

    async def test_failed_create_box_is_removed_even_without_returned_handle(self):
        runtime = Runtime(Catalog())
        await self.case(runtime, runtime.images)
        self.assertEqual(runtime.boxes, {}, "failed create stranded an untracked box")
        self.assertEqual(runtime.removed, ["box-id"])
        self.wait.assert_awaited_once_with(runtime, ["box-id"])

    async def test_full_unrelated_catalog_fails_precondition_without_creating(self):
        unrelated = {f"quay.io/other/image-{n}" for n in range(20)}
        runtime = Runtime(Catalog(unrelated))
        with self.assertRaisesRegex(AssertionError, "capacity precondition"):
            await self.case(runtime, runtime.images)
        self.assertEqual(runtime.pulls, [])
        self.assertEqual(runtime.images.names, unrelated)

    async def test_failed_pull_catalog_record_still_fails_after_box_cleanup(self):
        runtime = Runtime(Catalog())
        runtime.record_failed_pull = True
        with self.assertRaisesRegex(AssertionError, "entered the catalog"):
            await self.case(runtime, runtime.images)
        self.assertIn(self.missing_name, runtime.images.names)
        self.assertEqual(runtime.boxes, {})

    async def test_unexpected_success_still_fails_and_removes_box(self):
        runtime = Runtime(Catalog())
        runtime.boots = True
        with self.assertRaisesRegex(CaseFailed, "booted a box"):
            await self.case(runtime, runtime.images)
        self.assertEqual(runtime.boxes, {})

    async def test_report_window_runs_before_destroy_can_drop_a_pending_report(self):
        runtime = Runtime(Catalog())

        async def report_while_box_exists(check):
            self.assertTrue(runtime.boxes, "cleanup ran before the reporting window")
            await check()

        self.scope["hold_through_report_window"] = report_while_box_exists
        await self.case(runtime, runtime.images)
        self.assertEqual(runtime.boxes, {})

    async def test_unrelated_create_error_is_not_mistaken_for_registry_failure(self):
        runtime = Runtime(Catalog())
        runtime.failure = "connection lost"
        with self.assertRaisesRegex(AssertionError, "before the pull was attempted"):
            await self.case(runtime, runtime.images)
        self.assertEqual(runtime.boxes, {})

    async def test_cleanup_attempts_both_entries_and_reports_held_image(self):
        images = Catalog({self.catalog_name, self.missing_name})
        remove = images.remove

        async def held_catalog(name):
            if name == self.catalog_name:
                images.removed.append(name)
                raise InvalidStateError("box still holds the image")
            await remove(name)

        images.remove = held_catalog
        cleanup = self.scope["clean_catalog"](images)
        with self.assertRaisesRegex(AssertionError, "catalog cleanup"):
            await anext(cleanup)
        self.assertEqual(set(images.removed), {self.catalog_name, self.missing_name})
        self.assertNotIn(self.missing_name, images.names)

    async def test_default_create_leaves_runtime_naming_enabled(self):
        runtime = SimpleNamespace(create=AsyncMock(return_value="box"))
        await self.scope["create_box"](runtime, "quay.io/libpod/alpine:latest")
        args, kwargs = runtime.create.await_args
        self.assertEqual(args[0].image, "quay.io/libpod/alpine:latest")
        self.assertEqual(kwargs, {})


if __name__ == "__main__":
    unittest.main()
