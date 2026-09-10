#!/bin/bash
# Create the VPC a BoxLite stage's databases live in on GCP: a custom-mode
# network, one regional subnet with Private Google Access, Cloud NAT for
# outbound traffic (image pulls), the firewall rules the ClickHouse host needs,
# and the Private Service Access range plus peering that Memorystore requires.
#
# Safe to re-run: every resource is created only when missing, and immutable
# settings that differ from the flags produce a warning.
#
# Usage:
#   ./create-network.sh
#   ./create-network.sh --stage dev-db --dry-run

set -euo pipefail

GCP_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$GCP_SCRIPT_DIR/../../common.sh"

# ============================================================================
# Configuration
# ============================================================================

DEFAULT_STAGE="dev-db"
DEFAULT_REGION="asia-southeast1"
DEFAULT_SUBNET_RANGE="10.40.0.0/20"
DEFAULT_PSA_ADDRESS="10.90.0.0"
DEFAULT_PSA_PREFIX="16"
# Google's IAP TCP-forwarding source range; the rule stays dormant until the
# operator holds iap.tunnelInstances.accessViaIAP.
IAP_RANGE="35.235.240.0/20"
CLICKHOUSE_TAG="boxlite-clickhouse"
CLICKHOUSE_PORT="8123"

PROJECT=""
STAGE="$DEFAULT_STAGE"
REGION="$DEFAULT_REGION"
SUBNET_RANGE="$DEFAULT_SUBNET_RANGE"
PSA_ADDRESS="$DEFAULT_PSA_ADDRESS"
PSA_PREFIX="$DEFAULT_PSA_PREFIX"
SKIP_PEERING=false
DRY_RUN=false

# Derived in validate_args from the stage name.
NETWORK=""
SUBNET=""
ROUTER=""
NAT=""
PSA_RANGE=""
FW_CLICKHOUSE=""
FW_IAP=""

# Filled in by step_psa_peering: connected | pending | skipped.
PSA_STATUS=""

# ============================================================================
# Functions
# ============================================================================

usage() {
    cat << EOF
Usage: $(basename "$0") [OPTIONS]

Create the boxlite-<stage> VPC with a subnet, Cloud NAT, the ClickHouse
firewall rules, and the Private Service Access range and peering that
Memorystore needs. Safe to re-run.

OPTIONS:
    --project PROJECT       GCP project ID (default: gcloud config)
    --region REGION         Region (default: $DEFAULT_REGION)
    --stage STAGE           Stage name; resources are boxlite-<stage>-* (default: $DEFAULT_STAGE)
    --subnet-range CIDR     Subnet range (default: $DEFAULT_SUBNET_RANGE)
    --psa-address ADDRESS   First address of the Private Service Access range (default: $DEFAULT_PSA_ADDRESS)
    --psa-prefix LENGTH     Prefix length of that range (default: $DEFAULT_PSA_PREFIX)
    --skip-peering          Reserve the range but do not connect the servicenetworking peering
    --dry-run               Print the mutating commands instead of running them
    --help                  Show this help message

EXAMPLES:
    $(basename "$0")
    $(basename "$0") --stage dev-db --dry-run

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
            --subnet-range)
                SUBNET_RANGE="$2"
                shift 2
                ;;
            --psa-address)
                PSA_ADDRESS="$2"
                shift 2
                ;;
            --psa-prefix)
                PSA_PREFIX="$2"
                shift 2
                ;;
            --skip-peering)
                SKIP_PEERING=true
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
    if ! [[ "$STAGE" =~ ^[a-z][a-z0-9-]{0,20}$ ]]; then
        print_error "--stage must be lowercase letters, digits and hyphens, got: $STAGE"
        exit 1
    fi
    if ! [[ "$SUBNET_RANGE" =~ ^[0-9.]+/[0-9]+$ ]]; then
        print_error "--subnet-range must be a CIDR, got: $SUBNET_RANGE"
        exit 1
    fi
    if ! [[ "$PSA_PREFIX" =~ ^[0-9]+$ ]]; then
        print_error "--psa-prefix must be an integer, got: $PSA_PREFIX"
        exit 1
    fi
    NETWORK="boxlite-$STAGE"
    SUBNET="boxlite-$STAGE"
    ROUTER="boxlite-$STAGE"
    NAT="boxlite-$STAGE"
    PSA_RANGE="boxlite-$STAGE-private-services"
    FW_CLICKHOUSE="boxlite-$STAGE-allow-clickhouse-http"
    FW_IAP="boxlite-$STAGE-allow-iap-ssh"
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

