"""boxlite.Mount and BoxOptions(mounts=...): construction only, no VM."""

from __future__ import annotations

import pytest

import boxlite

# Skip only when the native extension is not built at all. A built extension
# whose package does not export `Mount` is a failure below, not a skip.
if not hasattr(boxlite, "BoxOptions"):
    pytest.skip(
        "boxlite native extension not available (rebuild SDK with: make dev:python)",
        allow_module_level=True,
    )


class TestMount:
    def test_is_exported_from_the_package(self):
        """`from boxlite import Mount` is the documented spelling."""
        assert "Mount" in boxlite.__all__
        assert hasattr(boxlite, "Mount")

    def test_keyword_construction_exposes_every_field(self):
        mount = boxlite.Mount(
            type="volume",
            source="run42",
            target="/workspace",
            read_only=True,
            sub_path="foo/bar",
        )

        assert mount.type == "volume"
        assert mount.source == "run42"
        assert mount.target == "/workspace"
        assert mount.read_only is True
        assert mount.sub_path == "foo/bar"

    def test_omitted_fields_mean_writable_and_the_whole_volume(self):
        mount = boxlite.Mount(type="bind", source="/srv/data", target="/data")

        assert mount.read_only is False
        assert mount.sub_path is None

    def test_arguments_are_keyword_only(self):
        """A positional call could otherwise put a source where a target goes."""
        with pytest.raises(TypeError):
            boxlite.Mount("volume", "/workspace")

    def test_a_misspelt_type_fails_where_it_is_written(self):
        with pytest.raises(RuntimeError, match="unknown mount type"):
            boxlite.Mount(type="volme", source="run42", target="/workspace")

    def test_repr_names_every_field(self):
        mount = boxlite.Mount(type="volume", source="run42", target="/workspace")

        assert repr(mount) == (
            'Mount(type="volume", source="run42", target="/workspace", '
            "read_only=False, sub_path=None)"
        )


class TestBoxOptionsMounts:
    def test_accepts_mount_objects_and_dicts(self):
        boxlite.BoxOptions(
            image="alpine:latest",
            mounts=[
                boxlite.Mount(type="volume", source="run42", target="/workspace"),
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

    def test_refuses_an_entry_that_is_neither_mount_nor_dict(self):
        with pytest.raises(RuntimeError, match="Mount or dict"):
            boxlite.BoxOptions(mounts=[("run42", "/workspace")])
