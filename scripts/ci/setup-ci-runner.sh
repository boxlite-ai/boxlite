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

    # GitHub repository (from git remote)
    print_step "GitHub repository... "
    local remotes
    remotes=$(git remote)
    local remote_count
    remote_count=$(echo "$remotes" | wc -l | tr -d ' ')

    if [ "$remote_count" -gt 1 ]; then
        echo ""
        print_info "Multiple remotes detected:"
        local i=1
        local -a remote_list=()
        while IFS= read -r r; do
            remote_list+=("$r")
            local url
            url=$(git remote get-url "$r")
            echo "  ${i}) ${r} → ${url}"
            i=$((i + 1))
        done <<< "$remotes"
        echo ""
        read -rp "  Select remote (name or number) [default: origin]: " SELECTED_REMOTE
        SELECTED_REMOTE="${SELECTED_REMOTE:-origin}"

        # If user entered a number, resolve to remote name
        if [[ "$SELECTED_REMOTE" =~ ^[0-9]+$ ]]; then
            local idx=$((SELECTED_REMOTE - 1))
            if [ "$idx" -ge 0 ] && [ "$idx" -lt "${#remote_list[@]}" ]; then
                SELECTED_REMOTE="${remote_list[$idx]}"
            else
                print_error "Invalid selection: $SELECTED_REMOTE"
                exit 1
            fi
        fi
    else
        SELECTED_REMOTE="origin"
    fi

    REPO=$(git remote get-url "$SELECTED_REMOTE" | sed 's|.*github.com[:/]||;s|\.git$||')
    if [ -z "$REPO" ]; then
        print_error "Cannot detect repo from '${SELECTED_REMOTE}' remote"
        exit 1
    fi
    print_success "$REPO (via ${SELECTED_REMOTE})"

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

    # Subnets — gather every subnet in the VPC so the workflow's multi-AZ
    # loop has the widest possible AZ pool to fall back on when an AZ is
    # short on capacity (InsufficientInstanceCapacity).
    if [ -z "$SUBNET_ID" ]; then
        print_step "Public subnets... "
        SUBNET_IDS=$(aws ec2 describe-subnets \
            --filters "Name=vpc-id,Values=${VPC_ID}" "Name=map-public-ip-on-launch,Values=true" \
            --query "Subnets[].SubnetId" --output text --region "$REGION" 2>/dev/null \
            | tr '[:space:]' ',' | sed 's/,$//; s/^,//')
        if [ -z "$SUBNET_IDS" ]; then
            SUBNET_IDS=$(aws ec2 describe-subnets \
                --filters "Name=vpc-id,Values=${VPC_ID}" \
                --query "Subnets[].SubnetId" --output text --region "$REGION" 2>/dev/null \
                | tr '[:space:]' ',' | sed 's/,$//; s/^,//')
        fi
        if [ -z "$SUBNET_IDS" ]; then
            print_error "No subnets found in VPC $VPC_ID. Provide --subnet-id."
            exit 1
        fi
        local az_count
        az_count=$(echo "$SUBNET_IDS" | tr ',' '\n' | wc -l | tr -d ' ')
        print_success "${SUBNET_IDS} (${az_count} AZs)"
    else
        SUBNET_IDS="$SUBNET_ID"
        print_info "Subnet (override): $SUBNET_ID"
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
        "ec2:StartInstances",
        "ec2:StopInstances",
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

    gh variable set AWS_SUBNET_IDS --body "$SUBNET_IDS" -R "$REPO"
    print_info "AWS_SUBNET_IDS = $SUBNET_IDS"
    # Drop the legacy single-subnet variable so the workflow's
    # `vars.AWS_SUBNET_IDS || vars.AWS_SUBNET_ID` fallback can't pick a
    # narrower (one-AZ) pool by accident.
    gh variable delete AWS_SUBNET_ID -R "$REPO" 2>/dev/null || true

    gh variable set AWS_SECURITY_GROUP_ID --body "$SG_ID" -R "$REPO"
    print_info "AWS_SECURITY_GROUP_ID = $SG_ID"

    print_section "GitHub App (runner registration)"

    local owner="${REPO%%/*}"

    # If credentials exist, verify the app is actually installed and working
    if gh secret list -R "$REPO" | grep -q "^GH_APP_PRIVATE_KEY"; then
        print_step "Verifying existing app... "
        local app_id_val
        app_id_val=$(gh variable get GH_APP_ID -R "$REPO" 2>/dev/null || echo "")
        if [ -n "$app_id_val" ]; then
            # Check if the app has an active installation on this repo
            local install_check
            install_check=$(gh api "/repos/${REPO}/installation" 2>/dev/null | jq -r '.app_id // empty' 2>/dev/null || echo "")
            if [ "$install_check" = "$app_id_val" ]; then
                print_success "App installed and working (ID: $app_id_val)"
                return 0
            fi
        fi
        print_error "App credentials exist but app is not installed on ${REPO}"
        print_info "Cleaning up stale credentials and recreating..."
        gh secret delete GH_APP_PRIVATE_KEY -R "$REPO" 2>/dev/null || true
        gh variable delete GH_APP_ID -R "$REPO" 2>/dev/null || true
    fi

    # Pre-check: GitHub rejects manifest creation with "Name is already taken"
    # if the slug exists anywhere (any owner, including private Apps). The
    # rejection happens on the form page, so the OAuth callback never fires
    # and we'd time out 120s later with no useful message. Detect it now.
    local app_slug="boxlite-e2e-runner"
    if [ "$(curl -sI -o /dev/null -w '%{http_code}' "https://github.com/apps/${app_slug}")" = "200" ]; then
        print_error "An App named '${app_slug}' already exists on GitHub."
        print_info "Local credentials are missing, so we can't reuse it from this script."
        print_info "Delete the App, then continue:"
        local app_settings_url
        if gh api "/orgs/${owner}" &>/dev/null; then
            app_settings_url="https://github.com/organizations/${owner}/settings/apps/${app_slug}/advanced"
        else
            app_settings_url="https://github.com/settings/apps/${app_slug}/advanced"
        fi
        print_info "  ${app_settings_url}"
        if command_exists open; then
            open "$app_settings_url"
        elif command_exists xdg-open; then
            xdg-open "$app_settings_url"
        fi
        read -rp "  Press Enter once the App has been deleted (or Ctrl+C to abort)... "
        if [ "$(curl -sI -o /dev/null -w '%{http_code}' "https://github.com/apps/${app_slug}")" = "200" ]; then
            print_error "App still exists. Aborting."
            exit 1
        fi
        print_success "App deleted. Continuing with creation."
    fi

    print_info "Creating GitHub App via manifest flow..."
    print_info "A browser window will open. Click 'Create GitHub App' to proceed."
    echo ""

    local callback_port=9876
    local callback_url="http://localhost:${callback_port}"

    # Build the manifest JSON
    # hook_attributes.url is required by the API even if unused
    local manifest
    # default_permissions:
    #   administration:     write — mint runner registration tokens (used by e2e-test.yml)
    #   actions_variables:  write — persist EC2_E2E_INSTANCE_ID across runs
    manifest=$(jq -n \
        --arg name "boxlite-e2e-runner" \
        --arg url "https://github.com/${REPO}" \
        --arg redirect_url "$callback_url" \
        '{
            name: $name,
            url: $url,
            public: false,
            redirect_url: $redirect_url,
            hook_attributes: { url: $url, active: false },
            default_permissions: {
                administration: "write",
                actions_variables: "write"
            },
            default_events: []
        }')

    # HTML-encode the manifest for safe embedding in a form input
    local manifest_escaped
    manifest_escaped=$(echo "$manifest" | python3 -c "import sys,html; print(html.escape(sys.stdin.read().strip()))")

    # Determine if owner is an org or user to pick the correct endpoint
    local app_create_url
    if gh api "/orgs/${owner}" &>/dev/null; then
        app_create_url="https://github.com/organizations/${owner}/settings/apps/new?state=boxlite-e2e"
    else
        app_create_url="https://github.com/settings/apps/new?state=boxlite-e2e"
    fi

    # Create HTML form that auto-submits the manifest to GitHub
    local html_file="/tmp/boxlite-app-manifest.html"
    cat > "$html_file" << HTMLEOF
<!DOCTYPE html>
<html><body>
<p>Redirecting to GitHub to create the app...</p>
<form id="form" method="post" action="${app_create_url}">
<input type="hidden" name="manifest" value="${manifest_escaped}">
</form>
<script>document.getElementById('form').submit();</script>
</body></html>
HTMLEOF

    # Start a one-shot HTTP listener to catch the callback
    local code_file="/tmp/boxlite-app-code"
    rm -f "$code_file"

    # Use Python to run a simple callback server (SO_REUSEADDR to avoid port conflicts)
    python3 -c "
import http.server, urllib.parse, sys, threading, socket

class ReusableServer(http.server.HTTPServer):
    allow_reuse_address = True
    allow_reuse_port = True

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        query = urllib.parse.urlparse(self.path).query
        params = urllib.parse.parse_qs(query)
        code = params.get('code', [''])[0]
        with open('$code_file', 'w') as f:
            f.write(code)
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(b'<html><body><h2>Done! You can close this tab.</h2></body></html>')
        threading.Thread(target=self.server.shutdown).start()
    def log_message(self, *args):
        pass

server = ReusableServer(('localhost', $callback_port), Handler)
server.serve_forever()
" &
    local server_pid=$!

    # Open browser
    if command_exists open; then
        open "$html_file"
    elif command_exists xdg-open; then
        xdg-open "$html_file"
    else
        print_warning "Cannot open browser. Open this file manually: $html_file"
    fi

    # Wait for callback (up to 5 minutes — clicking through GitHub's
    # "Create GitHub App" confirmation page can be slow if the user is
    # signed-out or has 2FA prompts).
    print_info "Waiting for GitHub callback (up to 5 min)..."
    print_info "  In the browser: click the green 'Create GitHub App' button to confirm."
    print_info "  If the page shows 'Invalid GitHub App configuration', stop and report the error."
    local elapsed=0
    while [ ! -s "$code_file" ] && [ $elapsed -lt 300 ]; do
        sleep 2
        elapsed=$((elapsed + 2))
    done

    # Cleanup server
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true

    if [ ! -s "$code_file" ]; then
        print_error "Timed out waiting for GitHub callback after ${elapsed}s."
        print_info "Common causes:"
        print_info "  - Didn't click 'Create GitHub App' on the GitHub confirmation page"
        print_info "  - GitHub rejected the manifest (page shows 'Invalid GitHub App configuration')"
        print_info "  - Browser blocked the redirect to http://localhost:9876"
        exit 1
    fi
    print_success "Callback received."

    local code
    code=$(cat "$code_file")
    rm -f "$code_file" "$html_file"

    # Exchange code for app credentials
    print_info "Exchanging code for app credentials..."
    local app_response
    app_response=$(curl -sf -X POST \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/app-manifests/${code}/conversions")

    local app_id pem app_slug
    app_id=$(echo "$app_response" | jq -r '.id')
    pem=$(echo "$app_response" | jq -r '.pem')
    app_slug=$(echo "$app_response" | jq -r '.slug')

    if [ -z "$app_id" ] || [ "$app_id" = "null" ]; then
        print_error "Failed to create GitHub App"
        echo "$app_response" >&2
        exit 1
    fi

    print_success "Created GitHub App: $app_slug (ID: $app_id)"

    # Store credentials
    gh variable set GH_APP_ID --body "$app_id" -R "$REPO"
    print_info "GH_APP_ID = $app_id"

    echo "$pem" | gh secret set GH_APP_PRIVATE_KEY -R "$REPO"
    print_success "GH_APP_PRIVATE_KEY stored"

    # Install the app on the repository automatically via API
    print_info "Installing app on ${REPO}..."

    # Generate a JWT from the private key to authenticate as the app
    local jwt
    jwt=$(python3 -c "
import json, time, base64, hashlib, hmac
try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    import jwt as pyjwt
    key = serialization.load_pem_private_key('''$pem'''.encode(), password=None)
    now = int(time.time())
    payload = {'iat': now - 60, 'exp': now + 600, 'iss': $app_id}
    token = pyjwt.encode(payload, key, algorithm='RS256')
    print(token)
except ImportError:
    # Fallback: manual JWT construction with openssl
    import subprocess, os
    header = base64.urlsafe_b64encode(json.dumps({'alg':'RS256','typ':'JWT'}).encode()).rstrip(b'=').decode()
    now = int(time.time())
    payload_data = json.dumps({'iat': now - 60, 'exp': now + 600, 'iss': $app_id})
    payload_b64 = base64.urlsafe_b64encode(payload_data.encode()).rstrip(b'=').decode()
    signing_input = f'{header}.{payload_b64}'
    pem_file = '/tmp/boxlite-app-key.pem'
    with open(pem_file, 'w') as f:
        f.write('''$pem''')
    result = subprocess.run(
        ['openssl', 'dgst', '-sha256', '-sign', pem_file],
        input=signing_input.encode(), capture_output=True)
    os.unlink(pem_file)
    sig = base64.urlsafe_b64encode(result.stdout).rstrip(b'=').decode()
    print(f'{signing_input}.{sig}')
")

    if [ -z "$jwt" ]; then
        print_warning "Could not generate JWT. Install manually: https://github.com/apps/${app_slug}/installations/new"
        read -rp "  Press Enter after installing the app in the browser..."
        return 0
    fi

    # Get the repo ID
    local repo_id
    repo_id=$(gh api "/repos/${REPO}" --jq .id)

    # Create installation targeting this repo
    local install_response
    install_response=$(curl -sf -X POST \
        -H "Authorization: Bearer ${jwt}" \
        -H "Accept: application/vnd.github+json" \
        "https://api.github.com/app/installations" \
        -d "{\"repository_selection\":\"selected\",\"target_id\":$(gh api "/orgs/${owner}" --jq .id 2>/dev/null || gh api "/users/${owner}" --jq .id),\"target_type\":\"Organization\",\"repositories\":[\"${REPO##*/}\"]}" 2>&1 || echo "")

    if echo "$install_response" | jq -e '.id' &>/dev/null; then
        print_success "App installed (installation ID: $(echo "$install_response" | jq -r '.id'))"
    else
        # Installation via API may not be supported for all account types — fall back to browser
        print_warning "Auto-install not available. Opening browser..."
        local install_url="https://github.com/apps/${app_slug}/installations/new"
        if command_exists open; then
            open "$install_url"
        elif command_exists xdg-open; then
            xdg-open "$install_url"
        else
            print_info "Open: $install_url"
        fi
        read -rp "  Press Enter after installing the app in the browser..."
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
