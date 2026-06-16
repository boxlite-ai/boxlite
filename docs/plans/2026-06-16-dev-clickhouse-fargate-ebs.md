# Dev ClickHouse Fargate EBS Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stand up a cheapest-viable, dev-only ClickHouse service on ECS Fargate with service-managed EBS and route dev `OtelCollector` plus API ClickHouse reads to it instead of ClickHouse Cloud.

**Architecture:** Create a separate ECS Fargate service in the existing `ap-southeast-1` dev cluster, using ARM64 Linux, `0.5 vCPU / 1GB`, and one gp3 service-managed EBS volume mounted at `/var/lib/clickhouse`. The service is private-only in the existing dev VPC; API and `OtelCollector` reach it through the task private IP on port `8123`. This is a dev-only disposable telemetry backend: ECS service-managed EBS volumes are not preserved when service-managed tasks terminate.

**Tech Stack:** AWS ECS Fargate, ECS service-managed EBS volumes, IAM ECS infrastructure role, Security Groups, Docker ClickHouse image, AWS CLI, OpenTelemetry Collector ClickHouse exporter, BoxLite SST dev env.

---

## Important Constraint

AWS ECS service-managed EBS volumes are deleted when service-managed tasks terminate. This means the cheapest Fargate+EBS service is acceptable for dev telemetry recovery, but it is not a durable database design. If durable dev telemetry becomes important, move to EC2+EBS or a managed ClickHouse provider.

## Stop Points

- Stop A: after PR creation, before creating IAM roles, security group, task definition, or ECS service.
- Stop B: after creating the ClickHouse Fargate service, before editing dev env.
- Stop C: after editing dev env, before deploying `OtelCollector` or `Api`.
- Stop D: after `OtelCollector` deploy, before `Api` deploy.
- Stop E: after verification, before deciding whether to keep or delete ClickHouse Cloud env backups.

## Current Known Context

- Region: `ap-southeast-1`.
- ECS cluster: `boxlite-dev-ClusterCluster-vmauahcx`.
- VPC: `vpc-0f3bd1effd970d18d`.
- VPC CIDR: `10.0.0.0/16`.
- Private subnets:
  - `subnet-07d2d928a654beafa`.
  - `subnet-0c5678eb9c8c8cd54`.
- Remote worker: `boxlite-dev`.
- Remote repo: `/home/brian/work/boxlite/repos/boxlite`.
- Current AWS role has enough permission for ECS/IAM/EC2 dry-run and should be used only from the remote worker.

## Target Defaults

- Service name: `boxlite-dev-clickhouse`.
- Task family: `boxlite-dev-clickhouse`.
- CPU: `512` CPU units.
- Memory: `1024` MiB.
- Architecture: `ARM64`.
- Image: `clickhouse/clickhouse-server:25.5`.
- EBS: `gp3`, `50` GiB, encrypted.
- Port: `8123/http`.
- Access: only from dev VPC CIDR `10.0.0.0/16`.
- Database: `otel`.
- Writer user: `boxlite_otel_writer`.
- Reader user: same as writer for this cheapest dev-only fallback.

## Task 1: Create Isolated Worktree

**Files:**
- No changes.

**Step 1: Verify `.worktrees` is ignored**

Run:

```bash
git check-ignore -q .worktrees && echo ignored
```

Expected:

```text
ignored
```

**Step 2: Create branch worktree**

Run:

```bash
git fetch origin main
git worktree add .worktrees/dev-clickhouse-fargate-ebs -b codex/dev-clickhouse-fargate-ebs origin/main
```

Expected: worktree exists and is clean.

**Step 3: Commit**

No commit.

## Task 2: Add Fargate EBS Script

**Files:**
- Create: `scripts/deploy/dev-clickhouse-fargate-ebs.sh`

**Step 1: Write script**

Create a script that supports:

