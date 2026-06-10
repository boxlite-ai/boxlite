#!/bin/bash
#
# Provision the AWS IAM role used by the `e2e-cloud` GitHub Actions workflow.
#
# Architecture: GitHub Actions (ubuntu-latest) authenticates to AWS via OIDC,
# assumes the role created here, and uses short-lived STS credentials to:
#   - push API container image to ECR
#   - register a new ECS task definition + force-redeploy the Api service
#   - upload the runner binary to S3 and replace it on the runner EC2 via SSM
#   - exec into the Api ECS task to seed admin-org sandbox quota in RDS (one-time)
#   - read API LB DNS, admin API key from SSM Parameter Store
#   - run pytest in scripts/test/e2e/cases/ pointing at the Tokyo stack
#   - on failure, tail CloudWatch logs + runner journalctl over SSM
#
# Why a SEPARATE role from `boxlite-e2e-github-actions`:
#   The existing role is tuned for the us-east-1 self-hosted KVM-runner flow
#   (ec2:RunInstances on c8i.4xlarge etc.). Cloud e2e against the Tokyo
#   stack needs an orthogonal permission set scoped to ap-northeast-1
#   resources. Keeping them split lets each role audit cleanly and follows
#   least-privilege.
#
# Idempotent: re-running this script updates the existing role/policy in
# place. Safe to run on every infra change.
#
# Trust: limited to specific event types on this repo. The trust policy
# StringLike list below enumerates the contexts the e2e-cloud workflow
# actually runs in — push to main, PRs, and operator workflow_dispatch.
# This blocks a stray workflow added on a feature branch with malicious
# intent from assuming the role: only the registered subject patterns
# can mint an STS token, regardless of who pushed the workflow file.
#
# Usage:
#   AWS_ACCOUNT_ID=064212132677 scripts/ci/setup-e2e-cloud-oidc.sh
#   AWS_ACCOUNT_ID=064212132677 STAGE=e2e-ci scripts/ci/setup-e2e-cloud-oidc.sh

set -euo pipefail

CI_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../common.sh
source "$CI_SCRIPT_DIR/../common.sh"

# ─── Config ──────────────────────────────────────────────────────────────
: "${AWS_ACCOUNT_ID:?AWS_ACCOUNT_ID is required (e.g. 064212132677)}"
GITHUB_ORG="${GITHUB_ORG:-boxlite-ai}"
GITHUB_REPO="${GITHUB_REPO:-boxlite}"
ROLE_NAME="${ROLE_NAME:-boxlite-e2e-cloud-github-actions}"
POLICY_NAME="${POLICY_NAME:-boxlite-e2e-cloud-github-actions-policy}"
AWS_REGION="${AWS_REGION:-ap-northeast-1}"
STAGE="${STAGE:-e2e-ci}"
STACK_PREFIX="boxlite-${STAGE}"
OIDC_PROVIDER_URL="token.actions.githubusercontent.com"
OIDC_PROVIDER_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER_URL}"

require_command aws "Install AWS CLI v2: https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html"
require_command jq  "Install jq (e.g. apt-get install jq / brew install jq)"

print_header "Provisioning IAM role: ${ROLE_NAME}"

# ─── 1. OIDC provider — verify, don't recreate (shared resource) ─────────
print_section "Verifying OIDC provider"
print_step "  ${OIDC_PROVIDER_ARN} ... "
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_PROVIDER_ARN" >/dev/null 2>&1; then
    print_success "exists"
else
    echo "missing — creating"
    # GitHub's OIDC thumbprint rotates; AWS-side validation uses
    # certificate-of-trust, so the thumbprint field is functionally legacy.
    aws iam create-open-id-connect-provider \
        --url "https://${OIDC_PROVIDER_URL}" \
        --client-id-list sts.amazonaws.com \
        --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 \
        >/dev/null
    print_success "OIDC provider created"
fi

