#!/bin/bash
# Provision the Memorystore for Redis instance the BoxLite API needs on GCP and
# store its AUTH string and server CA in Secret Manager.
#
# Mirrors the AWS side (apps/infra/stack/foundation.ts: sst.aws.Redis with
# cluster mode disabled): one node, TLS required, AUTH required, private
# network only, no persistence. The API needs a non-clustered Redis because it
# uses logical DB 1, EVAL, BRPOP, multi-key pipelines and pub/sub (the Socket.IO
# Redis adapter adds pattern subscriptions), so this is Memorystore for Redis
# (standalone), not Valkey or Redis Cluster.
#
# Usage:
#   ./create-memorystore-redis.sh
#   ./create-memorystore-redis.sh --project my-project --dry-run
#   ./create-memorystore-redis.sh --rotate-auth

set -euo pipefail

GCP_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$GCP_SCRIPT_DIR/../../common.sh"

# ============================================================================
# Configuration
# ============================================================================

# Names, labels and the display name derive from the stage unless overridden:
# boxlite-<stage>-cache, boxlite-<stage>-redis-auth, boxlite-<stage>-redis-ca.
DEFAULT_STAGE="dev"
DEFAULT_REGION="asia-southeast1"
DEFAULT_NETWORK="boxlite-backoffice-dev"
DEFAULT_RESERVED_RANGE="boxlite-backoffice-dev-private-services"
DEFAULT_TIER="basic"
DEFAULT_SIZE="1"
DEFAULT_REDIS_VERSION="redis_7_2"
# UTC. 19:00 UTC is 03:00 in Singapore, where the stack runs.
DEFAULT_MAINTENANCE_DAY="sunday"
DEFAULT_MAINTENANCE_HOUR="19"

PROJECT=""
STAGE="$DEFAULT_STAGE"
NAME=""
REGION="$DEFAULT_REGION"
NETWORK="$DEFAULT_NETWORK"
RESERVED_RANGE="$DEFAULT_RESERVED_RANGE"
TIER="$DEFAULT_TIER"
SIZE="$DEFAULT_SIZE"
REDIS_VERSION="$DEFAULT_REDIS_VERSION"
AUTH_SECRET=""
CA_SECRET=""
LABELS=""
ENABLE_TLS=true
ROTATE_AUTH=false
DRY_RUN=false

# Filled in by step_read_endpoint.
REDIS_HOST=""
REDIS_PORT=""
TLS_MODE=""
AUTH_SECRET_VERSION=""
CA_SECRET_VERSION=""

# ============================================================================
# Functions
# ============================================================================

