#!/bin/bash
# Exercise the native guest dependency cache through its public build helpers.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BUILD_SCRIPT="$PROJECT_ROOT/scripts/build/build-libseccomp.sh"
REAL_PATH="$PATH"

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

sha256_file() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    else
        shasum -a 256 "$1" | awk '{print $1}'
    fi
}

make_header_fixture() {
    local fixture_root="$1"
    local version="$2"
    local source_dir="$fixture_root/kernel-headers-$version"

    mkdir -p "$source_dir"
    printf '%s\n' 'fixture source' >"$source_dir/README"
    printf '%s\n' 'all:' >"$source_dir/Makefile"
    printf '%s\n' '	@:' >>"$source_dir/Makefile"
    printf '%s\n' 'install:' >>"$source_dir/Makefile"
    printf '%s\n' '	@mkdir -p "$(prefix)/include/asm" "$(prefix)/include/linux"' >>"$source_dir/Makefile"
    printf '%s\n' '	@printf "%s\\n" HEADER_GOOD >"$(prefix)/include/asm/unistd.h"' >>"$source_dir/Makefile"
    printf '%s\n' '	@printf "%s\\n" HEADER_GOOD >"$(prefix)/include/linux/audit.h"' >>"$source_dir/Makefile"
    printf '%s\n' '	@printf "%s\\n" EXTRA_GOOD >"$(prefix)/include/linux/extra.h"' >>"$source_dir/Makefile"
    printf '%s\n' '	@ln -s audit.h "$(prefix)/include/linux/audit-link.h"' >>"$source_dir/Makefile"
    tar -czf "$fixture_root/kernel-headers.tar.gz" -C "$fixture_root" "kernel-headers-$version"
}

make_libseccomp_fixture() {
    local fixture_root="$1"
    local version="$2"
    local source_dir="$fixture_root/libseccomp-$version"

    mkdir -p "$source_dir"
    printf '%s\n' '#!/bin/sh' >"$source_dir/configure"
    printf '%s\n' 'set -eu' >>"$source_dir/configure"
    printf '%s\n' 'prefix=' >>"$source_dir/configure"
    printf '%s\n' 'for arg in "$@"; do' >>"$source_dir/configure"
    printf '%s\n' '    case "$arg" in --prefix=*) prefix=${arg#--prefix=} ;; esac' >>"$source_dir/configure"
    printf '%s\n' 'done' >>"$source_dir/configure"
    printf '%s\n' '[ -n "$prefix" ]' >>"$source_dir/configure"
    printf '%s\n' 'printf "%s\\n" "$prefix" > .fixture-prefix' >>"$source_dir/configure"
    chmod +x "$source_dir/configure"

    printf '%s\n' 'all:' >"$source_dir/Makefile"
    printf '%s\n' '	@:' >>"$source_dir/Makefile"
    printf '%s\n' 'install:' >>"$source_dir/Makefile"
    printf '%s\n' '	@prefix="$(DESTDIR)$$(cat .fixture-prefix)"; \' >>"$source_dir/Makefile"
    printf '%s\n' '	mkdir -p "$$prefix/include" "$$prefix/lib/pkgconfig"; \' >>"$source_dir/Makefile"
    printf '%s\n' '	printf "%s\\n" LIB_GOOD >"$$prefix/include/seccomp.h"; \' >>"$source_dir/Makefile"
    printf '%s\n' '	printf "%s\\n" LIB_GOOD >"$$prefix/include/seccomp-syscalls.h"; \' >>"$source_dir/Makefile"
    printf '%s\n' '	printf "%s\\n" prefix-fixture >"$$prefix/lib/pkgconfig/libseccomp.pc"; \' >>"$source_dir/Makefile"
    printf '%s\n' '	payload="$$(mktemp)"; printf "%s\\n" LIB_GOOD >"$$payload"; \' >>"$source_dir/Makefile"
    printf '%s\n' '	cp "$$payload" ./fixture-payload; ar rcs "$$prefix/lib/libseccomp.a" ./fixture-payload; \' >>"$source_dir/Makefile"
    printf '%s\n' '	rm -f "$$payload" ./fixture-payload' >>"$source_dir/Makefile"
    tar -czf "$fixture_root/libseccomp.tar.gz" -C "$fixture_root" "libseccomp-$version"
}

define_toolchain_stubs() {
    target_to_arch() { printf '%s\n' x86_64; }
    resolve_musl_cc() { command -v true; }
    resolve_musl_tool() {
        case "$2" in
            ar) command -v ar ;;
            ranlib) command -v ranlib ;;
            *) return 1 ;;
        esac
    }
}

provision_headers() {
    local cache_dir="$1"
    local fixture_tarball="$2"
    local version="$3"
    local fixture_sha="$4"

    BOXLITE_CACHE="$cache_dir" \
    LINUX_HEADERS_VERSION="$version" \
    LINUX_HEADERS_SHA256="$fixture_sha" \
    LINUX_HEADERS_SOURCE_TARBALL="$fixture_tarball" \
        bash -c 'source "$1"; ensure_linux_headers_for_arch x86_64 >/dev/null' _ "$BUILD_SCRIPT"
}

provision_libseccomp() {
    local cache_dir="$1"
    local headers_tarball="$2"
    local headers_version="$3"
    local headers_sha="$4"
    local lib_tarball="$5"
    local lib_version="$6"
    local lib_sha="$7"
    local test_path="${8:-$REAL_PATH}"

    PATH="$test_path" \
    BOXLITE_CACHE="$cache_dir" \
    LINUX_HEADERS_VERSION="$headers_version" \
    LINUX_HEADERS_SHA256="$headers_sha" \
    LINUX_HEADERS_SOURCE_TARBALL="$headers_tarball" \
    LIBSECCOMP_VERSION="$lib_version" \
    LIBSECCOMP_TARBALL_SHA256="$lib_sha" \
    LIBSECCOMP_SOURCE_TARBALL="$lib_tarball" \
        bash -c '
            source "$1"
            target_to_arch() { printf "%s\n" x86_64; }
            resolve_musl_cc() { command -v true; }
            resolve_musl_tool() {
                case "$2" in ar) command -v ar ;; ranlib) command -v ranlib ;; *) return 1 ;; esac
            }
            ensure_libseccomp_for_target x86_64-unknown-linux-musl
        ' _ "$BUILD_SCRIPT" >/dev/null
}

make_download_wrappers() {
    local wrapper_dir="$1"
    mkdir -p "$wrapper_dir"
    printf '%s\n' '#!/bin/sh' >"$wrapper_dir/curl"
    printf '%s\n' 'set -eu' >>"$wrapper_dir/curl"
    printf '%s\n' 'destination=' >>"$wrapper_dir/curl"
    printf '%s\n' 'while [ "$#" -gt 0 ]; do' >>"$wrapper_dir/curl"
    printf '%s\n' '    if [ "$1" = -o ]; then shift; destination=$1; fi' >>"$wrapper_dir/curl"
    printf '%s\n' '    shift' >>"$wrapper_dir/curl"
    printf '%s\n' 'done' >>"$wrapper_dir/curl"
    printf '%s\n' '[ -n "$destination" ]' >>"$wrapper_dir/curl"
    printf '%s\n' 'cp "$FIXTURE_TARBALL" "$destination"' >>"$wrapper_dir/curl"
    chmod +x "$wrapper_dir/curl"
}

prepare_headers_for_lib_test() {
    local cache_dir="$1"
    local fixture_tarball="$2"
    local version="$3"
    local fixture_sha="$4"

    BOXLITE_CACHE="$cache_dir" \
    LINUX_HEADERS_VERSION="$version" \
    LINUX_HEADERS_SHA256="$fixture_sha" \
    LINUX_HEADERS_SOURCE_TARBALL="$fixture_tarball" \
        bash -c '
            source "$1"
            if declare -F linux_headers_content_id_for_arch >/dev/null 2>&1; then
                ensure_linux_headers_for_arch x86_64 >/dev/null
            else
                cache_root="$BOXLITE_CACHE/linux-headers/$LINUX_HEADERS_VERSION/x86_64/include"
                mkdir -p "$cache_root/asm" "$cache_root/linux"
                printf "%s\n" HEADER_GOOD >"$cache_root/asm/unistd.h"
                printf "%s\n" HEADER_GOOD >"$cache_root/linux/audit.h"
            fi
        ' _ "$BUILD_SCRIPT"
}

publish_native_cache_fixture() {
    local cache_parent="$1"
    local cache_root="$2"
    local generation="$3"
    local staging_root

    mkdir -p "$cache_parent"
    staging_root=$(mktemp -d "$cache_parent/.staging-$generation.XXXXXX")
    mkdir -p "$staging_root/include/asm" "$staging_root/include/linux"
    printf '%s\n' \
        'schema=boxlite-native-cache-v1' \
        'kind=linux-headers' \
        "generation=$generation" >"$staging_root/CACHE-IDENTITY"
    printf 'fixture=%s\n' "$generation" >"$staging_root/CACHE-METADATA"
    printf '%s\n' "$generation" >"$staging_root/include/asm/unistd.h"
    printf '%s\n' "$generation" >"$staging_root/include/linux/audit.h"
    printf '%s\n' "$generation" >"$staging_root/include/linux/extra.h"

    bash -c '
        source "$1"
        _native_cache_seal_tree "$2"
        _native_cache_publish "$3" "$2" "$4"
    ' _ "$BUILD_SCRIPT" "$staging_root" "$cache_parent/.fixture.lock" "$cache_root"
}

case_generation_gc() {
    local work_dir
    work_dir=$(mktemp -d -t boxlite-native-cache-generation-gc-XXXXXX)
    trap 'rm -rf "$work_dir"' RETURN
    local cache_parent="$work_dir/cache/fixture"
    local cache_root="$cache_parent/current"

    publish_native_cache_fixture "$cache_parent" "$cache_root" A
    publish_native_cache_fixture "$cache_parent" "$cache_root" B
    ln -s '.generations/missing' "$cache_parent/.publish-orphan"
    mkdir -p "$cache_parent/.invalid-orphan"
    printf '%s\n' stale >"$cache_parent/.invalid-orphan/payload"
    publish_native_cache_fixture "$cache_parent" "$cache_root" C

    local generation_count
    generation_count=$(find "$cache_parent/.generations" -mindepth 1 -maxdepth 1 \
        -type d -name 'generation-*' | wc -l | tr -d '[:space:]')
    [ "$generation_count" -eq 1 ] || \
        fail "A/B/C replacement retained $generation_count native cache generations"
    [ "$(cat "$cache_root/include/linux/extra.h")" = C ] || \
        fail "native cache GC changed the current generation"
    [ ! -e "$cache_parent/.publish-orphan" ] && [ ! -L "$cache_parent/.publish-orphan" ] || \
        fail "native cache GC left an orphan publication link"
    [ ! -e "$cache_parent/.invalid-orphan" ] || \
        fail "native cache GC left an orphan quarantine"
    trap - RETURN
    rm -rf "$work_dir"
}