warn_if_differs() {
    local field="$1" expected="$2" actual="$3"
    # A describe can transiently return nothing; that is not drift.
    if [ -z "$actual" ]; then
        print_warning "$field could not be read; rerun to check it against '$expected'"
        return 0
    fi
    if [ "$actual" != "$expected" ]; then
        print_warning "$field is '$actual' but this script expects '$expected' (immutable; recreate the resource to change it)"
    fi
}

step_enable_apis() {
    print_header "Enabling the Compute and Service Networking APIs"
    run gcloud services enable compute.googleapis.com servicenetworking.googleapis.com --project="$PROJECT"
}

step_network() {
    print_header "Creating VPC network $NETWORK"
    if gcloud compute networks describe "$NETWORK" --project="$PROJECT" >/dev/null 2>&1; then
        print_info "Network $NETWORK already exists"
        return 0
    fi
    run gcloud compute networks create "$NETWORK" --project="$PROJECT" \
        --subnet-mode=custom --bgp-routing-mode=regional
}

step_subnet() {
    print_header "Creating subnet $SUBNET ($SUBNET_RANGE)"
    local existing
    existing="$(gcloud compute networks subnets describe "$SUBNET" --project="$PROJECT" --region="$REGION" \
        --format='value(ipCidrRange,privateIpGoogleAccess,network.basename())' 2>/dev/null || true)"
    if [ -n "$existing" ]; then
        local range pga network
        read -r range pga network <<< "$existing"
        print_info "Subnet $SUBNET already exists"
        warn_if_differs "ipCidrRange" "$SUBNET_RANGE" "$range"
        warn_if_differs "privateIpGoogleAccess" "True" "$pga"
        warn_if_differs "network" "$NETWORK" "$network"
        return 0
    fi
    # Private Google Access lets the ClickHouse VM (no external IP) reach
    # Secret Manager and other Google APIs without going through the NAT.
    run gcloud compute networks subnets create "$SUBNET" --project="$PROJECT" \
        --network="$NETWORK" --region="$REGION" --range="$SUBNET_RANGE" \
        --enable-private-ip-google-access
}

step_nat() {
    print_header "Creating Cloud NAT $NAT"
    if ! gcloud compute routers describe "$ROUTER" --project="$PROJECT" --region="$REGION" >/dev/null 2>&1; then
        run gcloud compute routers create "$ROUTER" --project="$PROJECT" \
            --network="$NETWORK" --region="$REGION"
    else
        print_info "Router $ROUTER already exists"
    fi
    if gcloud compute routers nats describe "$NAT" --router="$ROUTER" --project="$PROJECT" --region="$REGION" >/dev/null 2>&1; then
        print_info "NAT $NAT already exists"
        return 0
    fi
    # VMs without external IPs pull the ClickHouse image from Docker Hub
    # through this NAT. Error-only logging keeps the log volume small.
    run gcloud compute routers nats create "$NAT" --project="$PROJECT" \
        --router="$ROUTER" --region="$REGION" \
        --auto-allocate-nat-external-ips --nat-all-subnet-ip-ranges \
        --enable-logging --log-filter=ERRORS_ONLY
}

step_firewall() {
    print_header "Creating firewall rules"
    if gcloud compute firewall-rules describe "$FW_CLICKHOUSE" --project="$PROJECT" >/dev/null 2>&1; then
        print_info "Firewall rule $FW_CLICKHOUSE already exists"
    else
        # Mirrors the AWS security group: only the HTTP port, only from the VPC.
        run gcloud compute firewall-rules create "$FW_CLICKHOUSE" --project="$PROJECT" \
            --network="$NETWORK" --direction=INGRESS \
            --allow="tcp:$CLICKHOUSE_PORT" --source-ranges="$SUBNET_RANGE" \
            --target-tags="$CLICKHOUSE_TAG" \
            --description="ClickHouse HTTP from the $SUBNET subnet"
    fi
    if gcloud compute firewall-rules describe "$FW_IAP" --project="$PROJECT" >/dev/null 2>&1; then
        print_info "Firewall rule $FW_IAP already exists"
    else
        run gcloud compute firewall-rules create "$FW_IAP" --project="$PROJECT" \
            --network="$NETWORK" --direction=INGRESS \
            --allow=tcp:22 --source-ranges="$IAP_RANGE" \
            --target-tags="$CLICKHOUSE_TAG" \
            --description="SSH through IAP for debugging the ClickHouse host"
    fi
}