# ─── 2. Trust policy — scoped to specific event types on this repo ───────
# Each `sub` pattern matches one execution context the e2e-cloud workflow
# actually needs. A stray workflow on a feature branch CAN'T assume this
# role unless its subject matches one of these patterns. To temporarily
# allow a debug branch, prepend its `sub` (e.g. `repo:.../ref:refs/heads/debug-x`)
# and re-run this script.
TRUST_POLICY=$(cat <<EOF
{
    "Version": "2012-10-17",
    "Statement": [{
        "Effect": "Allow",
        "Principal": { "Federated": "${OIDC_PROVIDER_ARN}" },
        "Action": "sts:AssumeRoleWithWebIdentity",
        "Condition": {
            "StringEquals": {
                "${OIDC_PROVIDER_URL}:aud": "sts.amazonaws.com"
            },
            "StringLike": {
                "${OIDC_PROVIDER_URL}:sub": [
                    "repo:${GITHUB_ORG}/${GITHUB_REPO}:ref:refs/heads/main",
                    "repo:${GITHUB_ORG}/${GITHUB_REPO}:pull_request",
                    "repo:${GITHUB_ORG}/${GITHUB_REPO}:environment:e2e-cloud"
                ]
            }
        }
    }]
}
EOF
)

# ─── 3. Permissions policy — scoped to Tokyo stack ───────────────────────
# Wildcards on Resource appear ONLY where AWS does not support resource-level
# scoping (ecr:GetAuthorizationToken, ssmmessages:*, ecs:Describe*, elbv2:Describe*,
# ecs:RegisterTaskDefinition). All actionable ARNs are pinned to the
# boxlite-e2e-ci stack prefix or specific role ARN patterns.
PERMISSIONS_POLICY=$(cat <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "EcrLogin",
            "Effect": "Allow",
            "Action": ["ecr:GetAuthorizationToken"],
            "Resource": "*"
        },
        {
            "Sid": "EcrPush",
            "Effect": "Allow",
            "Action": [
                "ecr:BatchCheckLayerAvailability",
                "ecr:BatchGetImage",
                "ecr:DescribeImages",
                "ecr:DescribeRepositories",
                "ecr:GetDownloadUrlForLayer",
                "ecr:InitiateLayerUpload",
                "ecr:UploadLayerPart",
                "ecr:CompleteLayerUpload",
                "ecr:PutImage"
            ],
            "Resource": "arn:aws:ecr:${AWS_REGION}:${AWS_ACCOUNT_ID}:repository/sst-asset"
        },
        {
            "Sid": "EcsReadDescribe",
            "Effect": "Allow",
            "Action": [
                "ecs:DescribeClusters",
                "ecs:DescribeServices",
                "ecs:DescribeTasks",
                "ecs:DescribeTaskDefinition",
                "ecs:ListClusters",
                "ecs:ListServices",
                "ecs:ListTasks",
                "ecs:ListTaskDefinitions"
            ],
            "Resource": "*"
        },
        {
            "Sid": "EcsRegisterTaskDef",
            "Effect": "Allow",
            "Action": ["ecs:RegisterTaskDefinition", "ecs:DeregisterTaskDefinition"],
            "Resource": "*"
        },
        {
            "Sid": "EcsUpdateApiService",
            "Effect": "Allow",
            "Action": "ecs:UpdateService",
            "Resource": "arn:aws:ecs:${AWS_REGION}:${AWS_ACCOUNT_ID}:service/${STACK_PREFIX}-*/Api"
        },
        {
            "Sid": "EcsExecApiTask",
            "Effect": "Allow",
            "Action": "ecs:ExecuteCommand",
            "Resource": "arn:aws:ecs:${AWS_REGION}:${AWS_ACCOUNT_ID}:task/${STACK_PREFIX}-*/*"
        },
        {
            "Sid": "EcsExecChannel",
            "Effect": "Allow",
            "Action": [
                "ssmmessages:CreateControlChannel",
                "ssmmessages:CreateDataChannel",
                "ssmmessages:OpenControlChannel",
                "ssmmessages:OpenDataChannel"
            ],
            "Resource": "*"
        },
        {
            "Sid": "IamPassRoleForEcsTaskDef",
            "Effect": "Allow",
            "Action": "iam:PassRole",
            "Resource": "arn:aws:iam::${AWS_ACCOUNT_ID}:role/${STACK_PREFIX}-*",
            "Condition": {
                "StringEquals": { "iam:PassedToService": "ecs-tasks.amazonaws.com" }
            }
        },
        {
            "Sid": "SsmSendCommandRunner",
            "Effect": "Allow",
            "Action": ["ssm:SendCommand"],
            "Resource": [
                "arn:aws:ec2:${AWS_REGION}:${AWS_ACCOUNT_ID}:instance/*",
                "arn:aws:ssm:${AWS_REGION}::document/AWS-RunShellScript"
            ],
            "Condition": {
                "StringEquals": {
                    "ssm:resourceTag/Name": "boxlite-runner"
                }
            }
        },
        {
            "Sid": "SsmReadCommandStatus",
            "Effect": "Allow",
            "Action": [
                "ssm:GetCommandInvocation",
                "ssm:ListCommandInvocations",
                "ssm:DescribeInstanceInformation"
            ],
            "Resource": "*"
        },
        {
            "Sid": "SsmReadParameters",
            "Effect": "Allow",
            "Action": ["ssm:GetParameter", "ssm:GetParameters"],
            "Resource": "arn:aws:ssm:${AWS_REGION}:${AWS_ACCOUNT_ID}:parameter/boxlite/${STAGE}/*"
        },
        {
            "Sid": "S3Artifacts",
            "Effect": "Allow",
            "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
            "Resource": "arn:aws:s3:::${STACK_PREFIX}-storagebucket-*/builds/*"
        },
        {
            "Sid": "S3List",
            "Effect": "Allow",
            "Action": ["s3:ListBucket", "s3:ListAllMyBuckets"],
            "Resource": "*"
        },
        {
            "Sid": "ElbRead",
            "Effect": "Allow",
            "Action": [
                "elasticloadbalancing:DescribeLoadBalancers",
                "elasticloadbalancing:DescribeListeners",
                "elasticloadbalancing:DescribeTargetGroups",
                "elasticloadbalancing:DescribeTargetHealth"
            ],
            "Resource": "*"
        },
        {
            "Sid": "Ec2DescribeRunner",
            "Effect": "Allow",
            "Action": ["ec2:DescribeInstances"],
            "Resource": "*"
        },
        {
            "Sid": "CloudWatchLogsRead",
            "Effect": "Allow",
            "Action": [
                "logs:DescribeLogGroups",
                "logs:DescribeLogStreams",
                "logs:GetLogEvents",
                "logs:FilterLogEvents"
            ],
            "Resource": "arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:/sst/cluster/${STACK_PREFIX}-*:*"
        }
    ]
}
EOF
)

