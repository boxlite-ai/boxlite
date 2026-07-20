"""Auto-stop interval options coverage for the Python SDK."""
from __future__ import annotations

import boxlite
import pytest


@pytest.mark.asyncio
async def test_auto_stop_interval_create_and_validation(rt, image):
    cases = ((None, 15), (0, 0), (5, 5))

    for requested, expected in cases:
        options = boxlite.BoxOptions(image=image, auto_remove=True)
        if requested is not None:
            options = boxlite.BoxOptions(
                image=image,
                auto_remove=True,
                auto_stop_interval=requested,
            )

        box = await rt.create(options)
        try:
            info = await rt.get_info(box.id)
            assert info.auto_stop_interval == expected
        finally:
            await rt.remove(box.id, force=True)

    for invalid in (-1, 1.5):
        with pytest.raises((OverflowError, TypeError, ValueError)):
            boxlite.BoxOptions(image=image, auto_stop_interval=invalid)
