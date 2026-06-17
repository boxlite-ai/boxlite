from cicd import versions as v

CARGO = '[workspace.package]\nversion = "0.9.5"\nedition = "2021"\n'
PYPROJECT = '[project]\nname = "boxlite"\nversion = "0.9.5"\n'
PKG_JSON = '{\n  "name": "@boxlite-ai/boxlite",\n  "version": "0.9.5"\n}\n'
PKG_JSON_DRIFT = '{\n  "name": "boxlite",\n  "version": "1.0.0"\n}\n'


def test_extractors():
    assert v.cargo_workspace_version(CARGO) == "0.9.5"
    assert v.pyproject_version(PYPROJECT) == "0.9.5"
    assert v.json_version(PKG_JSON) == "0.9.5"


def test_no_drift_when_aligned():
    sites = {
        "Cargo.toml": v.cargo_workspace_version(CARGO),
        "sdks/python/pyproject.toml": v.pyproject_version(PYPROJECT),
        "sdks/node/package.json": v.json_version(PKG_JSON),
    }
    assert v.check_drift(sites) == []


def test_detects_drift():
    sites = {
        "Cargo.toml": v.cargo_workspace_version(CARGO),
        "package.json": v.json_version(PKG_JSON_DRIFT),  # 1.0.0 != 0.9.5
    }
    errs = v.check_drift(sites)
    assert any("1.0.0" in e and "0.9.5" in e for e in errs)


def test_missing_version_reported():
    errs = v.check_drift({"Cargo.toml": "0.9.5", "weird": None})
    assert any("weird" in e for e in errs)


def test_unknown_source_of_truth_raises():
    import pytest

    with pytest.raises(ValueError):
        v.check_drift({"a": "1.0.0"}, source_of_truth="Cargo.toml")