case_headers_reader_gc() {
    local work_dir
    work_dir=$(mktemp -d -t boxlite-native-cache-reader-gc-XXXXXX)
    local reader_pid=""
    cleanup_headers_reader_gc() {
        if [ -n "$reader_pid" ] && kill -0 "$reader_pid" 2>/dev/null; then
            kill "$reader_pid" 2>/dev/null || true
            wait "$reader_pid" 2>/dev/null || true
        fi
        rm -rf "$work_dir"
    }
    trap cleanup_headers_reader_gc RETURN

    local cache_parent="$work_dir/cache/fixture"
    local cache_root="$cache_parent/current"
    publish_native_cache_fixture "$cache_parent" "$cache_root" A
    local generation_a="$cache_parent/$(readlink "$cache_root")"
    local reader_snapshot="$work_dir/reader-snapshot"
    local reader_ready="$work_dir/reader-ready.fifo"
    local reader_release="$work_dir/reader-release.fifo"
    mkfifo "$reader_ready" "$reader_release"
    exec 8<>"$reader_ready"
    exec 9<>"$reader_release"

    bash -c '
        set -euo pipefail
        source "$1"
        declare -F snapshot_linux_headers_for_path >/dev/null
        eval "$(declare -f _native_cache_copy_tree | sed \
            "1s/_native_cache_copy_tree/_native_cache_copy_tree_real/")"
        _native_cache_copy_tree() {
            printf "%s\n" ready >&8
            IFS= read -r release_event <&9
            [ "$release_event" = release ]
            _native_cache_copy_tree_real "$@"
        }
        snapshot_linux_headers_for_path "$2/include" "$3" >/dev/null
    ' _ "$BUILD_SCRIPT" "$generation_a" "$reader_snapshot" \
        8>"$reader_ready" 9<"$reader_release" &
    reader_pid=$!

    local reader_event
    if ! IFS= read -r -t 10 -u 8 reader_event; then
        wait "$reader_pid" 2>/dev/null || true
        reader_pid=""
        fail "header snapshot reader did not acquire its generation lease"
    fi
    [ "$reader_event" = ready ] || fail "unexpected header reader event: $reader_event"

    publish_native_cache_fixture "$cache_parent" "$cache_root" B
    publish_native_cache_fixture "$cache_parent" "$cache_root" C
    [ -d "$generation_a" ] || \
        fail "native cache GC deleted a generation leased by a header reader"
    local generation_count
    generation_count=$(find "$cache_parent/.generations" -mindepth 1 -maxdepth 1 \
        -type d -name 'generation-*' | wc -l | tr -d '[:space:]')
    [ "$generation_count" -eq 2 ] || \
        fail "native cache GC retained more than the current and leased generations"

    printf '%s\n' release >&9
    wait "$reader_pid" || fail "leased header snapshot reader failed"
    reader_pid=""
    [ "$(cat "$reader_snapshot/linux/extra.h")" = A ] || \
        fail "header reader snapshot mixed cache generations"

    publish_native_cache_fixture "$cache_parent" "$cache_root" D
    [ ! -e "$generation_a" ] || \
        fail "released header generation was not reclaimed"
    generation_count=$(find "$cache_parent/.generations" -mindepth 1 -maxdepth 1 \
        -type d -name 'generation-*' | wc -l | tr -d '[:space:]')
    [ "$generation_count" -eq 1 ] || \
        fail "released header generation left native cache GC unbounded"

    exec 8>&-
    exec 9>&-
    trap - RETURN
    cleanup_headers_reader_gc
}

case_headers_content_id_selection_lease() {
    local work_dir
    work_dir=$(mktemp -d -t boxlite-native-cache-headers-content-id-lease-XXXXXX)
    trap 'rm -rf "$work_dir"' RETURN

    local version="fixture-headers-content-id-lease"
    make_header_fixture "$work_dir" "$version"
    local fixture_tarball="$work_dir/kernel-headers.tar.gz"
    local fixture_sha
    fixture_sha=$(sha256_file "$fixture_tarball")
    local cache_dir="$work_dir/cache"
    provision_headers "$cache_dir" "$fixture_tarball" "$version" "$fixture_sha"

    local alternate_tools="$work_dir/alternate-tools"
    mkdir -p "$alternate_tools"
    ln -s "$(command -v make)" "$alternate_tools/make"
    local publisher_marker="$work_dir/publisher-ran"
    local content_id_file="$work_dir/content-id"

    set +e
    PATH="$REAL_PATH" \
    RACE_PUBLISHER_PATH="$alternate_tools:$REAL_PATH" \
    RACE_PUBLISHER_MARKER="$publisher_marker" \
    BOXLITE_CACHE="$cache_dir" \
    LINUX_HEADERS_VERSION="$version" \
    LINUX_HEADERS_SHA256="$fixture_sha" \
    LINUX_HEADERS_SOURCE_TARBALL="$fixture_tarball" \
        bash -c '
            set -euo pipefail
            build_script="$1"
            source "$build_script"
            declare -F linux_headers_content_id_for_arch >/dev/null
            eval "$(declare -f ensure_linux_headers_for_arch | sed \
                "1s/ensure_linux_headers_for_arch/ensure_linux_headers_for_arch_real/")"
            ensure_linux_headers_for_arch() {
                local selected_include
                selected_include=$(ensure_linux_headers_for_arch_real "$@") || return 1
                if [ ! -e "$RACE_PUBLISHER_MARKER" ]; then
                    PATH="$RACE_PUBLISHER_PATH" bash -c '\''
                        set -euo pipefail
                        source "$1"
                        ensure_linux_headers_for_arch x86_64 >/dev/null
                    '\'' _ "$build_script"
                    : >"$RACE_PUBLISHER_MARKER"
                fi
                printf "%s\n" "$selected_include"
            }
            linux_headers_content_id_for_arch x86_64
        ' _ "$BUILD_SCRIPT" >"$content_id_file" 2>"$work_dir/content-id.log"
    local status=$?
    set -e

    [ -e "$publisher_marker" ] || {
        cat "$work_dir/content-id.log" >&2
        fail "header content-id replacement publisher did not run"
    }
    if [ "$status" -ne 0 ]; then
        cat "$work_dir/content-id.log" >&2
        fail "header content-id consumer lost its selected generation: status=$status"
    fi
    grep -Eq '^[[:xdigit:]]{64}$' "$content_id_file" || \
        fail "header content-id consumer did not return a SHA-256 identity"

    trap - RETURN
    rm -rf "$work_dir"
}

case_libseccomp_headers_content_id_lease() {
    local work_dir
    work_dir=$(mktemp -d -t boxlite-native-cache-lib-headers-id-lease-XXXXXX)
    trap 'rm -rf "$work_dir"' RETURN

    local headers_version="fixture-headers-lib-id-lease"
    local lib_version="fixture-lib-headers-id-lease"
    make_header_fixture "$work_dir" "$headers_version"
    make_libseccomp_fixture "$work_dir" "$lib_version"
    local headers_sha lib_sha
    headers_sha=$(sha256_file "$work_dir/kernel-headers.tar.gz")
    lib_sha=$(sha256_file "$work_dir/libseccomp.tar.gz")
    local cache_dir="$work_dir/cache"
    provision_headers \
        "$cache_dir" "$work_dir/kernel-headers.tar.gz" "$headers_version" "$headers_sha"

    local alternate_tools="$work_dir/alternate-tools"
    mkdir -p "$alternate_tools"
    ln -s "$(command -v make)" "$alternate_tools/make"
    local publisher_marker="$work_dir/publisher-ran"
    local callback_marker="$work_dir/callback-ran"
    local target="x86_64-unknown-linux-musl"

    set +e
    PATH="$REAL_PATH" \
    RACE_PUBLISHER_PATH="$alternate_tools:$REAL_PATH" \
    RACE_PUBLISHER_MARKER="$publisher_marker" \
    BOXLITE_CACHE="$cache_dir" \
    LINUX_HEADERS_VERSION="$headers_version" \
    LINUX_HEADERS_SHA256="$headers_sha" \
    LINUX_HEADERS_SOURCE_TARBALL="$work_dir/kernel-headers.tar.gz" \
    LIBSECCOMP_VERSION="$lib_version" \
    LIBSECCOMP_TARBALL_SHA256="$lib_sha" \
    LIBSECCOMP_SOURCE_TARBALL="$work_dir/libseccomp.tar.gz" \
        bash -c '
            set -euo pipefail
            build_script="$1"
            callback_marker="$2"
            target="$3"
            source "$build_script"
            target_to_arch() { printf "%s\n" x86_64; }
            resolve_musl_cc() { command -v true; }
            resolve_musl_tool() {
                case "$2" in ar) command -v ar ;; ranlib) command -v ranlib ;; *) return 1 ;; esac
            }
            eval "$(declare -f ensure_linux_headers_for_arch | sed \
                "1s/ensure_linux_headers_for_arch/ensure_linux_headers_for_arch_real/")"
            ensure_linux_headers_for_arch() {
                local selected_include
                selected_include=$(ensure_linux_headers_for_arch_real "$@") || return 1
                if [ ! -e "$RACE_PUBLISHER_MARKER" ]; then
                    PATH="$RACE_PUBLISHER_PATH" bash -c '\''
                        set -euo pipefail
                        source "$1"
                        ensure_linux_headers_for_arch x86_64 >/dev/null
                    '\'' _ "$build_script"
                    : >"$RACE_PUBLISHER_MARKER"
                fi
                printf "%s\n" "$selected_include"
            }
            record_callback() {
                printf "%s\n" "$LIBSECCOMP_LIB_PATH" >"$1"
            }
            with_libseccomp_for_target "$target" record_callback "$callback_marker"
        ' _ "$BUILD_SCRIPT" "$callback_marker" "$target" \
        >"$work_dir/lib-headers-id.log" 2>&1
    local status=$?
    set -e

    [ -e "$publisher_marker" ] || {
        cat "$work_dir/lib-headers-id.log" >&2
        fail "libseccomp header content-id replacement publisher did not run"
    }
    if [ "$status" -ne 0 ] || [ ! -s "$callback_marker" ]; then
        cat "$work_dir/lib-headers-id.log" >&2
        fail "libseccomp header content-id race skipped its consumer: status=$status"
    fi
    [ -s "$(cat "$callback_marker")/libseccomp.a" ] || \
        fail "libseccomp header content-id consumer received no immutable archive"

    trap - RETURN
    rm -rf "$work_dir"
}

