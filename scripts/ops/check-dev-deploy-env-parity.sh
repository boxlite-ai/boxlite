#!/usr/bin/env bash
# Diagnose the dev "destructive LB replacement" diff = deploy env-parity gap.
#
# READ-ONLY: this script only DESCRIBES live resources and PRINTS the fix commands.
# It never mutates AWS or SSM. You review + run the printed commands yourself.
#
# Why: sst.config.ts references ~79 env vars; only ~18 are seeded to SSM
# (/boxlite/dev/env/*). The gap includes JAEGER_PUBLIC / MAILDEV_PUBLIC /
# PGADMIN_PUBLIC, which flip an ALB's scheme (internet-facing <-> internal) — an
# IMMUTABLE property — so a missing/false value forces a full LB replacement (and
# DNS churn). See docs/ops/dev-deploy-destructive-diff-rootcause.md.
#
# Usage:
#   aws sso login --profile boxlite-sso      # restore creds first
#   AWS_PROFILE=boxlite-sso bash scripts/ops/check-dev-deploy-env-parity.sh
set -euo pipefail

PROFILE="${AWS_PROFILE:-boxlite-sso}"
REGION="${AWS_REGION:-ap-southeast-1}"
STAGE="${STAGE:-dev}"
export AWS_PROFILE="$PROFILE"

echo "== 0. creds =="
aws sts get-caller-identity --query Arn --output text 2>&1 | sed -E 's/[0-9]{12}/<acct>/g' || {
  echo "  SSO expired — run: aws sso login --profile $PROFILE"; exit 1; }

echo
echo "== 1. live LB schemes (internet-facing vs internal) =="
# The observability LBs are the ones whose scheme is env-toggled (*_PUBLIC).
aws elbv2 describe-load-balancers --region "$REGION" \
  --query "LoadBalancers[?starts_with(LoadBalancerName,'boxlite') || contains(LoadBalancerName,'Jaeger') || contains(LoadBalancerName,'MailDev') || contains(LoadBalancerName,'PgAdmin') || contains(LoadBalancerName,'Api') || contains(LoadBalancerName,'Proxy')].{Name:LoadBalancerName,Scheme:Scheme}" \
  --output table 2>&1 | sed -E 's/[0-9]{12}/<acct>/g'

echo
echo "== 2. which *_PUBLIC env vars are seeded to SSM /boxlite/$STAGE/env/* =="
seeded=$(aws ssm get-parameters-by-path --path "/boxlite/$STAGE/env" --region "$REGION" --recursive \
  --query 'Parameters[].Name' --output text 2>&1 | tr '\t' '\n' | sed 's#.*/##' || true)
for v in JAEGER_PUBLIC MAILDEV_PUBLIC PGADMIN_PUBLIC; do
  if echo "$seeded" | grep -qx "$v"; then
    val=$(aws ssm get-parameter --name "/boxlite/$STAGE/env/$v" --region "$REGION" --query 'Parameter.Value' --output text 2>&1 || echo "?")
    echo "  $v = $val  (seeded)"
  else
    echo "  $v = (NOT seeded → deploy defaults to 'false' = internal)"
  fi
done

echo
echo "== 3. verdict + fix =="
echo "  For each observability LB above that is 'internet-facing' but whose *_PUBLIC"
echo "  is NOT seeded (or seeded 'false'): the next deploy will try to flip it to"
echo "  internal → FORCED LB REPLACE. To keep it as-is (Path A), seed the flag true:"
echo
echo "    # run only for LBs that are actually internet-facing:"
echo "    aws ssm put-parameter --region $REGION --type String --overwrite \\"
echo "      --name /boxlite/$STAGE/env/JAEGER_PUBLIC  --value true"
echo "    aws ssm put-parameter --region $REGION --type String --overwrite \\"
echo "      --name /boxlite/$STAGE/env/MAILDEV_PUBLIC --value true"
echo "    aws ssm put-parameter --region $REGION --type String --overwrite \\"
echo "      --name /boxlite/$STAGE/env/PGADMIN_PUBLIC --value true"
echo
echo "  Then re-check the plan (should no longer replace those LBs):"
echo "    cd apps/infra && AWS_PROFILE=$PROFILE npm run sst -- diff --stage $STAGE"
echo
echo "  Path B (accept the replace → make them internal, the config's intent): seed"
echo "  nothing / 'false', and let the deploy reconcile. CONFIRM in the diff that the"
echo "  PUBLIC Api/Proxy LBs (serving api.$STAGE / proxy.$STAGE) are NOT being flipped"
echo "  to internal — those must stay internet-facing or public access breaks."