usage() {
    cat << EOF
Usage: $(basename "$0") [OPTIONS]

Create a Memorystore for Redis instance for the BoxLite API and store its
AUTH string and server CA in Secret Manager. Safe to re-run: an existing
instance is left alone and a secret version is added only when the value
changed.

OPTIONS:
    --project PROJECT           GCP project ID (default: gcloud config)
    --region REGION             Region (default: $DEFAULT_REGION)
    --stage STAGE               Stage; derives names and labels (default: $DEFAULT_STAGE)
    --network NETWORK           VPC network name (default: $DEFAULT_NETWORK)
    --reserved-ip-range NAME    Private Service Access range (default: $DEFAULT_RESERVED_RANGE)
    --name NAME                 Instance name (default: boxlite-<stage>-cache)
    --tier basic|standard       Tier (default: $DEFAULT_TIER)
    --size GIB                  Memory in GiB (default: $DEFAULT_SIZE)
    --redis-version VERSION     e.g. redis_7_2 (default: $DEFAULT_REDIS_VERSION)
    --auth-secret NAME          Secret Manager name for the AUTH string (default: boxlite-<stage>-redis-auth)
    --ca-secret NAME            Secret Manager name for the server CA (default: boxlite-<stage>-redis-ca)
    --no-tls                    Disable in-transit encryption (port 6379, no CA secret)
    --rotate-auth               Regenerate the AUTH string of an existing instance
    --dry-run                   Print the mutating commands instead of running them
    --help                      Show this help message

EXAMPLES:
    $(basename "$0")
    $(basename "$0") --project avid-vine-500315-u4 --dry-run
    $(basename "$0") --stage dev-db --network boxlite-dev-db --reserved-ip-range boxlite-dev-db-private-services
    $(basename "$0") --rotate-auth

EOF
    exit 0
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --project)
                PROJECT="$2"
                shift 2
                ;;
            --region)
                REGION="$2"
                shift 2
                ;;
            --stage)
                STAGE="$2"
                shift 2
                ;;
            --network)
                NETWORK="$2"
                shift 2
                ;;
            --reserved-ip-range)
                RESERVED_RANGE="$2"
                shift 2
                ;;
            --name)
                NAME="$2"
                shift 2
                ;;
            --tier)
                TIER="$2"
                shift 2
                ;;
            --size)
                SIZE="$2"
                shift 2
                ;;
            --redis-version)
                REDIS_VERSION="$2"
                shift 2
                ;;
            --auth-secret)
                AUTH_SECRET="$2"
                shift 2
                ;;
            --ca-secret)
                CA_SECRET="$2"
                shift 2
                ;;
            --no-tls)
                ENABLE_TLS=false
                shift
                ;;
            --rotate-auth)
                ROTATE_AUTH=true
                shift
                ;;
            --dry-run)
                DRY_RUN=true
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

validate_args() {
    if [ -z "$PROJECT" ]; then
        PROJECT="$(gcloud config get-value project 2>/dev/null || true)"
    fi
    if [ -z "$PROJECT" ]; then
        print_error "No GCP project: pass --project or run 'gcloud config set project'"
        exit 1
    fi
    case "$TIER" in
        basic|standard) ;;
        *)
            print_error "--tier must be basic or standard, got: $TIER"
            exit 1
            ;;
    esac
    if ! [[ "$SIZE" =~ ^[0-9]+$ ]]; then
        print_error "--size must be an integer number of GiB, got: $SIZE"
        exit 1
    fi
    if ! [[ "$STAGE" =~ ^[a-z][a-z0-9-]{0,20}$ ]]; then
        print_error "--stage must be lowercase letters, digits and hyphens, got: $STAGE"
        exit 1
    fi
    NAME="${NAME:-boxlite-$STAGE-cache}"
    AUTH_SECRET="${AUTH_SECRET:-boxlite-$STAGE-redis-auth}"
    CA_SECRET="${CA_SECRET:-boxlite-$STAGE-redis-ca}"
    LABELS="app=boxlite,env=$STAGE,component=cache,managed-by=create-memorystore-redis"
}

# Run a mutating gcloud command, or print it under --dry-run. Arguments are
# passed through as an array so nothing is re-parsed by the shell.
run() {
    print_info "Running: $*"
    if [ "$DRY_RUN" = true ]; then
        return 0
    fi
    "$@"
}

redis_describe() {
    gcloud redis instances describe "$NAME" \
        --project="$PROJECT" --region="$REGION" --format="value($1)" 2>/dev/null
}

secret_exists() {
    gcloud secrets describe "$1" --project="$PROJECT" >/dev/null 2>&1
}

secret_latest_version() {
    gcloud secrets versions list "$1" --project="$PROJECT" \
        --filter="state=ENABLED" --sort-by="~createTime" --limit=1 \
        --format="value(name)" 2>/dev/null || true
}

# Ensure a secret exists and holds $value as its latest version. The value
# never touches argv or the log: it goes to gcloud on stdin, and the existing
# version is compared in memory only. Prints nothing about the value itself.
ensure_secret_value() {
    local secret="$1" value="$2" current=""

    if ! secret_exists "$secret"; then
        run gcloud secrets create "$secret" --project="$PROJECT" \
            --replication-policy=automatic --labels="$LABELS"
    fi
    if [ "$DRY_RUN" = true ]; then
        print_info "Would add a version to $secret if the stored value differs"
        return 0
    fi

    current="$(gcloud secrets versions access latest --secret="$secret" --project="$PROJECT" 2>/dev/null || true)"
    if [ "$current" = "$value" ]; then
        print_info "Secret $secret already holds the current value; no new version"
        return 0
    fi
    # printf, not echo: echo would append a newline to the stored value.
    printf '%s' "$value" | gcloud secrets versions add "$secret" --project="$PROJECT" --data-file=- >/dev/null
    print_success "Added a new version to $secret"
}

