"""Unit tests for orchestrator.topo_sort."""

import pytest

from boxlite_local.orchestrator import topo_sort
from boxlite_local.types import ServiceSpec


def _spec(name: str, depends_on: list[str] | None = None) -> ServiceSpec:
    return ServiceSpec(name=name, image="img:1", depends_on=depends_on or [])


def test_single_service_returns_one_layer():
    services = {"a": _spec("a")}
    assert topo_sort(services) == [["a"]]


def test_two_independent_services_share_a_layer():
    services = {"a": _spec("a"), "b": _spec("b")}
    layers = topo_sort(services)
    assert len(layers) == 1
    assert set(layers[0]) == {"a", "b"}


def test_linear_dependency_chain_layered():
    services = {
        "a": _spec("a"),
        "b": _spec("b", depends_on=["a"]),
        "c": _spec("c", depends_on=["b"]),
    }
    assert topo_sort(services) == [["a"], ["b"], ["c"]]


def test_diamond_dependency_layered():
    services = {
        "root": _spec("root"),
        "left": _spec("left", depends_on=["root"]),
        "right": _spec("right", depends_on=["root"]),
        "leaf": _spec("leaf", depends_on=["left", "right"]),
    }
    layers = topo_sort(services)
    assert layers[0] == ["root"]
    assert set(layers[1]) == {"left", "right"}
    assert layers[2] == ["leaf"]


def test_cycle_raises():
    import graphlib
    services = {
        "a": _spec("a", depends_on=["b"]),
        "b": _spec("b", depends_on=["a"]),
    }
    with pytest.raises(graphlib.CycleError):
        topo_sort(services)


def test_empty_services_returns_empty_layers():
    assert topo_sort({}) == []
