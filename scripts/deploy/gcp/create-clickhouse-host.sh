#!/bin/bash
# Provision the self-hosted ClickHouse the BoxLite observability pipeline
# writes to, on a GCE VM with a persistent data disk. The GCP counterpart of
# the self-hosted mode in apps/infra/stack/clickhouse.ts: one VM, one 50 GB
# data disk that outlives the VM, digest-pinned clickhouse-server in Docker,
# plaintext HTTP on 8123 inside the VPC only, three passwords in Secret
# Manager read by the VM's own service account.
#
# The VM configures itself from scripts/deploy/gcp/clickhouse-startup.sh on
# every boot and reports through a guest attribute, so nothing here needs SSH.
#
# Usage:
#   ./create-clickhouse-host.sh
#   ./create-clickhouse-host.sh --stage dev-db --dry-run
#   ./create-clickhouse-host.sh --reboot-vm      # push a new startup script / schema / image
#   ./create-clickhouse-host.sh --smoke          # write/read through HTTP from a Cloud Run job

set -euo pipefail

GCP_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$GCP_SCRIPT_DIR/../../common.sh"

# ============================================================================
# Configuration
# ============================================================================

DEFAULT_STAGE="dev-db"
DEFAULT_REGION="asia-southeast1"
DEFAULT_ZONE="asia-southeast1-b"
DEFAULT_MACHINE_TYPE="e2-standard-2"
DEFAULT_IMAGE_FAMILY="ubuntu-2404-lts-amd64"
DEFAULT_IMAGE_PROJECT="ubuntu-os-cloud"
DEFAULT_BOOT_GB="20"
DEFAULT_DATA_GB="50"
DEFAULT_DATA_DISK_TYPE="pd-balanced"
DEFAULT_RETENTION_HOURS="72"
DEFAULT_WAIT_TIMEOUT="900"
# Same digest as apps/infra/scripts/clickhouse-host.ts so both clouds run the
# same server build.
DEFAULT_CLICKHOUSE_IMAGE="clickhouse/clickhouse-server@sha256:c67cd26ea87301f3115e5fa7822905bcbb89cbd81e52bdd1ab7a938d1d5b77d8"
SCHEMA_FILE="$GCP_SCRIPT_DIR/../../../apps/infra/clickhouse/otel-schema-v0.144.0.sql"
STARTUP_FILE="$GCP_SCRIPT_DIR/clickhouse-startup.sh"
DATA_DEVICE="clickhouse-data"
CLICKHOUSE_TAG="boxlite-clickhouse"
SMOKE_IMAGE="docker.io/curlimages/curl:8.22.0"

PROJECT=""
STAGE="$DEFAULT_STAGE"
REGION="$DEFAULT_REGION"
ZONE="$DEFAULT_ZONE"
NETWORK=""
SUBNET=""
MACHINE_TYPE="$DEFAULT_MACHINE_TYPE"
CLICKHOUSE_IMAGE="$DEFAULT_CLICKHOUSE_IMAGE"
RETENTION_HOURS="$DEFAULT_RETENTION_HOURS"
WAIT_TIMEOUT="$DEFAULT_WAIT_TIMEOUT"
RECREATE_VM=false
REBOOT_VM=false
SMOKE=false
SKIP_WAIT=false
DRY_RUN=false

# Derived in validate_args.
NAME=""
DISK=""
SA_ID=""
SA_EMAIL=""
ADMIN_SECRET=""
WRITER_SECRET=""
READER_SECRET=""
LABELS=""
SCHEMA_TMP=""

# Filled in by later steps.
VM_IP=""
BINDING_PENDING=false
# Guest attribute value before a reboot/recreate. Guest attributes survive a
# reset, so the wait must see the value change before trusting a `ready`.
PREVIOUS_STATUS=""

# ============================================================================
# Functions
# ============================================================================