step_enable_api() {
    print_header "Enabling the Memorystore for Redis API"
    # Must precede any `gcloud redis` call: with the API disabled those prompt
    # interactively to enable it, which breaks non-interactive runs.
    run gcloud services enable redis.googleapis.com --project="$PROJECT"
}

step_preflight() {
    print_header "Checking the network the instance will attach to"

    if ! gcloud compute networks describe "$NETWORK" --project="$PROJECT" >/dev/null 2>&1; then
        print_error "VPC network '$NETWORK' not found in project $PROJECT"
        exit 1
    fi
    print_success "Network $NETWORK exists"

    local range_info
    range_info="$(gcloud compute addresses describe "$RESERVED_RANGE" --global --project="$PROJECT" \
        --format='value(purpose,network.basename(),address,prefixLength)' 2>/dev/null || true)"
    if [ -z "$range_info" ]; then
        print_error "Reserved range '$RESERVED_RANGE' not found. Private Service Access must be set up first."
        exit 1
    fi
    local purpose range_network address prefix
    read -r purpose range_network address prefix <<< "$range_info"
    if [ "$purpose" != "VPC_PEERING" ] || [ "$range_network" != "$NETWORK" ]; then
        print_error "Reserved range '$RESERVED_RANGE' is $purpose on network '$range_network', expected VPC_PEERING on '$NETWORK'"
        exit 1
    fi
    print_success "Reserved range $RESERVED_RANGE = $address/$prefix on $NETWORK"

    local peering_ranges
    peering_ranges="$(gcloud services vpc-peerings list --network="$NETWORK" --project="$PROJECT" \
        --format='value(reservedPeeringRanges)' 2>/dev/null || true)"
    if [[ "$peering_ranges" != *"$RESERVED_RANGE"* ]]; then
        print_warning "servicenetworking peering on $NETWORK does not list $RESERVED_RANGE; instance creation may fail"
    else
        print_success "servicenetworking peering includes $RESERVED_RANGE"
    fi

    # Memorystore needs no ingress rule on the consumer VPC. Only an explicit
    # egress deny could block clients, so surface any that exist.
    local egress_denies
    egress_denies="$(gcloud compute firewall-rules list --project="$PROJECT" \
        --filter="network:$NETWORK AND direction=EGRESS AND denied:*" \
        --format='value(name)' 2>/dev/null || true)"
    if [ -n "$egress_denies" ]; then
        print_warning "Egress deny rules exist on $NETWORK; make sure they exempt the Redis port: $egress_denies"
    else
        print_success "No egress deny rules on $NETWORK"
    fi
}

warn_if_differs() {
    local field="$1" expected="$2" actual="$3"
    # A describe can transiently return nothing; that is not drift.
    if [ -z "$actual" ]; then
        print_warning "$field could not be read; rerun to check it against '$expected'"
        return 0
    fi
    if [ "$actual" != "$expected" ]; then
        print_warning "$field is '$actual' but this script expects '$expected' (immutable; recreate the instance to change it)"
    fi
}