case_libseccomp_headers_snapshot_lease() {
    local work_dir
    work_dir=$(mktemp -d -t boxlite-native-cache-lib-headers-snapshot-lease-XXXXXX)
    trap 'rm -rf "$work_dir"' RETURN

    local headers_version="fixture-headers-lib-snapshot-lease"
    local lib_version="fixture-lib-headers-snapshot-lease"
    make_header_fixture "$work_dir" "$headers_version"
    make_libseccomp_fixture "$work_dir" "$lib_version"
    local headers_sha lib_sha
    headers_sha=$(sha256_file "$work_dir/kernel-headers.tar.gz")
    lib_sha=$(sha256_file "$work_dir/libseccomp.tar.gz")
    local cache_dir="$work_dir/cache"
    provision_headers \
        "$cache_dir" "$work_dir/kernel-headers.tar.gz" "$headers_version" "$headers_sha"

    local alternate_tools="$work_dir/alternate-tools"
    mkdir -p "$alternate_tools"
    ln -s "$(command -v make)" "$alternate_tools/make"
    local publisher_marker="$work_dir/publisher-ran"
    local callback_marker="$work_dir/callback-ran"
    local target="x86_64-unknown-linux-musl"

    set +e
    PATH="$REAL_PATH" \
    RACE_PUBLISHER_PATH="$alternate_tools:$REAL_PATH" \
    RACE_PUBLISHER_MARKER="$publisher_marker" \
    BOXLITE_CACHE="$cache_dir" \
    LINUX_HEADERS_VERSION="$headers_version" \
    LINUX_HEADERS_SHA256="$headers_sha" \
    LINUX_HEADERS_SOURCE_TARBALL="$work_dir/kernel-headers.tar.gz" \
    LIBSECCOMP_VERSION="$lib_version" \
    LIBSECCOMP_TARBALL_SHA256="$lib_sha" \
    LIBSECCOMP_SOURCE_TARBALL="$work_dir/libseccomp.tar.gz" \
        bash -c '
            set -euo pipefail
            build_script="$1"
            callback_marker="$2"
            target="$3"
            source "$build_script"
            target_to_arch() { printf "%s\n" x86_64; }
            resolve_musl_cc() { command -v true; }
            resolve_musl_tool() {
                case "$2" in ar) command -v ar ;; ranlib) command -v ranlib ;; *) return 1 ;; esac
            }
            eval "$(declare -f snapshot_linux_headers_for_path | sed \
                "1s/snapshot_linux_headers_for_path/snapshot_linux_headers_for_path_real/")"
            snapshot_linux_headers_for_path() {
                if [ ! -e "$RACE_PUBLISHER_MARKER" ]; then
                    PATH="$RACE_PUBLISHER_PATH" bash -c '\''
                        set -euo pipefail
                        source "$1"
                        ensure_linux_headers_for_arch x86_64 >/dev/null
                    '\'' _ "$build_script"
                    : >"$RACE_PUBLISHER_MARKER"
                fi
                snapshot_linux_headers_for_path_real "$@"
            }
            record_callback() {
                printf "%s\n" "$LIBSECCOMP_LIB_PATH" >"$1"
            }
            with_libseccomp_for_target "$target" record_callback "$callback_marker"
        ' _ "$BUILD_SCRIPT" "$callback_marker" "$target" \
        >"$work_dir/lib-headers-snapshot.log" 2>&1
    local status=$?
    set -e

    [ -e "$publisher_marker" ] || {
        cat "$work_dir/lib-headers-snapshot.log" >&2
        fail "libseccomp header snapshot replacement publisher did not run"
    }
    if [ "$status" -ne 0 ] || [ ! -s "$callback_marker" ]; then
        cat "$work_dir/lib-headers-snapshot.log" >&2
        fail "libseccomp header snapshot race skipped its consumer: status=$status"
    fi
    [ -s "$(cat "$callback_marker")/libseccomp.a" ] || \
        fail "libseccomp header snapshot consumer received no immutable archive"

    trap - RETURN
    rm -rf "$work_dir"
}