usage() {
    cat << EOF
Usage: $(basename "$0") [OPTIONS]

Create the boxlite-<stage>-clickhouse VM, its persistent data disk, its
service account, and the three ClickHouse passwords in Secret Manager. The VM
builds the otel schema and users itself on boot and reports readiness through
a guest attribute. Safe to re-run: existing resources are kept, passwords are
never regenerated, and the data disk is never deleted.

OPTIONS:
    --project PROJECT        GCP project ID (default: gcloud config)
    --region REGION          Region (default: $DEFAULT_REGION)
    --zone ZONE              Zone (default: $DEFAULT_ZONE)
    --stage STAGE            Stage; resources are boxlite-<stage>-* (default: $DEFAULT_STAGE)
    --network NETWORK        VPC network (default: boxlite-<stage>)
    --subnet SUBNET          Subnet (default: boxlite-<stage>)
    --machine-type TYPE      Machine type (default: $DEFAULT_MACHINE_TYPE)
    --image REF              clickhouse-server image reference (default: digest-pinned, see script)
    --retention-hours HOURS  TTL applied to every otel table (default: $DEFAULT_RETENTION_HOURS)
    --reboot-vm              Refresh metadata (startup script, schema, image) and reset the VM
    --recreate-vm            Delete and recreate the VM, keeping the data disk
    --smoke                  Run the HTTP write/read check from a Cloud Run job
    --skip-wait              Do not wait for the ready guest attribute
    --wait-timeout SECONDS   How long to wait for readiness (default: $DEFAULT_WAIT_TIMEOUT)
    --dry-run                Print the mutating commands instead of running them
    --help                   Show this help message

EXAMPLES:
    $(basename "$0")
    $(basename "$0") --stage dev-db --dry-run
    $(basename "$0") --reboot-vm --smoke

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
            --zone)
                ZONE="$2"
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
            --subnet)
                SUBNET="$2"
                shift 2
                ;;
            --machine-type)
                MACHINE_TYPE="$2"
                shift 2
                ;;
            --image)
                CLICKHOUSE_IMAGE="$2"
                shift 2
                ;;
            --retention-hours)
                RETENTION_HOURS="$2"
                shift 2
                ;;
            --reboot-vm)
                REBOOT_VM=true
                shift
                ;;
            --recreate-vm)
                RECREATE_VM=true
                shift
                ;;
            --smoke)
                SMOKE=true
                shift
                ;;
            --skip-wait)
                SKIP_WAIT=true
                shift
                ;;
            --wait-timeout)
                WAIT_TIMEOUT="$2"
                shift 2
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
    if ! [[ "$RETENTION_HOURS" =~ ^[0-9]+$ ]] || ! [[ "$WAIT_TIMEOUT" =~ ^[0-9]+$ ]]; then
        print_error "--retention-hours and --wait-timeout must be integers"
        exit 1
    fi
    if [ "$RECREATE_VM" = true ] && [ "$REBOOT_VM" = true ]; then
        print_error "--recreate-vm and --reboot-vm are mutually exclusive"
        exit 1
    fi
    if [ ! -f "$SCHEMA_FILE" ] || ! grep -q '__RETENTION_HOURS__' "$SCHEMA_FILE"; then
        print_error "Schema template not found or missing __RETENTION_HOURS__: $SCHEMA_FILE"
        exit 1
    fi
    if [ ! -f "$STARTUP_FILE" ] || ! bash -n "$STARTUP_FILE"; then
        print_error "Startup script missing or not valid bash: $STARTUP_FILE"
        exit 1
    fi
    NETWORK="${NETWORK:-boxlite-$STAGE}"
    SUBNET="${SUBNET:-boxlite-$STAGE}"
    NAME="boxlite-$STAGE-clickhouse"
    DISK="$NAME-data"
    SA_ID="boxlite-$STAGE-clickhouse"
    SA_EMAIL="$SA_ID@$PROJECT.iam.gserviceaccount.com"
    ADMIN_SECRET="boxlite-$STAGE-clickhouse-admin"
    WRITER_SECRET="boxlite-$STAGE-clickhouse-writer"
    READER_SECRET="boxlite-$STAGE-clickhouse-reader"
    LABELS="app=boxlite,env=$STAGE,component=clickhouse,managed-by=create-clickhouse-host"
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
        print_warning "$field is '$actual' but this script expects '$expected'"
    fi
}

