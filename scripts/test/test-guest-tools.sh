#!/bin/bash
# Structural and functional qualification for static guest e2fsprogs tools.

set -euo pipefail

TEST_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_PROJECT_ROOT="$(cd "$TEST_SCRIPT_DIR/../.." && pwd)"

profile="release"
requested_target=""
contract_case="${BOXLITE_GUEST_TOOLS_TEST_CASE:-all}"
while [ "$#" -gt 0 ]; do
    case "$1" in
        --profile)
            if [ "$#" -lt 2 ]; then
                echo "ERROR: --profile requires release or debug" >&2
                exit 2
            fi
            profile="$2"
            shift 2
            ;;
        --target)
            if [ "$#" -lt 2 ]; then
                echo "ERROR: --target requires a guest target triple" >&2
                exit 2
            fi
            requested_target="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: $0 [--target TARGET] [--profile release|debug]"
            exit 0
            ;;
        *)
            echo "ERROR: unknown option: $1" >&2
            exit 2
            ;;
    esac
done

case "$profile" in
    release|debug) ;;
    *)
        echo "ERROR: unsupported profile: $profile" >&2
        exit 2
        ;;
esac

# shellcheck source=../util.sh
source "$TEST_PROJECT_ROOT/scripts/util.sh"
if [ -n "$requested_target" ]; then
    target_to_arch "$requested_target" >/dev/null
    test_target="$requested_target"
else
    init_guest_vars
    test_target="$GUEST_TARGET"
fi

# shellcheck source=../build/verify-guest-elf.sh
source "$TEST_PROJECT_ROOT/scripts/build/verify-guest-elf.sh"

tools_dir="$TEST_PROJECT_ROOT/target/$test_target/$profile/guest-tools"
mke2fs="$tools_dir/mke2fs"
resize2fs="$tools_dir/resize2fs"

for required_file in \
    "$mke2fs" \
    "$resize2fs" \
    "$tools_dir/guest-tools-manifest.json" \
    "$tools_dir/SHA256SUMS" \
    "$tools_dir/NOTICE" \
    "$tools_dir/source-metadata.json" \
    "$tools_dir/build-metadata.json"; do
    if [ ! -f "$required_file" ]; then
        echo "ERROR: missing guest tools artifact: $required_file" >&2
        echo "Run: make guest-tools PROFILE=$profile" >&2
        exit 1
    fi
done

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/boxlite-guest-tools-test.XXXXXX")
cache_restore_pending=false
cache_backup=""
legacy_mke2fs=""
concurrency_restore_pending=false
concurrency_backup=""
concurrency_build_root=""
concurrency_output_dir=""
publish_pid=""
cache_pid=""
concurrency_pid_a=""
concurrency_pid_b=""
lock_competitor_pid=""
publish_pgid=""
cache_pgid=""
concurrency_pgid_a=""
concurrency_pgid_b=""
lock_competitor_pgid=""
sync_timeout_seconds="${BOXLITE_GUEST_TOOLS_TEST_SYNC_TIMEOUT_SECONDS:-300}"
case "$sync_timeout_seconds" in
    ''|*[!0-9]*|0)
        echo "ERROR: BOXLITE_GUEST_TOOLS_TEST_SYNC_TIMEOUT_SECONDS must be a positive integer" >&2
        exit 2
        ;;
esac

read_sync_event() {
    local event_fd="$1"
    local event_name="$2"
    local event_label="$3"
    if ! IFS= read -r -t "$sync_timeout_seconds" "$event_name" <&"$event_fd"; then
        echo "ERROR: timed out or reached EOF waiting for $event_label" >&2
        return 1
    fi
}

terminate_job_tree() {
    local child_pid="$1"
    local child_pgid="$2"
    [ -n "$child_pid" ] || return 0

    if [ -n "$child_pgid" ] && [ "$child_pgid" = "$child_pid" ]; then
        kill -KILL -- "-$child_pgid" 2>/dev/null || true
    else
        kill -KILL "$child_pid" 2>/dev/null || true
    fi
    wait "$child_pid" 2>/dev/null || true
}

stop_child_processes() {
    terminate_job_tree "$publish_pid" "$publish_pgid"
    terminate_job_tree "$cache_pid" "$cache_pgid"
    terminate_job_tree "$concurrency_pid_a" "$concurrency_pgid_a"
    terminate_job_tree "$concurrency_pid_b" "$concurrency_pgid_b"
    terminate_job_tree "$lock_competitor_pid" "$lock_competitor_pgid"
    publish_pid=""
    cache_pid=""
    concurrency_pid_a=""
    concurrency_pid_b=""
    lock_competitor_pid=""
    publish_pgid=""
    cache_pgid=""
    concurrency_pgid_a=""
    concurrency_pgid_b=""
    lock_competitor_pgid=""
}

restore_cache_state() {
    if [ "$cache_restore_pending" != true ]; then
        return 0
    fi
    if [ -f "$cache_backup/mke2fs.static" ]; then
        cp -p "$cache_backup/mke2fs.static" "$legacy_mke2fs"
    fi
    rm -rf "$tools_dir"
    cp -a "$cache_backup/guest-tools" "$tools_dir"
    cache_restore_pending=false
}

restore_concurrency_state() {
    if [ "$concurrency_restore_pending" != true ]; then
        return 0
    fi
    rm -rf "$concurrency_build_root" "$concurrency_output_dir"
    if [ -d "$concurrency_backup/build-root" ]; then
        mkdir -p "$(dirname "$concurrency_build_root")"
        cp -a "$concurrency_backup/build-root" "$concurrency_build_root"
    fi
    if [ -d "$concurrency_backup/guest-tools" ]; then
        mkdir -p "$(dirname "$concurrency_output_dir")"
        cp -a "$concurrency_backup/guest-tools" "$concurrency_output_dir"
    fi
    concurrency_restore_pending=false
}

cleanup_test_state() {
    local test_status=$?
    trap - EXIT HUP INT TERM
    set +e
    stop_child_processes
    restore_cache_state
    restore_concurrency_state
    rm -rf "$tmp_dir"
    exit "$test_status"
}
trap cleanup_test_state EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

expect_rejected() {
    local label="$1"
    shift
    if "$@" >"$tmp_dir/rejected.stdout" 2>"$tmp_dir/rejected.stderr"; then
        echo "ERROR: validator accepted invalid fixture: $label" >&2
        exit 1
    fi
    echo "✓ validator rejects $label"
}

expect_rejected_by() {
    local label="$1"
    local expected_error="$2"
    shift 2
    if "$@" >"$tmp_dir/rejected.stdout" 2>"$tmp_dir/rejected.stderr"; then
        echo "ERROR: validator accepted invalid fixture: $label" >&2
        exit 1
    fi
    if ! grep -Fq "$expected_error" "$tmp_dir/rejected.stderr"; then
        echo "ERROR: validator rejected $label for the wrong reason" >&2
        echo "Expected: $expected_error" >&2
        echo "Actual:" >&2
        sed 's/^/  /' "$tmp_dir/rejected.stderr" >&2
        exit 1
    fi
    echo "✓ validator rejects $label at the intended check"
}

null_program_headers_by_type() {
    local elf_path="$1"
    local rejected_type="$2"
    local phoff phentsize phnum index entry_offset entry_type
    local found=false

    phoff=$(od -An -t u8 -N 8 -j 32 "$elf_path" | tr -d '[:space:]')
    phentsize=$(od -An -t u2 -N 2 -j 54 "$elf_path" | tr -d '[:space:]')
    phnum=$(od -An -t u2 -N 2 -j 56 "$elf_path" | tr -d '[:space:]')
    index=0
    while [ "$index" -lt "$phnum" ]; do
        entry_offset=$((phoff + index * phentsize))
        entry_type=$(od -An -t u4 -N 4 -j "$entry_offset" "$elf_path" | tr -d '[:space:]')
        if [ "$entry_type" -eq "$rejected_type" ]; then
            printf '\000\000\000\000' | \
                dd of="$elf_path" bs=1 seek="$entry_offset" conv=notrunc 2>/dev/null
            found=true
        fi
        index=$((index + 1))
    done

    if [ "$found" != true ]; then
        echo "ERROR: fixture has no program header type $rejected_type: $elf_path" >&2
        exit 1
    fi
}

sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

echo "🧪 Verifying guest tools for $test_target ($profile)..."
verify_guest_elf "$test_target" "$mke2fs"
verify_guest_elf "$test_target" "$resize2fs"

empty_fixture="$tmp_dir/empty"
: > "$empty_fixture"
chmod 0755 "$empty_fixture"
expect_rejected "an empty executable" verify_guest_elf "$test_target" "$empty_fixture"

noexec_fixture="$tmp_dir/noexec"
cp "$mke2fs" "$noexec_fixture"
chmod 0644 "$noexec_fixture"
expect_rejected "a non-executable ELF" verify_guest_elf "$test_target" "$noexec_fixture"

