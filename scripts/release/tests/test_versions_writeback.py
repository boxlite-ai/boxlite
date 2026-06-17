from cicd import versions as v

CARGO = '[workspace.package]\nversion = "0.9.5"\nedition = "2021"\n'
PYPROJECT = '[project]\nname = "boxlite"\nversion = "0.9.5"\n'
PKG = '{\n  "name": "@boxlite-ai/boxlite",\n  "version": "0.9.5",\n  "dependencies": {}\n}\n'


def test_set_cargo_version_changes_only_version():
    out = v.set_first_version(CARGO, "0.9.6")
    assert v.cargo_workspace_version(out) == "0.9.6"
    assert "edition = \"2021\"" in out  # untouched


def test_set_pyproject_version():
    out = v.set_first_version(PYPROJECT, "0.9.6")
    assert v.pyproject_version(out) == "0.9.6"
    assert 'name = "boxlite"' in out


def test_set_json_version():
    out = v.set_json_version_text(PKG, "0.9.6")
    assert v.json_version(out) == "0.9.6"
    assert '"dependencies"' in out  # untouched


def test_writeback_then_no_drift():
    # round-trip: align all three to a new version -> drift check passes
    target = "1.2.3"
    sites = {
        "Cargo.toml": v.cargo_workspace_version(v.set_first_version(CARGO, target)),
        "pyproject.toml": v.pyproject_version(v.set_first_version(PYPROJECT, target)),
        "package.json": v.json_version(v.set_json_version_text(PKG, target)),
    }
    assert v.check_drift(sites) == []


def test_set_version_raises_when_absent():
    import pytest

    with pytest.raises(ValueError):
        v.set_first_version("name = \"x\"\n", "1.0.0")