case_libseccomp_consumer_lease() {
    local work_dir
    work_dir=$(mktemp -d -t boxlite-native-cache-lib-consumer-XXXXXX)
    local consumer_pid=""
    local consumer_pgid=""
    cleanup_libseccomp_consumer_lease() {
        if [ -n "$consumer_pid" ] && kill -0 "$consumer_pid" 2>/dev/null; then
            if [ -n "$consumer_pgid" ]; then
                kill -- "-$consumer_pgid" 2>/dev/null || true
            else
                kill "$consumer_pid" 2>/dev/null || true
            fi
            wait "$consumer_pid" 2>/dev/null || true
        fi
        exec 8>&- 2>/dev/null || true
        exec 9>&- 2>/dev/null || true
        rm -rf "$work_dir"
    }
    trap cleanup_libseccomp_consumer_lease RETURN

    local headers_version="fixture-headers-lib-consumer"
    local lib_version="fixture-lib-consumer"
    make_header_fixture "$work_dir" "$headers_version"
    make_libseccomp_fixture "$work_dir" "$lib_version"
    local headers_sha lib_sha
    headers_sha=$(sha256_file "$work_dir/kernel-headers.tar.gz")
    lib_sha=$(sha256_file "$work_dir/libseccomp.tar.gz")
    local cache_dir="$work_dir/cache"
    provision_libseccomp \
        "$cache_dir" "$work_dir/kernel-headers.tar.gz" "$headers_version" "$headers_sha" \
        "$work_dir/libseccomp.tar.gz" "$lib_version" "$lib_sha"

    local target="x86_64-unknown-linux-musl"
    local cache_root="$cache_dir/libseccomp/$target/$lib_version"
    local first_generation
    first_generation=$(cd "$(dirname "$cache_root")/$(readlink "$cache_root")" && pwd -P)
    local consumer_ready="$work_dir/consumer-ready.fifo"
    local consumer_release="$work_dir/consumer-release.fifo"
    mkfifo "$consumer_ready" "$consumer_release"
    exec 8<>"$consumer_ready"
    exec 9<>"$consumer_release"

    BOXLITE_CACHE="$cache_dir" \
    LINUX_HEADERS_VERSION="$headers_version" \
    LINUX_HEADERS_SHA256="$headers_sha" \
    LINUX_HEADERS_SOURCE_TARBALL="$work_dir/kernel-headers.tar.gz" \
    LIBSECCOMP_VERSION="$lib_version" \
    LIBSECCOMP_TARBALL_SHA256="$lib_sha" \
    LIBSECCOMP_SOURCE_TARBALL="$work_dir/libseccomp.tar.gz" \
        bash -c '
            set -euo pipefail
            source "$1"
            target_to_arch() { printf "%s\n" x86_64; }
            resolve_musl_cc() { command -v true; }
            resolve_musl_tool() {
                case "$2" in ar) command -v ar ;; ranlib) command -v ranlib ;; *) return 1 ;; esac
            }
            consume_libseccomp_generation() {
                local resolved_before resolved_after release_event
                resolved_before=$(cd "$LIBSECCOMP_LIB_PATH" && pwd -P)
                printf "%s\n" "$LIBSECCOMP_LIB_PATH" >"$1/exported-path"
                printf "%s\n" "$resolved_before" >"$1/resolved-before"
                printf "%s\n" ready >&8
                IFS= read -r release_event <&9
                [ "$release_event" = release ]
                resolved_after=$(cd "$LIBSECCOMP_LIB_PATH" && pwd -P) || {
                    echo "consumer libseccomp generation disappeared" >&2
                    return 91
                }
                if [ "$resolved_after" != "$resolved_before" ]; then
                    echo "consumer libseccomp path changed generations" >&2
                    return 92
                fi
                ar p "$LIBSECCOMP_LIB_PATH/libseccomp.a" fixture-payload \
                    >"$1/observed-payload"
            }
            if declare -F with_libseccomp_for_target >/dev/null 2>&1; then
                with_libseccomp_for_target "$3" consume_libseccomp_generation "$2"
            else
                ensure_libseccomp_for_target "$3"
                consume_libseccomp_generation "$2"
            fi
        ' _ "$BUILD_SCRIPT" "$work_dir" "$target" \
        8>"$consumer_ready" 9<"$consumer_release" \
        >"$work_dir/consumer.log" 2>&1 &
    consumer_pid=$!

    local consumer_event
    if ! IFS= read -r -t 10 -u 8 consumer_event; then
        cat "$work_dir/consumer.log" >&2
        fail "libseccomp consumer did not reach its Cargo-use boundary"
    fi
    [ "$consumer_event" = ready ] || fail "unexpected libseccomp consumer event: $consumer_event"

    local alternate_tools="$work_dir/alternate-tools"
    mkdir -p "$alternate_tools"
    ln -s "$(command -v gperf)" "$alternate_tools/gperf"
    ln -s "$(command -v make)" "$alternate_tools/make"
    provision_libseccomp \
        "$cache_dir" "$work_dir/kernel-headers.tar.gz" "$headers_version" "$headers_sha" \
        "$work_dir/libseccomp.tar.gz" "$lib_version" "$lib_sha" \
        "$alternate_tools:$REAL_PATH"

    if [ ! -d "$first_generation" ]; then
        printf '%s\n' release >&9
        wait "$consumer_pid" 2>/dev/null || true
        consumer_pid=""
        cat "$work_dir/consumer.log" >&2
        fail "native cache GC deleted the generation still consumed by Cargo"
    fi
    [ "$(cat "$work_dir/exported-path")" = "$first_generation/lib" ] || \
        fail "libseccomp consumer did not export the immutable physical generation path"

    printf '%s\n' release >&9
    wait "$consumer_pid" || {
        cat "$work_dir/consumer.log" >&2
        fail "leased libseccomp consumer failed"
    }
    consumer_pid=""
    ar p "$first_generation/lib/libseccomp.a" fixture-payload | grep -qx LIB_GOOD || \
        fail "leased libseccomp consumer observed the wrong archive generation"

    bash -c 'source "$1"; _native_cache_collect "$2" "$3"' \
        _ "$BUILD_SCRIPT" "$(dirname "$cache_root")/.$lib_version.lock" "$cache_root"
    [ ! -e "$first_generation" ] || \
        fail "released libseccomp consumer generation was not reclaimed"

    local prelease_generation
    prelease_generation=$(cd "$(dirname "$cache_root")/$(readlink "$cache_root")" && pwd -P)
    BOXLITE_CACHE="$cache_dir" \
    LINUX_HEADERS_VERSION="$headers_version" \
    LINUX_HEADERS_SHA256="$headers_sha" \
    LINUX_HEADERS_SOURCE_TARBALL="$work_dir/kernel-headers.tar.gz" \
    LIBSECCOMP_VERSION="$lib_version" \
    LIBSECCOMP_TARBALL_SHA256="$lib_sha" \
    LIBSECCOMP_SOURCE_TARBALL="$work_dir/libseccomp.tar.gz" \
    PATH="$alternate_tools:$REAL_PATH" \
        bash -c '
            set -euo pipefail
            source "$1"
            target_to_arch() { printf "%s\n" x86_64; }
            resolve_musl_cc() { command -v true; }
            resolve_musl_tool() {
                case "$2" in ar) command -v ar ;; ranlib) command -v ranlib ;; *) return 1 ;; esac
            }
            eval "$(declare -f _native_cache_with_generation_lease | sed \
                "1s/_native_cache_with_generation_lease/_native_cache_with_generation_lease_real/")"
            first_lease_attempt=true
            _native_cache_with_generation_lease() {
                local retry_event
                if [ "$first_lease_attempt" = true ] && \
                   [ "${1#*/libseccomp/}" != "$1" ]; then
                    first_lease_attempt=false
                    printf "%s\n" prelease >&8
                    IFS= read -r retry_event <&9
                    [ "$retry_event" = retry ]
                fi
                _native_cache_with_generation_lease_real "$@"
            }
            record_consumer_path() {
                printf "%s\n" "$LIBSECCOMP_LIB_PATH" >"$1"
            }
            prelease_status=0
            with_libseccomp_for_target "$3" record_consumer_path "$2" || prelease_status=$?
            if [ "$prelease_status" -ne 0 ]; then
                echo "pre-lease libseccomp consumer failed: $prelease_status" >&2
                exit "$prelease_status"
            fi
        ' _ "$BUILD_SCRIPT" "$work_dir/prelease-exported-path" "$target" \
        8>"$consumer_ready" 9<"$consumer_release" \
        >"$work_dir/prelease.log" 2>&1 &
    consumer_pid=$!
    if ! IFS= read -r -t 10 -u 8 consumer_event; then
        cat "$work_dir/prelease.log" >&2
        fail "libseccomp consumer did not reach the pre-lease race boundary"
    fi
    [ "$consumer_event" = prelease ] || \
        fail "unexpected libseccomp pre-lease event: $consumer_event"

    local prelease_publisher_tools="$work_dir/prelease-publisher-tools"
    mkdir -p "$prelease_publisher_tools"
    ln -s "$(command -v gperf)" "$prelease_publisher_tools/gperf"
    ln -s "$(command -v make)" "$prelease_publisher_tools/make"
    provision_libseccomp \
        "$cache_dir" "$work_dir/kernel-headers.tar.gz" "$headers_version" "$headers_sha" \
        "$work_dir/libseccomp.tar.gz" "$lib_version" "$lib_sha" \
        "$prelease_publisher_tools:$REAL_PATH"
    [ ! -e "$prelease_generation" ] || \
        fail "pre-lease race fixture unexpectedly retained the unleased generation"

    printf '%s\n' retry >&9
    wait "$consumer_pid" || {
        cat "$work_dir/prelease.log" >&2
        fail "libseccomp consumer did not retry after a pre-lease GC race"
    }
    consumer_pid=""
    local retried_consumer_path
    retried_consumer_path=$(cat "$work_dir/prelease-exported-path")
    [ "$(dirname "$retried_consumer_path")" != "$prelease_generation" ] || \
        fail "libseccomp pre-lease retry reused the reclaimed generation"
    [ -s "$retried_consumer_path/libseccomp.a" ] || \
        fail "libseccomp pre-lease retry did not bind a live physical generation"

    local failed_generation
    failed_generation=$(cd "$(dirname "$cache_root")/$(readlink "$cache_root")" && pwd -P)
    mkdir -p "$work_dir/failure-tmp"
    set +e
    PATH="$alternate_tools:$REAL_PATH" \
    TMPDIR="$work_dir/failure-tmp" \
    BOXLITE_CACHE="$cache_dir" \
    LINUX_HEADERS_VERSION="$headers_version" \
    LINUX_HEADERS_SHA256="$headers_sha" \
    LINUX_HEADERS_SOURCE_TARBALL="$work_dir/kernel-headers.tar.gz" \
    LIBSECCOMP_VERSION="$lib_version" \
    LIBSECCOMP_TARBALL_SHA256="$lib_sha" \
    LIBSECCOMP_SOURCE_TARBALL="$work_dir/libseccomp.tar.gz" \
        bash -c '
            set +e
            source "$1"
            target_to_arch() { printf "%s\n" x86_64; }
            resolve_musl_cc() { command -v true; }
            resolve_musl_tool() {
                case "$2" in ar) command -v ar ;; ranlib) command -v ranlib ;; *) return 1 ;; esac
            }
            original_pwd=$(pwd -P)
            original_flags=$-
            callback_marker=unchanged
            trap : EXIT
            original_trap=$(trap -p EXIT)
            fail_consumer() {
                printf "%s\n" "$LIBSECCOMP_LIB_PATH" >"$1"
                cd /
                set -e
                callback_marker=changed
                trap : EXIT
                return 47
            }
            callback_status=0
            with_libseccomp_for_target "$3" fail_consumer "$2" || callback_status=$?
            [ "$callback_status" -eq 47 ] || exit 81
            [ "$(pwd -P)" = "$original_pwd" ] || exit 82
            [ "$-" = "$original_flags" ] || exit 83
            [ "$callback_marker" = unchanged ] || exit 84
            [ "$(trap -p EXIT)" = "$original_trap" ] || exit 85
        ' _ "$BUILD_SCRIPT" "$work_dir/failure-exported-path" "$target"
    local failure_status=$?
    set -e
    [ "$failure_status" -eq 0 ] || \
        fail "libseccomp callback failure leaked shell state or changed status"
    [ "$(cat "$work_dir/failure-exported-path")" = "$failed_generation/lib" ] || \
        fail "failing libseccomp callback did not receive a physical generation path"
    if find "$work_dir/failure-tmp" -mindepth 1 -print -quit | grep -q .; then
        fail "failing libseccomp callback leaked lease control state"
    fi

    local post_failure_tools="$work_dir/post-failure-tools"
    mkdir -p "$post_failure_tools"
    ln -s "$(command -v gperf)" "$post_failure_tools/gperf"
    ln -s "$(command -v make)" "$post_failure_tools/make"
    provision_libseccomp \
        "$cache_dir" "$work_dir/kernel-headers.tar.gz" "$headers_version" "$headers_sha" \
        "$work_dir/libseccomp.tar.gz" "$lib_version" "$lib_sha" \
        "$post_failure_tools:$REAL_PATH"
    [ ! -e "$failed_generation" ] || \
        fail "failed libseccomp callback retained its generation lease"

    exec 8>&-
    exec 9>&-
    local interrupted_generation
    interrupted_generation=$(cd "$(dirname "$cache_root")/$(readlink "$cache_root")" && pwd -P)
    local interrupt_ready="$work_dir/interrupt-ready.fifo"
    local interrupt_release="$work_dir/interrupt-release.fifo"
    mkdir -p "$work_dir/interrupt-tmp"
    mkfifo "$interrupt_ready" "$interrupt_release"
    exec 8<>"$interrupt_ready"
    exec 9<>"$interrupt_release"

    perl -MPOSIX -e 'POSIX::setsid() >= 0 or die "setsid: $!"; exec @ARGV or die "exec: $!"' env \
        PATH="$post_failure_tools:$REAL_PATH" \
        TMPDIR="$work_dir/interrupt-tmp" \
        BOXLITE_CACHE="$cache_dir" \
        LINUX_HEADERS_VERSION="$headers_version" \
        LINUX_HEADERS_SHA256="$headers_sha" \
        LINUX_HEADERS_SOURCE_TARBALL="$work_dir/kernel-headers.tar.gz" \
        LIBSECCOMP_VERSION="$lib_version" \
        LIBSECCOMP_TARBALL_SHA256="$lib_sha" \
        LIBSECCOMP_SOURCE_TARBALL="$work_dir/libseccomp.tar.gz" \
        bash -c '
            set -euo pipefail
            source "$1"
            target_to_arch() { printf "%s\n" x86_64; }
            resolve_musl_cc() { command -v true; }
            resolve_musl_tool() {
                case "$2" in ar) command -v ar ;; ranlib) command -v ranlib ;; *) return 1 ;; esac
            }
            block_consumer() {
                local release_event
                printf "%s\n" "$LIBSECCOMP_LIB_PATH" >"$1"
                printf "%s\n" ready >&8
                IFS= read -r release_event <&9
            }
            with_libseccomp_for_target "$3" block_consumer "$2"
        ' _ "$BUILD_SCRIPT" "$work_dir/interrupt-exported-path" "$target" \
        8>"$interrupt_ready" 9<"$interrupt_release" \
        >"$work_dir/interrupt.log" 2>&1 &
    consumer_pid=$!
    consumer_pgid="$consumer_pid"
    if ! IFS= read -r -t 10 -u 8 consumer_event; then
        cat "$work_dir/interrupt.log" >&2
        fail "interruptible libseccomp consumer did not acquire its lease"
    fi
    [ "$consumer_event" = ready ] || \
        fail "unexpected interruptible libseccomp consumer event: $consumer_event"
    [ "$(cat "$work_dir/interrupt-exported-path")" = "$interrupted_generation/lib" ] || \
        fail "interruptible libseccomp callback did not receive its physical generation"

    kill -- "-$consumer_pgid"
    wait "$consumer_pid" 2>/dev/null || true
    consumer_pid=""
    if ! perl -MFcntl=:flock -e '
        $SIG{ALRM} = sub { exit 75 };
        alarm 10;
        open(my $lease, ">>", $ARGV[0]) or exit 71;
        flock($lease, LOCK_EX) or exit 72;
        exit 0;
    ' "$interrupted_generation/CACHE-LEASE"; then
        fail "interrupted libseccomp callback did not release its generation lease"
    fi
    if find "$work_dir/interrupt-tmp" -mindepth 1 -print -quit | grep -q .; then
        fail "interrupted libseccomp callback leaked lease control state"
    fi

    local post_interrupt_tools="$work_dir/post-interrupt-tools"
    mkdir -p "$post_interrupt_tools"
    ln -s "$(command -v gperf)" "$post_interrupt_tools/gperf"
    ln -s "$(command -v make)" "$post_interrupt_tools/make"
    provision_libseccomp \
        "$cache_dir" "$work_dir/kernel-headers.tar.gz" "$headers_version" "$headers_sha" \
        "$work_dir/libseccomp.tar.gz" "$lib_version" "$lib_sha" \
        "$post_interrupt_tools:$REAL_PATH"
    [ ! -e "$interrupted_generation" ] || \
        fail "interrupted libseccomp callback retained its generation"

    grep -Fq 'with_libseccomp_for_target' "$PROJECT_ROOT/scripts/build/build-guest.sh" || \
        fail "build-guest does not bind Cargo to the libseccomp lease facade"

    exec 8>&-
    exec 9>&-
    trap - RETURN
    cleanup_libseccomp_consumer_lease
}