vm_describe() {
    gcloud compute instances describe "$NAME" --project="$PROJECT" --zone="$ZONE" --format="value($1)" 2>/dev/null
}

vm_exists() {
    gcloud compute instances describe "$NAME" --project="$PROJECT" --zone="$ZONE" >/dev/null 2>&1
}

vm_status() {
    gcloud compute instances get-guest-attributes "$NAME" --project="$PROJECT" --zone="$ZONE" \
        --query-path=boxlite/clickhouse --format='value(value)' 2>/dev/null || true
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

# Grant the VM service account read access to one secret. Adding an existing
# binding is a no-op. A permission error is reported, not fatal: the VM fails
# closed until the binding exists, and the summary prints the command.
bind_secret_accessor() {
    local secret="$1" attempt stderr_file
    if [ "$DRY_RUN" = true ]; then
        print_info "Would bind roles/secretmanager.secretAccessor on $secret to $SA_EMAIL"
        return 0
    fi
    stderr_file="$(mktemp)"
    # A service account created seconds ago may not be visible to IAM yet.
    for attempt in 1 2 3 4 5 6; do
        if gcloud secrets add-iam-policy-binding "$secret" --project="$PROJECT" \
            --member="serviceAccount:$SA_EMAIL" --role=roles/secretmanager.secretAccessor \
            --condition=None >/dev/null 2>"$stderr_file"; then
            rm -f "$stderr_file"
            print_success "$SA_EMAIL can read $secret"
            return 0
        fi
        if grep -qiE 'PERMISSION_DENIED|permission' "$stderr_file"; then
            break
        fi
        sleep 5
    done
    if grep -qiE 'PERMISSION_DENIED|permission' "$stderr_file"; then
        print_warning "Cannot bind secretAccessor on $secret (needs setIamPolicy on it); the VM will fail closed until someone does"
    else
        print_warning "Binding secretAccessor on $secret failed: $(head -c 300 "$stderr_file")"
    fi
    rm -f "$stderr_file"
    BINDING_PENDING=true
}

step_enable_apis() {
    print_header "Enabling APIs"
    local apis=(compute.googleapis.com secretmanager.googleapis.com iam.googleapis.com)
    if [ "$SMOKE" = true ]; then
        apis+=(run.googleapis.com)
    fi
    run gcloud services enable "${apis[@]}" --project="$PROJECT"
}

step_preflight() {
    print_header "Checking network $NETWORK / subnet $SUBNET"
    if ! gcloud compute networks describe "$NETWORK" --project="$PROJECT" >/dev/null 2>&1; then
        print_error "VPC network '$NETWORK' not found; run create-network.sh --stage $STAGE first"
        exit 1
    fi
    if ! gcloud compute networks subnets describe "$SUBNET" --project="$PROJECT" --region="$REGION" >/dev/null 2>&1; then
        print_error "Subnet '$SUBNET' not found in $REGION; run create-network.sh --stage $STAGE first"
        exit 1
    fi
    print_success "Network and subnet exist"
    # The server-side filter rejects direction combined with targetTags, so
    # only the network is filtered remotely and the rest is matched here.
    local rules
    rules="$(gcloud compute firewall-rules list --project="$PROJECT" \
        --filter="network:$NETWORK" \
        --format='value(name,direction,targetTags.list(),allowed[].map().firewall_rule().list())' 2>/dev/null \
        | awk -v tag="$CLICKHOUSE_TAG" '$2 == "INGRESS" && index($3, tag) && index($4, "tcp:8123") {print $1}' || true)"
    if [ -z "$rules" ]; then
        print_warning "No ingress rule on $NETWORK allows tcp:8123 to tag $CLICKHOUSE_TAG; clients will not reach the VM"
    else
        print_success "Firewall allows 8123 to tag $CLICKHOUSE_TAG: $rules"
    fi
}

step_service_account() {
    print_header "Creating service account $SA_ID"
    if gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT" >/dev/null 2>&1; then
        print_info "Service account $SA_EMAIL already exists"
        return 0
    fi
    run gcloud iam service-accounts create "$SA_ID" --project="$PROJECT" \
        --display-name="BoxLite $STAGE ClickHouse VM" \
        --description="Reads the ClickHouse passwords from Secret Manager at boot"
}

step_secrets() {
    print_header "Storing the ClickHouse passwords in Secret Manager"
    local secret password
    for secret in "$ADMIN_SECRET" "$WRITER_SECRET" "$READER_SECRET"; do
        if secret_exists "$secret" && [ -n "$(secret_latest_version "$secret")" ]; then
            print_info "Secret $secret already has a version; keeping it"
        else
            # 32 alphanumeric characters, like the AWS RandomPassword. The value
            # exists only in this variable until ensure_secret_value ships it on
            # stdin. `|| true` absorbs the SIGPIPE tr receives when head stops
            # reading, which pipefail would otherwise turn into a silent exit.
            password="$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32 || true)"
            if [ "${#password}" -ne 32 ]; then
                print_error "Password generation produced ${#password} characters"
                exit 1
            fi
            ensure_secret_value "$secret" "$password"
            unset password
        fi
        bind_secret_accessor "$secret"
    done
}

step_data_disk() {
    print_header "Creating data disk $DISK"
    local existing
    existing="$(gcloud compute disks describe "$DISK" --project="$PROJECT" --zone="$ZONE" \
        --format='value(sizeGb,type.basename())' 2>/dev/null || true)"
    if [ -n "$existing" ]; then
        local size type
        read -r size type <<< "$existing"
        print_info "Disk $DISK already exists; never recreated by this script"
        warn_if_differs "sizeGb" "$DEFAULT_DATA_GB" "$size"
        warn_if_differs "type" "$DEFAULT_DATA_DISK_TYPE" "$type"
        return 0
    fi
    run gcloud compute disks create "$DISK" --project="$PROJECT" --zone="$ZONE" \
        --size="${DEFAULT_DATA_GB}GB" --type="$DEFAULT_DATA_DISK_TYPE" --labels="$LABELS"
}

step_render_schema() {
    SCHEMA_TMP="$(mktemp)"
    trap 'rm -f "$SCHEMA_TMP"' EXIT
    sed "s/__RETENTION_HOURS__/$RETENTION_HOURS/g" "$SCHEMA_FILE" > "$SCHEMA_TMP"
    print_info "Rendered $(grep -c 'CREATE TABLE' "$SCHEMA_TMP") tables with a ${RETENTION_HOURS}h TTL"
}

metadata_args() {
    printf '%s' "enable-guest-attributes=TRUE,enable-oslogin=TRUE,clickhouse-image=$CLICKHOUSE_IMAGE,clickhouse-retention-hours=$RETENTION_HOURS,clickhouse-data-device=$DATA_DEVICE,clickhouse-secret-admin=$ADMIN_SECRET,clickhouse-secret-writer=$WRITER_SECRET,clickhouse-secret-reader=$READER_SECRET"
}

metadata_file_args() {
    printf '%s' "startup-script=$STARTUP_FILE,clickhouse-schema=$SCHEMA_TMP"
}

create_vm() {
    run gcloud compute instances create "$NAME" --project="$PROJECT" --zone="$ZONE" \
        --machine-type="$MACHINE_TYPE" \
        --image-family="$DEFAULT_IMAGE_FAMILY" --image-project="$DEFAULT_IMAGE_PROJECT" \
        --boot-disk-size="${DEFAULT_BOOT_GB}GB" --boot-disk-type=pd-balanced \
        --disk="name=$DISK,device-name=$DATA_DEVICE,mode=rw,auto-delete=no" \
        --network="$NETWORK" --subnet="$SUBNET" --no-address \
        --service-account="$SA_EMAIL" --scopes=cloud-platform \
        --tags="$CLICKHOUSE_TAG" --labels="$LABELS" \
        --shielded-secure-boot --shielded-vtpm --shielded-integrity-monitoring \
        --deletion-protection \
        --metadata="$(metadata_args)" \
        --metadata-from-file="$(metadata_file_args)"
}

step_vm() {
    print_header "Creating VM $NAME"
    if ! vm_exists; then
        create_vm
        return 0
    fi

    print_info "VM $NAME already exists"
    warn_if_differs "machineType" "$MACHINE_TYPE" "$(vm_describe 'machineType.basename()')"
    warn_if_differs "subnetwork" "$SUBNET" "$(vm_describe 'networkInterfaces[0].subnetwork.basename()')"
    warn_if_differs "serviceAccount" "$SA_EMAIL" "$(vm_describe 'serviceAccounts[0].email')"
    warn_if_differs "dataDisk.deviceName" "$DATA_DEVICE" "$(vm_describe 'disks[1].deviceName')"
    warn_if_differs "dataDisk.autoDelete" "False" "$(vm_describe 'disks[1].autoDelete')"
    local live_image live_script_sha local_script_sha
    live_image="$(vm_describe 'metadata.items.filter(key:clickhouse-image).extract(value).flatten()')"
    # Both sides go through $(...) so trailing newlines, which gcloud's value
    # format adds and files end with, never count as drift.
    live_script_sha="$(printf '%s' "$(vm_describe 'metadata.items.filter(key:startup-script).extract(value).flatten()')" | sha256sum | awk '{print $1}')"
    local_script_sha="$(printf '%s' "$(cat "$STARTUP_FILE")" | sha256sum | awk '{print $1}')"
    if [ "$live_image" != "$CLICKHOUSE_IMAGE" ] || [ "$live_script_sha" != "$local_script_sha" ]; then
        if [ "$REBOOT_VM" = false ] && [ "$RECREATE_VM" = false ]; then
            print_warning "Startup script or image on the VM differs from this checkout; pass --reboot-vm to push it"
        fi
    fi

    if [ "$RECREATE_VM" = true ] || [ "$REBOOT_VM" = true ]; then
        PREVIOUS_STATUS="$(vm_status)"
    fi
    if [ "$RECREATE_VM" = true ]; then
        # The data disk is attached with auto-delete=no and --keep-disks=data
        # says it again, so only the boot disk goes with the VM.
        run gcloud compute instances update "$NAME" --project="$PROJECT" --zone="$ZONE" --no-deletion-protection
        run gcloud compute instances delete "$NAME" --project="$PROJECT" --zone="$ZONE" --keep-disks=data --quiet
        create_vm
        return 0
    fi
    if [ "$REBOOT_VM" = true ]; then
        # The GCE equivalent of userDataReplaceOnChange: refresh what the
        # startup script reads, then reboot so it runs again.
        run gcloud compute instances add-metadata "$NAME" --project="$PROJECT" --zone="$ZONE" \
            --metadata="$(metadata_args)" --metadata-from-file="$(metadata_file_args)"
        run gcloud compute instances reset "$NAME" --project="$PROJECT" --zone="$ZONE"
    fi
}

step_wait_ready() {
    print_header "Waiting for the VM to report ready"
    if [ "$DRY_RUN" = true ] || [ "$SKIP_WAIT" = true ]; then
        print_info "Not waiting (dry run or --skip-wait)"
        return 0
    fi
    local deadline status expected_digest
    deadline=$((SECONDS + WAIT_TIMEOUT))
    expected_digest="${CLICKHOUSE_IMAGE#*@}"
    while [ "$SECONDS" -lt "$deadline" ]; do
        status="$(vm_status)"
        # After a reboot the old value is still there until the startup script
        # writes `starting:`; only a value that changed since then counts.
        if [ -n "$PREVIOUS_STATUS" ] && [ "$status" = "$PREVIOUS_STATUS" ]; then
            sleep 10
            continue
        fi
        case "$status" in
            ready:*)
                local digest tables
                digest="$(echo "$status" | cut -d: -f2,3)"
                tables="$(echo "$status" | cut -d: -f4)"
                warn_if_differs "running image digest" "$expected_digest" "$digest"
                print_success "VM reports ready: $tables tables, image $digest (boot $(echo "$status" | cut -d: -f5))"
                return 0
                ;;
            failed:*)
                print_error "VM reports '$status'. Last serial console lines:"
                gcloud compute instances get-serial-port-output "$NAME" --project="$PROJECT" --zone="$ZONE" 2>/dev/null | tail -n 80 >&2 || true
                exit 1
                ;;
            *)
                sleep 10
                ;;
        esac
    done
    print_error "VM did not report ready within ${WAIT_TIMEOUT}s (last status: '${status:-none}'). Last serial console lines:"
    gcloud compute instances get-serial-port-output "$NAME" --project="$PROJECT" --zone="$ZONE" 2>/dev/null | tail -n 80 >&2 || true
    exit 1
}

