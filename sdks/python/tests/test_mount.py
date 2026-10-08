"""BoxOptions(mounts=...): construction only, no VM."""

from __future__ import annotations

import pytest

import boxlite

# Skip only when the native extension is not built at all.
if not hasattr(boxlite, "BoxOptions"):
    pytest.skip(
        "boxlite native extension not available (rebuild SDK with: make dev:python)",
        allow_module_level=True,
    )


class TestBoxOptionsMounts:
    def test_accepts_dicts(self):
        boxlite.BoxOptions(
            image="alpine:latest",
            mounts=[
                {"type": "volume", "source": "run42", "target": "/workspace"},
                {
                    "type": "bind",
                    "source": "/srv/data",
                    "target": "/data",
                    "read_only": True,
                },
            ],
        )

    def test_refuses_an_unknown_dict_key(self):
        """Dropping Docker's `readonly` would hand back a writable mount."""
        with pytest.raises(RuntimeError, match="unknown mount dict key"):
            boxlite.BoxOptions(
                mounts=[
                    {
                        "type": "volume",
                        "source": "run42",
                        "target": "/w",
                        "readonly": True,
                    }
                ]
            )

    def test_refuses_a_misspelt_type_in_a_dict(self):
        with pytest.raises(RuntimeError, match="unknown mount type"):
            boxlite.BoxOptions(
                mounts=[{"type": "volme", "source": "run42", "target": "/w"}]
            )

    def test_refuses_an_entry_that_is_not_a_dict(self):
        with pytest.raises(RuntimeError, match="must be dicts"):
            boxlite.BoxOptions(mounts=[("run42", "/workspace")])