case_libseccomp_ensure_transaction_retry() {
    local work_dir
    work_dir=$(mktemp -d -t boxlite-native-cache-lib-ensure-retry-XXXXXX)
    trap 'rm -rf "$work_dir"' RETURN

    local headers_version="fixture-headers-lib-ensure-retry"
    local lib_version="fixture-lib-ensure-retry"
    make_header_fixture "$work_dir" "$headers_version"
    make_libseccomp_fixture "$work_dir" "$lib_version"
    local headers_sha lib_sha
    headers_sha=$(sha256_file "$work_dir/kernel-headers.tar.gz")
    lib_sha=$(sha256_file "$work_dir/libseccomp.tar.gz")
    local cache_dir="$work_dir/cache"
    provision_libseccomp \
        "$cache_dir" "$work_dir/kernel-headers.tar.gz" "$headers_version" "$headers_sha" \
        "$work_dir/libseccomp.tar.gz" "$lib_version" "$lib_sha"

    local publisher_tools="$work_dir/publisher-tools"
    mkdir -p "$publisher_tools"
    ln -s "$(command -v gperf)" "$publisher_tools/gperf"
    local target="x86_64-unknown-linux-musl"
    local callback_marker="$work_dir/callback-ran"
    local publisher_marker="$work_dir/publisher-ran"

    set +e
    PATH="$REAL_PATH" \
    RACE_PUBLISHER_PATH="$publisher_tools:$REAL_PATH" \
    RACE_PUBLISHER_MARKER="$publisher_marker" \
    BOXLITE_CACHE="$cache_dir" \
    LINUX_HEADERS_VERSION="$headers_version" \
    LINUX_HEADERS_SHA256="$headers_sha" \
    LINUX_HEADERS_SOURCE_TARBALL="$work_dir/kernel-headers.tar.gz" \
    LIBSECCOMP_VERSION="$lib_version" \
    LIBSECCOMP_TARBALL_SHA256="$lib_sha" \
    LIBSECCOMP_SOURCE_TARBALL="$work_dir/libseccomp.tar.gz" \
        bash -c '
            set -euo pipefail
            build_script="$1"
            callback_marker="$2"
            race_target="$3"
            source "$build_script"
            target_to_arch() { printf "%s\n" x86_64; }
            resolve_musl_cc() { command -v true; }
            resolve_musl_tool() {
                case "$2" in ar) command -v ar ;; ranlib) command -v ranlib ;; *) return 1 ;; esac
            }
            eval "$(declare -f _native_cache_collect | sed \
                "1s/_native_cache_collect/_native_cache_collect_real/")"
            race_published=false
            _native_cache_collect() {
                local cache_root="$2"
                if [ "$race_published" = false ] && \
                   [ "${cache_root#*/libseccomp/}" != "$cache_root" ]; then
                    race_published=true
                    PATH="$RACE_PUBLISHER_PATH" bash -c '\''
                        set -euo pipefail
                        source "$1"
                        target_to_arch() { printf "%s\n" x86_64; }
                        resolve_musl_cc() { command -v true; }
                        resolve_musl_tool() {
                            case "$2" in
                                ar) command -v ar ;;
                                ranlib) command -v ranlib ;;
                                *) return 1 ;;
                            esac
                        }
                        ensure_libseccomp_for_target "$2" >/dev/null
                    '\'' _ "$build_script" "$race_target"
                    : >"$RACE_PUBLISHER_MARKER"
                fi
                _native_cache_collect_real "$@"
            }
            record_callback() {
                printf "%s\n" "$LIBSECCOMP_LIB_PATH" >"$1"
            }
            with_libseccomp_for_target "$race_target" record_callback "$callback_marker"
        ' _ "$BUILD_SCRIPT" "$callback_marker" "$target" \
        >"$work_dir/ensure-retry.log" 2>&1
    local status=$?
    set -e

    local callback_ran=false
    [ -e "$callback_marker" ] && callback_ran=true
    [ -e "$publisher_marker" ] || {
        cat "$work_dir/ensure-retry.log" >&2
        fail "inside-ensure replacement publisher did not run"
    }
    if [ "$status" -ne 0 ] || [ "$callback_ran" != true ]; then
        cat "$work_dir/ensure-retry.log" >&2
        fail "inside-ensure identity replacement was not retried: status=$status callback_ran=$callback_ran"
    fi

    local callback_lib_path
    callback_lib_path=$(cat "$callback_marker")
    [ -s "$callback_lib_path/libseccomp.a" ] || \
        fail "inside-ensure retry callback did not receive a live libseccomp generation"
    grep -qx "gperf-path=$(command -v gperf)" \
        "$(dirname "$callback_lib_path")/CACHE-IDENTITY" || \
        fail "inside-ensure retry callback received the competing libseccomp identity"
    trap - RETURN
    rm -rf "$work_dir"
}

case_headers_hit_transaction_retry() {
    local work_dir
    work_dir=$(mktemp -d -t boxlite-native-cache-headers-hit-retry-XXXXXX)
    trap 'rm -rf "$work_dir"' RETURN

    local version="fixture-headers-hit-retry"
    make_header_fixture "$work_dir" "$version"
    local fixture_tarball="$work_dir/kernel-headers.tar.gz"
    local fixture_sha
    fixture_sha=$(sha256_file "$fixture_tarball")
    local cache_dir="$work_dir/cache"
    provision_headers "$cache_dir" "$fixture_tarball" "$version" "$fixture_sha"

    local publisher_tools="$work_dir/publisher-tools"
    mkdir -p "$publisher_tools"
    ln -s "$(command -v make)" "$publisher_tools/make"
    local selected_include="$work_dir/selected-include"
    local publisher_marker="$work_dir/publisher-ran"

    set +e
    PATH="$REAL_PATH" \
    RACE_PUBLISHER_PATH="$publisher_tools:$REAL_PATH" \
    RACE_PUBLISHER_MARKER="$publisher_marker" \
    BOXLITE_CACHE="$cache_dir" \
    LINUX_HEADERS_VERSION="$version" \
    LINUX_HEADERS_SHA256="$fixture_sha" \
    LINUX_HEADERS_SOURCE_TARBALL="$fixture_tarball" \
        bash -c '
            set -euo pipefail
            build_script="$1"
            source "$build_script"
            eval "$(declare -f _native_cache_collect | sed \
                "1s/_native_cache_collect/_native_cache_collect_real/")"
            race_published=false
            _native_cache_collect() {
                local cache_root="$2"
                if [ "$race_published" = false ] && \
                   [ "${cache_root#*/linux-headers/}" != "$cache_root" ]; then
                    race_published=true
                    PATH="$RACE_PUBLISHER_PATH" bash -c '\''
                        set -euo pipefail
                        source "$1"
                        ensure_linux_headers_for_arch x86_64 >/dev/null
                    '\'' _ "$build_script"
                    : >"$RACE_PUBLISHER_MARKER"
                fi
                _native_cache_collect_real "$@"
            }
            ensure_linux_headers_for_arch x86_64
        ' _ "$BUILD_SCRIPT" >"$selected_include" 2>"$work_dir/hit-retry.log"
    local status=$?
    set -e

    [ -e "$publisher_marker" ] || {
        cat "$work_dir/hit-retry.log" >&2
        fail "inside-header-hit replacement publisher did not run"
    }
    if [ "$status" -ne 0 ] || [ ! -s "$selected_include" ]; then
        cat "$work_dir/hit-retry.log" >&2
        fail "inside-header-hit identity replacement was not retried: status=$status"
    fi

    local selected_generation
    selected_generation=$(dirname "$(cat "$selected_include")")
    [ -f "$selected_generation/include/asm/unistd.h" ] || \
        fail "header-hit retry did not return a live physical generation"
    grep -qx "make-path=$(command -v make)" \
        "$selected_generation/CACHE-IDENTITY" || \
        fail "header-hit transaction returned the competing identity"
    trap - RETURN
    rm -rf "$work_dir"
}

case_headers_publish_transaction_retry() {
    local work_dir
    work_dir=$(mktemp -d -t boxlite-native-cache-headers-publish-retry-XXXXXX)
    trap 'rm -rf "$work_dir"' RETURN

    local version="fixture-headers-publish-retry"
    make_header_fixture "$work_dir" "$version"
    local fixture_tarball="$work_dir/kernel-headers.tar.gz"
    local fixture_sha
    fixture_sha=$(sha256_file "$fixture_tarball")
    local cache_dir="$work_dir/cache"
    local publisher_tools="$work_dir/publisher-tools"
    mkdir -p "$publisher_tools"
    ln -s "$(command -v make)" "$publisher_tools/make"
    local selected_include="$work_dir/selected-include"
    local publisher_marker="$work_dir/publisher-ran"

    set +e
    PATH="$REAL_PATH" \
    RACE_PUBLISHER_PATH="$publisher_tools:$REAL_PATH" \
    RACE_PUBLISHER_MARKER="$publisher_marker" \
    BOXLITE_CACHE="$cache_dir" \
    LINUX_HEADERS_VERSION="$version" \
    LINUX_HEADERS_SHA256="$fixture_sha" \
    LINUX_HEADERS_SOURCE_TARBALL="$fixture_tarball" \
        bash -c '
            set -euo pipefail
            build_script="$1"
            source "$build_script"
            eval "$(declare -f _native_cache_publish | sed \
                "1s/_native_cache_publish/_native_cache_publish_real/")"
            _native_cache_publish() {
                local cache_root="$3"
                _native_cache_publish_real "$@"
                if [ ! -e "$RACE_PUBLISHER_MARKER" ] && \
                   [ "${cache_root#*/linux-headers/}" != "$cache_root" ]; then
                    PATH="$RACE_PUBLISHER_PATH" bash -c '\''
                        set -euo pipefail
                        source "$1"
                        ensure_linux_headers_for_arch x86_64 >/dev/null
                    '\'' _ "$build_script"
                    : >"$RACE_PUBLISHER_MARKER"
                fi
            }
            ensure_linux_headers_for_arch x86_64
        ' _ "$BUILD_SCRIPT" >"$selected_include" 2>"$work_dir/publish-retry.log"
    local status=$?
    set -e

    [ -e "$publisher_marker" ] || {
        cat "$work_dir/publish-retry.log" >&2
        fail "post-header-publish replacement publisher did not run"
    }
    if [ "$status" -ne 0 ] || [ ! -s "$selected_include" ]; then
        cat "$work_dir/publish-retry.log" >&2
        fail "post-header-publish identity replacement was not retried: status=$status"
    fi

    local selected_generation
    selected_generation=$(dirname "$(cat "$selected_include")")
    [ -f "$selected_generation/include/asm/unistd.h" ] || \
        fail "header-publish retry did not return a live physical generation"
    grep -qx "make-path=$(command -v make)" \
        "$selected_generation/CACHE-IDENTITY" || \
        fail "header-publish transaction returned the competing identity"
    trap - RETURN
    rm -rf "$work_dir"
}

case_headers_partial() {
    local work_dir
    work_dir=$(mktemp -d -t boxlite-native-cache-partial-XXXXXX)
    trap 'rm -rf "$work_dir"' RETURN
    local version="fixture-headers-partial"
    make_header_fixture "$work_dir" "$version"
    local fixture_tarball="$work_dir/kernel-headers.tar.gz"
    local fixture_sha
    fixture_sha=$(sha256_file "$fixture_tarball")
    local cache_dir="$work_dir/cache"
    local cache_root="$cache_dir/linux-headers/$version/x86_64"
    mkdir -p "$cache_root/include/asm" "$cache_root/include/linux"
    printf '%s\n' CORRUPT >"$cache_root/include/asm/unistd.h"
    printf '%s\n' CORRUPT >"$cache_root/include/linux/audit.h"

    provision_headers "$cache_dir" "$fixture_tarball" "$version" "$fixture_sha"

    [ -f "$cache_root/CACHE-MANIFEST" ] || \
        fail "ensure_linux_headers_for_arch accepted a two-sentinel partial cache"
    [ "$(cat "$cache_root/include/asm/unistd.h")" = HEADER_GOOD ] || \
        fail "partial Linux-header cache was not rebuilt"
    [ "$(cat "$cache_root/include/linux/extra.h")" = EXTRA_GOOD ] || \
        fail "rebuilt Linux-header cache is incomplete"
    trap - RETURN
    rm -rf "$work_dir"
}