step_read_ip() {
    if [ "$DRY_RUN" = true ]; then
        VM_IP="<internal ip>"
        return 0
    fi
    VM_IP="$(vm_describe 'networkInterfaces[0].networkIP')"
}

step_smoke() {
    if [ "$SMOKE" != true ]; then
        return 0
    fi
    print_header "Smoke test over HTTP from a Cloud Run job in $SUBNET"
    local job="$NAME-smoke" marker body
    marker="boxlite-smoke-$(date +%s)"
    # POSIX sh for the curl image. Passwords arrive through --set-secrets, so
    # the job spec never carries them.
    body="$(cat <<'SMOKE'
set -eu
q() { curl -sS -o /tmp/out -w '%{http_code}' -H "X-ClickHouse-User: $1" -H "X-ClickHouse-Key: $2" --data-binary "$3" "$CH_URL"; }
code=$(q otel_writer "$WRITER_PW" "INSERT INTO otel.otel_logs (Timestamp, ServiceName, Body) VALUES (now64(9), 'boxlite-smoke', '$MARKER')")
[ "$code" = 200 ] || { echo "writer insert: HTTP $code $(cat /tmp/out)"; exit 1; }
echo "writer insert: ok"
code=$(q otel_reader "$READER_PW" "SELECT count() FROM otel.otel_logs WHERE Body = '$MARKER'")
[ "$code" = 200 ] && [ "$(cat /tmp/out)" = 1 ] || { echo "reader count: HTTP $code $(cat /tmp/out)"; exit 1; }
echo "reader count: ok"
code=$(q otel_reader "$READER_PW" "INSERT INTO otel.otel_logs (Timestamp) VALUES (now64(9))")
[ "$code" != 200 ] || { echo "reader INSERT was accepted"; exit 1; }
echo "reader insert denied: HTTP $code"
code=$(q otel_reader wrong-password "SELECT 1")
[ "$code" != 200 ] || { echo "wrong password was accepted"; exit 1; }
echo "wrong password denied: HTTP $code"
echo SMOKE_OK
SMOKE
)"
    if gcloud run jobs describe "$job" --project="$PROJECT" --region="$REGION" >/dev/null 2>&1; then
        run gcloud run jobs delete "$job" --project="$PROJECT" --region="$REGION" --quiet
    fi
    # ^~^ makes ~ the list separator so the commas inside the SQL survive.
    run gcloud run jobs create "$job" --project="$PROJECT" --region="$REGION" \
        --image="$SMOKE_IMAGE" \
        --network="$NETWORK" --subnet="$SUBNET" --vpc-egress=private-ranges-only \
        --service-account="$SA_EMAIL" \
        --set-env-vars="CH_URL=http://$VM_IP:8123/,MARKER=$marker" \
        --set-secrets="WRITER_PW=$WRITER_SECRET:latest,READER_PW=$READER_SECRET:latest" \
        --max-retries=0 --task-timeout=120s \
        --command=sh --args="^~^-c~$body"
    if [ "$DRY_RUN" = true ]; then
        return 0
    fi
    local execution smoke_ok=true
    if ! gcloud run jobs execute "$job" --project="$PROJECT" --region="$REGION" --wait >/dev/null 2>&1; then
        smoke_ok=false
    fi
    execution="$(gcloud run jobs executions list --job="$job" --project="$PROJECT" --region="$REGION" --limit=1 --format='value(name)')"
    sleep 5
    gcloud logging read "resource.type=cloud_run_job AND resource.labels.job_name=$job AND labels.\"run.googleapis.com/execution_name\"=$execution" \
        --project="$PROJECT" --format='value(textPayload)' --order=asc --limit=50 2>/dev/null | grep -v '^$' || true
    run gcloud run jobs delete "$job" --project="$PROJECT" --region="$REGION" --quiet
    if [ "$smoke_ok" != true ]; then
        print_error "Smoke test failed; see the job output above"
        exit 1
    fi
    print_success "Smoke test passed"
}

