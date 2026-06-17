from cicd import preflight as pf

# Representative sst/pulumi diff. The runner EC2 instance is being REPLACED
# (the exact "routine deploy nuked a stateful resource" class we gate against),
# while the ECS service is only updated.
SST_DIFF_DANGER = """
  Plan:
    ~  aws:ecs/service:Service       boxlite-dev-Api          (update)
    +- aws:ec2/instance:Instance     boxlite-runner-default   (replace)
    +  aws:cloudwatch/logGroup:LogGroup  boxlite-dev-logs     (create)
"""

SST_DIFF_SAFE = """
  Plan:
    ~  aws:ecs/service:Service       boxlite-dev-Api          (update)
    +  aws:cloudwatch/logGroup:LogGroup  boxlite-dev-logs     (create)
"""


def test_parse_sst_diff_extracts_changes():
    changes = pf.parse_sst_diff(SST_DIFF_DANGER)
    actions = {(c.action, c.name) for c in changes}
    assert ("replace", "boxlite-runner-default") in actions
    assert ("update", "boxlite-dev-Api") in actions
    assert ("create", "boxlite-dev-logs") in actions


def test_resource_gate_blocks_runner_replace():
    v = pf.resource_gate(pf.parse_sst_diff(SST_DIFF_DANGER))
    assert v.blocked
    assert any("boxlite-runner-default" in r for r in v.reasons)


def test_resource_gate_allows_safe_diff():
    v = pf.resource_gate(pf.parse_sst_diff(SST_DIFF_SAFE))
    assert not v.blocked


def test_resource_gate_override_warns_not_blocks():
    v = pf.resource_gate(pf.parse_sst_diff(SST_DIFF_DANGER), allow_infra_change=True)
    assert not v.blocked
    assert v.warnings  # override is recorded, not silent


def test_db_baseline_gate_clean():
    assert not pf.db_baseline_gate(["1740", "1741"], ["1740", "1741"]).blocked


def test_db_baseline_gate_blocks_extra_migration():
    # db ran a migration the baseline doesn't know -> divergent-branch drift
    v = pf.db_baseline_gate(["1740", "1741", "1753"], ["1740", "1741"])
    assert v.blocked and any("1753" in r for r in v.reasons)


def test_db_baseline_gate_blocks_missing_migration():
    # baseline recorded but db never built it -> "relation does not exist" class
    v = pf.db_baseline_gate(["1740"], ["1740", "1741"])
    assert v.blocked and any("1741" in r for r in v.reasons)


def test_dns_preflight_blocks_cross_stage_collision():
    planned = [{"fqdn": "api.boxlite.ai"}]
    owned = {"api.boxlite.ai": "prod"}
    v = pf.dns_preflight(planned, owned, stage="dev")
    assert v.blocked


def test_dns_preflight_same_stage_ok():
    planned = [{"fqdn": "api.dev.boxlite.ai"}]
    owned = {"api.dev.boxlite.ai": "dev"}
    assert not pf.dns_preflight(planned, owned, stage="dev").blocked
