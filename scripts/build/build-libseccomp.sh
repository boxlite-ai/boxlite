#!/bin/bash
# Build and cache Linux UAPI headers and static libseccomp for guest musl targets.
#
# Public functions:
#   ensure_linux_headers_for_arch ARCH
#       Selects and prints a verified physical generation. The returned path has
#       no reader lease; consumers must use with_linux_headers_for_arch.
#   with_linux_headers_for_arch ARCH CALLBACK [ARG ...]
#       Invokes CALLBACK with the selected include path while holding that
#       generation's reader lease for the callback's complete lifetime.
#   linux_headers_content_id_for_arch ARCH
#       Prints a stable SHA-256 identity for the verified include tree.
#   linux_headers_content_id_for_path INCLUDE_DIR
#       Verifies an immutable generation and hashes that exact include path.
#   snapshot_linux_headers_for_path INCLUDE_DIR DESTINATION
#       Copies one leased generation into a private consumer-owned snapshot.
#   snapshot_linux_headers_for_arch ARCH DESTINATION
#       Ensures and snapshots the current generation for a long-lived consumer.
#   ensure_libseccomp_for_target TARGET
#       Exports LIBSECCOMP_LIB_PATH, LIBSECCOMP_INCLUDE_PATH, and
#       LIBSECCOMP_LINK_TYPE for one fully verified physical generation.
#   with_libseccomp_for_target TARGET CALLBACK [ARG ...]
#       Invokes CALLBACK with that environment while holding the generation's
#       reader lease. Long-lived consumers such as Cargo must use this facade.
#
# The file is intentionally source-safe: shell options, traps, and cwd belong to
# the caller. Cleanup traps are confined to subshells.

_BUILD_LIBSECCOMP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_BOXLITE_CACHE="$(cd "$_BUILD_LIBSECCOMP_DIR/../.." && pwd)/target/native"

LIBSECCOMP_VERSION="${LIBSECCOMP_VERSION:-2.5.5}"
LIBSECCOMP_TARBALL_SHA256="${LIBSECCOMP_TARBALL_SHA256:-248a2c8a4d9b9858aa6baf52712c34afefcf9c9e94b76dce02c1c9aa25fb3375}"

# sabotage-linux/kernel-headers is a small portable export of Linux user-space
# headers. musl-cross supplies libc headers, but not asm/ or linux/ UAPI headers.
LINUX_HEADERS_VERSION="${LINUX_HEADERS_VERSION:-4.19.88-2}"
LINUX_HEADERS_SHA256="${LINUX_HEADERS_SHA256:-16161844e56944d39794ad74c2dfd6faad12bda79b5dc00595f4178d28a92e2d}"

_NATIVE_CACHE_SCHEMA="boxlite-native-cache-v1"
_NATIVE_CACHE_MANIFEST="CACHE-MANIFEST"
_NATIVE_CACHE_IDENTITY="CACHE-IDENTITY"
_NATIVE_CACHE_METADATA="CACHE-METADATA"
_NATIVE_CACHE_LEASE="CACHE-LEASE"
_NATIVE_CACHE_SELECTION_MAX_ATTEMPTS=3