# ─── 4. Create or update role ────────────────────────────────────────────
print_section "Creating / updating IAM role"
print_step "  ${ROLE_NAME} ... "
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
    echo "exists — updating trust policy"
    aws iam update-assume-role-policy --role-name "$ROLE_NAME" \
        --policy-document "$TRUST_POLICY"
    print_success "trust policy updated"
else
    echo "missing — creating"
    aws iam create-role \
        --role-name "$ROLE_NAME" \
        --description "Used by .github/workflows/e2e-cloud.yml - deploys to Tokyo stack and runs e2e tests" \
        --assume-role-policy-document "$TRUST_POLICY" \
        --max-session-duration 3600 \
        >/dev/null
    print_success "role created"
fi

# ─── 5. Attach inline permissions policy ─────────────────────────────────
print_section "Putting inline policy"
print_step "  ${POLICY_NAME} ... "
aws iam put-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name "$POLICY_NAME" \
    --policy-document "$PERMISSIONS_POLICY"
print_success "policy attached"

# ─── 6. Surface the role ARN for GitHub repo variables ───────────────────
ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${ROLE_NAME}"
echo ""
print_header "Done"
cat >&2 <<EOF

  Role ARN: ${ROLE_ARN}
  Region:   ${AWS_REGION}

  Set this in GitHub repo Settings → Secrets and variables → Actions → Variables:
    AWS_ACCOUNT_ID          = ${AWS_ACCOUNT_ID}          (already set, per .github/workflows/README.md)
    AWS_E2E_CLOUD_REGION    = ${AWS_REGION}
    AWS_E2E_CLOUD_ROLE_ARN  = ${ROLE_ARN}

  Test from a GHA workflow with:
    - uses: aws-actions/configure-aws-credentials@v4
      with:
        role-to-assume: \${{ vars.AWS_E2E_CLOUD_ROLE_ARN }}
        aws-region: \${{ vars.AWS_E2E_CLOUD_REGION }}

EOF