case_libseccomp_partial() {
    local work_dir
    work_dir=$(mktemp -d -t boxlite-native-cache-lib-partial-XXXXXX)
    trap 'rm -rf "$work_dir"' RETURN
    local headers_version="fixture-headers-for-lib"
    local lib_version="fixture-lib-partial"
    make_header_fixture "$work_dir" "$headers_version"
    make_libseccomp_fixture "$work_dir" "$lib_version"
    local headers_sha lib_sha
    headers_sha=$(sha256_file "$work_dir/kernel-headers.tar.gz")
    lib_sha=$(sha256_file "$work_dir/libseccomp.tar.gz")
    local cache_dir="$work_dir/cache"
    local cache_root="$cache_dir/libseccomp/x86_64-unknown-linux-musl/$lib_version"
    mkdir -p "$cache_root/lib"
    printf '%s\n' CORRUPT >"$cache_root/lib/libseccomp.a"

    BOXLITE_CACHE="$cache_dir" \
    LINUX_HEADERS_VERSION="$headers_version" \
    LINUX_HEADERS_SHA256="$headers_sha" \
    LINUX_HEADERS_SOURCE_TARBALL="$work_dir/kernel-headers.tar.gz" \
    LIBSECCOMP_VERSION="$lib_version" \
    LIBSECCOMP_TARBALL_SHA256="$lib_sha" \
    LIBSECCOMP_SOURCE_TARBALL="$work_dir/libseccomp.tar.gz" \
        bash -c '
            source "$1"
            target_to_arch() { printf "%s\n" x86_64; }
            resolve_musl_cc() { command -v true; }
            resolve_musl_tool() {
                case "$2" in ar) command -v ar ;; ranlib) command -v ranlib ;; *) return 1 ;; esac
            }
            ensure_libseccomp_for_target x86_64-unknown-linux-musl
        ' _ "$BUILD_SCRIPT" >/dev/null

    [ -f "$cache_root/CACHE-MANIFEST" ] || \
        fail "ensure_libseccomp_for_target accepted an archive-only partial cache"
    [ "$(cat "$cache_root/include/seccomp.h")" = LIB_GOOD ] || \
        fail "partial libseccomp cache was not rebuilt"
    ar p "$cache_root/lib/libseccomp.a" fixture-payload | grep -qx LIB_GOOD || \
        fail "rebuilt libseccomp archive has unexpected content"
    trap - RETURN
    rm -rf "$work_dir"
}

case_headers_concurrency() {
    local work_dir
    work_dir=$(mktemp -d -t boxlite-native-cache-headers-concurrency-XXXXXX)
    local worker_pid=""
    cleanup_headers_concurrency() {
        if [ -n "$worker_pid" ] && kill -0 "$worker_pid" 2>/dev/null; then
            kill -- "-$worker_pid" 2>/dev/null || kill "$worker_pid" 2>/dev/null || true
            wait "$worker_pid" 2>/dev/null || true
        fi
        rm -rf "$work_dir"
    }
    trap cleanup_headers_concurrency RETURN

    local version="fixture-headers-concurrency"
    make_header_fixture "$work_dir" "$version"
    local fixture_tarball="$work_dir/kernel-headers.tar.gz"
    local fixture_sha
    fixture_sha=$(sha256_file "$fixture_tarball")
    local wrapper_dir="$work_dir/bin"
    make_download_wrappers "$wrapper_dir"
    printf '%s\n' '#!/bin/sh' >"$wrapper_dir/make"
    printf '%s\n' 'set -eu' >>"$wrapper_dir/make"
    printf '%s\n' 'prefix=' >>"$wrapper_dir/make"
    printf '%s\n' 'for arg in "$@"; do case "$arg" in prefix=*) prefix=${arg#prefix=} ;; esac; done' >>"$wrapper_dir/make"
    printf '%s\n' '[ -n "$prefix" ]' >>"$wrapper_dir/make"
    printf '%s\n' 'mkdir -p "$prefix/include/asm" "$prefix/include/linux"' >>"$wrapper_dir/make"
    printf '%s\n' 'printf "%s\\n" "$FIXTURE_GENERATION" >"$prefix/include/asm/unistd.h"' >>"$wrapper_dir/make"
    printf '%s\n' 'if [ "${FIXTURE_BLOCK:-0}" = 1 ]; then' >>"$wrapper_dir/make"
    printf '%s\n' '    printf "%s\\n" ready >"$FIXTURE_EVENT_FIFO"' >>"$wrapper_dir/make"
    printf '%s\n' '    IFS= read -r _ <"$FIXTURE_RELEASE_FIFO"' >>"$wrapper_dir/make"
    printf '%s\n' 'fi' >>"$wrapper_dir/make"
    printf '%s\n' 'printf "%s\\n" "$FIXTURE_GENERATION" >"$prefix/include/linux/audit.h"' >>"$wrapper_dir/make"
    printf '%s\n' 'printf "%s\\n" "$FIXTURE_GENERATION" >"$prefix/include/linux/extra.h"' >>"$wrapper_dir/make"
    chmod +x "$wrapper_dir/make"

    local event_fifo="$work_dir/event.fifo"
    local release_fifo="$work_dir/release.fifo"
    mkfifo "$event_fifo" "$release_fifo"
    exec 8<>"$event_fifo"
    exec 9<>"$release_fifo"

    local cache_dir="$work_dir/cache"
    perl -MPOSIX -e 'POSIX::setsid() >= 0 or die "setsid: $!"; exec @ARGV or die "exec: $!"' env \
        PATH="$wrapper_dir:$REAL_PATH" \
        FIXTURE_TARBALL="$fixture_tarball" \
        FIXTURE_GENERATION=A \
        FIXTURE_BLOCK=1 \
        FIXTURE_EVENT_FIFO="$event_fifo" \
        FIXTURE_RELEASE_FIFO="$release_fifo" \
        BOXLITE_CACHE="$cache_dir" \
        LINUX_HEADERS_VERSION="$version" \
        LINUX_HEADERS_SHA256="$fixture_sha" \
        LINUX_HEADERS_SOURCE_TARBALL="$fixture_tarball" \
        bash -c 'source "$1"; ensure_linux_headers_for_arch x86_64' _ "$BUILD_SCRIPT" \
        >"$work_dir/worker-a.log" 2>&1 &
    worker_pid=$!

    IFS= read -r -t 10 -u 8 event || {
        cat "$work_dir/worker-a.log" >&2
        fail "timed out waiting for the first header install"
    }
    [ "$event" = ready ] || fail "unexpected header concurrency event: $event"

    PATH="$wrapper_dir:$REAL_PATH" \
    FIXTURE_TARBALL="$fixture_tarball" \
    FIXTURE_GENERATION=B \
    FIXTURE_BLOCK=0 \
    BOXLITE_CACHE="$cache_dir" \
    LINUX_HEADERS_VERSION="$version" \
    LINUX_HEADERS_SHA256="$fixture_sha" \
    LINUX_HEADERS_SOURCE_TARBALL="$fixture_tarball" \
        bash -c 'source "$1"; ensure_linux_headers_for_arch x86_64' _ "$BUILD_SCRIPT" \
        >"$work_dir/worker-b.log" 2>&1 || {
            cat "$work_dir/worker-b.log" >&2
            fail "second header cache worker failed"
        }

    printf '%s\n' go >&9
    wait "$worker_pid" || {
        cat "$work_dir/worker-a.log" >&2
        fail "first header cache worker failed"
    }
    worker_pid=""

    local cache_root="$cache_dir/linux-headers/$version/x86_64/include"
    local asm_generation audit_generation extra_generation
    asm_generation=$(cat "$cache_root/asm/unistd.h")
    audit_generation=$(cat "$cache_root/linux/audit.h")
    extra_generation=$(cat "$cache_root/linux/extra.h")
    if [ "$asm_generation" != "$audit_generation" ] || \
       [ "$asm_generation" != "$extra_generation" ]; then
        fail "concurrent header installs exposed a mixed generation: asm=$asm_generation audit=$audit_generation extra=$extra_generation"
    fi

    exec 8>&-
    exec 9>&-
    trap - RETURN
    cleanup_headers_concurrency
}

case_headers_failure_cleanup() {
    local work_dir
    work_dir=$(mktemp -d -t boxlite-native-cache-headers-cleanup-XXXXXX)
    trap 'rm -rf "$work_dir"' RETURN
    local version="fixture-headers-cleanup"
    make_header_fixture "$work_dir" "$version"
    local fixture_tarball="$work_dir/kernel-headers.tar.gz"
    local fixture_sha
    fixture_sha=$(sha256_file "$fixture_tarball")
    local wrapper_dir="$work_dir/bin"
    make_download_wrappers "$wrapper_dir"
    printf '%s\n' '#!/bin/sh' 'exit 73' >"$wrapper_dir/tar"
    chmod +x "$wrapper_dir/tar"
    mkdir -p "$work_dir/tmp"

    set +e
    PATH="$wrapper_dir:$REAL_PATH" \
    FIXTURE_TARBALL="$fixture_tarball" \
    TMPDIR="$work_dir/tmp" \
    BOXLITE_CACHE="$work_dir/cache" \
    LINUX_HEADERS_VERSION="$version" \
    LINUX_HEADERS_SHA256="$fixture_sha" \
    LINUX_HEADERS_SOURCE_TARBALL="$fixture_tarball" \
        bash -c 'source "$1"; ensure_linux_headers_for_arch x86_64' _ "$BUILD_SCRIPT" \
        >"$work_dir/failure.log" 2>&1
    local status=$?
    set -e
    [ "$status" -ne 0 ] || fail "header extraction failure unexpectedly succeeded"
    if find "$work_dir/tmp" -mindepth 1 -print -quit | grep -q .; then
        fail "header extraction failure leaked its build workspace"
    fi
    if find "$work_dir/cache" -name '.staging-*' -print -quit 2>/dev/null | grep -q .; then
        fail "header extraction failure leaked cache staging"
    fi
    trap - RETURN
    rm -rf "$work_dir"
}