# Changing only e_type creates a useful structural static-PIE fixture: it has
# no interpreter or dynamic dependencies, but is ET_DYN and must still fail.
et_dyn_fixture="$tmp_dir/et-dyn"
cp "$mke2fs" "$et_dyn_fixture"
printf '\003\000' | dd of="$et_dyn_fixture" bs=1 seek=16 conv=notrunc 2>/dev/null
expect_rejected_by \
    "an ET_DYN/static-PIE-shaped ELF" \
    "guest executable must be non-PIE ET_EXEC" \
    verify_guest_elf "$test_target" "$et_dyn_fixture"

dynamic_source="$tmp_dir/dynamic.c"
dynamic_fixture="$tmp_dir/target-musl-dynamic"
printf '%s\n' 'int main(void) { return 0; }' > "$dynamic_source"
fixture_cc=$(resolve_musl_cc "$test_target")
"$fixture_cc" -no-pie -o "$dynamic_fixture" "$dynamic_source"
expect_rejected_by \
    "a target-musl dynamic ELF with PT_INTERP" \
    "guest executable has a PT_INTERP segment" \
    verify_guest_elf "$test_target" "$dynamic_fixture"

pt_dynamic_fixture="$tmp_dir/target-musl-pt-dynamic"
cp "$dynamic_fixture" "$pt_dynamic_fixture"
null_program_headers_by_type "$pt_dynamic_fixture" 3
expect_rejected_by \
    "a target-musl dynamic ELF with PT_DYNAMIC but no PT_INTERP" \
    "guest executable has a PT_DYNAMIC segment" \
    verify_guest_elf "$test_target" "$pt_dynamic_fixture"

sht_dynamic_fixture="$tmp_dir/target-musl-sht-dynamic"
cp "$pt_dynamic_fixture" "$sht_dynamic_fixture"
null_program_headers_by_type "$sht_dynamic_fixture" 2
expect_rejected_by \
    "a target-musl ELF with SHT_DYNAMIC but no dynamic program headers" \
    "guest executable has an SHT_DYNAMIC section" \
    verify_guest_elf "$test_target" "$sht_dynamic_fixture"

case "$test_target" in
    x86_64-unknown-linux-musl) wrong_target="aarch64-unknown-linux-musl" ;;
    aarch64-unknown-linux-musl) wrong_target="x86_64-unknown-linux-musl" ;;
esac
expect_rejected "an ELF for the wrong architecture" verify_guest_elf "$wrong_target" "$mke2fs"

while read -r expected_sha checksum_name; do
    [ -n "$expected_sha" ] || continue
    checksum_name="${checksum_name#\*}"
    if [ ! -f "$tools_dir/$checksum_name" ]; then
        echo "ERROR: SHA256SUMS names a missing file: $checksum_name" >&2
        exit 1
    fi
    actual_sha=$(sha256_file "$tools_dir/$checksum_name")
    if [ "$actual_sha" != "$expected_sha" ]; then
        echo "ERROR: checksum mismatch for $checksum_name" >&2
        exit 1
    fi
done < "$tools_dir/SHA256SUMS"
echo "✓ artifact checksums match"

grep -Fq '"cache_scope": "verified-output"' "$tools_dir/build-metadata.json"
grep -Fq '"publication": "atomic-files-sha256sums-last"' "$tools_dir/build-metadata.json"
grep -Fq '"publish_lock": "perl-flock-exclusive"' "$tools_dir/build-metadata.json"
grep -Fq '"lock_lifetime": "publisher-holder-shared-ofd"' "$tools_dir/build-metadata.json"
for tool_field in compiler build_compiler ar ranlib strip; do
    grep -Eq "\"${tool_field}\": \"[^\"]+\"" "$tools_dir/build-metadata.json"
    grep -Eq "\"${tool_field}_version\": \"[^\"]+\"" "$tools_dir/build-metadata.json"
done
grep -Eq '"linux_headers_content_id": "[[:xdigit:]]{64}"' \
    "$tools_dir/build-metadata.json"
grep -Fq '"source_snapshot": "private-content-addressed"' \
    "$tools_dir/build-metadata.json"
grep -Fq '"linux_headers": "consumer-owned-snapshot"' \
    "$tools_dir/build-metadata.json"
grep -Eq '"snapshot_content_sha256": "[[:xdigit:]]{64}"' \
    "$tools_dir/source-metadata.json"
echo "✓ build metadata records the toolchain, cache, and publication contract"

