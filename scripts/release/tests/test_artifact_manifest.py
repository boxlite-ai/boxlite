from cicd import artifact_manifest as am

GOOD = "sha256:" + "a" * 64


def _artifact(**over):
    base = {"name": "python-sdk", "kind": "oss", "digest": GOOD, "location": "pypi"}
    base.update(over)
    return base


def test_build_then_validate_ok():
    man = am.build("0.9.6", "abc123", [_artifact()], created_by="ci")
    assert am.validate(man) == []
    assert man["version"] == "0.9.6"


def test_bad_digest_rejected():
    man = am.build("0.9.6", "abc", [_artifact(digest="abc")])
    errs = am.validate(man)
    assert any("digest" in e for e in errs)


def test_unknown_kind_rejected():
    man = am.build("0.9.6", "abc", [_artifact(kind="banana")])
    assert any("kind" in e for e in am.validate(man))


def test_duplicate_name_rejected():
    man = am.build("0.9.6", "abc", [_artifact(), _artifact(digest="sha256:" + "b" * 64)])
    assert any("duplicate" in e for e in am.validate(man))


def test_empty_artifacts_rejected():
    man = am.build("0.9.6", "abc", [])
    assert any("artifacts" in e for e in am.validate(man))


def test_missing_version_rejected():
    man = am.build("", "abc", [_artifact()])
    assert any("version" in e for e in am.validate(man))


def test_find_returns_artifact_or_none():
    man = am.build("0.9.6", "abc", [_artifact(name="runner", kind="runner-binary", location="gh")])
    assert am.find(man, "runner")["kind"] == "runner-binary"
    assert am.find(man, "nope") is None
