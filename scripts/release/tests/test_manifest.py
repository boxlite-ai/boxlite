from pathlib import Path

from cicd import manifest as m

EXAMPLE = Path(__file__).resolve().parents[1] / "release.example.yaml"


def test_example_manifest_is_valid():
    data = m.load(EXAMPLE)
    assert m.validate(data) == []
    assert m.enabled_trains(data) == ["oss", "cloud"]


def test_oss_release_requires_version():
    errs = m.validate({"oss": {"release": True}})
    assert any(e.field == "oss.version" for e in errs)


def test_oss_version_must_be_semver():
    errs = m.validate({"oss": {"release": True, "version": "v1"}})
    assert any(e.field == "oss.version" and "semver" in e.message for e in errs)


def test_prerelease_semver_is_accepted():
    assert m.validate({"oss": {"release": True, "version": "0.9.6-rc.1"}}) == []


def test_cloud_deploy_unknown_stage_rejected():
    errs = m.validate({"cloud": {"deploy": True, "stage": "tokyo"}})
    assert any(e.field == "cloud.stage" for e in errs)


def test_cloud_deploy_missing_stage_rejected():
    errs = m.validate({"cloud": {"deploy": True}})
    assert any(e.field == "cloud.stage" for e in errs)


def test_no_train_enabled_rejected():
    errs = m.validate({"oss": {"release": False}})
    assert any(e.field == "<root>" for e in errs)


def test_unknown_top_level_key_rejected():
    errs = m.validate({"ossss": {"release": True}})
    assert any(e.field == "ossss" for e in errs)


def test_non_mapping_root_rejected():
    assert m.validate(["oss"]) != []


def test_runner_only_release_is_valid():
    data = {"runner": {"rollout": True, "stage": "dev"}}
    assert m.validate(data) == []
    assert m.enabled_trains(data) == ["runner"]