- `plan`: print config and dry-run IAM/security group where possible.
- `render`: render AWS CLI JSON inputs into `/tmp`.
- `create`: create IAM roles, log group, security group, task definition, and ECS service.
- `status`: print service/task/private IP.
- `print-env`: print BoxLite env values with secret placeholders.
- `delete`: scale service to 0 and delete service.

**Step 2: Run syntax check**

Run:

```bash
bash -n scripts/deploy/dev-clickhouse-fargate-ebs.sh
```

Expected: no output.

**Step 3: Commit**

Run:

```bash
git add scripts/deploy/dev-clickhouse-fargate-ebs.sh
git commit -m "chore(dev): add clickhouse fargate ebs script"
```

## Task 3: Add Operation Docs

**Files:**
- Create: `docs/operations/dev-clickhouse-fargate-ebs.md`

**Step 1: Document deploy flow**

Include:

- Cost estimate.
- Data loss constraint.
- Required secrets.
- Commands for plan/create/status/print-env.
- Required stop points.
- `OtelCollector` and `Api` deploy commands.
- Verification commands.
- Rollback.

**Step 2: Commit**

Run:

```bash
git add docs/operations/dev-clickhouse-fargate-ebs.md docs/plans/2026-06-16-dev-clickhouse-fargate-ebs.md
git commit -m "docs(dev): plan clickhouse fargate ebs fallback"
```

## Task 4: Verify Script Without Creating Resources

**Files:**
- No changes.

**Step 1: Run local syntax check**

Run:

```bash
bash -n scripts/deploy/dev-clickhouse-fargate-ebs.sh
```

Expected: no output.

**Step 2: Run `render` locally**

Run:

```bash
scripts/deploy/dev-clickhouse-fargate-ebs.sh render
```

Expected:

- Prints paths for task definition JSON, volume JSON, and trust policies.
- Does not call AWS mutating APIs.

**Step 3: Run remote `plan`**

Use @boxlite-remote-worker:

```bash
/Users/brian/.codex/skills/boxlite-remote-worker/scripts/remote_worker.sh run clickhouse-fargate-plan 'cd /home/brian/work/boxlite/repos/boxlite && scripts/deploy/dev-clickhouse-fargate-ebs.sh plan'
/Users/brian/.codex/skills/boxlite-remote-worker/scripts/remote_worker.sh wait clickhouse-fargate-plan
```

Expected:

- Shows config.
- Confirms AWS identity.
- Dry-run returns `DryRunOperation` for security group create.

## Task 5: Create PR and Stop

**Files:**
- No changes.

**Step 1: Push branch**

Run:

```bash
git push -u origin codex/dev-clickhouse-fargate-ebs
```

**Step 2: Create PR**

Run:

```bash
gh pr create \
  --base main \
  --head codex/dev-clickhouse-fargate-ebs \
  --title "Add dev ClickHouse Fargate EBS fallback" \
  --body "Adds a dev-only script and runbook for the cheapest ClickHouse fallback on ECS Fargate with service-managed EBS. No AWS resources are created by this PR."
```

**Step 3: Stop**

Do not run `create`, edit env, or deploy until Brian reviews the PR.

## Post-PR Deployment Outline

Only after Brian approves:

1. Run `scripts/deploy/dev-clickhouse-fargate-ebs.sh create` from `boxlite-dev`.
2. Run `status` until the service has one running task.
3. Run `print-env` and update remote dev env.
4. Stop before deploying.
5. Run `npx sst diff --stage dev --target OtelCollector`.
6. If scoped, deploy `OtelCollector`.
7. Verify `OtelCollector running=1`.
8. Run `npx sst diff --stage dev --target Api`.
9. If scoped, deploy `Api`.
10. Verify API health and ClickHouse telemetry tables.

## Verification Gates

- No public security group ingress.
- ECS service desired count is 1.
- Task uses ARM64 Fargate.
- Task private IP responds to `http://<ip>:8123/ping`.
- `OtelCollector` logs do not contain `failed to start "clickhouse" exporter`.
- `https://dev.boxlite.ai/api/health` returns healthy after API deploy.