workflow_file="$TEST_PROJECT_ROOT/.github/workflows/test.yml"
guest_filter_contract=$(awk '
    /^            guest_tools:/ { in_filter = 1 }
    in_filter && /^  [[:alnum:]_-]+:/ { exit }
    in_filter { print }
' "$workflow_file")
printf '%s\n' "$guest_filter_contract" | grep -Fq -- "- 'src/shared/**'"
printf '%s\n' "$guest_filter_contract" | \
    grep -Fq -- "- 'scripts/test/test-guest-native-cache.sh'"
grep -Fq 'test/test-guest-native-cache.sh' "$TEST_PROJECT_ROOT/make/test.mk"
for qualified_path in \
    boxlite-guest \
    guest-tools/mke2fs \
    guest-tools/resize2fs \
    guest-tools/NOTICE \
    guest-tools/source-metadata.json \
    guest-tools/build-metadata.json \
    guest-tools/guest-tools-manifest.json \
    guest-tools/SHA256SUMS; do
    grep -Fq "          $qualified_path" "$workflow_file"
done
if grep -Eq -- '-C .* boxlite-guest guest-tools[[:space:]]*$' "$workflow_file"; then
    echo "ERROR: qualification artifact recursively archives guest-tools" >&2
    exit 1
fi
echo "✓ CI filter and artifact allowlist cover the guest-tools dependency closure"

# Sourcing the build helper is part of its public contract.  Check the common
# failure modes explicitly: cwd, shell flags, variables, traps, and caller-owned
# file descriptors.
if [ "$contract_case" = all ] || [ "$contract_case" = source-contract ]; then
source_fd8_log="$tmp_dir/source-fd8.log"
source_fd9_log="$tmp_dir/source-fd9.log"
(
    set +e
    exec 8>>"$source_fd8_log"
    exec 9>>"$source_fd9_log"
    printf 'before-source\n' >&8
    printf 'before-source\n' >&9
    source_pwd="$PWD"
    source_flags="$-"
    source_marker="unchanged"
    trap 'true' EXIT
    source_trap=$(trap -p EXIT)
    # shellcheck source=../build/build-e2fsprogs-guest.sh
    source "$TEST_PROJECT_ROOT/scripts/build/build-e2fsprogs-guest.sh" || exit 1
    [ "$PWD" = "$source_pwd" ] || exit 1
    [ "$-" = "$source_flags" ] || exit 1
    [ "$source_marker" = "unchanged" ] || exit 1
    [ "$(trap -p EXIT)" = "$source_trap" ] || exit 1
    declare -F ensure_guest_e2fsprogs_for_target >/dev/null || exit 1
    printf 'after-source\n' >&8
    printf 'after-source\n' >&9

    ensure_guest_e2fsprogs_for_target "$test_target" "$profile" \
        >"$tmp_dir/source-ensure.log" 2>&1 || exit 1
    [ "$PWD" = "$source_pwd" ] || exit 1
    [ "$-" = "$source_flags" ] || exit 1
    [ "$source_marker" = "unchanged" ] || exit 1
    [ "$(trap -p EXIT)" = "$source_trap" ] || exit 1
    printf 'after-ensure\n' >&8
    printf 'after-ensure\n' >&9

    source_lock_dir="$tmp_dir/source-lock"
    mkdir -p "$source_lock_dir"
    publish_lock_pid=""
    publish_lock_channels_open=false
    publish_lock_ready_fifo=""
    publish_lock_release_fifo=""
    publish_lock_release_fd=""
    _guest_tools_acquire_publish_lock \
        "$source_lock_dir/publish.lock" "$source_lock_dir" || exit 1
    _guest_tools_release_publish_lock || exit 1
    printf 'after-lock\n' >&8
    printf 'after-lock\n' >&9

    # The lock holder can fail between validation and exec. Its shell
    # redirection must still connect the ready FIFO and deliver EOF, rather
    # than leaving the caller blocked forever waiting for a writer.
    source_failed_lock_dir="$tmp_dir/source-failed-lock"
    mkdir -p "$source_failed_lock_dir"
    perl() {
        if [ "$#" -eq 3 ] && [ "$3" = "exit 0" ]; then
            command perl "$@"
        else
            return 127
        fi
    }
    if _guest_tools_acquire_publish_lock \
        "$source_failed_lock_dir/publish.lock" "$source_failed_lock_dir" \
        2>"$tmp_dir/source-failed-lock.stderr"; then
        echo "ERROR: publication lock accepted a failed holder exec" >&2
        exit 1
    fi
    unset -f perl
    printf 'after-failed-lock\n' >&8
    printf 'after-failed-lock\n' >&9
    exec 8>&-
    exec 9>&-
)
if [ "$(wc -l < "$source_fd8_log" | tr -d '[:space:]')" -ne 5 ] || \
   [ "$(wc -l < "$source_fd9_log" | tr -d '[:space:]')" -ne 5 ]; then
    echo "ERROR: sourced build helper changed caller-owned file descriptors" >&2
    exit 1
fi
echo "✓ build helper is safe to source"
fi

# shellcheck source=../build/build-e2fsprogs-guest.sh
source "$TEST_PROJECT_ROOT/scripts/build/build-e2fsprogs-guest.sh"

# Source snapshots may preserve symlinks only when every link resolves to bytes
# captured in that same immutable snapshot. External, escaping, broken, and
# cyclic links would otherwise let configure or NOTICE consume unnamed bytes.
if [ "$contract_case" = "all" ] || [ "$contract_case" = "source-snapshot-links" ]; then
    source_links_repo="$tmp_dir/source-links-repo"
    source_links_snapshot="$tmp_dir/source-links-snapshot"
    source_links_external="$tmp_dir/source-links-external"
    mkdir -p "$source_links_repo/nested/deeper"
    git -C "$source_links_repo" init -q
    printf '%s\n' captured >"$source_links_repo/nested/target.txt"
    printf '%s\n' external >"$source_links_external"
    ln -s nested/target.txt "$source_links_repo/internal-link"
    ln -s internal-link "$source_links_repo/internal-chain"
    ln -s ../target.txt "$source_links_repo/nested/deeper/internal-up"
    git -C "$source_links_repo" add \
        nested/target.txt nested/deeper/internal-up internal-link internal-chain
    git -C "$source_links_repo" \
        -c user.name=BoxLite -c user.email=boxlite@example.invalid \
        commit -qm fixture

    _guest_tools_create_source_snapshot \
        "$source_links_repo" "$source_links_snapshot" >/dev/null
    [ "$(cat "$source_links_snapshot/internal-link")" = captured ] || \
        { echo "ERROR: source snapshot broke an internal symlink" >&2; exit 1; }
    [ "$(cat "$source_links_snapshot/internal-chain")" = captured ] || \
        { echo "ERROR: source snapshot broke an internal symlink chain" >&2; exit 1; }
    [ "$(cat "$source_links_snapshot/nested/deeper/internal-up")" = captured ] || \
        { echo "ERROR: source snapshot rejected an internal parent link" >&2; exit 1; }
    printf '%s\n' mutated >"$source_links_repo/nested/target.txt"
    [ "$(cat "$source_links_snapshot/internal-chain")" = captured ] || \
        { echo "ERROR: internal snapshot link followed later source bytes" >&2; exit 1; }
    _guest_tools_remove_private_tree "$source_links_snapshot"

    expect_source_link_rejected() {
        local link_name="$1"
        local link_target="$2"
        local destination="$tmp_dir/source-links-rejected-$link_name"
        ln -s "$link_target" "$source_links_repo/$link_name"
        git -C "$source_links_repo" add "$link_name"
        if _guest_tools_create_source_snapshot \
            "$source_links_repo" "$destination" >"$destination.log" 2>&1; then
            echo "ERROR: source snapshot accepted unsafe symlink $link_name -> $link_target" >&2
            exit 1
        fi
        _guest_tools_remove_private_tree "$destination"
        git -C "$source_links_repo" rm -q -f "$link_name"
    }

    expect_source_link_rejected absolute-link "$source_links_external"
    expect_source_link_rejected escaping-link "../$(basename "$source_links_external")"
    expect_source_link_rejected broken-link missing-target
    ln -s loop-b "$source_links_repo/loop-a"
    ln -s loop-a "$source_links_repo/loop-b"
    git -C "$source_links_repo" add loop-a loop-b
    if _guest_tools_create_source_snapshot \
        "$source_links_repo" "$tmp_dir/source-links-loop" \
        >"$tmp_dir/source-links-loop.log" 2>&1; then
        echo "ERROR: source snapshot accepted a cyclic symlink chain" >&2
        exit 1
    fi
    _guest_tools_remove_private_tree "$tmp_dir/source-links-loop"
    echo "✓ source snapshots preserve only wholly internal symlink graphs"
fi

# A build must consume the exact source tree that its cache signature names.
# Mutate and restore the live NOTICE at the copy boundary: only a build reading
# the live worktree after fingerprinting can publish the transient bytes.
if [ "$contract_case" = "all" ] || [ "$contract_case" = "source-snapshot" ]; then
    source_snapshot_fixture_repo="$tmp_dir/source-snapshot-repo"
    source_snapshot_fixture_one="$tmp_dir/source-snapshot-one"
    source_snapshot_fixture_two="$tmp_dir/source-snapshot-two"
    mkdir -p "$source_snapshot_fixture_repo"
    git -C "$source_snapshot_fixture_repo" init -q
    printf '%s\n' committed >"$source_snapshot_fixture_repo/tracked.txt"
    printf '%s\n' deleted >"$source_snapshot_fixture_repo/deleted.txt"
    printf '%s\n' '#!/bin/sh' 'exit 0' >"$source_snapshot_fixture_repo/tool.sh"
    chmod 0755 "$source_snapshot_fixture_repo/tool.sh"
    git -C "$source_snapshot_fixture_repo" add tracked.txt deleted.txt tool.sh
    git -C "$source_snapshot_fixture_repo" \
        -c user.name=BoxLite -c user.email=boxlite@example.invalid \
        commit -qm fixture
    printf '%s\n' staged >"$source_snapshot_fixture_repo/tracked.txt"
    git -C "$source_snapshot_fixture_repo" add tracked.txt
    printf '%s\n' working-tree >"$source_snapshot_fixture_repo/tracked.txt"
    rm "$source_snapshot_fixture_repo/deleted.txt"
    printf '%s\n' untracked >"$source_snapshot_fixture_repo/untracked.txt"
    ln -s tracked.txt "$source_snapshot_fixture_repo/untracked-link"

    source_snapshot_fixture_one_id=$(
        _guest_tools_create_source_snapshot \
            "$source_snapshot_fixture_repo" "$source_snapshot_fixture_one"
    )
    [ "$(cat "$source_snapshot_fixture_one/tracked.txt")" = working-tree ] || \
        { echo "ERROR: source snapshot did not use dirty working-tree bytes" >&2; exit 1; }
    [ "$(cat "$source_snapshot_fixture_one/untracked.txt")" = untracked ] || \
        { echo "ERROR: source snapshot omitted non-ignored untracked content" >&2; exit 1; }
    [ ! -e "$source_snapshot_fixture_one/deleted.txt" ] || \
        { echo "ERROR: source snapshot restored a deleted tracked path" >&2; exit 1; }
    [ -x "$source_snapshot_fixture_one/tool.sh" ] || \
        { echo "ERROR: source snapshot lost a tracked executable mode" >&2; exit 1; }
    [ -L "$source_snapshot_fixture_one/untracked-link" ] && \
        [ "$(readlink "$source_snapshot_fixture_one/untracked-link")" = tracked.txt ] || \
        { echo "ERROR: source snapshot did not preserve an untracked symlink" >&2; exit 1; }

    printf '%s\n' changed-after-snapshot >"$source_snapshot_fixture_repo/tracked.txt"
    [ "$(cat "$source_snapshot_fixture_one/tracked.txt")" = working-tree ] || \
        { echo "ERROR: private source snapshot followed a later worktree mutation" >&2; exit 1; }
    source_snapshot_fixture_two_id=$(
        _guest_tools_create_source_snapshot \
            "$source_snapshot_fixture_repo" "$source_snapshot_fixture_two"
    )
    [ "$source_snapshot_fixture_two_id" != "$source_snapshot_fixture_one_id" ] || \
        { echo "ERROR: source snapshot identity ignored dirty content changes" >&2; exit 1; }
    _guest_tools_remove_private_tree "$source_snapshot_fixture_one"
    _guest_tools_remove_private_tree "$source_snapshot_fixture_two"

    source_snapshot_backup="$tmp_dir/source-snapshot-backup"
    source_snapshot_live_notice="$TEST_PROJECT_ROOT/src/deps/e2fsprogs-sys/vendor/e2fsprogs/NOTICE"
    source_snapshot_notice_backup="$tmp_dir/source-snapshot-NOTICE"
    source_snapshot_log="$tmp_dir/source-snapshot.log"
    mkdir -p "$source_snapshot_backup"
    cp -a "$tools_dir" "$source_snapshot_backup/guest-tools"
    cp -p "$source_snapshot_live_notice" "$source_snapshot_notice_backup"
    cache_backup="$source_snapshot_backup"
    cache_restore_pending=true
    source_snapshot_expected_notice_sha=$(sha256_file "$source_snapshot_notice_backup")
    source_snapshot_expected_signature=$(sed -n \
        's/.*"cache_signature": "\([[:xdigit:]]*\)".*/\1/p' \
        "$tools_dir/build-metadata.json")
    printf '%s\n' 'force a source snapshot rebuild' >>"$tools_dir/NOTICE"

    install() {
        local -a install_args=("$@")
        local destination_index=$(($# - 1))
        local destination_path="${install_args[$destination_index]}"
        local install_status=0
        if [ "$destination_path" = "${destination_path%/NOTICE}/NOTICE" ]; then
            printf '%s\n' TRANSIENT_SOURCE_POISON >"$source_snapshot_live_notice"
            command install "$@" || install_status=$?
            command cp -p "$source_snapshot_notice_backup" "$source_snapshot_live_notice" || \
                return 1
            return "$install_status"
        fi
        command install "$@"
    }
    source_snapshot_status=0
    ensure_guest_e2fsprogs_for_target "$test_target" "$profile" \
        >"$source_snapshot_log" 2>&1 || source_snapshot_status=$?
    unset -f install
    command cp -p "$source_snapshot_notice_backup" "$source_snapshot_live_notice"

    source_snapshot_actual_notice_sha=$(sha256_file "$tools_dir/NOTICE")
    source_snapshot_live_notice_sha=$(sha256_file "$source_snapshot_live_notice")
    source_snapshot_actual_signature=$(sed -n \
        's/.*"cache_signature": "\([[:xdigit:]]*\)".*/\1/p' \
        "$tools_dir/build-metadata.json")
    restore_cache_state
    if [ "$source_snapshot_status" -ne 0 ]; then
        echo "ERROR: source snapshot rebuild failed" >&2
        sed 's/^/  /' "$source_snapshot_log" >&2
        exit 1
    fi
    if [ "$source_snapshot_live_notice_sha" != "$source_snapshot_expected_notice_sha" ]; then
        echo "ERROR: source mutation fixture did not restore the vendored NOTICE" >&2
        exit 1
    fi
    if [ "$source_snapshot_actual_notice_sha" != "$source_snapshot_expected_notice_sha" ]; then
        echo "ERROR: transient live source bytes were published under a stable cache signature" >&2
        exit 1
    fi
    if [ "$source_snapshot_actual_signature" != "$source_snapshot_expected_signature" ]; then
        echo "ERROR: mutate-restore fixture unexpectedly changed the source cache signature" >&2
        exit 1
    fi
    echo "✓ guest-tools build fingerprints and consumes one immutable source snapshot"
fi
if ! _guest_tools_verify_tree_shape "$tools_dir"; then
    echo "ERROR: public guest-tools directory violates the exact seven-file contract" >&2
    exit 1
fi

# The publication holder must not announce success until every resource needed
# to retain the lock is ready. Remove the release FIFO inside the real holder
# process, after the parent has opened it but before the holder can open it, and
# prove the production installer never mutates output after that setup failure.
if [ "$contract_case" = "all" ] || [ "$contract_case" = "holder-ready" ]; then
    failed_holder_output="$tmp_dir/failed-holder-output"
    failed_holder_staging="$tmp_dir/failed-holder-staging"
    failed_holder_channels="$tmp_dir/failed-holder-channels"
    mkdir -p "$failed_holder_channels"
    cp -a "$tools_dir" "$failed_holder_staging"
    failed_holder_signature=$(sed -n \
        's/.*"cache_signature": "\([[:xdigit:]]*\)".*/\1/p' \
        "$tools_dir/build-metadata.json")
    if [ -z "$failed_holder_signature" ]; then
        echo "ERROR: could not read cache signature for holder readiness fixture" >&2
        exit 1
    fi

    perl() {
        if [ "$#" -ge 6 ] && \
           { [ "$4" = "$failed_holder_channels/publish.lock" ] || \
             [ "$5" = "$failed_holder_channels/publish-lock-release.fifo" ]; }; then
            rm -f "$5"
        fi
        command perl "$@"
    }
    publish_lock_pid=""
    publish_lock_channels_open=false
    publish_lock_ready_fifo=""
    publish_lock_release_fifo=""
    publish_lock_release_fd=""
    failed_holder_status=0
    _guest_tools_install_staging \
        "$test_target" "$profile" "$failed_holder_signature" \
        "$failed_holder_staging" "$failed_holder_output" \
        "$failed_holder_channels/publish.lock" "$failed_holder_channels" || \
        failed_holder_status=$?
    unset -f perl

    if [ "$failed_holder_status" -eq 0 ]; then
        echo "ERROR: publication accepted a holder that could not retain its lock" >&2
        exit 1
    fi
    if [ -e "$failed_holder_output/SHA256SUMS" ]; then
        echo "ERROR: publication mutated output after the lock holder failed setup" >&2
        exit 1
    fi
    echo "✓ failed lock-holder setup cannot publish guest tools"
fi

# Killing the auxiliary holder during one of the seven renames must not release
# the lock while the Bash publisher is still in its critical section. The
# publisher and holder therefore share one locked open-file description.
if [ "$contract_case" = "all" ] || [ "$contract_case" = "holder-lifetime" ]; then
    lifetime_output="$tmp_dir/lifetime-output"
    lifetime_staging="$tmp_dir/lifetime-staging"
    lifetime_channels_a="$tmp_dir/lifetime-channels-a"
    lifetime_channels_b="$tmp_dir/lifetime-channels-b"
    lifetime_event="$tmp_dir/lifetime-competitor-event.fifo"
    lifetime_release="$tmp_dir/lifetime-competitor-release.fifo"
    mkdir -p "$lifetime_channels_a" "$lifetime_channels_b"
    mkfifo "$lifetime_event" "$lifetime_release"
    cp -a "$tools_dir" "$lifetime_staging"
    lifetime_signature=$(sed -n \
        's/.*"cache_signature": "\([[:xdigit:]]*\)".*/\1/p' \
        "$lifetime_staging/build-metadata.json")
    [ -n "$lifetime_signature" ] || exit 1
    lifetime_competitor_started=false
    lifetime_competitor_entered_early=false
    publish_lock_pid=""
    publish_lock_channels_open=false
    publish_lock_release_fd=""
    publish_lock_fd=""
    publish_lock_fd_open=false

    start_lifetime_competitor() {
        lifetime_inherited_lock_fd="$publish_lock_fd"
        lifetime_inherited_release_fd="$publish_lock_release_fd"
        set -m
        (
            set +m
            if [ -n "$lifetime_inherited_lock_fd" ]; then
                eval "exec ${lifetime_inherited_lock_fd}>&-"
            fi
            if [ -n "$lifetime_inherited_release_fd" ]; then
                eval "exec ${lifetime_inherited_release_fd}>&-"
            fi
            publish_lock_pid=""
            publish_lock_channels_open=false
            publish_lock_fd_open=false
            _guest_tools_acquire_publish_lock \
                "$lifetime_channels_a/publish.lock" "$lifetime_channels_b"
            printf 'acquired\n' >&8
            IFS= read -r -t "$sync_timeout_seconds" lifetime_release_event <&9
            [ "$lifetime_release_event" = release ] || exit 1
            _guest_tools_release_publish_lock
            printf 'released\n' >&8
        ) 9<"$lifetime_release" 8>"$lifetime_event" &
        lock_competitor_pid=$!
        lock_competitor_pgid=$lock_competitor_pid
        set +m
        exec 9>"$lifetime_release"
        exec 8<"$lifetime_event"
        lifetime_competitor_started=true
    }

    eval "$(declare -f mv | sed '1s/mv/mv_before_holder_lifetime_test/')" 2>/dev/null || true
    mv() {
        command mv "$@" || return 1
        if [ "$lifetime_competitor_started" != true ]; then
            kill -KILL "$publish_lock_pid" 2>/dev/null || true
            wait "$publish_lock_pid" 2>/dev/null || true
            start_lifetime_competitor
            if IFS= read -r -t 1 lifetime_early_event <&8; then
                lifetime_competitor_entered_early=true
                printf 'release\n' >&9
                read_sync_event 8 lifetime_release_event "early competitor release"
                [ "$lifetime_release_event" = released ] || return 1
                wait "$lock_competitor_pid" 2>/dev/null || true
                lock_competitor_pid=""
                lock_competitor_pgid=""
            fi
        fi
    }

    lifetime_status=0
    _guest_tools_install_staging \
        "$test_target" "$profile" "$lifetime_signature" \
        "$lifetime_staging" "$lifetime_output" \
        "$lifetime_channels_a/publish.lock" "$lifetime_channels_a" || \
        lifetime_status=$?
    unset -f mv

    if [ "$lifetime_competitor_entered_early" = true ]; then
        echo "ERROR: competing publisher acquired while the first publisher was still renaming" >&2
        exit 1
    fi
    if [ "$lifetime_competitor_started" != true ] || \
       ! read_sync_event 8 lifetime_late_event "competitor after publisher release" || \
       [ "$lifetime_late_event" != acquired ]; then
        echo "ERROR: competing publisher did not acquire after the first publisher released" >&2
        exit 1
    fi
    printf 'release\n' >&9
    read_sync_event 8 lifetime_release_event "competitor release"
    [ "$lifetime_release_event" = released ] || exit 1
    competitor_status=0
    wait "$lock_competitor_pid" || competitor_status=$?
    lock_competitor_pid=""
    lock_competitor_pgid=""
    exec 8<&-
    exec 9>&-
    if [ "$lifetime_status" -eq 0 ] || [ "$competitor_status" -ne 0 ]; then
        echo "ERROR: holder-death fixture returned unexpected statuses ($lifetime_status, $competitor_status)" >&2
        exit 1
    fi
    _guest_tools_verify_output \
        "$test_target" "$profile" "$lifetime_signature" "$lifetime_output"
    echo "✓ publication lock survives auxiliary-holder death until publisher release"
fi

# e2fsprogs compiles and executes host generators during a cross build. Changing
# that compiler without changing its path must invalidate the verified-output
# cache, and the selected compiler plus flags must be recorded in metadata.
if [ "$contract_case" = "all" ] || [ "$contract_case" = "host-cc-cache" ]; then
    host_cc_backup="$tmp_dir/host-cc-backup"
    host_cc_wrapper="$tmp_dir/host-cc"
    host_cc_version_file="$tmp_dir/host-cc.version"
    host_cc_invocations="$tmp_dir/host-cc.invocations"
    real_host_cc=$(command -v "${BUILD_CC:-cc}")
    mkdir -p "$host_cc_backup"
    cp -a "$tools_dir" "$host_cc_backup/guest-tools"
    cache_backup="$host_cc_backup"
    cache_restore_pending=true

    printf '%s\n' 'fixture-host-cc version A' > "$host_cc_version_file"
    printf '%s\n' \
        '#!/bin/sh' \
        'if [ "${1:-}" = "--version" ]; then' \
        '    sed -n "1p" "$BOXLITE_HOST_CC_VERSION_FILE"' \
        '    exit 0' \
        'fi' \
        'printf "compile\\n" >> "$BOXLITE_HOST_CC_INVOCATIONS"' \
        'exec "$BOXLITE_REAL_HOST_CC" "$@"' > "$host_cc_wrapper"
    chmod 0755 "$host_cc_wrapper"

    BOXLITE_HOST_CC_VERSION_FILE="$host_cc_version_file" \
    BOXLITE_HOST_CC_INVOCATIONS="$host_cc_invocations" \
    BOXLITE_REAL_HOST_CC="$real_host_cc" \
    BUILD_CC="$host_cc_wrapper" \
    BUILD_CFLAGS="-DBOXLITE_HOST_CC_FIXTURE=1" \
    BUILD_LDFLAGS="" \
        ensure_guest_e2fsprogs_for_target "$test_target" "$profile" \
        >"$tmp_dir/host-cc-a.log" 2>&1
    invocations_after_a=$(wc -l < "$host_cc_invocations" | tr -d '[:space:]')
    if [ "$invocations_after_a" -le 0 ]; then
        echo "ERROR: selected BUILD_CC was not used for host generators" >&2
        exit 1
    fi

    printf '%s\n' 'fixture-host-cc version B' > "$host_cc_version_file"
    BOXLITE_HOST_CC_VERSION_FILE="$host_cc_version_file" \
    BOXLITE_HOST_CC_INVOCATIONS="$host_cc_invocations" \
    BOXLITE_REAL_HOST_CC="$real_host_cc" \
    BUILD_CC="$host_cc_wrapper" \
    BUILD_CFLAGS="-DBOXLITE_HOST_CC_FIXTURE=1" \
    BUILD_LDFLAGS="" \
        ensure_guest_e2fsprogs_for_target "$test_target" "$profile" \
        >"$tmp_dir/host-cc-b.log" 2>&1
    invocations_after_b=$(wc -l < "$host_cc_invocations" | tr -d '[:space:]')

    if [ "$invocations_after_b" -le "$invocations_after_a" ]; then
        echo "ERROR: BUILD_CC version change did not invalidate guest-tools cache" >&2
        exit 1
    fi
    grep -Fq '"build_compiler_version": "fixture-host-cc version B"' \
        "$tools_dir/build-metadata.json"
    grep -Fq '"build_cflags": "-DBOXLITE_HOST_CC_FIXTURE=1"' \
        "$tools_dir/build-metadata.json"
    restore_cache_state
    echo "✓ host generator compiler and flags participate in the cache contract"
fi

# The public guest-tools directory is a closed qualification artifact: it must
# contain exactly seven regular files with fixed modes. A checksum-equivalent
# symlink, a mode-only mutation, or an unverified extra must all force recovery.
if [ "$contract_case" = "all" ] || [ "$contract_case" = "artifact-contract" ]; then
    artifact_backup="$tmp_dir/artifact-backup"
    artifact_external_mke2fs="$tmp_dir/external-mke2fs"
    mkdir -p "$artifact_backup"
    cp -a "$tools_dir" "$artifact_backup/guest-tools"
    cache_backup="$artifact_backup"
    cache_restore_pending=true

    mv "$tools_dir/mke2fs" "$artifact_external_mke2fs"
    external_mke2fs_sha=$(sha256_file "$artifact_external_mke2fs")
    ln -s "$artifact_external_mke2fs" "$tools_dir/mke2fs"
    chmod 0777 "$tools_dir/resize2fs"
    printf '%s\n' 'not part of the verified contract' > "$tools_dir/unverified-secret"

    ensure_guest_e2fsprogs_for_target "$test_target" "$profile" \
        >"$tmp_dir/artifact-contract.log" 2>&1
    if [ -L "$tools_dir/mke2fs" ] || [ ! -f "$tools_dir/mke2fs" ]; then
        echo "ERROR: checksum-equivalent symlink survived guest-tools recovery" >&2
        exit 1
    fi
    if [ -e "$tools_dir/unverified-secret" ]; then
        echo "ERROR: unverified extra survived guest-tools recovery" >&2
        exit 1
    fi
    if [ "$(_guest_tools_file_mode "$tools_dir/mke2fs")" != 755 ] || \
       [ "$(_guest_tools_file_mode "$tools_dir/resize2fs")" != 755 ]; then
        echo "ERROR: guest-tools recovery did not restore executable modes" >&2
        exit 1
    fi
    if [ "$(sha256_file "$artifact_external_mke2fs")" != "$external_mke2fs_sha" ]; then
        echo "ERROR: guest-tools recovery mutated the symlink target" >&2
        exit 1
    fi
    _guest_tools_verify_output \
        "$test_target" "$profile" \
        "$(sed -n 's/.*"cache_signature": "\([[:xdigit:]]*\)".*/\1/p' \
            "$tools_dir/build-metadata.json")" \
        "$tools_dir"
    restore_cache_state
    echo "✓ guest-tools recovery enforces exact files, types, and modes"
fi

# Publishing must not remove the last verified output directory before the
# replacement is ready. Pause the production installer after its first rename
# and inspect the reader-visible path at that exact point.
if [ "$contract_case" = "all" ] || [ "$contract_case" = "publication" ]; then
    incomplete_output="$tmp_dir/incomplete-output"
    incomplete_staging="$tmp_dir/incomplete-staging"
    mkdir -p "$incomplete_output" "$incomplete_staging"
    for publish_name in \
        mke2fs resize2fs NOTICE source-metadata.json build-metadata.json \
        guest-tools-manifest.json; do
        printf 'old %s\n' "$publish_name" > "$incomplete_output/$publish_name"
        if [ "$publish_name" != "guest-tools-manifest.json" ]; then
            printf 'new %s\n' "$publish_name" > "$incomplete_staging/$publish_name"
        fi
    done
    printf 'old checksums\n' > "$incomplete_output/SHA256SUMS"
    printf 'new checksums\n' > "$incomplete_staging/SHA256SUMS"
    if _guest_tools_replace_staging_files "$incomplete_staging" "$incomplete_output"; then
        echo "ERROR: guest-tools publisher accepted incomplete staging" >&2
        exit 1
    fi
    for publish_name in \
        mke2fs resize2fs NOTICE source-metadata.json build-metadata.json \
        guest-tools-manifest.json SHA256SUMS; do
        if ! grep -Fq "old" "$incomplete_output/$publish_name"; then
            echo "ERROR: guest-tools publisher modified output before validating staging" >&2
            exit 1
        fi
    done
    echo "✓ guest-tools publication validates complete staging before mutation"

    publish_output="$tmp_dir/publish-output"
    publish_staging="$tmp_dir/publish-staging"
    mkdir -p "$publish_output" "$publish_staging"
    for publish_name in \
        mke2fs resize2fs NOTICE source-metadata.json build-metadata.json \
        guest-tools-manifest.json; do
        printf 'old %s\n' "$publish_name" > "$publish_output/$publish_name"
        printf 'new %s\n' "$publish_name" > "$publish_staging/$publish_name"
    done
    printf 'old checksums\n' > "$publish_output/SHA256SUMS"
    printf 'new checksums\n' > "$publish_staging/SHA256SUMS"
    chmod 0755 "$publish_output/mke2fs" "$publish_output/resize2fs"
    chmod 0755 "$publish_staging/mke2fs" "$publish_staging/resize2fs"
    chmod 0644 "$publish_output"/* "$publish_staging"/*
    chmod 0755 "$publish_output/mke2fs" "$publish_output/resize2fs"
    chmod 0755 "$publish_staging/mke2fs" "$publish_staging/resize2fs"

    publish_paused="$tmp_dir/publish-paused.fifo"
    publish_continue="$tmp_dir/publish-continue.fifo"
    mkfifo "$publish_paused" "$publish_continue"
    set -m
    (
        set +m
        rename_count=0
        mv() {
            command mv "$@"
            rename_count=$((rename_count + 1))
            if [ "$rename_count" -eq 1 ]; then
                printf 'paused\n' >&8
                if ! IFS= read -r -t "$sync_timeout_seconds" _publish_continue <&9; then
                    return 1
                fi
            fi
        }
        _guest_tools_replace_staging_files "$publish_staging" "$publish_output"
    ) 9<"$publish_continue" 8>"$publish_paused" &
    publish_pid=$!
    publish_pgid=$publish_pid
    set +m
    exec 9>"$publish_continue"
    exec 8<"$publish_paused"
    read_sync_event 8 publish_event "publication pause"
    publish_had_gap=false
    publish_kept_old_marker=false
    if [ "$publish_event" = "paused" ]; then
        if [ ! -d "$publish_output" ]; then
            publish_had_gap=true
        fi
        if grep -Fq 'old checksums' "$publish_output/SHA256SUMS"; then
            publish_kept_old_marker=true
        fi
        kill -KILL -- "-$publish_pgid" 2>/dev/null || true
    fi
    publish_status=0
    wait "$publish_pid" || publish_status=$?
    publish_pid=""
    publish_pgid=""
    exec 8>&-
    exec 9>&-
    if [ "$publish_event" != "paused" ] || [ "$publish_status" -eq 0 ]; then
        echo "ERROR: guest-tools publisher exited before the observation point" >&2
        exit 1
    fi
    if [ "$publish_had_gap" = true ]; then
        echo "ERROR: guest-tools output directory disappeared during publication" >&2
        exit 1
    fi
    if [ "$publish_kept_old_marker" != true ]; then
        echo "ERROR: interrupted publication replaced the commit marker early" >&2
        exit 1
    fi
    echo "✓ interrupted publication keeps the prior output and commit marker visible"
fi

# A structurally valid intermediate object is still mutable state. Corrupt one
# loadable byte, invalidate the verified output cache, and require the helper to
# rebuild from source instead of blessing the corrupted intermediate with a new
# SHA256SUMS file.
if [ "$contract_case" = "all" ] || [ "$contract_case" = "cache-integrity" ]; then
legacy_build_dir="$TEST_PROJECT_ROOT/target/native/e2fsprogs-guest/$test_target/$profile"
legacy_mke2fs="$legacy_build_dir/misc/mke2fs.static"
cache_backup="$tmp_dir/cache-backup"
mkdir -p "$cache_backup"
cp -a "$tools_dir" "$cache_backup/guest-tools"
if [ -f "$legacy_mke2fs" ] && \
   [ "${BOXLITE_GUEST_TOOLS_TEST_FORCE_OUTPUT_CACHE:-0}" != "1" ]; then
    cp -p "$legacy_mke2fs" "$cache_backup/mke2fs.static"
    cache_mutation_target="$legacy_mke2fs"
    printf 'invalidate verified output cache\n' >> "$tools_dir/NOTICE"
else
    cache_mutation_target="$tools_dir/mke2fs"
fi

cache_restore_pending=true
mutation_offset=4224
original_byte=$(od -An -t u1 -N 1 -j "$mutation_offset" "$cache_mutation_target" | tr -d '[:space:]')
mutated_byte=$((original_byte ^ 1))
printf "\\$(printf '%03o' "$mutated_byte")" | \
    dd of="$cache_mutation_target" bs=1 seek="$mutation_offset" conv=notrunc 2>/dev/null
verify_guest_elf "$test_target" "$cache_mutation_target"
mutated_cache_sha=$(sha256_file "$cache_mutation_target")

cache_build_log="$tmp_dir/cache-integrity.log"
cache_event="$tmp_dir/cache-integrity-event.fifo"
mkfifo "$cache_event"
set -m
(
    set +m
    cache_worker_status=0
    ensure_guest_e2fsprogs_for_target "$test_target" "$profile" || \
        cache_worker_status=$?
    printf 'worker-done:%s\n' "$cache_worker_status" >&8
    exit "$cache_worker_status"
) 8>"$cache_event" >"$cache_build_log" 2>&1 &
cache_pid=$!
cache_pgid=$cache_pid
set +m
exec 8<"$cache_event"
read_sync_event 8 cache_event_value "cache-integrity rebuild completion"
exec 8<&-
case "$cache_event_value" in
    worker-done:*) ;;
    *)
        echo "ERROR: cache-integrity worker emitted unexpected completion event" >&2
        exit 1
        ;;
esac
cache_build_status=0
wait "$cache_pid" || cache_build_status=$?
cache_pid=""
cache_pgid=""
expected_clean_sha=$(sha256_file "$cache_backup/guest-tools/mke2fs")
actual_rebuilt_sha=$(sha256_file "$tools_dir/mke2fs")
restore_cache_state

if [ "$cache_build_status" -ne 0 ]; then
    echo "ERROR: cache-integrity rebuild failed" >&2
    sed 's/^/  /' "$cache_build_log" >&2
    exit 1
fi
if [ "$profile" = "release" ] && [ "$actual_rebuilt_sha" != "$expected_clean_sha" ]; then
    echo "ERROR: mutable cache corruption was re-signed into guest-tools output" >&2
    echo "Expected clean mke2fs: $expected_clean_sha" >&2
    echo "Published mke2fs:      $actual_rebuilt_sha" >&2
    exit 1
fi
if [ "$profile" = "debug" ] && [ "$actual_rebuilt_sha" = "$mutated_cache_sha" ]; then
    echo "ERROR: mutable debug cache corruption was re-signed into guest-tools output" >&2
    exit 1
fi
echo "✓ output cache miss rebuilds from source, not mutable intermediates"
fi

# Two independent entry points (`make guest` and `make guest-tools`) can invoke
# the helper simultaneously. Every worker gets an EOF-visible event channel and
# a separate command channel. Background workers own process groups so cleanup
# can terminate nested ensure/make/lock-holder descendants before restoring the
# real cache and public output.
if [ "$contract_case" = "all" ] || [ "$contract_case" = "concurrency" ] || \
   [ "$contract_case" = "worker-crash" ]; then
concurrency_build_root="$TEST_PROJECT_ROOT/target/native/e2fsprogs-guest/$test_target/$profile"
concurrency_output_dir="$tools_dir"
concurrency_backup="$tmp_dir/concurrency-backup"
concurrency_dir_log="$tmp_dir/concurrency-build-dirs.log"
concurrency_staged_sha_log="$tmp_dir/concurrency-staged-shas.log"
concurrency_publish_log="$tmp_dir/concurrency-publish.log"
concurrency_arch=$(target_to_arch "$test_target")
concurrency_linux_headers=$(
    _guest_tools_linux_headers "$TEST_PROJECT_ROOT" "$concurrency_arch"
)
concurrency_linux_headers_content_id=$(
    _guest_tools_linux_headers_content_id \
        "$TEST_PROJECT_ROOT" "$concurrency_linux_headers"
)
concurrency_force_interleave=false
concurrency_crash_worker="${BOXLITE_GUEST_TOOLS_TEST_KILL_WORKER_BEFORE_READY:-}"
if [ "$contract_case" = worker-crash ] && [ -z "$concurrency_crash_worker" ]; then
    concurrency_crash_worker=a
fi
if ! declare -F _guest_tools_acquire_publish_lock >/dev/null 2>&1 || \
   [ "${BOXLITE_GUEST_TOOLS_TEST_DISABLE_PUBLISH_LOCK:-0}" = "1" ]; then
    concurrency_force_interleave=true
fi
mkdir -p "$concurrency_backup"
if [ -d "$concurrency_build_root" ]; then
    cp -a "$concurrency_build_root" "$concurrency_backup/build-root"
fi
if [ -d "$concurrency_output_dir" ]; then
    cp -a "$concurrency_output_dir" "$concurrency_backup/guest-tools"
fi
concurrency_restore_pending=true
rm -rf "$concurrency_build_root" "$concurrency_output_dir"

concurrency_event_a="$tmp_dir/concurrency-event-a.fifo"
concurrency_command_a="$tmp_dir/concurrency-command-a.fifo"
concurrency_event_b="$tmp_dir/concurrency-event-b.fifo"
concurrency_command_b="$tmp_dir/concurrency-command-b.fifo"
mkfifo \
    "$concurrency_event_a" "$concurrency_command_a" \
    "$concurrency_event_b" "$concurrency_command_b"

run_concurrent_build() (
    set +m
    concurrency_worker="$1"
    concurrency_rename_count=0
    concurrency_make_ready=false

    _guest_tools_linux_headers() {
        printf '%s\n' "$concurrency_linux_headers"
    }
    _guest_tools_linux_headers_content_id() {
        printf '%s\n' "$concurrency_linux_headers_content_id"
    }
    _guest_tools_snapshot_linux_headers() {
        local destination_root="$3"
        mkdir -p "$destination_root" || return 1
        cp -R "$concurrency_linux_headers/." "$destination_root/" || return 1
        printf '%s\n' "$concurrency_linux_headers_content_id"
    }

    send_worker_event() {
        printf '%s\n' "$1" >&3
    }
    read_worker_command() {
        local expected_command="$1"
        local actual_command=""
        if ! IFS= read -r -t "$sync_timeout_seconds" actual_command <&4; then
            echo "ERROR: worker $concurrency_worker timed out or reached EOF waiting for $expected_command" >&2
            return 1
        fi
        if [ "$actual_command" != "$expected_command" ]; then
            echo "ERROR: worker $concurrency_worker expected $expected_command, got $actual_command" >&2
            return 1
        fi
    }

    make() {
        if [ "$concurrency_make_ready" != true ]; then
            send_worker_event make-ready || return 1
            concurrency_make_ready=true
            read_worker_command start-build || return 1
        fi
        printf '%s\n' "$PWD" >> "$concurrency_dir_log"
        command make "$@"
    }

    eval "$(declare -f verify_guest_elf | \
        sed '1s/verify_guest_elf/verify_guest_elf_real/')"
    verify_guest_elf() {
        if [ -n "${staging_dir:-}" ] && \
           [ "$2" = "$staging_dir/mke2fs" ] && \
           [ ! -f "$tmp_dir/concurrency-mutated.$concurrency_worker" ]; then
            local mutation_offset=4224
            local original_byte mutated_byte mutation_mask
            original_byte=$(od -An -t u1 -N 1 -j "$mutation_offset" "$2" | tr -d '[:space:]') || return 1
            if [ "$concurrency_worker" = a ]; then
                mutation_mask=1
            else
                mutation_mask=2
            fi
            mutated_byte=$((original_byte ^ mutation_mask))
            printf "\\$(printf '%03o' "$mutated_byte")" | \
                dd of="$2" bs=1 seek="$mutation_offset" conv=notrunc 2>/dev/null
            : > "$tmp_dir/concurrency-mutated.$concurrency_worker"
        fi
        verify_guest_elf_real "$@"
    }

    eval "$(declare -f _guest_tools_install_staging | \
        sed '1s/_guest_tools_install_staging/_guest_tools_install_staging_real/')"
    _guest_tools_install_staging() {
        local worker_staging_dir staged_sha
        worker_staging_dir="$4"
        staged_sha=$(sha256_file "$worker_staging_dir/mke2fs") || return 1
        printf '%s %s\n' "$concurrency_worker" "$staged_sha" >> "$concurrency_staged_sha_log"
        send_worker_event publish-ready || return 1
        read_worker_command start-publish || return 1
        _guest_tools_install_staging_real "$@"
    }

    if [ "${BOXLITE_GUEST_TOOLS_TEST_DISABLE_PUBLISH_LOCK:-0}" = "1" ] && \
       declare -F _guest_tools_acquire_publish_lock >/dev/null 2>&1; then
        _guest_tools_acquire_publish_lock() { return 0; }
    fi

    mv() {
        local is_publication_rename=false
        if [ "$#" -eq 3 ] && [ "$1" = -f ] && \
           [[ "$2" = "$staging_dir/"* ]] && \
           [[ "$3" = "$concurrency_output_dir/"* ]]; then
            is_publication_rename=true
            printf '%s %s\n' "$concurrency_worker" "$(basename "$2")" \
                >> "$concurrency_publish_log"
            if [ "$concurrency_force_interleave" = true ]; then
                concurrency_rename_count=$((concurrency_rename_count + 1))
                send_worker_event "rename-ready:$concurrency_rename_count" || return 1
                read_worker_command "rename:$concurrency_rename_count" || return 1
            fi
        fi
        command mv "$@" || return 1
        if [ "$is_publication_rename" = true ] && \
           [ "$concurrency_force_interleave" = true ]; then
            send_worker_event "rename-done:$concurrency_rename_count" || return 1
        fi
    }

    concurrency_worker_status=0
    if [ "$concurrency_crash_worker" = "$concurrency_worker" ]; then
        nested_gate="$tmp_dir/concurrency-nested-$concurrency_worker.fifo"
        mkfifo "$nested_gate"
        (
            set +m
            if ! IFS= read -r -t "$sync_timeout_seconds" nested_command; then
                exit 1
            fi
            [ "$nested_command" = start ] || exit 1
            send_worker_event ensure-started
            ensure_guest_e2fsprogs_for_target "$test_target" "$profile"
        ) < "$nested_gate" &
        nested_ensure_pid=$!
        exec 10>"$nested_gate"
        printf 'start\n' >&10
        exec 10>&-
        wait "$nested_ensure_pid" || concurrency_worker_status=$?
    else
        ensure_guest_e2fsprogs_for_target "$test_target" "$profile" || \
            concurrency_worker_status=$?
    fi
    send_worker_event "worker-done:$concurrency_worker_status"
    exit "$concurrency_worker_status"
)

set -m
run_concurrent_build a 4<"$concurrency_command_a" 3>"$concurrency_event_a" \
    >"$tmp_dir/concurrency-a.log" 2>&1 &
concurrency_pid_a=$!
concurrency_pgid_a=$concurrency_pid_a
run_concurrent_build b 4<"$concurrency_command_b" 3>"$concurrency_event_b" \
    >"$tmp_dir/concurrency-b.log" 2>&1 &
concurrency_pid_b=$!
concurrency_pgid_b=$concurrency_pid_b
set +m

exec 4>"$concurrency_command_a"
exec 3<"$concurrency_event_a"
exec 6>"$concurrency_command_b"
exec 5<"$concurrency_event_b"

crash_worker="$concurrency_crash_worker"
if [ -n "$crash_worker" ]; then
    case "$crash_worker" in
        a)
            read_sync_event 3 crash_event "worker A nested ensure start"
            [ "$crash_event" = ensure-started ] || {
                echo "ERROR: worker A emitted unexpected crash event: $crash_event" >&2
                exit 1
            }
            kill -KILL "$concurrency_pid_a" 2>/dev/null || true
            ;;
        b)
            read_sync_event 5 crash_event "worker B nested ensure start"
            [ "$crash_event" = ensure-started ] || {
                echo "ERROR: worker B emitted unexpected crash event: $crash_event" >&2
                exit 1
            }
            kill -KILL "$concurrency_pid_b" 2>/dev/null || true
            ;;
        *)
            echo "ERROR: crash worker must be a or b" >&2
            exit 2
            ;;
    esac
    terminate_job_tree "$concurrency_pid_a" "$concurrency_pgid_a"
    terminate_job_tree "$concurrency_pid_b" "$concurrency_pgid_b"
    concurrency_pid_a=""
    concurrency_pid_b=""
    concurrency_pgid_a=""
    concurrency_pgid_b=""
    exec 3<&-
    exec 4>&-
    exec 5<&-
    exec 6>&-
    restore_concurrency_state
    if [ -d "$concurrency_backup/guest-tools" ]; then
        diff -qr "$concurrency_backup/guest-tools" "$concurrency_output_dir" >/dev/null
    elif [ -e "$concurrency_output_dir" ]; then
        echo "ERROR: crash cleanup created output that did not exist before the test" >&2
        exit 1
    fi
    if [ -d "$concurrency_backup/build-root" ]; then
        diff -qr "$concurrency_backup/build-root" "$concurrency_build_root" >/dev/null
    elif [ -e "$concurrency_build_root" ]; then
        echo "ERROR: crash cleanup created cache that did not exist before the test" >&2
        exit 1
    fi
    echo "✓ worker crash cleanup terminates the full process group before restore"
else
    read_sync_event 3 concurrency_event_a "worker A build readiness"
    read_sync_event 5 concurrency_event_b "worker B build readiness"
    [ "$concurrency_event_a" = make-ready ] && [ "$concurrency_event_b" = make-ready ] || {
        echo "ERROR: concurrent workers did not reach build readiness" >&2
        exit 1
    }
    printf 'start-build\n' >&4
    printf 'start-build\n' >&6

    read_sync_event 3 concurrency_publish_event_a "worker A publication readiness"
    read_sync_event 5 concurrency_publish_event_b "worker B publication readiness"
    [ "$concurrency_publish_event_a" = publish-ready ] && \
        [ "$concurrency_publish_event_b" = publish-ready ] || {
        echo "ERROR: concurrent builds did not reach publication readiness ($concurrency_publish_event_a, $concurrency_publish_event_b)" >&2
        sed 's/^/  A: /' "$tmp_dir/concurrency-a.log" >&2
        sed 's/^/  B: /' "$tmp_dir/concurrency-b.log" >&2
        exit 1
    }
    printf 'start-publish\n' >&4
    printf 'start-publish\n' >&6

    if [ "$concurrency_force_interleave" = true ]; then
        concurrency_rename_pair=1
        while [ "$concurrency_rename_pair" -le 7 ]; do
            read_sync_event 3 rename_event_a "worker A rename $concurrency_rename_pair"
            read_sync_event 5 rename_event_b "worker B rename $concurrency_rename_pair"
            [ "$rename_event_a" = "rename-ready:$concurrency_rename_pair" ] && \
                [ "$rename_event_b" = "rename-ready:$concurrency_rename_pair" ] || {
                echo "ERROR: concurrent workers emitted unexpected rename readiness" >&2
                exit 1
            }
            if [ $((concurrency_rename_pair % 2)) -eq 1 ]; then
                first_command_fd=4
                first_event_fd=3
                second_command_fd=6
                second_event_fd=5
            else
                first_command_fd=6
                first_event_fd=5
                second_command_fd=4
                second_event_fd=3
            fi
            printf 'rename:%s\n' "$concurrency_rename_pair" >&"$first_command_fd"
            read_sync_event "$first_event_fd" rename_done "first rename $concurrency_rename_pair"
            [ "$rename_done" = "rename-done:$concurrency_rename_pair" ] || exit 1
            printf 'rename:%s\n' "$concurrency_rename_pair" >&"$second_command_fd"
            read_sync_event "$second_event_fd" rename_done "second rename $concurrency_rename_pair"
            [ "$rename_done" = "rename-done:$concurrency_rename_pair" ] || exit 1
            concurrency_rename_pair=$((concurrency_rename_pair + 1))
        done
    fi

    read_sync_event 3 concurrency_done_a "worker A completion"
    read_sync_event 5 concurrency_done_b "worker B completion"
    case "$concurrency_done_a:$concurrency_done_b" in
        worker-done:*:worker-done:*) ;;
        *)
            echo "ERROR: concurrent workers emitted unexpected completion events" >&2
            exit 1
            ;;
    esac

    concurrency_status_a=0
    concurrency_status_b=0
    wait "$concurrency_pid_a" || concurrency_status_a=$?
    wait "$concurrency_pid_b" || concurrency_status_b=$?
    concurrency_pid_a=""
    concurrency_pid_b=""
    concurrency_pgid_a=""
    concurrency_pgid_b=""
    exec 3<&-
    exec 4>&-
    exec 5<&-
    exec 6>&-

    distinct_build_dirs=$(sort -u "$concurrency_dir_log" | wc -l | tr -d '[:space:]')
    distinct_staged_shas=$(awk '{print $2}' "$concurrency_staged_sha_log" | sort -u | wc -l | tr -d '[:space:]')
    publication_rename_count=$(wc -l < "$concurrency_publish_log" | tr -d '[:space:]')
    publication_worker_count=$(awk '{print $1}' "$concurrency_publish_log" | sort -u | wc -l | tr -d '[:space:]')
    publication_names=$(awk 'BEGIN { separator = "" } { printf "%s%s", separator, $2; separator = " " }' \
        "$concurrency_publish_log")
    concurrent_recheck_count=$(awk '
        /concurrent guest e2fsprogs build already published/ { count++ }
        END { print count + 0 }
    ' "$tmp_dir/concurrency-a.log" "$tmp_dir/concurrency-b.log")
    restore_concurrency_state

    if [ "$distinct_staged_shas" -ne 2 ] || \
       [ "$publication_rename_count" -ne 7 ] || \
       [ "$publication_worker_count" -ne 1 ] || \
       [ "$concurrent_recheck_count" -ne 1 ] || \
       [ "$concurrency_status_a" -ne 0 ] || [ "$concurrency_status_b" -ne 0 ] || \
       [ "$distinct_build_dirs" -ne 2 ]; then
        echo "ERROR: concurrent guest-tools build violated isolation or serialization" >&2
        sed 's/^/  A: /' "$tmp_dir/concurrency-a.log" >&2
        sed 's/^/  B: /' "$tmp_dir/concurrency-b.log" >&2
        exit 1
    fi
    if [ "$publication_names" != \
         "mke2fs resize2fs NOTICE source-metadata.json build-metadata.json guest-tools-manifest.json SHA256SUMS" ]; then
        echo "ERROR: concurrent publication did not commit one complete generation in order" >&2
        cat "$concurrency_publish_log" >&2
        exit 1
    fi
    echo "✓ concurrent guest-tools builds isolate workspaces and serialize publication"
fi
fi

if [ "$contract_case" = worker-crash ]; then
    exit 0
fi

host_target=$(map_arch_to_target "$(detect_host_arch)")
if [ "$(uname -s)" != "Linux" ] || [ "$test_target" != "$host_target" ]; then
    echo "⏭️  Cross-built Linux tools passed structural validation; runtime smoke skipped"
    exit 0
fi

source_dir="$TEST_PROJECT_ROOT/src/deps/e2fsprogs-sys/vendor/e2fsprogs"
expected_version=$(awk -F'"' '/E2FSPROGS_VERS/ { print $2; exit }' "$source_dir/version.h")
mke2fs_version=$($mke2fs -V 2>&1 || true)
resize2fs_version=$($resize2fs -V 2>&1 || true)
printf '%s\n' "$mke2fs_version" | grep -Fq "$expected_version"
printf '%s\n' "$resize2fs_version" | grep -Fq "$expected_version"
echo "✓ tool versions match vendored e2fsprogs $expected_version"

image="$tmp_dir/ext4.img"
dd if=/dev/zero of="$image" bs=1 count=0 seek=$((32 * 1024 * 1024)) 2>/dev/null
MKE2FS_CONFIG="$source_dir/misc/mke2fs.conf.in" \
    "$mke2fs" -q -t ext4 -F "$image"

# ext superblock starts at byte 1024; s_blocks_count_lo is its second u32.
blocks_before=$(od -An -t u4 -N 4 -j 1028 "$image" | tr -d '[:space:]')
if [ -z "$blocks_before" ] || [ "$blocks_before" -le 0 ]; then
    echo "ERROR: mke2fs did not write a valid ext block count" >&2
    exit 1
fi

# mke2fs.static embeds the same default profile at build time.  A guest must
# therefore be able to create ext4 without packaging an mke2fs.conf alongside
# the binary.
embedded_profile_image="$tmp_dir/ext4-embedded-profile.img"
dd if=/dev/zero of="$embedded_profile_image" bs=1 count=0 seek=$((16 * 1024 * 1024)) 2>/dev/null
MKE2FS_CONFIG="$tmp_dir/does-not-exist.conf" \
    "$mke2fs" -q -t ext4 -F "$embedded_profile_image"
embedded_blocks=$(od -An -t u4 -N 4 -j 1028 "$embedded_profile_image" | tr -d '[:space:]')
if [ -z "$embedded_blocks" ] || [ "$embedded_blocks" -le 0 ]; then
    echo "ERROR: embedded mke2fs profile did not create a valid ext filesystem" >&2
    exit 1
fi
echo "✓ embedded mke2fs profile works without a runtime config file"

dd if=/dev/zero of="$image" bs=1 count=0 seek=$((64 * 1024 * 1024)) 2>/dev/null
"$resize2fs" -f "$image" >/dev/null
blocks_after=$(od -An -t u4 -N 4 -j 1028 "$image" | tr -d '[:space:]')
if [ -z "$blocks_after" ] || [ "$blocks_after" -le "$blocks_before" ]; then
    echo "ERROR: resize2fs did not increase the ext block count ($blocks_before -> $blocks_after)" >&2
    exit 1
fi

echo "✓ ext4 create + offline resize smoke passed ($blocks_before -> $blocks_after blocks)"