step_create_instance() {
    print_header "Creating Memorystore for Redis instance"

    local tls_mode="disabled"
    if [ "$ENABLE_TLS" = true ]; then
        tls_mode="server-authentication"
    fi

    # The API reports the standard tier as STANDARD_HA, not STANDARD.
    local expected_tier="BASIC"
    if [ "$TIER" = "standard" ]; then
        expected_tier="STANDARD_HA"
    fi

    local state
    state="$(redis_describe state || true)"
    if [ -n "$state" ]; then
        print_info "Instance $NAME already exists (state: $state); not recreating"
        warn_if_differs "tier" "$expected_tier" "$(redis_describe tier)"
        warn_if_differs "redisVersion" "$(echo "$REDIS_VERSION" | tr '[:lower:]' '[:upper:]')" "$(redis_describe redisVersion)"
        warn_if_differs "transitEncryptionMode" "$(echo "$tls_mode" | tr '[:lower:]-' '[:upper:]_')" "$(redis_describe transitEncryptionMode)"
        warn_if_differs "authEnabled" "True" "$(redis_describe authEnabled)"
        warn_if_differs "connectMode" "PRIVATE_SERVICE_ACCESS" "$(redis_describe connectMode)"
        warn_if_differs "authorizedNetwork" "projects/$PROJECT/global/networks/$NETWORK" "$(redis_describe authorizedNetwork)"
        return 0
    fi

    print_info "Instance: $NAME ($TIER, ${SIZE} GiB, $REDIS_VERSION, TLS $tls_mode)"
    print_info "Network: $NETWORK via $RESERVED_RANGE in $REGION"

    # Synchronous: creation takes several minutes and the later steps need the
    # instance to be READY. --quiet answers the --enable-auth confirmation
    # prompt so the script also works without a terminal.
    run gcloud redis instances create "$NAME" \
        --quiet \
        --project="$PROJECT" \
        --region="$REGION" \
        --tier="$TIER" \
        --size="$SIZE" \
        --redis-version="$REDIS_VERSION" \
        --network="projects/$PROJECT/global/networks/$NETWORK" \
        --connect-mode=private-service-access \
        --reserved-ip-range="$RESERVED_RANGE" \
        --enable-auth \
        --transit-encryption-mode="$tls_mode" \
        --maintenance-window-day="$DEFAULT_MAINTENANCE_DAY" \
        --maintenance-window-hour="$DEFAULT_MAINTENANCE_HOUR" \
        --display-name="BoxLite $STAGE cache" \
        --labels="$LABELS"
    if [ "$DRY_RUN" = true ]; then
        print_info "Would create instance $NAME"
    else
        print_success "Instance $NAME created"
    fi
}

step_rotate_auth() {
    if [ "$ROTATE_AUTH" != true ]; then
        return 0
    fi
    print_header "Rotating the AUTH string"
    # Memorystore has no regenerate verb: disabling and re-enabling AUTH mints
    # a new string. Between the two calls the instance accepts unauthenticated
    # connections, and every client is disconnected.
    print_warning "AUTH is briefly disabled during rotation and all clients are disconnected"
    run gcloud redis instances update "$NAME" --project="$PROJECT" --region="$REGION" --no-enable-auth
    run gcloud redis instances update "$NAME" --project="$PROJECT" --region="$REGION" --enable-auth
    print_success "AUTH string rotated"
}

step_read_endpoint() {
    if [ "$DRY_RUN" = true ]; then
        REDIS_HOST="<host>"
        REDIS_PORT="<port>"
        TLS_MODE="<tls mode>"
        return 0
    fi
    REDIS_HOST="$(redis_describe host)"
    REDIS_PORT="$(redis_describe port)"
    TLS_MODE="$(redis_describe transitEncryptionMode)"
    if [ -z "$REDIS_HOST" ] || [ -z "$REDIS_PORT" ]; then
        print_error "Could not read host/port of $NAME"
        exit 1
    fi
}

step_store_auth() {
    print_header "Storing the AUTH string in Secret Manager"
    local auth_string=""
    if [ "$DRY_RUN" != true ]; then
        auth_string="$(gcloud redis instances get-auth-string "$NAME" \
            --project="$PROJECT" --region="$REGION" --format='value(authString)')"
        if [ -z "$auth_string" ]; then
            print_error "AUTH string is empty; AUTH is not enabled on $NAME"
            exit 1
        fi
    fi
    ensure_secret_value "$AUTH_SECRET" "$auth_string"
    unset auth_string
    if [ "$DRY_RUN" != true ]; then
        AUTH_SECRET_VERSION="$(secret_latest_version "$AUTH_SECRET")"
    fi
}