case_libseccomp_concurrency() {
    local work_dir
    work_dir=$(mktemp -d -t boxlite-native-cache-lib-concurrency-XXXXXX)
    local worker_pid=""
    cleanup_libseccomp_concurrency() {
        if [ -n "$worker_pid" ] && kill -0 "$worker_pid" 2>/dev/null; then
            kill -- "-$worker_pid" 2>/dev/null || kill "$worker_pid" 2>/dev/null || true
            wait "$worker_pid" 2>/dev/null || true
        fi
        rm -rf "$work_dir"
    }
    trap cleanup_libseccomp_concurrency RETURN

    local headers_version="fixture-headers-lib-concurrency"
    local lib_version="fixture-lib-concurrency"
    make_header_fixture "$work_dir" "$headers_version"
    make_libseccomp_fixture "$work_dir" "$lib_version"
    local headers_sha lib_sha
    headers_sha=$(sha256_file "$work_dir/kernel-headers.tar.gz")
    lib_sha=$(sha256_file "$work_dir/libseccomp.tar.gz")
    local cache_dir="$work_dir/cache"
    prepare_headers_for_lib_test \
        "$cache_dir" "$work_dir/kernel-headers.tar.gz" "$headers_version" "$headers_sha"

    local wrapper_dir="$work_dir/bin"
    make_download_wrappers "$wrapper_dir"
    printf '%s\n' '#!/bin/sh' >"$wrapper_dir/make"
    printf '%s\n' 'set -eu' >>"$wrapper_dir/make"
    printf '%s\n' '[ -f .fixture-prefix ] || exec "$REAL_MAKE" "$@"' >>"$wrapper_dir/make"
    printf '%s\n' 'is_install=0' >>"$wrapper_dir/make"
    printf '%s\n' 'destination_root=' >>"$wrapper_dir/make"
    printf '%s\n' 'for arg in "$@"; do' >>"$wrapper_dir/make"
    printf '%s\n' '    [ "$arg" = install ] && is_install=1' >>"$wrapper_dir/make"
    printf '%s\n' '    case "$arg" in DESTDIR=*) destination_root=${arg#DESTDIR=} ;; esac' >>"$wrapper_dir/make"
    printf '%s\n' 'done' >>"$wrapper_dir/make"
    printf '%s\n' '[ "$is_install" = 1 ] || exit 0' >>"$wrapper_dir/make"
    printf '%s\n' 'prefix="$destination_root$(cat .fixture-prefix)"' >>"$wrapper_dir/make"
    printf '%s\n' 'mkdir -p "$prefix/include" "$prefix/lib/pkgconfig"' >>"$wrapper_dir/make"
    printf '%s\n' 'printf "%s\\n" "$FIXTURE_GENERATION" >"$prefix/include/seccomp.h"' >>"$wrapper_dir/make"
    printf '%s\n' 'printf "%s\\n" "$FIXTURE_GENERATION" >"$prefix/include/seccomp-syscalls.h"' >>"$wrapper_dir/make"
    printf '%s\n' 'if [ "${FIXTURE_BLOCK:-0}" = 1 ]; then' >>"$wrapper_dir/make"
    printf '%s\n' '    printf "%s\\n" ready >"$FIXTURE_EVENT_FIFO"' >>"$wrapper_dir/make"
    printf '%s\n' '    IFS= read -r _ <"$FIXTURE_RELEASE_FIFO"' >>"$wrapper_dir/make"
    printf '%s\n' 'fi' >>"$wrapper_dir/make"
    printf '%s\n' 'payload_dir=$(mktemp -d)' >>"$wrapper_dir/make"
    printf '%s\n' 'printf "%s\\n" "$FIXTURE_GENERATION" >"$payload_dir/fixture-payload"' >>"$wrapper_dir/make"
    printf '%s\n' '(cd "$payload_dir" && "$REAL_AR" rcs "$prefix/lib/libseccomp.a" fixture-payload)' >>"$wrapper_dir/make"
    printf '%s\n' 'rm -rf "$payload_dir"' >>"$wrapper_dir/make"
    printf '%s\n' 'printf "%s\\n" "$FIXTURE_GENERATION" >"$prefix/lib/pkgconfig/libseccomp.pc"' >>"$wrapper_dir/make"
    chmod +x "$wrapper_dir/make"

    local event_fifo="$work_dir/event.fifo"
    local release_fifo="$work_dir/release.fifo"
    mkfifo "$event_fifo" "$release_fifo"
    exec 8<>"$event_fifo"
    exec 9<>"$release_fifo"
    local target="x86_64-unknown-linux-musl"
    local common_script='\
        source "$1"; \
        target_to_arch() { printf "%s\\n" x86_64; }; \
        resolve_musl_cc() { command -v true; }; \
        resolve_musl_tool() { \
            case "$2" in ar) command -v ar ;; ranlib) command -v ranlib ;; *) return 1 ;; esac; \
        }; \
        ensure_libseccomp_for_target x86_64-unknown-linux-musl'
    local real_ar real_make
    real_ar=$(command -v ar)
    real_make=$(command -v make)

    perl -MPOSIX -e 'POSIX::setsid() >= 0 or die "setsid: $!"; exec @ARGV or die "exec: $!"' env \
        PATH="$wrapper_dir:$REAL_PATH" \
        REAL_AR="$real_ar" \
        REAL_MAKE="$real_make" \
        FIXTURE_TARBALL="$work_dir/libseccomp.tar.gz" \
        FIXTURE_GENERATION=A \
        FIXTURE_BLOCK=1 \
        FIXTURE_EVENT_FIFO="$event_fifo" \
        FIXTURE_RELEASE_FIFO="$release_fifo" \
        BOXLITE_CACHE="$cache_dir" \
        LINUX_HEADERS_VERSION="$headers_version" \
        LINUX_HEADERS_SHA256="$headers_sha" \
        LINUX_HEADERS_SOURCE_TARBALL="$work_dir/kernel-headers.tar.gz" \
        LIBSECCOMP_VERSION="$lib_version" \
        LIBSECCOMP_TARBALL_SHA256="$lib_sha" \
        LIBSECCOMP_SOURCE_TARBALL="$work_dir/libseccomp.tar.gz" \
        bash -c "$common_script" _ "$BUILD_SCRIPT" >"$work_dir/worker-a.log" 2>&1 &
    worker_pid=$!

    IFS= read -r -t 10 -u 8 event || {
        cat "$work_dir/worker-a.log" >&2
        fail "timed out waiting for the first libseccomp install"
    }
    [ "$event" = ready ] || fail "unexpected libseccomp concurrency event: $event"

    PATH="$wrapper_dir:$REAL_PATH" \
    REAL_AR="$real_ar" \
    REAL_MAKE="$real_make" \
    FIXTURE_TARBALL="$work_dir/libseccomp.tar.gz" \
    FIXTURE_GENERATION=B \
    FIXTURE_BLOCK=0 \
    BOXLITE_CACHE="$cache_dir" \
    LINUX_HEADERS_VERSION="$headers_version" \
    LINUX_HEADERS_SHA256="$headers_sha" \
    LINUX_HEADERS_SOURCE_TARBALL="$work_dir/kernel-headers.tar.gz" \
    LIBSECCOMP_VERSION="$lib_version" \
    LIBSECCOMP_TARBALL_SHA256="$lib_sha" \
    LIBSECCOMP_SOURCE_TARBALL="$work_dir/libseccomp.tar.gz" \
        bash -c "$common_script" _ "$BUILD_SCRIPT" >"$work_dir/worker-b.log" 2>&1 || {
            cat "$work_dir/worker-b.log" >&2
            fail "second libseccomp cache worker failed"
        }

    printf '%s\n' go >&9
    wait "$worker_pid" || {
        cat "$work_dir/worker-a.log" >&2
        fail "first libseccomp cache worker failed"
    }
    worker_pid=""

    local cache_root="$cache_dir/libseccomp/$target/$lib_version"
    local include_generation archive_generation pkgconfig_generation
    include_generation=$(cat "$cache_root/include/seccomp.h")
    archive_generation=$(ar p "$cache_root/lib/libseccomp.a" fixture-payload)
    pkgconfig_generation=$(cat "$cache_root/lib/pkgconfig/libseccomp.pc")
    if [ "$include_generation" != "$archive_generation" ] || \
       [ "$include_generation" != "$pkgconfig_generation" ]; then
        fail "concurrent libseccomp installs exposed a mixed generation: include=$include_generation archive=$archive_generation pkgconfig=$pkgconfig_generation"
    fi

    exec 8>&-
    exec 9>&-
    trap - RETURN
    cleanup_libseccomp_concurrency
}

case_libseccomp_failure_cleanup() {
    local work_dir
    work_dir=$(mktemp -d -t boxlite-native-cache-lib-cleanup-XXXXXX)
    trap 'rm -rf "$work_dir"' RETURN
    local headers_version="fixture-headers-lib-cleanup"
    local lib_version="fixture-lib-cleanup"
    make_header_fixture "$work_dir" "$headers_version"
    make_libseccomp_fixture "$work_dir" "$lib_version"
    local headers_sha lib_sha
    headers_sha=$(sha256_file "$work_dir/kernel-headers.tar.gz")
    lib_sha=$(sha256_file "$work_dir/libseccomp.tar.gz")
    local cache_dir="$work_dir/cache"
    prepare_headers_for_lib_test \
        "$cache_dir" "$work_dir/kernel-headers.tar.gz" "$headers_version" "$headers_sha"

    local wrapper_dir="$work_dir/bin"
    make_download_wrappers "$wrapper_dir"
    printf '%s\n' '#!/bin/sh' 'exit 74' >"$wrapper_dir/tar"
    chmod +x "$wrapper_dir/tar"
    mkdir -p "$work_dir/tmp"

    set +e
    PATH="$wrapper_dir:$REAL_PATH" \
    FIXTURE_TARBALL="$work_dir/libseccomp.tar.gz" \
    TMPDIR="$work_dir/tmp" \
    BOXLITE_CACHE="$cache_dir" \
    LINUX_HEADERS_VERSION="$headers_version" \
    LINUX_HEADERS_SHA256="$headers_sha" \
    LINUX_HEADERS_SOURCE_TARBALL="$work_dir/kernel-headers.tar.gz" \
    LIBSECCOMP_VERSION="$lib_version" \
    LIBSECCOMP_TARBALL_SHA256="$lib_sha" \
    LIBSECCOMP_SOURCE_TARBALL="$work_dir/libseccomp.tar.gz" \
        bash -c '
            source "$1"
            target_to_arch() { printf "%s\n" x86_64; }
            resolve_musl_cc() { command -v true; }
            resolve_musl_tool() {
                case "$2" in ar) command -v ar ;; ranlib) command -v ranlib ;; *) return 1 ;; esac
            }
            ensure_libseccomp_for_target x86_64-unknown-linux-musl
        ' _ "$BUILD_SCRIPT" >"$work_dir/failure.log" 2>&1
    local status=$?
    set -e
    [ "$status" -ne 0 ] || fail "libseccomp extraction failure unexpectedly succeeded"
    if find "$work_dir/tmp" -mindepth 1 -print -quit | grep -q .; then
        fail "libseccomp extraction failure leaked its build workspace"
    fi
    if find "$cache_dir/libseccomp" -name '.staging-*' -print -quit 2>/dev/null | grep -q .; then
        fail "libseccomp extraction failure leaked cache staging"
    fi
    if find "$cache_dir/libseccomp" -name '.install-*' -print -quit 2>/dev/null | grep -q .; then
        fail "libseccomp extraction failure leaked its install workspace"
    fi
    trap - RETURN
    rm -rf "$work_dir"
}