step_summary() {
    print_header "ClickHouse host $NAME"
    echo "URL:             http://$VM_IP:8123   (VPC $NETWORK only, plaintext like the AWS host)"
    echo "Users:           boxlite_admin (management), otel_writer (collector), otel_reader (API)"
    echo "Admin secret:    projects/$PROJECT/secrets/$ADMIN_SECRET"
    echo "Writer secret:   projects/$PROJECT/secrets/$WRITER_SECRET"
    echo "Reader secret:   projects/$PROJECT/secrets/$READER_SECRET"
    echo "Data disk:       $DISK (never deleted by this script)"
    echo "Boot log:        gcloud compute instances get-serial-port-output $NAME --zone $ZONE"
    echo "Status:          gcloud compute instances get-guest-attributes $NAME --zone $ZONE --query-path=boxlite/clickhouse"
    echo ""
    echo "Collector env:   CLICKHOUSE_ENDPOINT=http://$VM_IP:8123  CLICKHOUSE_USERNAME=otel_writer  CLICKHOUSE_PASSWORD from $WRITER_SECRET"
    echo "API env:         CLICKHOUSE_URL=http://$VM_IP:8123       CLICKHOUSE_USERNAME=otel_reader  CLICKHOUSE_PASSWORD from $READER_SECRET"
    if [ "$BINDING_PENDING" = true ]; then
        echo ""
        echo "ACTION REQUIRED: the VM cannot read its secrets yet. Someone with setIamPolicy on them runs:"
        local secret
        for secret in "$ADMIN_SECRET" "$WRITER_SECRET" "$READER_SECRET"; do
            echo "  gcloud secrets add-iam-policy-binding $secret --project=$PROJECT --member=serviceAccount:$SA_EMAIL --role=roles/secretmanager.secretAccessor"
        done
        echo "then: $(basename "$0") --stage $STAGE --reboot-vm"
    fi
}

main() {
    require_command gcloud "Install: https://cloud.google.com/sdk/docs/install"

    parse_args "$@"
    validate_args

    step_enable_apis
    step_preflight
    step_service_account
    step_secrets
    step_data_disk
    step_render_schema
    step_vm
    step_wait_ready
    step_read_ip
    step_smoke
    step_summary
}

# ============================================================================
# Entry point
# ============================================================================

main "$@"
