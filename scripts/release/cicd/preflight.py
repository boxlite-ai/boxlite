"""Pre-apply gates (read-only "plan"): block dangerous deploys BEFORE they run.

Three gates, each pure-logic so they unit-test against fixtures (the workflow
feeds them real ``sst diff`` text / DB state / DNS records):

1. resource_gate   -- block replace/delete on stateful resources (Runner/RDS/Redis)
2. db_baseline_gate-- block when migrations table drifts from the expected baseline
                      (this is the 1741/1753 "recorded baseline but table not built"
                      class of incident this repo hit)
3. dns_preflight   -- block when a DNS record would collide across stages

Each returns a Verdict(blocked, reasons, warnings).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# Stateful resources a routine deploy must never replace/delete without an
# explicit override. Matched as substrings against the SST/Pulumi resource type.
PROTECTED_TYPES = ("Instance", "Runner", "rds", "Database", "elasticache", "Redis")
DANGEROUS_ACTIONS = ("replace", "delete")


@dataclass
class Verdict:
    blocked: bool = False
    reasons: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def block(self, reason: str) -> None:
        self.blocked = True
        self.reasons.append(reason)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)


@dataclass(frozen=True)
class Change:
    action: str  # create | update | replace | delete
    type: str
    name: str


# Matches lines like:  +  aws:ec2/instance:Instance  boxlite-runner-default   (create)
#                       -  aws:rds/instance:Instance  boxlite-dev-db           (delete)
#                       +- ...:Instance ... (replace)   /   ~ ...:... (update)
_SIGN = {"+": "create", "-": "delete", "+-": "replace", "-+": "replace", "~": "update"}
_DIFF_LINE = re.compile(r"^\s*([+~-]{1,2})\s+([\w.:/-]+)\s+(\S+)")


def parse_sst_diff(text: str) -> list[Change]:
    """Parse ``sst diff`` / pulumi-style output into structured changes."""
    changes: list[Change] = []
    for line in text.splitlines():
        m = _DIFF_LINE.match(line)
        if not m:
            continue
        sign, rtype, name = m.group(1), m.group(2), m.group(3)
        action = _SIGN.get(sign)
        if action is None:
            continue
        changes.append(Change(action=action, type=rtype, name=name))
    return changes


def resource_gate(changes: list[Change], allow_infra_change: bool = False) -> Verdict:
    """Block replace/delete on protected stateful resources unless overridden."""
    v = Verdict()
    for c in changes:
        if c.action in DANGEROUS_ACTIONS and any(p.lower() in c.type.lower() for p in PROTECTED_TYPES):
            msg = f"{c.action} on protected resource {c.type} ({c.name})"
            if allow_infra_change:
                v.warn(f"ALLOWED via override: {msg}")
            else:
                v.block(msg)
    return v


def db_baseline_gate(migrations_in_db: list[str], expected_baseline: list[str]) -> Verdict:
    """Block when the DB migrations table does not match the expected baseline.

    Two failure modes, both seen in real incidents:
      * EXTRA   -- db ran migrations not in the baseline (drift / divergent branch)
      * MISSING -- baseline recorded but the migration is absent from the db
                   ("recorded baseline but table not built" -> relation does not exist)
    """
    v = Verdict()
    db = set(migrations_in_db)
    base = set(expected_baseline)
    for extra in sorted(db - base):
        v.block(f"db has migration not in baseline: {extra}")
    for missing in sorted(base - db):
        v.block(f"baseline migration missing from db: {missing}")
    return v


def dns_preflight(planned_records: list[dict], owned_by_stage: dict[str, str], stage: str) -> Verdict:
    """Block when a planned DNS record's fqdn is already owned by another stage.

    planned_records : [{"fqdn": "api.dev.boxlite.ai"}, ...]
    owned_by_stage  : {"api.dev.boxlite.ai": "dev", ...}  (existing ownership)
    stage           : the stage we are deploying
    """
    v = Verdict()
    for rec in planned_records:
        fqdn = rec.get("fqdn")
        owner = owned_by_stage.get(fqdn)
        if owner and owner != stage:
            v.block(f"DNS record {fqdn} already owned by stage {owner!r} (deploying {stage!r})")
    return v