case_headers_bitflip_recovery() {
    local work_dir
    work_dir=$(mktemp -d -t boxlite-native-cache-headers-bitflip-XXXXXX)
    trap 'rm -rf "$work_dir"' RETURN
    local version="fixture-headers-bitflip"
    make_header_fixture "$work_dir" "$version"
    local fixture_tarball="$work_dir/kernel-headers.tar.gz"
    local fixture_sha
    fixture_sha=$(sha256_file "$fixture_tarball")
    local cache_dir="$work_dir/cache"
    provision_headers "$cache_dir" "$fixture_tarball" "$version" "$fixture_sha"
    local cache_root="$cache_dir/linux-headers/$version/x86_64"
    local first_generation first_content_id path_content_id second_generation second_content_id
    first_generation=$(readlink "$cache_root")
    first_content_id=$(
        BOXLITE_CACHE="$cache_dir" \
        LINUX_HEADERS_VERSION="$version" \
        LINUX_HEADERS_SHA256="$fixture_sha" \
        LINUX_HEADERS_SOURCE_TARBALL="$fixture_tarball" \
            bash -c 'source "$1"; linux_headers_content_id_for_arch x86_64' _ "$BUILD_SCRIPT"
    )
    case "$first_content_id" in
        *[!0-9a-f]*) fail "Linux-header content ID is not a SHA-256 digest: $first_content_id" ;;
    esac
    [ "${#first_content_id}" -eq 64 ] || fail "Linux-header content ID has the wrong length"
    path_content_id=$(
        BOXLITE_CACHE="$cache_dir" \
        LINUX_HEADERS_VERSION="$version" \
        LINUX_HEADERS_SHA256="$fixture_sha" \
            bash -c 'source "$1"; linux_headers_content_id_for_path "$2"' \
                _ "$BUILD_SCRIPT" "$cache_root/include"
    )
    [ "$path_content_id" = "$first_content_id" ] || \
        fail "path-specific Linux-header content ID disagrees with the ensured generation"

    printf '%s\n' BITFLIPPED >"$cache_root/include/linux/extra.h"
    printf '%s\n' ROGUE >"$cache_root/include/linux/rogue.h"
    rm "$cache_root/include/linux/audit-link.h"
    ln -s extra.h "$cache_root/include/linux/audit-link.h"
    provision_headers "$cache_dir" "$fixture_tarball" "$version" "$fixture_sha"

    second_generation=$(readlink "$cache_root")
    [ "$second_generation" != "$first_generation" ] || \
        fail "header corruption recovery did not atomically replace the current generation"
    [ "$(cat "$cache_root/include/linux/extra.h")" = EXTRA_GOOD ] || \
        fail "header bitflip was not repaired"
    [ ! -e "$cache_root/include/linux/rogue.h" ] || \
        fail "unlisted header survived exact-manifest recovery"
    [ "$(readlink "$cache_root/include/linux/audit-link.h")" = audit.h ] || \
        fail "header symlink target was not repaired"
    second_content_id=$(
        BOXLITE_CACHE="$cache_dir" \
        LINUX_HEADERS_VERSION="$version" \
        LINUX_HEADERS_SHA256="$fixture_sha" \
        LINUX_HEADERS_SOURCE_TARBALL="$fixture_tarball" \
            bash -c 'source "$1"; linux_headers_content_id_for_arch x86_64' _ "$BUILD_SCRIPT"
    )
    [ "$second_content_id" = "$first_content_id" ] || \
        fail "recovered Linux-header content ID is unstable"

    rm "$fixture_tarball"
    provision_headers "$cache_dir" "$fixture_tarball" "$version" "$fixture_sha" || \
        fail "verified Linux-header cache hit tried to read its removed source tarball"
    trap - RETURN
    rm -rf "$work_dir"
}

case_libseccomp_bitflip_recovery() {
    local work_dir
    work_dir=$(mktemp -d -t boxlite-native-cache-lib-bitflip-XXXXXX)
    trap 'rm -rf "$work_dir"' RETURN
    local headers_version="fixture-headers-lib-bitflip"
    local lib_version="fixture-lib-bitflip"
    make_header_fixture "$work_dir" "$headers_version"
    make_libseccomp_fixture "$work_dir" "$lib_version"
    local headers_sha lib_sha
    headers_sha=$(sha256_file "$work_dir/kernel-headers.tar.gz")
    lib_sha=$(sha256_file "$work_dir/libseccomp.tar.gz")
    local cache_dir="$work_dir/cache"
    provision_libseccomp \
        "$cache_dir" "$work_dir/kernel-headers.tar.gz" "$headers_version" "$headers_sha" \
        "$work_dir/libseccomp.tar.gz" "$lib_version" "$lib_sha"
    local cache_root="$cache_dir/libseccomp/x86_64-unknown-linux-musl/$lib_version"
    local first_generation second_generation third_generation
    first_generation=$(readlink "$cache_root")

    printf '%s\n' BITFLIPPED >"$cache_root/lib/libseccomp.a"
    provision_libseccomp \
        "$cache_dir" "$work_dir/kernel-headers.tar.gz" "$headers_version" "$headers_sha" \
        "$work_dir/libseccomp.tar.gz" "$lib_version" "$lib_sha"
    second_generation=$(readlink "$cache_root")
    [ "$second_generation" != "$first_generation" ] || \
        fail "libseccomp archive corruption did not replace the current generation"
    ar p "$cache_root/lib/libseccomp.a" fixture-payload | grep -qx LIB_GOOD || \
        fail "libseccomp archive bitflip was not repaired"

    printf '%s\n' BITFLIPPED >"$cache_root/CACHE-METADATA"
    provision_libseccomp \
        "$cache_dir" "$work_dir/kernel-headers.tar.gz" "$headers_version" "$headers_sha" \
        "$work_dir/libseccomp.tar.gz" "$lib_version" "$lib_sha"
    third_generation=$(readlink "$cache_root")
    [ "$third_generation" != "$second_generation" ] || \
        fail "libseccomp metadata corruption did not replace the current generation"
    grep -qx 'source=seccomp/libseccomp' "$cache_root/CACHE-METADATA" || \
        fail "libseccomp metadata bitflip was not repaired"

    rm "$work_dir/kernel-headers.tar.gz" "$work_dir/libseccomp.tar.gz"
    provision_libseccomp \
        "$cache_dir" "$work_dir/kernel-headers.tar.gz" "$headers_version" "$headers_sha" \
        "$work_dir/libseccomp.tar.gz" "$lib_version" "$lib_sha" || \
        fail "verified libseccomp cache hit tried to read a removed source tarball"
    trap - RETURN
    rm -rf "$work_dir"
}

case_libseccomp_build_tool_identity() {
    local work_dir
    work_dir=$(mktemp -d -t boxlite-native-cache-lib-tools-XXXXXX)
    trap 'rm -rf "$work_dir"' RETURN
    local headers_version="fixture-headers-lib-tools"
    local lib_version="fixture-lib-tools"
    make_header_fixture "$work_dir" "$headers_version"
    make_libseccomp_fixture "$work_dir" "$lib_version"
    local headers_sha lib_sha
    headers_sha=$(sha256_file "$work_dir/kernel-headers.tar.gz")
    lib_sha=$(sha256_file "$work_dir/libseccomp.tar.gz")
    local cache_dir="$work_dir/cache"
    provision_libseccomp \
        "$cache_dir" "$work_dir/kernel-headers.tar.gz" "$headers_version" "$headers_sha" \
        "$work_dir/libseccomp.tar.gz" "$lib_version" "$lib_sha"
    local cache_root="$cache_dir/libseccomp/x86_64-unknown-linux-musl/$lib_version"
    local first_generation second_generation
    local first_headers_generation second_headers_generation
    first_generation=$(readlink "$cache_root")
    first_headers_generation=$(
        readlink "$cache_dir/linux-headers/$headers_version/x86_64"
    )

    local wrapper_dir="$work_dir/build-tools"
    mkdir -p "$wrapper_dir"
    ln -s "$(command -v gperf)" "$wrapper_dir/gperf"
    ln -s "$(command -v make)" "$wrapper_dir/make"
    provision_libseccomp \
        "$cache_dir" "$work_dir/kernel-headers.tar.gz" "$headers_version" "$headers_sha" \
        "$work_dir/libseccomp.tar.gz" "$lib_version" "$lib_sha" \
        "$wrapper_dir:$REAL_PATH"
    second_generation=$(readlink "$cache_root")
    second_headers_generation=$(
        readlink "$cache_dir/linux-headers/$headers_version/x86_64"
    )
    [ "$second_generation" != "$first_generation" ] || \
        fail "gperf/make identity change reused the previous libseccomp cache"
    [ "$second_headers_generation" != "$first_headers_generation" ] || \
        fail "make identity change reused the previous Linux-header cache"
    grep -qx "gperf-path=$wrapper_dir/gperf" "$cache_root/CACHE-IDENTITY" || \
        fail "libseccomp identity does not record the resolved gperf path"
    grep -qx "make-path=$wrapper_dir/make" "$cache_root/CACHE-IDENTITY" || \
        fail "libseccomp identity does not record the resolved make path"
    trap - RETURN
    rm -rf "$work_dir"
}

case_source_safe() {
    bash -c '
        set +e
        set +u
        original_options=$-
        original_cwd=$(pwd -P)
        trap : EXIT
        original_trap=$(trap -p EXIT)
        source "$1"
        [ "$-" = "$original_options" ] || exit 81
        [ "$(pwd -P)" = "$original_cwd" ] || exit 82
        [ "$(trap -p EXIT)" = "$original_trap" ] || exit 83
    ' _ "$BUILD_SCRIPT" || fail "sourcing build-libseccomp changed caller options, cwd, or traps"
}

run_case() {
    case "$1" in
        headers-partial) case_headers_partial ;;
        libseccomp-partial) case_libseccomp_partial ;;
        headers-concurrency) case_headers_concurrency ;;
        headers-failure-cleanup) case_headers_failure_cleanup ;;
        libseccomp-concurrency) case_libseccomp_concurrency ;;
        libseccomp-failure-cleanup) case_libseccomp_failure_cleanup ;;
        headers-bitflip-recovery) case_headers_bitflip_recovery ;;
        libseccomp-bitflip-recovery) case_libseccomp_bitflip_recovery ;;
        libseccomp-build-tool-identity) case_libseccomp_build_tool_identity ;;
        generation-gc) case_generation_gc ;;
        headers-reader-gc) case_headers_reader_gc ;;
        headers-content-id-selection-lease) case_headers_content_id_selection_lease ;;
        libseccomp-headers-content-id-lease) case_libseccomp_headers_content_id_lease ;;
        libseccomp-headers-snapshot-lease) case_libseccomp_headers_snapshot_lease ;;
        headers-hit-transaction-retry) case_headers_hit_transaction_retry ;;
        headers-publish-transaction-retry) case_headers_publish_transaction_retry ;;
        libseccomp-consumer-lease) case_libseccomp_consumer_lease ;;
        libseccomp-ensure-transaction-retry) case_libseccomp_ensure_transaction_retry ;;
        source-safe) case_source_safe ;;
        *) fail "unknown case: $1" ;;
    esac
}

if [ "$#" -gt 0 ]; then
    run_case "$1"
else
    for test_case in \
        headers-partial \
        libseccomp-partial \
        headers-concurrency \
        headers-failure-cleanup \
        libseccomp-concurrency \
        libseccomp-failure-cleanup \
        headers-bitflip-recovery \
        libseccomp-bitflip-recovery \
        libseccomp-build-tool-identity \
        generation-gc \
        headers-reader-gc \
        headers-content-id-selection-lease \
        libseccomp-headers-content-id-lease \
        libseccomp-headers-snapshot-lease \
        headers-hit-transaction-retry \
        headers-publish-transaction-retry \
        libseccomp-consumer-lease \
        libseccomp-ensure-transaction-retry \
        source-safe
    do
        echo "==> $test_case"
        run_case "$test_case"
    done
fi

echo "guest native cache tests passed"
