import pytest

from cicd import ledger


def _entry(**over):
    base = {"version": "0.9.6", "stage": "dev", "sha": "aaa", "ts": "2026-06-17T00:00:00Z",
            "smoke": "passed"}
    base.update(over)
    return base


def test_append_and_read_roundtrip(tmp_path):
    p = tmp_path / "ledger.jsonl"
    ledger.append(p, _entry(sha="aaa"))
    ledger.append(p, _entry(sha="bbb"))
    rows = ledger.read(p)
    assert [r["sha"] for r in rows] == ["aaa", "bbb"]


def test_last_good_sha_returns_latest_passed(tmp_path):
    p = tmp_path / "ledger.jsonl"
    ledger.append(p, _entry(sha="aaa", smoke="passed"))
    ledger.append(p, _entry(sha="bbb", smoke="passed"))
    assert ledger.last_good_sha(p, "dev") == "bbb"


def test_last_good_sha_skips_failed_latest(tmp_path):
    # latest deploy failed smoke -> rollback target must be the prior good one
    p = tmp_path / "ledger.jsonl"
    ledger.append(p, _entry(sha="good", smoke="passed"))
    ledger.append(p, _entry(sha="bad", smoke="failed"))
    assert ledger.last_good_sha(p, "dev") == "good"


def test_last_good_sha_is_per_stage(tmp_path):
    p = tmp_path / "ledger.jsonl"
    ledger.append(p, _entry(stage="dev", sha="devsha"))
    ledger.append(p, _entry(stage="prod", sha="prodsha"))
    assert ledger.last_good_sha(p, "prod") == "prodsha"
    assert ledger.last_good_sha(p, "dev") == "devsha"


def test_last_good_sha_none_when_empty(tmp_path):
    assert ledger.last_good_sha(tmp_path / "missing.jsonl", "dev") is None


def test_append_rejects_incomplete_entry(tmp_path):
    with pytest.raises(ValueError):
        ledger.append(tmp_path / "l.jsonl", {"stage": "dev"})  # no version/sha/ts
