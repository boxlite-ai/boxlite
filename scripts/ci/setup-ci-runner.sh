#!/bin/bash
# Set up AWS infrastructure for E2E integration test runner.
#
# This provisions everything needed to run the e2e-test.yml workflow:
#   AWS: OIDC provider, IAM roles, instance profile, security group
#   GitHub: Repository variables and secrets
#
# Auto-detects AWS account ID, GitHub repo, default VPC, and public subnet.
#
# Usage:
#   ./scripts/ci/setup-ci-runner.sh
#   ./scripts/ci/setup-ci-runner.sh --vpc-id vpc-xxx --subnet-id subnet-xxx
#   ./scripts/ci/setup-ci-runner.sh --skip-github

set -euo pipefail

CI_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$CI_SCRIPT_DIR/../common.sh"

# ============================================================================
# Configuration
# ============================================================================

DEFAULT_REGION="us-east-1"

VPC_ID=""
SUBNET_ID=""
REGION="$DEFAULT_REGION"
SKIP_GITHUB=false

OIDC_PROVIDER_URL="token.actions.githubusercontent.com"
GH_ACTIONS_ROLE_NAME="boxlite-e2e-github-actions"
INSTANCE_PROFILE_ROLE_NAME="boxlite-e2e-runner"
INSTANCE_PROFILE_NAME="boxlite-e2e-runner"
SECURITY_GROUP_NAME="boxlite-e2e-runner"

# ============================================================================
# Functions
# ============================================================================

usage() {
    cat << EOF
Usage: $(basename "$0") [OPTIONS]

Set up AWS + GitHub infrastructure for BoxLite E2E integration tests.

OPTIONS:
    --vpc-id VPC_ID         VPC ID for security group (auto-detects default VPC)
    --subnet-id SUBNET_ID   Subnet ID for EC2 instances (auto-detects public subnet)
    --region REGION         AWS region (default: $DEFAULT_REGION)
    --skip-github           Skip GitHub variables/secrets setup
    --help                  Show this help message

EXAMPLES:
    $(basename "$0")                                                    # auto-detect everything
    $(basename "$0") --vpc-id vpc-abc123 --subnet-id subnet-abc123      # explicit VPC/subnet
    $(basename "$0") --skip-github                                      # AWS only

EOF
    exit 0
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --vpc-id)
                VPC_ID="$2"
                shift 2
                ;;
            --subnet-id)
                SUBNET_ID="$2"
                shift 2
                ;;
            --region)
                REGION="$2"
                shift 2
                ;;
            --skip-github)
                SKIP_GITHUB=true
                shift
                ;;
            --help|-h)
                usage
                ;;
            *)
                print_error "Unknown option: $1"
                usage
                ;;
        esac
    done
}

step_detect_config() {
    print_section "Detecting configuration"

    # AWS account ID
    print_step "AWS account... "
    ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    print_success "$ACCOUNT_ID"

    # GitHub repository (derive from origin remote to avoid multi-remote ambiguity)
    print_step "GitHub repository... "
    REPO=$(git remote get-url origin | sed 's|.*github.com[:/]||;s|\.git$||')
    if [ -z "$REPO" ]; then
        print_error "Cannot detect repo from 'origin' remote"
        exit 1
    fi
    print_success "$REPO"

    # VPC
    if [ -z "$VPC_ID" ]; then
        print_step "Default VPC... "
        VPC_ID=$(aws ec2 describe-vpcs \
            --filters "Name=is-default,Values=true" \
            --query "Vpcs[0].VpcId" --output text --region "$REGION" 2>/dev/null || echo "")
        if [ -z "$VPC_ID" ] || [ "$VPC_ID" = "None" ]; then
            print_error "No default VPC found in $REGION. Provide --vpc-id."
            exit 1
        fi
        print_success "$VPC_ID"
    else
        print_info "VPC: $VPC_ID"
    fi

    # Subnet
    if [ -z "$SUBNET_ID" ]; then
        print_step "Public subnet... "
        SUBNET_ID=$(aws ec2 describe-subnets \
            --filters "Name=vpc-id,Values=${VPC_ID}" "Name=map-public-ip-on-launch,Values=true" \
            --query "Subnets[0].SubnetId" --output text --region "$REGION" 2>/dev/null || echo "")
        if [ -z "$SUBNET_ID" ] || [ "$SUBNET_ID" = "None" ]; then
            SUBNET_ID=$(aws ec2 describe-subnets \
                --filters "Name=vpc-id,Values=${VPC_ID}" \
                --query "Subnets[0].SubnetId" --output text --region "$REGION" 2>/dev/null || echo "")
        fi
        if [ -z "$SUBNET_ID" ] || [ "$SUBNET_ID" = "None" ]; then
            print_error "No subnet found in VPC $VPC_ID. Provide --subnet-id."
            exit 1
        fi
        print_success "$SUBNET_ID"
    else
        print_info "Subnet: $SUBNET_ID"
    fi

    echo ""
}