_native_cache_validate_component() {
    local label="$1"
    local value="$2"
    case "$value" in
        ""|.|..|*/*|*$'\n'*|*$'\t'*)
            echo "ERROR: invalid $label cache key: $value" >&2
            return 1
            ;;
    esac
}

_native_cache_sha256_file() {
    local file_path="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$file_path" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$file_path" | awk '{print $1}'
    else
        echo "ERROR: sha256sum or shasum is required" >&2
        return 1
    fi
}

_native_cache_tool_version() {
    local tool_path="$1"
    local version_line
    version_line=$("$tool_path" --version 2>/dev/null | sed -n '1p') || version_line=""
    if [ -n "$version_line" ]; then
        printf '%s\n' "$version_line"
    else
        printf '%s\n' unknown
    fi
}

_native_cache_fetch() {
    local url="$1"
    local destination="$2"
    local local_tarball="$3"

    if [ -n "$local_tarball" ]; then
        if [ ! -f "$local_tarball" ]; then
            echo "ERROR: local source tarball does not exist: $local_tarball" >&2
            return 1
        fi
        cp "$local_tarball" "$destination"
    elif command -v curl >/dev/null 2>&1; then
        curl -fsSL "$url" -o "$destination"
    elif command -v wget >/dev/null 2>&1; then
        wget -q "$url" -O "$destination"
    else
        echo "ERROR: curl or wget is required to download $url" >&2
        return 1
    fi
}

_native_cache_unpack_source() {
    local source_name="$1"
    local url="$2"
    local local_tarball="$3"
    local expected_sha256="$4"
    local tarball="$5"
    local build_root="$6"
    local source_dir="$7"
    local actual_sha256

    _native_cache_fetch "$url" "$tarball" "$local_tarball" || return 1
    actual_sha256=$(_native_cache_sha256_file "$tarball") || return 1
    if [ "$actual_sha256" != "$expected_sha256" ]; then
        echo "ERROR: $source_name tarball SHA256 mismatch" >&2
        echo "  expected: $expected_sha256" >&2
        echo "  actual:   $actual_sha256" >&2
        return 1
    fi
    tar -xzf "$tarball" -C "$build_root" || return 1
    [ -d "$source_dir" ] || {
        echo "ERROR: $source_name archive has no expected source directory" >&2
        return 1
    }
}

_native_cache_resolve_root() {
    local cache_root="$1"
    [ -d "$cache_root" ] || return 1
    (cd "$cache_root" && pwd -P)
}

# Write a canonical inventory of every directory, symlink target, and regular
# file hash below ROOT. A single Perl traversal makes lstat/open failures part of
# the return status instead of hiding them behind shell process substitution.
_native_cache_write_inventory() {
    local cache_root="$1"
    local output_file="$2"
    perl -MDigest::SHA -MFile::Find -MCwd=abs_path -e '
        use strict;
        use warnings;
        my ($root_arg, $output, $manifest_name, $lease_name) = @ARGV;
        my $root = abs_path($root_arg);
        defined($root) && -d $root or die "invalid cache root: $root_arg\n";
        my @inventory;
        find(
            {
                no_chdir => 1,
                wanted => sub {
                    my $path = $File::Find::name;
                    return if $path eq $root;
                    my $relative = substr($path, length($root) + 1);
                    return if $relative eq $manifest_name || $relative eq $lease_name;
                    $relative !~ /[\t\n]/
                        or die "cache path contains a tab or newline\n";
                    lstat($path) or die "lstat $path: $!\n";
                    if (-l _) {
                        my $target = readlink($path);
                        defined($target) or die "readlink $path: $!\n";
                        $target !~ /[\t\n]/
                            or die "symlink target contains a tab or newline\n";
                        push @inventory, "L\t$relative\t$target\n";
                    } elsif (-d _) {
                        push @inventory, "D\t$relative\n";
                    } elsif (-f _) {
                        open(my $file, "<", $path) or die "open $path: $!\n";
                        binmode($file);
                        my $digest = Digest::SHA->new(256);
                        $digest->addfile($file);
                        close($file) or die "close $path: $!\n";
                        push @inventory,
                            "F\t" . $digest->hexdigest . "\t$relative\n";
                    } else {
                        die "unsupported cache entry: $relative\n";
                    }
                },
            },
            $root,
        );
        open(my $result, ">", $output) or die "open $output: $!\n";
        binmode($result);
        print {$result} sort @inventory or die "write $output: $!\n";
        close($result) or die "close $output: $!\n";
    ' "$cache_root" "$output_file" "$_NATIVE_CACHE_MANIFEST" "$_NATIVE_CACHE_LEASE"
}

_native_cache_seal_tree() (
    local cache_root="$1"
    local cache_parent
    local manifest_temp

    cache_parent=$(dirname "$cache_root") || return 1
    manifest_temp=$(mktemp "$cache_parent/.native-manifest.XXXXXX") || return 1
    cleanup_manifest_temp() {
        rm -f "$manifest_temp"
    }
    trap cleanup_manifest_temp EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM

    : >"$cache_root/$_NATIVE_CACHE_LEASE" || return 1
    chmod 0644 "$cache_root/$_NATIVE_CACHE_LEASE" || return 1
    _native_cache_write_inventory "$cache_root" "$manifest_temp" || return 1
    mv -f "$manifest_temp" "$cache_root/$_NATIVE_CACHE_MANIFEST" || return 1
)

_native_cache_validate_tree() (
    local cache_root="$1"
    local resolved_root
    local manifest_file
    local manifest_temp

    resolved_root=$(_native_cache_resolve_root "$cache_root") || return 1
    manifest_file="$resolved_root/$_NATIVE_CACHE_MANIFEST"
    [ -f "$manifest_file" ] && [ ! -L "$manifest_file" ]

    manifest_temp=$(mktemp "${TMPDIR:-/tmp}/boxlite-native-manifest.XXXXXX") || return 1
    cleanup_manifest_temp() {
        rm -f "$manifest_temp"
    }
    trap cleanup_manifest_temp EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM

    _native_cache_write_inventory "$resolved_root" "$manifest_temp" || return 1
    cmp -s "$manifest_temp" "$manifest_file"
)

_native_cache_content_id() (
    local content_root="$1"
    local inventory_temp

    inventory_temp=$(mktemp "${TMPDIR:-/tmp}/boxlite-native-content.XXXXXX") || return 1
    cleanup_inventory_temp() {
        rm -f "$inventory_temp"
    }
    trap cleanup_inventory_temp EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM

    _native_cache_write_inventory "$content_root" "$inventory_temp" || return 1
    _native_cache_sha256_file "$inventory_temp"
)

# Hold a shared flock on a generation-owned control file while CALLBACK uses
# that physical generation. The helper process owns the lock until this
# subshell closes its release channel, which works with both Linux and macOS
# flock semantics and leaves the caller's descriptors and traps untouched.
_native_cache_with_generation_lease() (
    if [ "$#" -lt 2 ]; then
        echo "ERROR: _native_cache_with_generation_lease requires a generation and callback" >&2
        return 2
    fi

    local generation_root="$1"
    local callback="$2"
    shift 2
    local resolved_generation
    local lease_path
    local channel_dir=""
    local ready_fifo
    local release_fifo
    local release_fd=""
    local lease_pid=""
    local lease_status=0
    local callback_status=0

    resolved_generation=$(_native_cache_resolve_root "$generation_root") || return 1
    lease_path="$resolved_generation/$_NATIVE_CACHE_LEASE"
    : >>"$lease_path" || return 1

    channel_dir=$(mktemp -d "${TMPDIR:-/tmp}/boxlite-native-lease.XXXXXX") || return 1
    ready_fifo="$channel_dir/ready.fifo"
    release_fifo="$channel_dir/release.fifo"
    cleanup_generation_lease() {
        if [ -n "$release_fd" ]; then
            eval "exec ${release_fd}>&-" 2>/dev/null || true
            release_fd=""
        fi
        if [ -n "$lease_pid" ]; then
            kill "$lease_pid" 2>/dev/null || true
            wait "$lease_pid" 2>/dev/null || true
            lease_pid=""
        fi
        [ -z "$channel_dir" ] || rm -rf "$channel_dir"
    }
    trap cleanup_generation_lease EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM

    mkfifo "$ready_fifo" "$release_fifo" || return 1
    release_fd=$(_native_cache_find_free_fd) || return 1
    eval "exec ${release_fd}<>\"\$release_fifo\"" || return 1
    perl -MFcntl=:flock -e '
        use strict;
        use warnings;
        use POSIX ();
        my ($lease_path, $release_path, $release_fd) = @ARGV;
        open(my $lease, ">>", $lease_path) or exit 71;
        flock($lease, LOCK_SH) or exit 72;
        open(my $release, "<", $release_path) or exit 73;
        POSIX::close(0 + $release_fd) == 0 or exit 74;
        my $event = "acquired\n";
        syswrite(STDOUT, $event, length($event)) == length($event) or exit 75;
        scalar(<$release>);
        exit 0;
    ' "$lease_path" "$release_fifo" "$release_fd" >"$ready_fifo" &
    lease_pid=$!

    local lease_event=""
    if ! IFS= read -r lease_event <"$ready_fifo" || [ "$lease_event" != acquired ]; then
        wait "$lease_pid" || lease_status=$?
        lease_pid=""
        echo "ERROR: failed to acquire native cache generation lease ($lease_status)" >&2
        return 1
    fi

    "$callback" "$resolved_generation" "$@" || callback_status=$?
    eval "exec ${release_fd}>&-"
    release_fd=""
    wait "$lease_pid" || lease_status=$?
    lease_pid=""
    if [ "$lease_status" -ne 0 ]; then
        echo "ERROR: failed to release native cache generation lease ($lease_status)" >&2
        return 1
    fi
    return "$callback_status"
)

_native_cache_copy_tree() {
    local source_root="$1"
    local destination_root="$2"
    mkdir -p "$destination_root" || return 1
    cp -a "$source_root/." "$destination_root/"
}

_native_cache_hash_verified_headers() {
    local resolved_generation="$1"
    local requested_include="$2"
    local resolved_include

    resolved_include=$(cd "$requested_include" && pwd -P) || return 1
    [ "$resolved_include" = "$resolved_generation/include" ] || {
        echo "ERROR: path is not a Linux-header generation include directory: $requested_include" >&2
        return 1
    }
    _native_cache_validate_tree "$resolved_generation" || {
        echo "ERROR: Linux-header generation failed verification: $resolved_generation" >&2
        return 1
    }
    grep -qx 'kind=linux-headers' "$resolved_generation/$_NATIVE_CACHE_IDENTITY" || {
        echo "ERROR: path does not belong to a Linux-header cache generation: $requested_include" >&2
        return 1
    }
    [ -f "$resolved_include/asm/unistd.h" ] || return 1
    [ -f "$resolved_include/linux/audit.h" ] || return 1
    _native_cache_content_id "$resolved_include"
}

_native_cache_snapshot_verified_headers() (
    local resolved_generation="$1"
    local requested_include="$2"
    local destination_root="$3"
    local destination_parent
    local snapshot_stage=""
    local content_id

    [ ! -e "$destination_root" ] && [ ! -L "$destination_root" ] || {
        echo "ERROR: Linux-header snapshot destination already exists: $destination_root" >&2
        return 1
    }
    _native_cache_hash_verified_headers "$resolved_generation" "$requested_include" \
        >/dev/null || return 1
    destination_parent=$(dirname "$destination_root") || return 1
    mkdir -p "$destination_parent" || return 1
    snapshot_stage=$(mktemp -d "$destination_parent/.headers-snapshot.XXXXXX") || return 1
    cleanup_header_snapshot_stage() {
        [ -z "$snapshot_stage" ] || rm -rf "$snapshot_stage"
    }
    trap cleanup_header_snapshot_stage EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM

    _native_cache_copy_tree "$resolved_generation/include" "$snapshot_stage" || return 1
    content_id=$(_native_cache_content_id "$snapshot_stage") || return 1
    _native_cache_atomic_rename "$snapshot_stage" "$destination_root" || return 1
    snapshot_stage=""
    printf '%s\n' "$content_id"
)

snapshot_linux_headers_for_path() (
    if [ "$#" -ne 2 ]; then
        echo "ERROR: snapshot_linux_headers_for_path requires include and destination paths" >&2
        return 2
    fi
    local include_dir="$1"
    local destination_root="$2"
    local resolved_include
    local generation_root

    resolved_include=$(cd "$include_dir" && pwd -P) || {
        echo "ERROR: Linux-header include directory does not exist: $include_dir" >&2
        return 1
    }
    generation_root=$(dirname "$resolved_include") || return 1
    _native_cache_with_generation_lease \
        "$generation_root" \
        _native_cache_snapshot_verified_headers \
        "$resolved_include" \
        "$destination_root"
)

_native_cache_same_generation() {
    local first_root="$1"
    local second_root="$2"
    local first_resolved
    local second_resolved

    _native_cache_validate_tree "$first_root" || return 1
    _native_cache_validate_tree "$second_root" || return 1
    first_resolved=$(_native_cache_resolve_root "$first_root") || return 1
    second_resolved=$(_native_cache_resolve_root "$second_root") || return 1
    cmp -s \
        "$first_resolved/$_NATIVE_CACHE_IDENTITY" \
        "$second_resolved/$_NATIVE_CACHE_IDENTITY" || return 1
    cmp -s \
        "$first_resolved/$_NATIVE_CACHE_MANIFEST" \
        "$second_resolved/$_NATIVE_CACHE_MANIFEST"
}

_native_cache_identity_matches() {
    local cache_root="$1"
    local expected_identity="$2"
    local resolved_root
    local actual_identity

    _native_cache_validate_tree "$cache_root" || return 1
    resolved_root=$(_native_cache_resolve_root "$cache_root") || return 1
    [ -f "$resolved_root/$_NATIVE_CACHE_METADATA" ] || return 1
    actual_identity=$(cat "$resolved_root/$_NATIVE_CACHE_IDENTITY") || return 1
    [ "$actual_identity" = "$expected_identity" ]
}

_native_cache_publish_validated_generation() {
    local source_name="$1"
    local staging_root="$2"
    local cache_root="$3"
    local lock_file="$4"
    local validator="$5"
    shift 5

    _native_cache_seal_tree "$staging_root" || return 1
    "$validator" "$staging_root" "$@" || {
        echo "ERROR: $source_name staging tree failed verification" >&2
        return 1
    }
    _native_cache_publish "$lock_file" "$staging_root" "$cache_root" || return 1
}

_native_cache_atomic_rename() {
    local source_path="$1"
    local destination_path="$2"
    perl -e '
        use strict;
        use warnings;
        rename($ARGV[0], $ARGV[1])
            or die "rename $ARGV[0] -> $ARGV[1]: $!\n";
    ' "$source_path" "$destination_path"
}

_native_cache_find_free_fd() {
    local candidate_fd=10
    while [ "$candidate_fd" -le 99 ]; do
        if ! eval ": <&${candidate_fd}" 2>/dev/null && \
           ! eval ": >&${candidate_fd}" 2>/dev/null; then
            printf '%s\n' "$candidate_fd"
            return 0
        fi
        candidate_fd=$((candidate_fd + 1))
    done
    return 1
}

# Move an unleased generation out of the reader-visible namespace while its
# generation-owned lease is held exclusively. A reader that resolved the old
# path before this rename either already owns a shared lease, or fails its
# post-lock validation and retries without ever traversing the quarantine.
_native_cache_quarantine_unleased_generation() {
    local generation_root="$1"
    local quarantine_root="$2"
    perl -MFcntl=:flock -e '
        use strict;
        use warnings;
        my ($generation, $quarantine, $lease_name) = @ARGV;
        open(my $lease, ">>", "$generation/$lease_name") or exit 71;
        flock($lease, LOCK_EX | LOCK_NB) or exit 75;
        rename($generation, $quarantine) or exit 72;
        exit 0;
    ' "$generation_root" "$quarantine_root" "$_NATIVE_CACHE_LEASE"
}

_native_cache_cleanup_controls_locked() {
    local cache_parent="$1"
    local orphan

    for orphan in "$cache_parent"/.publish-*; do
        [ -e "$orphan" ] || [ -L "$orphan" ] || continue
        if [ -L "$orphan" ] || [ -f "$orphan" ]; then
            rm -f -- "$orphan" || return 1
        else
            echo "ERROR: refusing to remove unexpected native cache publication entry: $orphan" >&2
            return 1
        fi
    done
    for orphan in "$cache_parent"/.invalid-*; do
        [ -e "$orphan" ] || [ -L "$orphan" ] || continue
        if [ -d "$orphan" ] && [ ! -L "$orphan" ]; then
            rm -rf -- "$orphan" || return 1
        elif [ -L "$orphan" ] || [ -f "$orphan" ]; then
            rm -f -- "$orphan" || return 1
        else
            echo "ERROR: refusing to remove unexpected native cache quarantine: $orphan" >&2
            return 1
        fi
    done
}

_native_cache_gc_locked() {
    local cache_root="$1"
    local cache_parent
    local generations_dir
    local current_generation=""
    local generation_root
    local generation_resolved
    local generation_name
    local quarantine_root
    local quarantine_status

    cache_parent=$(dirname "$cache_root") || return 1
    generations_dir="$cache_parent/.generations"
    _native_cache_cleanup_controls_locked "$cache_parent" || return 1
    [ -d "$generations_dir" ] || return 0

    for quarantine_root in "$generations_dir"/.gc-*; do
        [ -e "$quarantine_root" ] || [ -L "$quarantine_root" ] || continue
        rm -rf -- "$quarantine_root" || return 1
    done

    current_generation=$(_native_cache_resolve_root "$cache_root" 2>/dev/null) || \
        current_generation=""
    for generation_root in "$generations_dir"/generation-*; do
        [ -e "$generation_root" ] || [ -L "$generation_root" ] || continue
        [ -d "$generation_root" ] && [ ! -L "$generation_root" ] || {
            echo "ERROR: invalid native cache generation entry: $generation_root" >&2
            return 1
        }
        generation_resolved=$(cd "$generation_root" && pwd -P) || return 1
        if [ -n "$current_generation" ] && [ "$generation_resolved" = "$current_generation" ]; then
            continue
        fi

        generation_name=$(basename "$generation_root") || return 1
        quarantine_root="$generations_dir/.gc-$generation_name"
        rm -rf -- "$quarantine_root" || return 1
        quarantine_status=0
        _native_cache_quarantine_unleased_generation \
            "$generation_root" "$quarantine_root" || quarantine_status=$?
        case "$quarantine_status" in
            0)
                rm -rf -- "$quarantine_root" || return 1
                ;;
            75)
                # An active reader owns the generation. It remains eligible on
                # the next cache hit or publication after that lease ends.
                ;;
            *)
                echo "ERROR: failed to quarantine native cache generation: $generation_root" >&2
                return 1
                ;;
        esac
    done
}

# Called only by the lock-owning child mode at the end of this file.
_native_cache_publish_locked() {
    local staging_root="$1"
    local cache_root="$2"
    local cache_parent
    local generations_dir
    local staging_name
    local generation_name
    local generation_root
    local publish_link
    local old_cache_root=""

    cache_parent=$(dirname "$cache_root")
    _native_cache_gc_locked "$cache_root" || return 1

    _native_cache_validate_tree "$staging_root" || {
        echo "ERROR: refusing to publish an invalid native cache staging tree" >&2
        return 1
    }
    [ -f "$staging_root/$_NATIVE_CACHE_IDENTITY" ] || return 1

    if _native_cache_same_generation "$cache_root" "$staging_root"; then
        _native_cache_gc_locked "$cache_root" || return 1
        return 0
    fi

    generations_dir="$cache_parent/.generations"
    mkdir -p "$generations_dir" || return 1
    staging_name=$(basename "$staging_root")
    generation_name="generation-${staging_name#.}"
    generation_root="$generations_dir/$generation_name"
    publish_link="$cache_parent/.publish-${staging_name#.}"

    [ ! -e "$generation_root" ] && [ ! -L "$generation_root" ] || {
        echo "ERROR: native cache generation already exists: $generation_root" >&2
        return 1
    }
    _native_cache_atomic_rename "$staging_root" "$generation_root" || return 1
    rm -f "$publish_link" || return 1
    if ! ln -s ".generations/$generation_name" "$publish_link"; then
        rm -rf "$generation_root"
        return 1
    fi

    # New-format caches are symlinks and can be atomically replaced. An old
    # directory is never a valid committed generation (it has no manifest), so
    # quarantine it under the lock before installing the compatibility symlink.
    if [ -d "$cache_root" ] && [ ! -L "$cache_root" ]; then
        old_cache_root="$cache_parent/.invalid-${staging_name#.}"
        rm -rf "$old_cache_root"
        _native_cache_atomic_rename "$cache_root" "$old_cache_root" || return 1
    fi

    if ! _native_cache_atomic_rename "$publish_link" "$cache_root"; then
        if [ -n "$old_cache_root" ] && [ ! -e "$cache_root" ]; then
            _native_cache_atomic_rename "$old_cache_root" "$cache_root" || true
        fi
        return 1
    fi
    if [ -n "$old_cache_root" ]; then
        rm -rf "$old_cache_root" || return 1
    fi

    _native_cache_validate_tree "$cache_root" || {
        echo "ERROR: published native cache generation failed verification" >&2
        return 1
    }
    _native_cache_same_generation "$cache_root" "$generation_root" || return 1
    _native_cache_gc_locked "$cache_root"
}

# Perl owns the advisory lock and synchronously launches one cache transaction.
# The lock fd has FD_CLOEXEC cleared, so either side retains the flock if the
# other is killed while publication or collection is in progress.
_native_cache_run_locked() {
    local lock_file="$1"
    shift
    local script_path="$_BUILD_LIBSECCOMP_DIR/build-libseccomp.sh"

    mkdir -p "$(dirname "$lock_file")" || return 1
    perl -MFcntl=:flock,F_SETFD -e '
        use strict;
        use warnings;
        my ($lock_path, $script, @arguments) = @ARGV;
        open(my $lock_fh, ">>", $lock_path) or die "open $lock_path: $!\n";
        flock($lock_fh, LOCK_EX) or die "flock $lock_path: $!\n";
        defined(fcntl($lock_fh, F_SETFD, 0)) or die "fcntl $lock_path: $!\n";
        my $status = system {$script} $script, @arguments;
        if ($status == -1) {
            die "execute $script: $!\n";
        }
        if ($status & 127) {
            exit(128 + ($status & 127));
        }
        exit($status >> 8);
    ' "$lock_file" "$script_path" "$@"
}

_native_cache_publish() {
    local lock_file="$1"
    local staging_root="$2"
    local cache_root="$3"
    _native_cache_run_locked \
        "$lock_file" --native-cache-publish "$staging_root" "$cache_root"
}

_native_cache_collect() {
    local lock_file="$1"
    local cache_root="$2"
    _native_cache_run_locked "$lock_file" --native-cache-gc "$cache_root"
}

# Select one fully verified physical generation. MATCH_CALLBACK decides whether
# the mutable alias already has the requested identity, while BUILD_CALLBACK
# prepares and publishes that identity on a miss. Every alias change after that
# decision is converted into a bounded retry by resolving and validating the
# immutable generation only after locked collection.
_native_cache_select_generation() {
    local result_variable="$1"
    local cache_name="$2"
    local resource_key="$3"
    local cache_root="$4"
    local lock_file="$5"
    local match_callback="$6"
    local build_callback="$7"
    shift 7
    local attempt=1
    local candidate_generation

    while [ "$attempt" -le "$_NATIVE_CACHE_SELECTION_MAX_ATTEMPTS" ]; do
        if ! "$match_callback" "$cache_root" "$@"; then
            "$build_callback" "$cache_root" "$@" || return 1
        fi
        _native_cache_collect "$lock_file" "$cache_root" || return 1

        candidate_generation=$(_native_cache_resolve_root "$cache_root") || \
            candidate_generation=""
        if [ -n "$candidate_generation" ] && \
           "$match_callback" "$candidate_generation" "$@"; then
            printf -v "$result_variable" '%s' "$candidate_generation"
            return 0
        fi
        attempt=$((attempt + 1))
    done

    echo "ERROR: $cache_name cache changed repeatedly while provisioning $resource_key" >&2
    return 1
}

_native_cache_headers_identity() {
    local arch="$1"
    local make_path="$2"
    printf 'schema=%s\n' "$_NATIVE_CACHE_SCHEMA"
    printf 'kind=linux-headers\n'
    printf 'version=%s\n' "$LINUX_HEADERS_VERSION"
    printf 'source-sha256=%s\n' "$LINUX_HEADERS_SHA256"
    printf 'arch=%s\n' "$arch"
    printf 'make-path=%s\n' "$make_path"
    printf 'make-version=%s\n' "$(_native_cache_tool_version "$make_path")"
}

_native_cache_headers_metadata() {
    local arch="$1"
    local make_path="$2"
    printf 'source=sabotage-linux/kernel-headers\n'
    printf 'install=%s ARCH=%s prefix=<staging> install\n' "$make_path" "$arch"
}

_native_cache_headers_match_expected() {
    local cache_root="$1"
    local expected_identity="$2"
    local resolved_root

    _native_cache_identity_matches "$cache_root" "$expected_identity" || return 1
    resolved_root=$(_native_cache_resolve_root "$cache_root") || return 1
    [ -f "$resolved_root/include/asm/unistd.h" ] || return 1
    [ -f "$resolved_root/include/linux/audit.h" ] || return 1
}

_build_linux_headers_generation() (
    local cache_root="$1"
    local expected_identity="$2"
    local arch="$3"
    local make_path="$4"
    local cache_parent
    local build_root=""
    local staging_root=""
    local tarball
    local source_dir
    local url

    cache_parent=$(dirname "$cache_root") || return 1
    mkdir -p "$cache_parent" || return 1
    build_root=$(mktemp -d "${TMPDIR:-/tmp}/boxlite-kheaders.XXXXXX") || return 1
    staging_root=$(mktemp -d "$cache_parent/.staging-${arch}.XXXXXX") || {
        rm -rf "$build_root"
        return 1
    }
    cleanup_headers_build() {
        [ -z "$build_root" ] || rm -rf "$build_root"
        [ -z "$staging_root" ] || rm -rf "$staging_root"
    }
    trap cleanup_headers_build EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM

    tarball="$build_root/kernel-headers.tar.gz"
    url="https://github.com/sabotage-linux/kernel-headers/archive/refs/tags/v$LINUX_HEADERS_VERSION.tar.gz"
    echo "  → provisioning Linux headers $LINUX_HEADERS_VERSION for $arch" >&2
    source_dir="$build_root/kernel-headers-$LINUX_HEADERS_VERSION"
    _native_cache_unpack_source \
        kernel-headers \
        "$url" \
        "${LINUX_HEADERS_SOURCE_TARBALL:-}" \
        "$LINUX_HEADERS_SHA256" \
        "$tarball" \
        "$build_root" \
        "$source_dir" || return 1
    (
        cd "$source_dir" || exit 1
        "$make_path" ARCH="$arch" prefix="$staging_root" install >/dev/null
    ) || return 1

    _native_cache_headers_identity "$arch" "$make_path" \
        >"$staging_root/$_NATIVE_CACHE_IDENTITY" || return 1
    _native_cache_headers_metadata "$arch" "$make_path" \
        >"$staging_root/$_NATIVE_CACHE_METADATA" || return 1
    _native_cache_publish_validated_generation \
        kernel-headers \
        "$staging_root" \
        "$cache_root" \
        "$cache_parent/.$arch.lock" \
        _native_cache_headers_match_expected \
        "$expected_identity"
)

ensure_linux_headers_for_arch() (
    local arch="${1:-}"
    local cache_base
    local cache_parent
    local cache_root
    local resolved_root
    local expected_identity
    local make_path

    _native_cache_validate_component arch "$arch" || return 1
    case "$arch" in
        aarch64|x86_64) ;;
        *)
            echo "ERROR: unsupported Linux-header architecture: $arch" >&2
            return 1
            ;;
    esac
    _native_cache_validate_component linux-headers-version "$LINUX_HEADERS_VERSION" || return 1
    make_path=$(command -v make) || {
        echo "ERROR: make not found (Linux-header install dependency)" >&2
        return 1
    }
    expected_identity=$(_native_cache_headers_identity "$arch" "$make_path") || return 1

    cache_base="${BOXLITE_CACHE:-$DEFAULT_BOXLITE_CACHE}"
    mkdir -p "$cache_base" || return 1
    cache_base=$(cd "$cache_base" && pwd -P) || return 1
    cache_parent="$cache_base/linux-headers/$LINUX_HEADERS_VERSION"
    cache_root="$cache_parent/$arch"

    _native_cache_select_generation \
        resolved_root \
        Linux-header \
        "$arch" \
        "$cache_root" \
        "$cache_parent/.$arch.lock" \
        _native_cache_headers_match_expected \
        _build_linux_headers_generation \
        "$expected_identity" \
        "$arch" \
        "$make_path" || return 1
    printf '%s\n' "$resolved_root/include"
)

_native_cache_use_linux_headers_generation() {
    local resolved_generation="$1"
    local callback_marker_dir="$2"
    local callback="$3"
    shift 3
    local include_dir="$resolved_generation/include"

    _native_cache_hash_verified_headers "$resolved_generation" "$include_dir" \
        >/dev/null || return 1
    : >"$callback_marker_dir/started" || return 1
    ("$callback" "$include_dir" "$@")
}

with_linux_headers_for_arch() (
    if [ "$#" -lt 2 ]; then
        echo "ERROR: with_linux_headers_for_arch requires an arch and callback" >&2
        return 2
    fi

    local arch="$1"
    local callback="$2"
    shift 2
    local include_dir
    local generation_root
    local callback_marker_dir=""
    local attempt=1
    local lease_status=0

    cleanup_linux_headers_callback() {
        [ -z "$callback_marker_dir" ] || rm -rf "$callback_marker_dir"
    }
    trap cleanup_linux_headers_callback EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM

    while [ "$attempt" -le "$_NATIVE_CACHE_SELECTION_MAX_ATTEMPTS" ]; do
        include_dir=$(ensure_linux_headers_for_arch "$arch") || return 1
        generation_root=$(dirname "$include_dir") || return 1
        callback_marker_dir=$(mktemp -d \
            "${TMPDIR:-/tmp}/boxlite-linux-headers-callback.XXXXXX") || return 1
        lease_status=0
        _native_cache_with_generation_lease \
            "$generation_root" \
            _native_cache_use_linux_headers_generation \
            "$callback_marker_dir" \
            "$callback" \
            "$@" || lease_status=$?
        if [ -e "$callback_marker_dir/started" ]; then
            return "$lease_status"
        fi
        rm -rf "$callback_marker_dir"
        callback_marker_dir=""
        attempt=$((attempt + 1))
    done

    echo "ERROR: Linux-header generation changed repeatedly before consumer start" >&2
    return 1
)

_native_cache_content_id_for_leased_linux_headers() {
    local include_dir="$1"
    local generation_root

    generation_root=$(dirname "$include_dir") || return 1
    _native_cache_hash_verified_headers "$generation_root" "$include_dir"
}

_native_cache_snapshot_leased_linux_headers() {
    local include_dir="$1"
    local destination_root="$2"
    local generation_root

    generation_root=$(dirname "$include_dir") || return 1
    _native_cache_snapshot_verified_headers \
        "$generation_root" "$include_dir" "$destination_root"
}

snapshot_linux_headers_for_arch() (
    if [ "$#" -ne 2 ]; then
        echo "ERROR: snapshot_linux_headers_for_arch requires an arch and destination" >&2
        return 2
    fi
    local arch="$1"
    local destination_root="$2"

    with_linux_headers_for_arch \
        "$arch" \
        _native_cache_snapshot_leased_linux_headers \
        "$destination_root"
)

linux_headers_content_id_for_path() (
    local include_dir="${1:-}"
    local resolved_include
    local generation_root
    local resolved_generation

    [ -d "$include_dir" ] || {
        echo "ERROR: Linux-header include directory does not exist: $include_dir" >&2
        return 1
    }
    resolved_include=$(cd "$include_dir" && pwd -P) || return 1
    generation_root=$(dirname "$resolved_include") || return 1
    resolved_generation=$(_native_cache_resolve_root "$generation_root") || return 1
    [ "$resolved_include" = "$resolved_generation/include" ] || {
        echo "ERROR: path is not a Linux-header generation include directory: $include_dir" >&2
        return 1
    }
    _native_cache_with_generation_lease \
        "$resolved_generation" \
        _native_cache_hash_verified_headers \
        "$resolved_include"
)

linux_headers_content_id_for_arch() (
    local arch="${1:-}"
    with_linux_headers_for_arch \
        "$arch" \
        _native_cache_content_id_for_leased_linux_headers
)

_libseccomp_util_call() {
    local function_name="$1"
    shift
    if declare -F "$function_name" >/dev/null 2>&1; then
        "$function_name" "$@"
    else
        (
            # shellcheck source=../util.sh
            source "$_BUILD_LIBSECCOMP_DIR/../util.sh"
            "$function_name" "$@"
        )
    fi
}

_native_cache_libseccomp_identity() {
    local target="$1"
    local arch="$2"
    local cc="$3"
    local ar="$4"
    local ranlib="$5"
    local headers_content_id="$6"
    local gperf_path="$7"
    local make_path="$8"

    printf 'schema=%s\n' "$_NATIVE_CACHE_SCHEMA"
    printf 'kind=libseccomp\n'
    printf 'version=%s\n' "$LIBSECCOMP_VERSION"
    printf 'source-sha256=%s\n' "$LIBSECCOMP_TARBALL_SHA256"
    printf 'target=%s\n' "$target"
    printf 'arch=%s\n' "$arch"
    printf 'cc-path=%s\n' "$cc"
    printf 'cc-version=%s\n' "$(_native_cache_tool_version "$cc")"
    printf 'ar-path=%s\n' "$ar"
    printf 'ar-version=%s\n' "$(_native_cache_tool_version "$ar")"
    printf 'ranlib-path=%s\n' "$ranlib"
    printf 'ranlib-version=%s\n' "$(_native_cache_tool_version "$ranlib")"
    printf 'headers-content-id=%s\n' "$headers_content_id"
    printf 'gperf-path=%s\n' "$gperf_path"
    printf 'gperf-version=%s\n' "$(_native_cache_tool_version "$gperf_path")"
    printf 'make-path=%s\n' "$make_path"
    printf 'make-version=%s\n' "$(_native_cache_tool_version "$make_path")"
    printf 'cflags=-Os -fPIC\n'
    printf 'configure=--host=%s-linux-musl --enable-static --disable-shared --disable-python\n' "$arch"
}

_native_cache_libseccomp_metadata() {
    printf 'source=seccomp/libseccomp\n'
    printf 'prefix=%s\n' '<cache-root>'
}

_native_cache_libseccomp_match() {
    local cache_root="$1"
    local target="$2"
    local arch="$3"
    local cc="$4"
    local ar="$5"
    local ranlib="$6"
    local headers_content_id="$7"
    local gperf_path="$8"
    local make_path="$9"
    local resolved_root
    local expected_identity

    expected_identity=$(
        _native_cache_libseccomp_identity \
            "$target" "$arch" "$cc" "$ar" "$ranlib" "$headers_content_id" \
            "$gperf_path" "$make_path"
    ) || return 1
    _native_cache_identity_matches "$cache_root" "$expected_identity" || return 1
    resolved_root=$(_native_cache_resolve_root "$cache_root") || return 1
    [ -s "$resolved_root/lib/libseccomp.a" ] || return 1
    [ -f "$resolved_root/include/seccomp.h" ] || return 1
    [ -f "$resolved_root/include/seccomp-syscalls.h" ] || return 1
}

_native_cache_use_libseccomp_generation() {
    local resolved_generation="$1"
    local callback_marker_dir="$2"
    local callback="$3"
    shift 3

    _native_cache_validate_tree "$resolved_generation" || {
        echo "ERROR: leased libseccomp generation failed verification: $resolved_generation" >&2
        return 1
    }
    grep -qx 'kind=libseccomp' "$resolved_generation/$_NATIVE_CACHE_IDENTITY" || {
        echo "ERROR: leased native cache generation is not libseccomp: $resolved_generation" >&2
        return 1
    }
    [ -s "$resolved_generation/lib/libseccomp.a" ] || return 1
    [ -f "$resolved_generation/include/seccomp.h" ] || return 1
    [ -f "$resolved_generation/include/seccomp-syscalls.h" ] || return 1

    export LIBSECCOMP_LIB_PATH="$resolved_generation/lib"
    export LIBSECCOMP_INCLUDE_PATH="$resolved_generation/include"
    export LIBSECCOMP_LINK_TYPE="static"
    : >"$callback_marker_dir/started" || return 1
    ("$callback" "$@")
}

_build_libseccomp_generation() (
    local target="$1"
    local arch="$2"
    local cc="$3"
    local ar="$4"
    local ranlib="$5"
    local headers_include="$6"
    local headers_content_id="$7"
    local gperf_path="$8"
    local make_path="$9"
    local cache_parent="${10}"
    local cache_root="${11}"
    local build_root=""
    local install_root=""
    local staging_root=""
    local tarball
    local source_dir
    local installed_root
    local headers_snapshot
    local snapshot_content_id
    local jobs
    local url

    mkdir -p "$cache_parent" || return 1
    build_root=$(mktemp -d "${TMPDIR:-/tmp}/boxlite-libseccomp.XXXXXX") || return 1
    install_root=$(mktemp -d "$cache_parent/.install-$LIBSECCOMP_VERSION.XXXXXX") || {
        rm -rf "$build_root"
        return 1
    }
    staging_root="$cache_parent/.staging-$LIBSECCOMP_VERSION.$(basename "$install_root")"
    cleanup_libseccomp_build() {
        [ -z "$build_root" ] || rm -rf "$build_root"
        [ -z "$install_root" ] || rm -rf "$install_root"
        [ -z "$staging_root" ] || rm -rf "$staging_root"
    }
    trap cleanup_libseccomp_build EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM

    headers_snapshot="$build_root/linux-headers"
    snapshot_content_id=$(snapshot_linux_headers_for_path \
        "$headers_include" "$headers_snapshot") || return 1
    if [ "$snapshot_content_id" != "$headers_content_id" ]; then
        echo "ERROR: Linux-header generation changed before libseccomp snapshot" >&2
        return 1
    fi

    tarball="$build_root/libseccomp-$LIBSECCOMP_VERSION.tar.gz"
    url="https://github.com/seccomp/libseccomp/releases/download/v$LIBSECCOMP_VERSION/libseccomp-$LIBSECCOMP_VERSION.tar.gz"
    echo "  → provisioning libseccomp $LIBSECCOMP_VERSION for $target" >&2
    source_dir="$build_root/libseccomp-$LIBSECCOMP_VERSION"
    _native_cache_unpack_source \
        libseccomp \
        "$url" \
        "${LIBSECCOMP_SOURCE_TARBALL:-}" \
        "$LIBSECCOMP_TARBALL_SHA256" \
        "$tarball" \
        "$build_root" \
        "$source_dir" || return 1
    jobs=$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '%s\n' 4) || return 1
    (
        cd "$source_dir" || exit 1
        ./configure \
            --host="${arch}-linux-musl" \
            --prefix="$cache_root" \
            --enable-static \
            --disable-shared \
            --disable-python \
            CC="$cc" \
            AR="$ar" \
            RANLIB="$ranlib" \
            CFLAGS="-Os -fPIC" \
            CPPFLAGS="-I$headers_snapshot" \
            LDFLAGS="" \
            >/dev/null || exit 1
        "$make_path" -j"$jobs" >/dev/null &&
            "$make_path" install DESTDIR="$install_root" >/dev/null
    ) || return 1

    installed_root="$install_root$cache_root"
    [ -d "$installed_root" ] || {
        echo "ERROR: libseccomp install did not produce $installed_root" >&2
        return 1
    }
    _native_cache_atomic_rename "$installed_root" "$staging_root" || return 1
    _native_cache_libseccomp_identity \
        "$target" "$arch" "$cc" "$ar" "$ranlib" "$headers_content_id" \
        "$gperf_path" "$make_path" \
        >"$staging_root/$_NATIVE_CACHE_IDENTITY" || return 1
    _native_cache_libseccomp_metadata \
        >"$staging_root/$_NATIVE_CACHE_METADATA" || return 1
    _native_cache_publish_validated_generation \
        libseccomp \
        "$staging_root" \
        "$cache_root" \
        "$cache_parent/.$LIBSECCOMP_VERSION.lock" \
        _native_cache_libseccomp_match \
        "$target" "$arch" "$cc" "$ar" "$ranlib" "$headers_content_id" \
        "$gperf_path" "$make_path"
)

_build_libseccomp_for_selection() {
    local cache_root="$1"
    local target="$2"
    local arch="$3"
    local cc="$4"
    local ar="$5"
    local ranlib="$6"
    local headers_content_id="$7"
    local gperf_path="$8"
    local make_path="$9"
    local headers_include="${10}"
    local cache_parent

    cache_parent=$(dirname "$cache_root") || return 1
    echo "🔨 Building libseccomp $LIBSECCOMP_VERSION for $target..." >&2
    _build_libseccomp_generation \
        "$target" \
        "$arch" \
        "$cc" \
        "$ar" \
        "$ranlib" \
        "$headers_include" \
        "$headers_content_id" \
        "$gperf_path" \
        "$make_path" \
        "$cache_parent" \
        "$cache_root"
}

_ensure_libseccomp_with_linux_headers() {
    local headers_include="$1"
    local target="$2"
    local arch="$3"
    local cc="$4"
    local ar="$5"
    local ranlib="$6"
    local gperf_path="$7"
    local make_path="$8"
    local cache_root="$9"
    local cache_parent
    local headers_generation
    local headers_content_id
    local resolved_root

    headers_generation=$(dirname "$headers_include") || return 1
    headers_content_id=$(
        _native_cache_hash_verified_headers \
            "$headers_generation" "$headers_include"
    ) || return 1
    cache_parent=$(dirname "$cache_root") || return 1

    _native_cache_select_generation \
        resolved_root \
        libseccomp \
        "$target" \
        "$cache_root" \
        "$cache_parent/.$LIBSECCOMP_VERSION.lock" \
        _native_cache_libseccomp_match \
        _build_libseccomp_for_selection \
        "$target" \
        "$arch" \
        "$cc" \
        "$ar" \
        "$ranlib" \
        "$headers_content_id" \
        "$gperf_path" \
        "$make_path" \
        "$headers_include" || return 1
    printf '%s\n' "$resolved_root"
}

ensure_libseccomp_for_target() {
    local target="${1:-}"
    local arch
    local cc
    local ar
    local ranlib
    local gperf_path
    local make_path
    local cache_base
    local cache_parent
    local cache_root
    local resolved_root
    local selection_status=0

    if [ -z "$target" ]; then
        echo "ERROR: ensure_libseccomp_for_target requires a target triple" >&2
        return 1
    fi
    _native_cache_validate_component target "$target" || return 1
    _native_cache_validate_component libseccomp-version "$LIBSECCOMP_VERSION" || return 1

    arch=$(_libseccomp_util_call target_to_arch "$target") || return 1
    cc=$(_libseccomp_util_call resolve_musl_cc "$target") || return 1
    ar=$(_libseccomp_util_call resolve_musl_tool "$target" ar) || return 1
    ranlib=$(_libseccomp_util_call resolve_musl_tool "$target" ranlib) || return 1
    gperf_path=$(command -v gperf) || {
        echo "ERROR: gperf not found (libseccomp build dependency)" >&2
        echo "  macOS:  brew install gperf" >&2
        echo "  Ubuntu: sudo apt-get install gperf" >&2
        return 1
    }
    make_path=$(command -v make) || {
        echo "ERROR: make not found (libseccomp build dependency)" >&2
        return 1
    }

    cache_base="${BOXLITE_CACHE:-$DEFAULT_BOXLITE_CACHE}"
    mkdir -p "$cache_base" || return 1
    cache_base=$(cd "$cache_base" && pwd -P) || return 1
    cache_parent="$cache_base/libseccomp/$target"
    cache_root="$cache_parent/$LIBSECCOMP_VERSION"

    resolved_root=$(
        with_linux_headers_for_arch \
            "$arch" \
            _ensure_libseccomp_with_linux_headers \
            "$target" \
            "$arch" \
            "$cc" \
            "$ar" \
            "$ranlib" \
            "$gperf_path" \
            "$make_path" \
            "$cache_root"
    ) || selection_status=$?
    if [ "$selection_status" -ne 0 ]; then
        return "$selection_status"
    fi

    export LIBSECCOMP_LIB_PATH="$resolved_root/lib"
    export LIBSECCOMP_INCLUDE_PATH="$resolved_root/include"
    export LIBSECCOMP_LINK_TYPE="static"
}

with_libseccomp_for_target() (
    if [ "$#" -lt 2 ]; then
        echo "ERROR: with_libseccomp_for_target requires a target and callback" >&2
        return 2
    fi

    local target="$1"
    local callback="$2"
    shift 2
    local generation_root
    local callback_marker_dir=""
    local attempt=1
    local lease_status=0

    cleanup_libseccomp_callback() {
        [ -z "$callback_marker_dir" ] || rm -rf "$callback_marker_dir"
    }
    trap cleanup_libseccomp_callback EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM

    while [ "$attempt" -le 3 ]; do
        ensure_libseccomp_for_target "$target" || return 1
        generation_root=$(dirname "$LIBSECCOMP_LIB_PATH") || return 1
        callback_marker_dir=$(mktemp -d \
            "${TMPDIR:-/tmp}/boxlite-libseccomp-callback.XXXXXX") || return 1
        lease_status=0
        _native_cache_with_generation_lease \
            "$generation_root" \
            _native_cache_use_libseccomp_generation \
            "$callback_marker_dir" \
            "$callback" \
            "$@" || lease_status=$?
        if [ -e "$callback_marker_dir/started" ]; then
            return "$lease_status"
        fi
        rm -rf "$callback_marker_dir"
        callback_marker_dir=""
        attempt=$((attempt + 1))
    done

    echo "ERROR: libseccomp generation changed repeatedly before consumer start" >&2
    return 1
)

_build_libseccomp_main() {
    case "${1:-}" in
        --native-cache-publish)
            shift
            if [ "$#" -ne 2 ]; then
                echo "ERROR: internal native cache publisher expects staging and cache roots" >&2
                return 1
            fi
            _native_cache_publish_locked "$1" "$2"
            ;;
        --native-cache-gc)
            shift
            if [ "$#" -ne 1 ]; then
                echo "ERROR: internal native cache GC expects one cache root" >&2
                return 1
            fi
            _native_cache_gc_locked "$1"
            ;;
        *)
            local target="${1:-}"
            if [ -z "$target" ]; then
                target=$(
                    # shellcheck source=../util.sh
                    source "$_BUILD_LIBSECCOMP_DIR/../util.sh"
                    printf '%s\n' "$GUEST_TARGET"
                ) || return 1
            fi
            ensure_libseccomp_for_target "$target" || return 1
            echo "LIBSECCOMP_LIB_PATH=$LIBSECCOMP_LIB_PATH"
            echo "LIBSECCOMP_INCLUDE_PATH=$LIBSECCOMP_INCLUDE_PATH"
            echo "LIBSECCOMP_LINK_TYPE=$LIBSECCOMP_LINK_TYPE"
            ;;
    esac
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
    _build_libseccomp_main "$@"
fi