step_store_ca() {
    if [ "$ENABLE_TLS" != true ]; then
        print_info "TLS disabled; skipping the server CA secret"
        return 0
    fi
    print_header "Storing the server CA in Secret Manager"
    local ca_pem="" expected_count=0 actual_count=0
    if [ "$DRY_RUN" != true ]; then
        # Google can publish more than one CA during a rotation. Store all of
        # them, and check the joined output really contains every certificate.
        expected_count="$(redis_describe 'serverCaCerts.len()')"
        # An empty read must fail the count check below, not the arithmetic.
        expected_count="${expected_count:-0}"
        ca_pem="$(gcloud redis instances describe "$NAME" --project="$PROJECT" --region="$REGION" \
            --format='value[separator="\n"](serverCaCerts[].cert)')"
        actual_count="$(printf '%s\n' "$ca_pem" | grep -c 'BEGIN CERTIFICATE' || true)"
        if [ -z "$ca_pem" ] || [ "$actual_count" -ne "$expected_count" ]; then
            print_error "Expected $expected_count server CA certificate(s), extracted $actual_count"
            exit 1
        fi
        print_info "Server CA bundle has $actual_count certificate(s)"
    fi
    ensure_secret_value "$CA_SECRET" "$ca_pem"
    if [ "$DRY_RUN" != true ]; then
        CA_SECRET_VERSION="$(secret_latest_version "$CA_SECRET")"
    fi
}

step_summary() {
    print_header "Redis is ready"
    echo "Instance:      projects/$PROJECT/locations/$REGION/instances/$NAME"
    echo "Host:          $REDIS_HOST"
    echo "Port:          $REDIS_PORT (transit encryption: $TLS_MODE)"
    echo "AUTH secret:   projects/$PROJECT/secrets/$AUTH_SECRET${AUTH_SECRET_VERSION:+  (latest: $(basename "$AUTH_SECRET_VERSION"))}"
    if [ "$ENABLE_TLS" = true ]; then
        echo "CA secret:     projects/$PROJECT/secrets/$CA_SECRET${CA_SECRET_VERSION:+  (latest: $(basename "$CA_SECRET_VERSION"))}"
    fi
    echo ""
    echo "API environment (apps/api reads these; see apps/api/.env.example):"
    echo "  REDIS_HOST=$REDIS_HOST"
    echo "  REDIS_PORT=$REDIS_PORT"
    if [ "$ENABLE_TLS" = true ]; then
        echo "  REDIS_TLS=true"
        echo "  Cloud Run: --set-secrets=REDIS_PASSWORD=$AUTH_SECRET:latest,REDIS_TLS_CA=$CA_SECRET:latest"
    else
        echo "  REDIS_TLS=false"
        echo "  Cloud Run: --set-secrets=REDIS_PASSWORD=$AUTH_SECRET:latest"
    fi
    echo ""
    echo "Next, a project owner grants the API's service account read access:"
    echo "  gcloud secrets add-iam-policy-binding $AUTH_SECRET --project=$PROJECT \\"
    echo "    --member=serviceAccount:<api-sa> --role=roles/secretmanager.secretAccessor"
    if [ "$ENABLE_TLS" = true ]; then
        echo "  gcloud secrets add-iam-policy-binding $CA_SECRET --project=$PROJECT \\"
        echo "    --member=serviceAccount:<api-sa> --role=roles/secretmanager.secretAccessor"
    fi
}

main() {
    require_command gcloud "Install: https://cloud.google.com/sdk/docs/install"

    parse_args "$@"
    validate_args

    step_enable_api
    step_preflight
    step_create_instance
    step_rotate_auth
    step_read_endpoint
    step_store_auth
    step_store_ca
    step_summary
}

# ============================================================================
# Entry point
# ============================================================================

main "$@"