step_create_oidc_provider() {
    print_section "OIDC identity provider"

    OIDC_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_PROVIDER_URL}"

    print_step "Checking provider... "
    if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" &>/dev/null; then
        print_success "Already exists"
    else
        aws iam create-open-id-connect-provider \
            --url "https://${OIDC_PROVIDER_URL}" \
            --client-id-list sts.amazonaws.com \
            --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 \
            > /dev/null
        print_success "Created"
    fi
}

step_create_actions_role() {
    print_section "GitHub Actions IAM role"

    local trust_policy
    trust_policy=$(cat << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "${OIDC_ARN}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:${REPO}:*"
        }
      }
    }
  ]
}
EOF
    )

    local permissions_policy
    permissions_policy=$(cat << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EC2Management",
      "Effect": "Allow",
      "Action": [
        "ec2:RunInstances",
        "ec2:TerminateInstances",
        "ec2:DescribeInstances",
        "ec2:DescribeInstanceStatus",
        "ec2:CreateTags"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "aws:RequestedRegion": "${REGION}"
        }
      }
    },
    {
      "Sid": "PassRoleToEC2",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::${ACCOUNT_ID}:role/${INSTANCE_PROFILE_ROLE_NAME}",
      "Condition": {
        "StringEquals": {
          "iam:PassedToService": "ec2.amazonaws.com"
        }
      }
    }
  ]
}
EOF
    )

    print_step "Checking role... "
    if aws iam get-role --role-name "$GH_ACTIONS_ROLE_NAME" &>/dev/null; then
        print_success "Exists, updating trust policy"
        aws iam update-assume-role-policy \
            --role-name "$GH_ACTIONS_ROLE_NAME" \
            --policy-document "$trust_policy"
    else
        aws iam create-role \
            --role-name "$GH_ACTIONS_ROLE_NAME" \
            --assume-role-policy-document "$trust_policy" \
            > /dev/null
        print_success "Created"
    fi

    aws iam put-role-policy \
        --role-name "$GH_ACTIONS_ROLE_NAME" \
        --policy-name "EC2Management" \
        --policy-document "$permissions_policy"
    print_info "Permissions attached"
}

step_create_instance_profile() {
    print_section "EC2 instance profile"

    local instance_role_policy
    instance_role_policy=$(cat << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SelfTerminate",
      "Effect": "Allow",
      "Action": "ec2:TerminateInstances",
      "Resource": "arn:aws:ec2:${REGION}:${ACCOUNT_ID}:instance/*",
      "Condition": {
        "StringEquals": {
          "aws:ResourceTag/Purpose": "boxlite-e2e"
        }
      }
    }
  ]
}
EOF
    )

    local instance_trust_policy
    instance_trust_policy=$(cat << EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Service": "ec2.amazonaws.com" },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
    )

    print_step "Checking instance role... "
    if aws iam get-role --role-name "$INSTANCE_PROFILE_ROLE_NAME" &>/dev/null; then
        print_success "Exists"
    else
        aws iam create-role \
            --role-name "$INSTANCE_PROFILE_ROLE_NAME" \
            --assume-role-policy-document "$instance_trust_policy" \
            > /dev/null
        print_success "Created"
    fi

    aws iam put-role-policy \
        --role-name "$INSTANCE_PROFILE_ROLE_NAME" \
        --policy-name "SelfTerminate" \
        --policy-document "$instance_role_policy"

    print_step "Checking instance profile... "
    if aws iam get-instance-profile --instance-profile-name "$INSTANCE_PROFILE_NAME" &>/dev/null; then
        print_success "Exists"
    else
        aws iam create-instance-profile --instance-profile-name "$INSTANCE_PROFILE_NAME" > /dev/null
        aws iam add-role-to-instance-profile \
            --instance-profile-name "$INSTANCE_PROFILE_NAME" \
            --role-name "$INSTANCE_PROFILE_ROLE_NAME"
        print_success "Created"
    fi
}