step_psa_address() {
    print_header "Reserving the Private Service Access range $PSA_RANGE"
    local existing
    existing="$(gcloud compute addresses describe "$PSA_RANGE" --global --project="$PROJECT" \
        --format='value(purpose,address,prefixLength,network.basename())' 2>/dev/null || true)"
    if [ -n "$existing" ]; then
        local purpose address prefix network
        read -r purpose address prefix network <<< "$existing"
        print_info "Range $PSA_RANGE already exists"
        warn_if_differs "purpose" "VPC_PEERING" "$purpose"
        warn_if_differs "address" "$PSA_ADDRESS" "$address"
        warn_if_differs "prefixLength" "$PSA_PREFIX" "$prefix"
        warn_if_differs "network" "$NETWORK" "$network"
        return 0
    fi
    run gcloud compute addresses create "$PSA_RANGE" --project="$PROJECT" \
        --global --purpose=VPC_PEERING \
        --addresses="$PSA_ADDRESS" --prefix-length="$PSA_PREFIX" \
        --network="$NETWORK"
}

step_psa_peering() {
    print_header "Connecting the servicenetworking peering"
    if [ "$SKIP_PEERING" = true ]; then
        print_info "Skipping the peering (--skip-peering)"
        PSA_STATUS="skipped"
        return 0
    fi

    local peering_ranges
    peering_ranges="$(gcloud services vpc-peerings list --network="$NETWORK" --project="$PROJECT" \
        --format='value(reservedPeeringRanges)' 2>/dev/null || true)"
    if [[ "$peering_ranges" == *"$PSA_RANGE"* ]]; then
        print_success "Peering already includes $PSA_RANGE"
        PSA_STATUS="connected"
        return 0
    fi

    # `connect` creates the peering; a second range on an existing peering
    # needs `update`. Both need servicenetworking.services.addPeering, which
    # roles/editor does not include, so a permission error is reported with
    # the exact command for someone who holds it rather than failing the run:
    # nothing else in this script depends on the peering.
    local verb="connect"
    if [ -n "$peering_ranges" ]; then
        verb="update"
    fi
    local cmd=(gcloud services vpc-peerings "$verb" --project="$PROJECT" --network="$NETWORK"
        --service=servicenetworking.googleapis.com --ranges="$PSA_RANGE")
    if [ "$verb" = "update" ]; then
        cmd+=(--force)
    fi
    print_info "Running: ${cmd[*]}"
    if [ "$DRY_RUN" = true ]; then
        PSA_STATUS="pending"
        return 0
    fi
    local stderr_file
    stderr_file="$(mktemp)"
    if "${cmd[@]}" 2>"$stderr_file"; then
        rm -f "$stderr_file"
        print_success "Peering connected for $PSA_RANGE"
        PSA_STATUS="connected"
        return 0
    fi
    if grep -qiE 'PERMISSION_DENIED|permission' "$stderr_file"; then
        rm -f "$stderr_file"
        PSA_STATUS="pending"
        print_warning "ACTION REQUIRED: this account cannot create the peering (needs roles/servicenetworking.networksAdmin)."
        print_warning "Someone with that role runs: ${cmd[*]}"
        return 0
    fi
    cat "$stderr_file" >&2
    rm -f "$stderr_file"
    print_error "Peering $verb failed"
    exit 1
}

step_summary() {
    print_header "Network $NETWORK"
    echo "Network:       $NETWORK"
    echo "Subnet:        $SUBNET  $SUBNET_RANGE  ($REGION, Private Google Access on)"
    echo "Cloud NAT:     $NAT on router $ROUTER"
    echo "Firewall:      $FW_CLICKHOUSE (tcp:$CLICKHOUSE_PORT from subnet), $FW_IAP (tcp:22 from IAP)"
    echo "PSA range:     $PSA_RANGE = $PSA_ADDRESS/$PSA_PREFIX  (peering: $PSA_STATUS)"
    echo ""
    echo "Next:"
    echo "  $GCP_SCRIPT_DIR/create-clickhouse-host.sh --stage $STAGE"
    if [ "$PSA_STATUS" = "connected" ]; then
        echo "  $GCP_SCRIPT_DIR/create-memorystore-redis.sh --stage $STAGE --network $NETWORK --reserved-ip-range $PSA_RANGE"
    else
        echo "  (after the peering is connected) $GCP_SCRIPT_DIR/create-memorystore-redis.sh --stage $STAGE --network $NETWORK --reserved-ip-range $PSA_RANGE"
    fi
}

main() {
    require_command gcloud "Install: https://cloud.google.com/sdk/docs/install"

    parse_args "$@"
    validate_args

    step_enable_apis
    step_network
    step_subnet
    step_nat
    step_firewall
    step_psa_address
    step_psa_peering
    step_summary
}

# ============================================================================
# Entry point
# ============================================================================

main "$@"
