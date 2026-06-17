from cicd import artifact_manifest as am
from cicd.release_plan import plan

SAFE_DIFF = "  ~  aws:ecs/service:Service  boxlite-dev-Api  (update)\n"
DANGER_DIFF = "  +- aws:ec2/instance:Instance  boxlite-runner-default  (replace)\n"

CLOUD_MANIFEST = {"cloud": {"deploy": True, "stage": "dev"}}
OSS_MANIFEST = {"oss": {"release": True, "version": "0.9.6"}}


def test_clean_cloud_plan_can_apply():
    r = plan(
        CLOUD_MANIFEST,
        sst_diff_text=SAFE_DIFF,
        migrations_in_db=["1740", "1741"],
        expected_baseline=["1740", "1741"],
    )
    assert r["can_apply"] is True
    assert r["blocked_by"] == []
    assert r["trains"] == ["cloud"]


def test_invalid_manifest_short_circuits():
    r = plan({"oss": {"release": True}})  # missing version
    assert r["can_apply"] is False
    assert any("manifest:" in b for b in r["blocked_by"])


def test_resource_gate_blocks_runner_replace():
    r = plan(CLOUD_MANIFEST, sst_diff_text=DANGER_DIFF)
    assert r["can_apply"] is False
    assert any("resource:" in b and "boxlite-runner-default" in b for b in r["blocked_by"])


def test_allow_infra_override_unblocks_with_warning():
    r = plan(CLOUD_MANIFEST, sst_diff_text=DANGER_DIFF, allow_infra_change=True)
    assert r["can_apply"] is True
    assert any("resource:" in w for w in r["warnings"])


def test_db_drift_blocks():
    r = plan(
        CLOUD_MANIFEST,
        sst_diff_text=SAFE_DIFF,
        migrations_in_db=["1740", "1741", "1753"],
        expected_baseline=["1740", "1741"],
    )
    assert r["can_apply"] is False
    assert any("db-baseline:" in b for b in r["blocked_by"])


def test_dns_collision_blocks():
    r = plan(
        CLOUD_MANIFEST,
        sst_diff_text=SAFE_DIFF,
        planned_dns=[{"fqdn": "api.boxlite.ai"}],
        owned_dns={"api.boxlite.ai": "prod"},
        stage="dev",
    )
    assert r["can_apply"] is False
    assert any("dns:" in b for b in r["blocked_by"])


def test_oss_only_skips_infra_gates():
    # OSS publish doesn't touch AWS — even a scary diff is irrelevant here.
    r = plan(OSS_MANIFEST, sst_diff_text=DANGER_DIFF)
    assert r["can_apply"] is True
    assert r["trains"] == ["oss"]


def test_bad_artifact_manifest_blocks():
    bad = am.build("0.9.6", "abc", [{"name": "x", "kind": "oss", "digest": "nope", "location": "p"}])
    r = plan(CLOUD_MANIFEST, artifact_manifest_data=bad, sst_diff_text=SAFE_DIFF)
    assert r["can_apply"] is False
    assert any("artifact-manifest:" in b for b in r["blocked_by"])