step_create_security_group() {
    print_section "Security group"

    print_step "Checking security group... "
    SG_ID=$(aws ec2 describe-security-groups \
        --filters "Name=group-name,Values=${SECURITY_GROUP_NAME}" "Name=vpc-id,Values=${VPC_ID}" \
        --query "SecurityGroups[0].GroupId" --output text --region "$REGION" 2>/dev/null || echo "None")

    if [ "$SG_ID" != "None" ] && [ -n "$SG_ID" ]; then
        print_success "Exists ($SG_ID)"
    else
        SG_ID=$(aws ec2 create-security-group \
            --group-name "$SECURITY_GROUP_NAME" \
            --description "BoxLite E2E runner - outbound HTTPS only" \
            --vpc-id "$VPC_ID" \
            --region "$REGION" \
            --query "GroupId" --output text)

        aws ec2 authorize-security-group-egress \
            --group-id "$SG_ID" --region "$REGION" \
            --protocol tcp --port 443 --cidr 0.0.0.0/0 2>/dev/null || true
        aws ec2 authorize-security-group-egress \
            --group-id "$SG_ID" --region "$REGION" \
            --protocol tcp --port 80 --cidr 0.0.0.0/0 2>/dev/null || true

        print_success "Created ($SG_ID)"
    fi
}

step_configure_github() {
    if [ "$SKIP_GITHUB" = true ]; then
        print_info "GitHub configuration skipped (--skip-github)"
        return 0
    fi

    print_section "GitHub repository variables"

    gh variable set AWS_ACCOUNT_ID --body "$ACCOUNT_ID" -R "$REPO"
    print_info "AWS_ACCOUNT_ID = $ACCOUNT_ID"

    gh variable set AWS_SUBNET_ID --body "$SUBNET_ID" -R "$REPO"
    print_info "AWS_SUBNET_ID = $SUBNET_ID"

    gh variable set AWS_SECURITY_GROUP_ID --body "$SG_ID" -R "$REPO"
    print_info "AWS_SECURITY_GROUP_ID = $SG_ID"

    print_section "GitHub repository secret (GH_PAT)"

    if gh secret list -R "$REPO" | grep -q "^GH_PAT"; then
        print_info "GH_PAT already exists, skipping"
    else
        # Get repo ID for pre-filled token creation URL
        local repo_id
        repo_id=$(gh repo view "$REPO" --json databaseId -q .databaseId 2>/dev/null || echo "")

        print_info "A fine-grained PAT is needed for runner registration."
        print_info "Required permission: Administration → Read and write"
        print_info "Scope: this repository only"
        echo ""

        if [ -n "$repo_id" ]; then
            local token_url="https://github.com/settings/personal-access-tokens/new?scoped_to=${repo_id}"
            print_info "Create one here (permission pre-filled is not supported, select manually):"
            echo "  ${token_url}"
        else
            print_info "Create one at: https://github.com/settings/personal-access-tokens/new"
        fi

        echo ""
        print_info "Steps: 1) Open link above"
        print_info "       2) Set token name: boxlite-e2e-runner"
        print_info "       3) Repository access → Only select repositories → ${REPO}"
        print_info "       4) Permissions → Repository → Administration → Read and write"
        print_info "       5) Generate token, copy it"
        echo ""
        read -rsp "  Paste your GitHub PAT (input hidden): " GH_PAT_VALUE
        echo ""
        if [ -n "$GH_PAT_VALUE" ]; then
            echo "$GH_PAT_VALUE" | gh secret set GH_PAT -R "$REPO"
            print_success "GH_PAT set"
        else
            print_warning "Skipped (empty input). Set manually: gh secret set GH_PAT"
        fi
    fi
}

# ============================================================================
# Entry point
# ============================================================================

main() {
    require_command aws "Install: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
    require_command gh "Install: https://cli.github.com"
    require_command jq "Install: https://jqlang.github.io/jq/download"

    parse_args "$@"

    print_header "E2E CI Runner Setup"

    step_detect_config
    step_create_oidc_provider
    step_create_actions_role
    step_create_instance_profile
    step_create_security_group
    step_configure_github

    print_header "Setup Complete"
    print_info "OIDC Provider: $OIDC_ARN"
    print_info "Actions Role:  arn:aws:iam::${ACCOUNT_ID}:role/${GH_ACTIONS_ROLE_NAME}"
    print_info "Instance Profile: $INSTANCE_PROFILE_NAME"
    print_info "Security Group: $SG_ID"
    echo ""
    print_success "Run: gh workflow run e2e-test.yml"
}

main "$@"
