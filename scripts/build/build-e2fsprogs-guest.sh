#!/bin/bash
# Build the e2fsprogs utilities needed inside the guest as static musl ELFs.
#
# Sourceable interface:
#   ensure_guest_e2fsprogs_for_target <target> <release|debug>
# The call runs in a subshell, so it preserves the caller's cwd, options,
# variables, and traps as well as keeping this file side-effect-free on source.
#
# Standalone interface:
#   scripts/build/build-e2fsprogs-guest.sh [--profile release|debug]
#
# This file intentionally does not set shell options, change directory, install
# a trap, or initialize global variables when sourced.

_guest_tools_sha256_stdin() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 | awk '{print $1}'
    else
        echo "ERROR: sha256sum or shasum is required" >&2
        return 1
    fi
}

_guest_tools_sha256_file() {
    if [ "$#" -ne 1 ]; then
        echo "ERROR: _guest_tools_sha256_file requires a path" >&2
        return 2
    fi
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | awk '{print $1}'
    else
        echo "ERROR: sha256sum or shasum is required" >&2
        return 1
    fi
}

_guest_tools_source_tree_id() {
    if [ "$#" -ne 1 ]; then
        echo "ERROR: _guest_tools_source_tree_id requires a source root" >&2
        return 2
    fi
    perl -MDigest::SHA -MFile::Find -MCwd=abs_path -MFcntl=:mode -e '
        use strict;
        use warnings;
        my ($root_arg) = @ARGV;
        my $root = abs_path($root_arg);
        defined($root) && -d $root or die "invalid source snapshot: $root_arg\n";
        my @paths;
        find(
            {
                no_chdir => 1,
                wanted => sub {
                    return if $File::Find::name eq $root;
                    push @paths, substr($File::Find::name, length($root) + 1);
                },
            },
            $root,
        );
        my $tree = Digest::SHA->new(256);
        for my $relative (sort @paths) {
            my $path = "$root/$relative";
            my @entry = lstat($path);
            @entry or die "lstat $path: $!\n";
            my $mode = $entry[2] & 07777;
            my $path_record = length($relative) . ":" . $relative;
            if (S_ISLNK($entry[2])) {
                my $target = readlink($path);
                defined($target) or die "readlink $path: $!\n";
                $tree->add("L\0$path_record\0", length($target), ":", $target, "\0");
            } elsif (S_ISDIR($entry[2])) {
                $tree->add("D\0$path_record\0", sprintf("%04o", $mode), "\0");
            } elsif (S_ISREG($entry[2])) {
                open(my $file, "<", $path) or die "open $path: $!\n";
                binmode($file);
                my $file_digest = Digest::SHA->new(256);
                $file_digest->addfile($file);
                close($file) or die "close $path: $!\n";
                $tree->add(
                    "F\0$path_record\0",
                    sprintf("%04o", $mode),
                    "\0",
                    $file_digest->hexdigest,
                    "\0",
                );
            } else {
                die "unsupported source snapshot entry: $relative\n";
            }
        }
        print $tree->hexdigest, "\n";
    ' "$1"
}

_guest_tools_remove_private_tree() {
    local private_root="$1"
    [ -n "$private_root" ] || return 0
    [ -e "$private_root" ] || [ -L "$private_root" ] || return 0
    chmod -R u+w "$private_root" 2>/dev/null || true
    rm -rf -- "$private_root"
}

# Copy the Git working tree that the build would consume into a private,
# content-addressed directory. Git supplies tracked plus non-ignored untracked paths
# from the vendored submodule itself; deleted tracked paths are absent, and the
# resulting content ID covers paths, types, executable modes, and bytes.
_guest_tools_create_source_snapshot() (
    if [ "$#" -ne 2 ]; then
        echo "ERROR: _guest_tools_create_source_snapshot requires source and destination paths" >&2
        return 2
    fi
    local source_root="$1"
    local destination_root="$2"
    local resolved_source
    local destination_parent
    local path_list=""
    local snapshot_stage=""
    local snapshot_id

    resolved_source=$(cd "$source_root" && pwd -P) || return 1
    [ ! -e "$destination_root" ] && [ ! -L "$destination_root" ] || {
        echo "ERROR: source snapshot destination already exists: $destination_root" >&2
        return 1
    }
    destination_parent=$(dirname "$destination_root") || return 1
    mkdir -p "$destination_parent" || return 1
    path_list=$(mktemp "$destination_parent/.e2fs-source-paths.XXXXXX") || return 1
    snapshot_stage=$(mktemp -d "$destination_parent/.e2fs-source-snapshot.XXXXXX") || {
        rm -f "$path_list"
        return 1
    }
    cleanup_source_snapshot() {
        [ -z "$path_list" ] || rm -f "$path_list"
        [ -z "$snapshot_stage" ] || _guest_tools_remove_private_tree "$snapshot_stage"
    }
    trap cleanup_source_snapshot EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM

    git -C "$resolved_source" ls-files --cached --others --exclude-standard -z \
        >"$path_list" || return 1
    perl -MErrno=ENOENT -MFcntl=:DEFAULT,:mode -MFile::Basename=dirname \
        -MFile::Path=make_path -MCwd=abs_path -e '
        use strict;
        use warnings;
        my ($source, $destination, $list_path) = @ARGV;
        open(my $list, "<", $list_path) or die "open $list_path: $!\n";
        binmode($list);
        local $/;
        my $paths = <$list>;
        close($list) or die "close $list_path: $!\n";
        for my $relative (split(/\0/, $paths, -1)) {
            next if $relative eq "";
            $relative !~ m{^/} && $relative !~ m{(?:^|/)\.\.(?:/|$)}
                or die "unsafe Git source path: $relative\n";
            my $source_path = "$source/$relative";
            my @before = lstat($source_path);
            if (!@before) {
                next if $!{ENOENT};
                die "lstat $source_path: $!\n";
            }
            my $destination_path = "$destination/$relative";
            make_path(dirname($destination_path), { mode => 0755 });
            if (S_ISLNK($before[2])) {
                my $target = readlink($source_path);
                defined($target) or die "readlink $source_path: $!\n";
                symlink($target, $destination_path)
                    or die "symlink $destination_path: $!\n";
                next;
            }
            S_ISREG($before[2]) or die "unsupported Git source entry: $relative\n";
            sysopen(my $input, $source_path, O_RDONLY)
                or die "open $source_path: $!\n";
            my @opened = stat($input);
            @opened && $opened[0] == $before[0] && $opened[1] == $before[1]
                && S_ISREG($opened[2])
                or die "source entry changed type while snapshotting: $relative\n";
            sysopen(my $output, $destination_path, O_WRONLY | O_CREAT | O_EXCL, 0600)
                or die "create $destination_path: $!\n";
            binmode($input);
            binmode($output);
            my $buffer;
            while (1) {
                my $read = sysread($input, $buffer, 1024 * 1024);
                defined($read) or die "read $source_path: $!\n";
                last if $read == 0;
                my $offset = 0;
                while ($offset < $read) {
                    my $written = syswrite($output, $buffer, $read - $offset, $offset);
                    defined($written) && $written > 0
                        or die "write $destination_path: $!\n";
                    $offset += $written;
                }
            }
            close($input) or die "close $source_path: $!\n";
            close($output) or die "close $destination_path: $!\n";
            my $snapshot_mode = ($before[2] & 0111) ? 0555 : 0444;
            chmod($snapshot_mode, $destination_path)
                or die "chmod $destination_path: $!\n";
        }

        my $snapshot_root = abs_path($destination);
        defined($snapshot_root) or die "resolve source snapshot $destination: $!\n";
        my @symlinks;
        use File::Find;
        find(
            {
                no_chdir => 1,
                wanted => sub {
                    lstat($File::Find::name)
                        or die "lstat $File::Find::name: $!\n";
                    push @symlinks, $File::Find::name if -l _;
                },
            },
            $destination,
        );
        for my $symlink (@symlinks) {
            my $relative = substr($symlink, length($destination) + 1);
            my $target = readlink($symlink);
            defined($target) or die "readlink $symlink: $!\n";
            $target !~ m{^/}
                or die "source snapshot symlink is absolute: $relative -> $target\n";
            my @inside = grep { length($_) && $_ ne "." }
                split(m{/+}, dirname($relative));
            for my $component (split(m{/+}, $target)) {
                next if $component eq "" || $component eq ".";
                if ($component eq "..") {
                    @inside
                        or die "source snapshot symlink escapes snapshot: $relative -> $target\n";
                    pop @inside;
                    next;
                }
                push @inside, $component;
            }
            my $resolved = abs_path($symlink);
            my @resolved_entry = stat($symlink);
            defined($resolved) && @resolved_entry
                or die "source snapshot symlink is broken or cyclic: $relative -> $target\n";
            ($resolved eq $snapshot_root || index($resolved, "$snapshot_root/") == 0)
                or die "source snapshot symlink escapes snapshot: $relative -> $target\n";
        }

        chmod(0755, $destination) or die "chmod $destination: $!\n";
        find(
            {
                no_chdir => 1,
                bydepth => 1,
                wanted => sub {
                    return unless -d $File::Find::name && !-l $File::Find::name;
                    chmod(0755, $File::Find::name)
                        or die "chmod $File::Find::name: $!\n";
                },
            },
            $destination,
        );
    ' "$resolved_source" "$snapshot_stage" "$path_list" || return 1
    rm -f "$path_list" || return 1
    path_list=""
    snapshot_id=$(_guest_tools_source_tree_id "$snapshot_stage") || return 1
    mv "$snapshot_stage" "$destination_root" || return 1
    snapshot_stage=""
    printf '%s\n' "$snapshot_id"
)

_guest_tools_json_escape() {
    LC_ALL=C awk 'BEGIN { ORS = "" }
        {
            if (NR > 1) printf "\\n"
            gsub(/\\/, "\\\\")
            gsub(/"/, "\\\"")
            gsub(/\r/, "\\r")
            gsub(/\t/, "\\t")
            printf "%s", $0
        }'
}

_guest_tools_version_line() {
    if [ "$#" -ne 1 ]; then
        echo "ERROR: _guest_tools_version_line requires a tool path" >&2
        return 2
    fi
    local version_output
    version_output=$("$1" --version) || return 1
    printf '%s\n' "$version_output" | sed -n '1p'
}

_guest_tools_file_mode() {
    local file_path="$1"
    local file_mode

    if file_mode=$(stat -c '%a' "$file_path" 2>/dev/null); then
        printf '%s\n' "$file_mode"
    elif file_mode=$(stat -f '%Lp' "$file_path" 2>/dev/null); then
        printf '%s\n' "$file_mode"
    else
        return 1
    fi
}

_guest_tools_expected_mode() {
    case "$1" in
        mke2fs|resize2fs) printf '%s\n' 755 ;;
        NOTICE|source-metadata.json|build-metadata.json|guest-tools-manifest.json|SHA256SUMS)
            printf '%s\n' 644
            ;;
        *) return 1 ;;
    esac
}

_guest_tools_verify_tree_shape() {
    local tree_dir="$1"
    local entry_count artifact_name expected_mode actual_mode

    [ -d "$tree_dir" ] && [ ! -L "$tree_dir" ] || return 1
    entry_count=$(find "$tree_dir" ! -path "$tree_dir" -prune -print | wc -l | tr -d '[:space:]') || return 1
    [ "$entry_count" -eq 7 ] || return 1

    for artifact_name in \
        mke2fs resize2fs NOTICE source-metadata.json build-metadata.json \
        guest-tools-manifest.json SHA256SUMS; do
        [ -f "$tree_dir/$artifact_name" ] && [ ! -L "$tree_dir/$artifact_name" ] || return 1
        expected_mode=$(_guest_tools_expected_mode "$artifact_name") || return 1
        actual_mode=$(_guest_tools_file_mode "$tree_dir/$artifact_name") || return 1
        [ "$actual_mode" = "$expected_mode" ] || return 1
    done
}

_guest_tools_prepare_output_entries() {
    local output_dir="$1"
    local output_entry output_name keep_existing=false

    [ -d "$output_dir" ] && [ ! -L "$output_dir" ] || return 1
    while IFS= read -r -d '' output_entry; do
        output_name=${output_entry##*/}
        keep_existing=false
        case "$output_name" in
            mke2fs|resize2fs|NOTICE|source-metadata.json|build-metadata.json|guest-tools-manifest.json|SHA256SUMS)
                if [ -f "$output_entry" ] && [ ! -L "$output_entry" ]; then
                    keep_existing=true
                fi
                ;;
        esac
        if [ "$keep_existing" != true ]; then
            rm -rf -- "$output_entry" || return 1
        fi
    done < <(find "$output_dir" ! -path "$output_dir" -prune -print0)
}

_guest_tools_verify_output() {
    local target="$1"
    local profile="$2"
    local cache_signature="$3"
    local output_dir="$4"
    local required_name

    _guest_tools_verify_tree_shape "$output_dir" || return 1

    grep -Fq "\"cache_signature\": \"$cache_signature\"" \
        "$output_dir/build-metadata.json" || return 1
    grep -Fq '"cache_scope": "verified-output"' \
        "$output_dir/build-metadata.json" || return 1
    grep -Fq '"publication": "atomic-files-sha256sums-last"' \
        "$output_dir/build-metadata.json" || return 1
    grep -Fq '"publish_lock": "perl-flock-exclusive"' \
        "$output_dir/build-metadata.json" || return 1
    grep -Fq '"lock_lifetime": "publisher-holder-shared-ofd"' \
        "$output_dir/build-metadata.json" || return 1
    grep -Eq '"build_compiler": "[^"]+"' \
        "$output_dir/build-metadata.json" || return 1
    grep -Eq '"build_compiler_version": "[^"]+"' \
        "$output_dir/build-metadata.json" || return 1
    grep -Eq '"linux_headers_content_id": "[[:xdigit:]]{64}"' \
        "$output_dir/build-metadata.json" || return 1
    grep -Fq '"source_snapshot": "private-content-addressed"' \
        "$output_dir/build-metadata.json" || return 1
    grep -Fq '"linux_headers": "consumer-owned-snapshot"' \
        "$output_dir/build-metadata.json" || return 1
    grep -Eq '"snapshot_content_sha256": "[[:xdigit:]]{64}"' \
        "$output_dir/source-metadata.json" || return 1
    grep -Fq "\"target\": \"$target\"" \
        "$output_dir/guest-tools-manifest.json" || return 1
    grep -Fq "\"profile\": \"$profile\"" \
        "$output_dir/guest-tools-manifest.json" || return 1

    verify_guest_elf "$target" "$output_dir/mke2fs" >/dev/null 2>&1 || return 1
    verify_guest_elf "$target" "$output_dir/resize2fs" >/dev/null 2>&1 || return 1

    [ "$(wc -l < "$output_dir/SHA256SUMS" | tr -d '[:space:]')" -eq 6 ] || return 1
    local expected_sha checksum_name actual_sha
    while read -r expected_sha checksum_name; do
        [ -n "$expected_sha" ] || continue
        checksum_name="${checksum_name#\*}"
        case "$checksum_name" in
            mke2fs|resize2fs|NOTICE|source-metadata.json|build-metadata.json|guest-tools-manifest.json) ;;
            *) return 1 ;;
        esac
        [ -f "$output_dir/$checksum_name" ] || return 1
        actual_sha=$(_guest_tools_sha256_file "$output_dir/$checksum_name") || return 1
        [ "$actual_sha" = "$expected_sha" ] || return 1
    done < "$output_dir/SHA256SUMS"

    for required_name in \
        mke2fs resize2fs NOTICE source-metadata.json build-metadata.json guest-tools-manifest.json; do
        grep -Eq "^[[:xdigit:]]{64}  ${required_name}$" "$output_dir/SHA256SUMS" || return 1
    done

    local mke2fs_sha resize2fs_sha mke2fs_size resize2fs_size
    mke2fs_sha=$(_guest_tools_sha256_file "$output_dir/mke2fs") || return 1
    resize2fs_sha=$(_guest_tools_sha256_file "$output_dir/resize2fs") || return 1
    mke2fs_size=$(wc -c < "$output_dir/mke2fs" | tr -d '[:space:]') || return 1
    resize2fs_size=$(wc -c < "$output_dir/resize2fs" | tr -d '[:space:]') || return 1
    grep -Fq "{\"path\": \"mke2fs\", \"sha256\": \"$mke2fs_sha\", \"size\": $mke2fs_size," \
        "$output_dir/guest-tools-manifest.json" || return 1
    grep -Fq "{\"path\": \"resize2fs\", \"sha256\": \"$resize2fs_sha\", \"size\": $resize2fs_size," \
        "$output_dir/guest-tools-manifest.json" || return 1
}

_guest_tools_resolve_cc() {
    local project_root="$1"
    local target="$2"
    if declare -F resolve_musl_cc >/dev/null 2>&1; then
        resolve_musl_cc "$target"
    else
        (
            # shellcheck source=../util.sh
            source "$project_root/scripts/util.sh"
            resolve_musl_cc "$target"
        )
    fi
}

_guest_tools_resolve_tool() {
    local project_root="$1"
    local target="$2"
    local tool="$3"
    if declare -F resolve_musl_tool >/dev/null 2>&1; then
        resolve_musl_tool "$target" "$tool"
    else
        (
            # shellcheck source=../util.sh
            source "$project_root/scripts/util.sh"
            resolve_musl_tool "$target" "$tool"
        )
    fi
}

_guest_tools_target_arch() {
    local project_root="$1"
    local target="$2"
    if declare -F target_to_arch >/dev/null 2>&1; then
        target_to_arch "$target"
    else
        (
            # shellcheck source=../util.sh
            source "$project_root/scripts/util.sh"
            target_to_arch "$target"
        )
    fi
}

_guest_tools_linux_headers() {
    local project_root="$1"
    local arch="$2"
    if declare -F ensure_linux_headers_for_arch >/dev/null 2>&1; then
        ensure_linux_headers_for_arch "$arch"
    else
        (
            # Reuse libseccomp's pinned and checksum-verified Linux UAPI header
            # cache.  The subshell contains all variables and shell options set
            # by build-libseccomp.sh.
            # shellcheck source=./build-libseccomp.sh
            source "$project_root/scripts/build/build-libseccomp.sh"
            ensure_linux_headers_for_arch "$arch"
        )
    fi
}

_guest_tools_linux_headers_content_id() {
    local project_root="$1"
    local include_dir="$2"
    if declare -F linux_headers_content_id_for_path >/dev/null 2>&1; then
        linux_headers_content_id_for_path "$include_dir"
    else
        (
            # shellcheck source=./build-libseccomp.sh
            source "$project_root/scripts/build/build-libseccomp.sh"
            linux_headers_content_id_for_path "$include_dir"
        )
    fi
}

_guest_tools_snapshot_linux_headers() {
    local project_root="$1"
    local arch="$2"
    local destination_root="$3"
    if declare -F snapshot_linux_headers_for_arch >/dev/null 2>&1; then
        snapshot_linux_headers_for_arch "$arch" "$destination_root"
    else
        (
            # shellcheck source=./build-libseccomp.sh
            source "$project_root/scripts/build/build-libseccomp.sh"
            snapshot_linux_headers_for_arch "$arch" "$destination_root"
        )
    fi
}

_guest_tools_replace_staging_files() {
    local staging_dir="$1"
    local output_dir="$2"
    local artifact_name
    local -a artifact_names=(
        mke2fs resize2fs NOTICE source-metadata.json build-metadata.json
        guest-tools-manifest.json
    )

    _guest_tools_verify_tree_shape "$staging_dir" || return 1

    if [ -L "$output_dir" ]; then
        return 1
    fi
    mkdir -p "$output_dir" || return 1
    _guest_tools_prepare_output_entries "$output_dir" || return 1

    # Staging is a sibling of output_dir, so every mv below is a same-filesystem
    # atomic rename. Keep the old directory mounted throughout publication and
    # replace SHA256SUMS last as the commit marker. If the process dies earlier,
    # the old checksum file rejects the partial generation and the next call
    # rebuilds it from source.
    for artifact_name in "${artifact_names[@]}"; do
        mv -f "$staging_dir/$artifact_name" "$output_dir/$artifact_name" || return 1
    done
    mv -f "$staging_dir/SHA256SUMS" "$output_dir/SHA256SUMS" || return 1
    rmdir "$staging_dir" || return 1
}

_guest_tools_find_free_fd() {
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

_guest_tools_close_publish_release_channel() {
    if [ "${publish_lock_channels_open:-false}" = true ]; then
        case "${publish_lock_release_fd:-}" in
            ''|*[!0-9]*) return 1 ;;
        esac
        eval "exec ${publish_lock_release_fd}>&-"
        publish_lock_channels_open=false
        publish_lock_release_fd=""
    fi
}

_guest_tools_close_publish_lock_fd() {
    if [ "${publish_lock_fd_open:-false}" = true ]; then
        case "${publish_lock_fd:-}" in
            ''|*[!0-9]*) return 1 ;;
        esac
        eval "exec ${publish_lock_fd}>&-"
        publish_lock_fd_open=false
        publish_lock_fd=""
    fi
}

_guest_tools_acquire_publish_lock() {
    if [ "$#" -ne 2 ]; then
        echo "ERROR: _guest_tools_acquire_publish_lock requires <lock-path> <channel-dir>" >&2
        return 2
    fi

    local lock_path="$1"
    local channel_dir="$2"
    local lock_event
    local lock_status=0

    if ! command -v perl >/dev/null 2>&1 || \
       ! perl -MFcntl=:flock -e 'exit 0' >/dev/null 2>&1; then
        echo "ERROR: Perl with Fcntl flock support is required to publish guest tools" >&2
        return 1
    fi

    publish_lock_ready_fifo="$channel_dir/publish-lock-ready.fifo"
    publish_lock_release_fifo="$channel_dir/publish-lock-release.fifo"
    if ! mkfifo "$publish_lock_ready_fifo" "$publish_lock_release_fifo"; then
        echo "ERROR: failed to create guest-tools publication lock channels" >&2
        return 1
    fi
    publish_lock_fd=$(_guest_tools_find_free_fd) || {
        echo "ERROR: no free file descriptor for guest-tools publication lock" >&2
        return 1
    }
    if ! eval "exec ${publish_lock_fd}>>\"\$lock_path\""; then
        echo "ERROR: failed to open guest-tools publication lock" >&2
        return 1
    fi
    publish_lock_fd_open=true

    publish_lock_release_fd=$(_guest_tools_find_free_fd) || {
        echo "ERROR: no free file descriptor for guest-tools publication lock" >&2
        _guest_tools_close_publish_lock_fd || true
        return 1
    }
    if ! eval "exec ${publish_lock_release_fd}<>\"\$publish_lock_release_fifo\""; then
        echo "ERROR: failed to open guest-tools publication release channel" >&2
        _guest_tools_close_publish_lock_fd || true
        return 1
    fi
    publish_lock_channels_open=true

    perl -MFcntl=:flock -e '
        use strict;
        use warnings;
        use POSIX ();

        my ($lock_fd, $release_path, $release_fd) = @ARGV;

        sub fail_lock {
            my $message = "failed\n";
            syswrite(STDOUT, $message, length($message));
            exit 1;
        }

        open(my $lock, ">&=$lock_fd") or fail_lock();
        flock($lock, LOCK_EX) or fail_lock();
        open(my $release, "<", $release_path) or fail_lock();
        POSIX::close(0 + $release_fd) == 0 or fail_lock();
        my $acquired = "acquired\n";
        syswrite(STDOUT, $acquired, length($acquired)) == length($acquired)
            or exit 1;
        scalar(<$release>);
        exit 0;
    ' "$publish_lock_fd" "$publish_lock_release_fifo" "$publish_lock_release_fd" \
        > "$publish_lock_ready_fifo" &
    publish_lock_pid=$!

    if ! IFS= read -r lock_event < "$publish_lock_ready_fifo"; then
        _guest_tools_cancel_publish_lock
        echo "ERROR: failed to read guest-tools publication ready channel" >&2
        return 1
    fi
    if [ "$lock_event" != "acquired" ]; then
        _guest_tools_close_publish_release_channel || true
        wait "$publish_lock_pid" || lock_status=$?
        publish_lock_pid=""
        _guest_tools_close_publish_lock_fd || true
        echo "ERROR: failed to acquire guest-tools publication lock ($lock_status)" >&2
        return 1
    fi
}

_guest_tools_release_publish_lock() {
    local lock_status=0

    [ -n "${publish_lock_pid:-}" ] || return 0
    if ! _guest_tools_close_publish_release_channel; then
        _guest_tools_cancel_publish_lock
        return 1
    fi
    wait "$publish_lock_pid" || lock_status=$?
    publish_lock_pid=""
    if ! _guest_tools_close_publish_lock_fd; then
        lock_status=1
    fi
    if [ "$lock_status" -ne 0 ]; then
        echo "ERROR: failed to release guest-tools publication lock" >&2
        return 1
    fi
}

_guest_tools_cancel_publish_lock() {
    _guest_tools_close_publish_release_channel 2>/dev/null || true
    if [ -n "${publish_lock_pid:-}" ]; then
        kill "$publish_lock_pid" 2>/dev/null || true
        wait "$publish_lock_pid" 2>/dev/null || true
        publish_lock_pid=""
    fi
    _guest_tools_close_publish_lock_fd 2>/dev/null || true
}

_guest_tools_install_staging() {
    if [ "$#" -ne 7 ]; then
        echo "ERROR: _guest_tools_install_staging requires target, profile, signature, staging, output, lock, and channel paths" >&2
        return 2
    fi

    local target="$1"
    local profile="$2"
    local cache_signature="$3"
    local staging_dir="$4"
    local output_dir="$5"
    local lock_path="$6"
    local channel_dir="$7"
    local publication_status=0

    _guest_tools_acquire_publish_lock "$lock_path" "$channel_dir" || return 1
    if _guest_tools_verify_output "$target" "$profile" "$cache_signature" "$output_dir"; then
        echo "✓ concurrent guest e2fsprogs build already published for $target ($profile)"
    elif ! _guest_tools_replace_staging_files "$staging_dir" "$output_dir"; then
        echo "ERROR: failed to install guest tools at $output_dir" >&2
        publication_status=1
    elif ! _guest_tools_verify_output "$target" "$profile" "$cache_signature" "$output_dir"; then
        echo "ERROR: published guest tools failed verification at $output_dir" >&2
        publication_status=1
    fi

    if ! _guest_tools_release_publish_lock; then
        publication_status=1
    fi
    return "$publication_status"
}

ensure_guest_e2fsprogs_for_target() (
    if [ "$#" -ne 2 ]; then
        echo "ERROR: ensure_guest_e2fsprogs_for_target requires <target> <profile>" >&2
        return 2
    fi

    local target="$1"
    local profile="$2"
    case "$profile" in
        release|debug) ;;
        *)
            echo "ERROR: unsupported guest tools profile: $profile" >&2
            echo "Supported profiles: release, debug" >&2
            return 2
            ;;
    esac

    local script_build_dir
    local project_root
    script_build_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || return 1
    project_root=$(cd "$script_build_dir/../.." && pwd) || return 1

    local verifier="$script_build_dir/verify-guest-elf.sh"
    if ! declare -F verify_guest_elf >/dev/null 2>&1; then
        # shellcheck source=./verify-guest-elf.sh
        source "$verifier" || return 1
    fi

    local source_dir="$project_root/src/deps/e2fsprogs-sys/vendor/e2fsprogs"
    if [ ! -x "$source_dir/configure" ]; then
        echo "ERROR: e2fsprogs submodule is not initialized at $source_dir" >&2
        echo "Run: git submodule update --init --recursive" >&2
        return 1
    fi

    local cc ar ranlib strip_tool arch
    cc=$(_guest_tools_resolve_cc "$project_root" "$target") || return 1
    ar=$(_guest_tools_resolve_tool "$project_root" "$target" ar) || return 1
    ranlib=$(_guest_tools_resolve_tool "$project_root" "$target" ranlib) || return 1
    strip_tool=$(_guest_tools_resolve_tool "$project_root" "$target" strip) || return 1
    arch=$(_guest_tools_target_arch "$project_root" "$target") || return 1

    local build_parent="$project_root/target/native/e2fsprogs-guest/$target/$profile"
    local output_dir="$project_root/target/$target/$profile/guest-tools"
    mkdir -p "$build_parent" "$(dirname "$output_dir")" || return 1
    local build_dir=""
    local staging_dir=""
    local publish_lock_pid=""
    local publish_lock_channels_open=false
    local publish_lock_ready_fifo=""
    local publish_lock_release_fifo=""
    local publish_lock_release_fd=""
    local publish_lock_fd=""
    local publish_lock_fd_open=false
    _guest_tools_cleanup_workspace() {
        _guest_tools_cancel_publish_lock
        [ -z "$build_dir" ] || _guest_tools_remove_private_tree "$build_dir"
        [ -z "$staging_dir" ] || rm -rf "$staging_dir"
    }
    trap _guest_tools_cleanup_workspace EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM

    build_dir=$(mktemp -d "$build_parent/build.XXXXXX") || return 1

    local source_commit source_version source_status source_diff_sha source_untracked_sha
    local source_snapshot source_snapshot_id
    source_commit=$(git -C "$source_dir" rev-parse HEAD) || return 1
    source_status=$(git -C "$source_dir" status --porcelain=v1 -uall) || return 1
    source_diff_sha=$(
        {
            git -C "$source_dir" diff --binary HEAD
            git -C "$source_dir" diff --cached --binary HEAD
        } | _guest_tools_sha256_stdin
    ) || return 1
    source_untracked_sha=$(
        {
            while IFS= read -r -d '' untracked_path; do
                printf '%s\000' "$untracked_path"
                if [ -L "$source_dir/$untracked_path" ]; then
                    printf 'symlink:%s\n' "$(readlink "$source_dir/$untracked_path")"
                else
                    _guest_tools_sha256_file "$source_dir/$untracked_path"
                fi
            done < <(git -C "$source_dir" ls-files --others --exclude-standard -z)
        } | _guest_tools_sha256_stdin
    ) || return 1
    source_snapshot="$build_dir/source"
    source_snapshot_id=$(
        _guest_tools_create_source_snapshot "$source_dir" "$source_snapshot"
    ) || return 1
    [ -x "$source_snapshot/configure" ] || {
        echo "ERROR: e2fsprogs source snapshot has no executable configure script" >&2
        return 1
    }
    source_version=$(awk -F'"' '/E2FSPROGS_VERS/ { print $2; exit }' \
        "$source_snapshot/version.h") || return 1

    local linux_headers="$build_dir/linux-headers"
    local linux_headers_content_id
    linux_headers_content_id=$(
        _guest_tools_snapshot_linux_headers \
            "$project_root" "$arch" "$linux_headers"
    ) || return 1
    if ! printf '%s\n' "$linux_headers_content_id" | grep -Eq '^[[:xdigit:]]{64}$'; then
        echo "ERROR: invalid Linux headers content id for $arch" >&2
        return 1
    fi

    local build_cc_name build_cc build_cflags build_ldflags
    build_cc_name="${BUILD_CC:-cc}"
    build_cc=$(command -v "$build_cc_name") || {
        echo "ERROR: host build compiler not found: $build_cc_name" >&2
        return 1
    }
    if [ "${build_cc#/}" = "$build_cc" ]; then
        build_cc=$(cd "$(dirname "$build_cc")" && pwd)/$(basename "$build_cc") || return 1
    fi
    [ -f "$build_cc" ] && [ -x "$build_cc" ] || {
        echo "ERROR: host build compiler is not executable: $build_cc" >&2
        return 1
    }
    build_cflags="${BUILD_CFLAGS:-}"
    build_ldflags="${BUILD_LDFLAGS:-}"

    local host_triplet
    local build_triplet
    host_triplet="${target/-unknown/}"
    build_triplet=$("$source_snapshot/config/config.guess") || return 1

    local cflags ldflags
    if [ "$profile" = "release" ]; then
        cflags="-O2 -fno-pie -ffunction-sections -fdata-sections"
        ldflags="-no-pie -Wl,--gc-sections"
    else
        cflags="-O0 -g3 -fno-omit-frame-pointer -fno-pie"
        ldflags="-no-pie"
    fi

    local -a configure_args=(
        "--build=$build_triplet"
        "--host=$host_triplet"
        "--prefix=/usr"
        "--enable-libuuid"
        "--enable-libblkid"
        "--enable-resizer"
        "--disable-elf-shlibs"
        "--disable-bsd-shlibs"
        "--disable-hardening"
        "--disable-debugfs"
        "--disable-imager"
        "--disable-defrag"
        "--disable-fsck"
        "--disable-e2initrd-helper"
        "--disable-uuidd"
        "--disable-tdb"
        "--disable-nls"
        "--disable-rpath"
        "--disable-fuse2fs"
        "--disable-backtrace"
        "--disable-tls"
        "--without-pthread"
        "--without-libarchive"
    )

    local compiler_version build_compiler_version ar_version ranlib_version strip_version
    compiler_version=$(_guest_tools_version_line "$cc") || return 1
    build_compiler_version=$(_guest_tools_version_line "$build_cc") || return 1
    ar_version=$(_guest_tools_version_line "$ar") || return 1
    ranlib_version=$(_guest_tools_version_line "$ranlib") || return 1
    strip_version=$(_guest_tools_version_line "$strip_tool") || return 1

    local helper_sha verifier_sha util_sha headers_helper_sha configure_text
    helper_sha=$(_guest_tools_sha256_file "$script_build_dir/build-e2fsprogs-guest.sh") || return 1
    verifier_sha=$(_guest_tools_sha256_file "$verifier") || return 1
    util_sha=$(_guest_tools_sha256_file "$project_root/scripts/util.sh") || return 1
    headers_helper_sha=$(_guest_tools_sha256_file "$script_build_dir/build-libseccomp.sh") || return 1
    configure_text=$(printf '%s\n' "${configure_args[@]}") || return 1

    local signature_material cache_signature
    signature_material=$(printf '%s\n' \
        "source_commit=$source_commit" \
        "source_status=$source_status" \
        "source_diff_sha=$source_diff_sha" \
        "source_untracked_sha=$source_untracked_sha" \
        "source_snapshot_id=$source_snapshot_id" \
        "target=$target" \
        "profile=$profile" \
        "cc=$cc" \
        "compiler_version=$compiler_version" \
        "build_cc=$build_cc" \
        "build_compiler_version=$build_compiler_version" \
        "build_cflags=$build_cflags" \
        "build_ldflags=$build_ldflags" \
        "ar=$ar" \
        "ar_version=$ar_version" \
        "ranlib=$ranlib" \
        "ranlib_version=$ranlib_version" \
        "strip=$strip_tool" \
        "strip_version=$strip_version" \
        "linux_headers_snapshot=consumer-owned" \
        "linux_headers_content_id=$linux_headers_content_id" \
        "cflags=$cflags" \
        "ldflags=$ldflags" \
        "configure=$configure_text" \
        "cache_scope=verified-output" \
        "publication=atomic-files-sha256sums-last" \
        "publish_lock=perl-flock-exclusive" \
        "lock_lifetime=publisher-holder-shared-ofd" \
        "helper_sha=$helper_sha" \
        "verifier_sha=$verifier_sha" \
        "util_sha=$util_sha" \
        "headers_helper_sha=$headers_helper_sha") || return 1
    cache_signature=$(printf '%s' "$signature_material" | _guest_tools_sha256_stdin) || return 1

    if _guest_tools_verify_output "$target" "$profile" "$cache_signature" "$output_dir"; then
        echo "✓ guest e2fsprogs $source_version already built for $target ($profile)"
        return 0
    fi
    local built_mke2fs="$build_dir/misc/mke2fs.static"
    local built_resize2fs="$build_dir/resize/resize2fs.static"

    echo "🔨 Building e2fsprogs $source_version guest tools for $target ($profile)..."
    local jobs
    jobs=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)
    if ! (
            cd "$build_dir" &&
            env \
                BUILD_CC="$build_cc" \
                BUILD_CFLAGS="$build_cflags" \
                BUILD_LDFLAGS="$build_ldflags" \
                CC="$cc" \
                AR="$ar" \
                RANLIB="$ranlib" \
                STRIP="$strip_tool" \
                PKG_CONFIG=false \
                CPPFLAGS="-I$linux_headers" \
                CFLAGS="$cflags" \
                CFLAGS_STLIB="$cflags" \
                LDFLAGS="$ldflags" \
                LDFLAGS_STATIC="$ldflags -static" \
                ./source/configure "${configure_args[@]}" &&
            make -j"$jobs" libs &&
            make -C misc -j"$jobs" mke2fs.static &&
            make -C resize -j"$jobs" resize2fs.static
        ); then
        echo "ERROR: failed to build guest e2fsprogs for $target" >&2
        return 1
    fi

    verify_guest_elf "$target" "$built_mke2fs" || return 1
    verify_guest_elf "$target" "$built_resize2fs" || return 1

    staging_dir=$(mktemp -d "$(dirname "$output_dir")/.guest-tools-stage.XXXXXX") || return 1

    if ! install -m 0755 "$built_mke2fs" "$staging_dir/mke2fs" || \
       ! install -m 0755 "$built_resize2fs" "$staging_dir/resize2fs" || \
       ! install -m 0644 "$source_snapshot/NOTICE" "$staging_dir/NOTICE"; then
        rm -rf "$staging_dir"
        return 1
    fi

    if [ "$profile" = "release" ]; then
        if ! "$strip_tool" "$staging_dir/mke2fs" || ! "$strip_tool" "$staging_dir/resize2fs"; then
            rm -rf "$staging_dir"
            return 1
        fi
    fi

    if ! verify_guest_elf "$target" "$staging_dir/mke2fs" || \
       ! verify_guest_elf "$target" "$staging_dir/resize2fs"; then
        rm -rf "$staging_dir"
        return 1
    fi

    local dirty=false
    if [ -n "$source_status" ]; then
        dirty=true
    fi

    local escaped_compiler escaped_cc escaped_build_cc escaped_build_compiler
    local escaped_build_cflags escaped_build_ldflags escaped_ar escaped_ar_version
    local escaped_ranlib escaped_ranlib_version escaped_strip escaped_strip_version
    local escaped_cflags escaped_ldflags escaped_configure
    escaped_compiler=$(printf '%s' "$compiler_version" | _guest_tools_json_escape) || return 1
    escaped_cc=$(printf '%s' "$cc" | _guest_tools_json_escape) || return 1
    escaped_build_cc=$(printf '%s' "$build_cc" | _guest_tools_json_escape) || return 1
    escaped_build_compiler=$(printf '%s' "$build_compiler_version" | _guest_tools_json_escape) || return 1
    escaped_build_cflags=$(printf '%s' "$build_cflags" | _guest_tools_json_escape) || return 1
    escaped_build_ldflags=$(printf '%s' "$build_ldflags" | _guest_tools_json_escape) || return 1
    escaped_ar=$(printf '%s' "$ar" | _guest_tools_json_escape) || return 1
    escaped_ar_version=$(printf '%s' "$ar_version" | _guest_tools_json_escape) || return 1
    escaped_ranlib=$(printf '%s' "$ranlib" | _guest_tools_json_escape) || return 1
    escaped_ranlib_version=$(printf '%s' "$ranlib_version" | _guest_tools_json_escape) || return 1
    escaped_strip=$(printf '%s' "$strip_tool" | _guest_tools_json_escape) || return 1
    escaped_strip_version=$(printf '%s' "$strip_version" | _guest_tools_json_escape) || return 1
    escaped_cflags=$(printf '%s' "$cflags" | _guest_tools_json_escape) || return 1
    escaped_ldflags=$(printf '%s' "$ldflags" | _guest_tools_json_escape) || return 1
    escaped_configure=$(printf '%s' "$configure_text" | _guest_tools_json_escape) || return 1

    if ! printf '{\n  "name": "e2fsprogs",\n  "version": "%s",\n  "revision": "%s",\n  "dirty": %s,\n  "dirty_diff_sha256": "%s",\n  "untracked_content_sha256": "%s",\n  "snapshot_content_sha256": "%s"\n}\n' \
        "$source_version" "$source_commit" "$dirty" "$source_diff_sha" \
        "$source_untracked_sha" "$source_snapshot_id" \
        > "$staging_dir/source-metadata.json"; then
        rm -rf "$staging_dir"
        return 1
    fi

    if ! printf '{\n  "target": "%s",\n  "profile": "%s",\n  "compiler": "%s",\n  "compiler_version": "%s",\n  "build_compiler": "%s",\n  "build_compiler_version": "%s",\n  "build_cflags": "%s",\n  "build_ldflags": "%s",\n  "ar": "%s",\n  "ar_version": "%s",\n  "ranlib": "%s",\n  "ranlib_version": "%s",\n  "strip": "%s",\n  "strip_version": "%s",\n  "linux_headers_content_id": "%s",\n  "source_snapshot": "private-content-addressed",\n  "linux_headers": "consumer-owned-snapshot",\n  "cflags": "%s",\n  "ldflags": "%s",\n  "configure": "%s",\n  "cache_scope": "verified-output",\n  "publication": "atomic-files-sha256sums-last",\n  "publish_lock": "perl-flock-exclusive",\n  "lock_lifetime": "publisher-holder-shared-ofd",\n  "cache_signature": "%s"\n}\n' \
        "$target" "$profile" "$escaped_cc" "$escaped_compiler" \
        "$escaped_build_cc" "$escaped_build_compiler" \
        "$escaped_build_cflags" "$escaped_build_ldflags" \
        "$escaped_ar" "$escaped_ar_version" "$escaped_ranlib" "$escaped_ranlib_version" \
        "$escaped_strip" "$escaped_strip_version" "$linux_headers_content_id" "$escaped_cflags" \
        "$escaped_ldflags" "$escaped_configure" "$cache_signature" \
        > "$staging_dir/build-metadata.json"; then
        rm -rf "$staging_dir"
        return 1
    fi

    local mke2fs_sha resize2fs_sha mke2fs_size resize2fs_size
    mke2fs_sha=$(_guest_tools_sha256_file "$staging_dir/mke2fs") || return 1
    resize2fs_sha=$(_guest_tools_sha256_file "$staging_dir/resize2fs") || return 1
    mke2fs_size=$(wc -c < "$staging_dir/mke2fs" | tr -d '[:space:]') || return 1
    resize2fs_size=$(wc -c < "$staging_dir/resize2fs" | tr -d '[:space:]') || return 1

    if ! printf '{\n  "schema_version": 1,\n  "target": "%s",\n  "profile": "%s",\n  "source": {"name": "e2fsprogs", "version": "%s", "revision": "%s"},\n  "artifacts": [\n    {"path": "mke2fs", "sha256": "%s", "size": %s, "elf": "static-et-exec"},\n    {"path": "resize2fs", "sha256": "%s", "size": %s, "elf": "static-et-exec"}\n  ]\n}\n' \
        "$target" "$profile" "$source_version" "$source_commit" \
        "$mke2fs_sha" "$mke2fs_size" "$resize2fs_sha" "$resize2fs_size" \
        > "$staging_dir/guest-tools-manifest.json"; then
        rm -rf "$staging_dir"
        return 1
    fi

    local checksum_file checksum_name checksum_sha
    : > "$staging_dir/SHA256SUMS" || return 1
    for checksum_name in \
        mke2fs resize2fs NOTICE source-metadata.json build-metadata.json guest-tools-manifest.json; do
        checksum_file="$staging_dir/$checksum_name"
        checksum_sha=$(_guest_tools_sha256_file "$checksum_file") || return 1
        printf '%s  %s\n' "$checksum_sha" "$checksum_name" >> "$staging_dir/SHA256SUMS" || return 1
    done
    chmod 0755 "$staging_dir/mke2fs" "$staging_dir/resize2fs" || return 1
    chmod 0644 \
        "$staging_dir/NOTICE" \
        "$staging_dir/source-metadata.json" \
        "$staging_dir/build-metadata.json" \
        "$staging_dir/guest-tools-manifest.json" \
        "$staging_dir/SHA256SUMS" || return 1

    # Recheck, publication, and post-publication verification form one locked
    # transaction. Concurrent builds may differ (for example, debug DWARF paths)
    # even when their cache signatures match, so their per-file renames must not
    # interleave.
    if ! _guest_tools_install_staging \
        "$target" "$profile" "$cache_signature" "$staging_dir" "$output_dir" \
        "$build_parent/.publish.lock" "$build_dir"; then
        return 1
    fi

    echo "✓ guest e2fsprogs tools → $output_dir"
)

_build_e2fsprogs_guest_main() (
    set -eu
    local profile="release"
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --profile)
                if [ "$#" -lt 2 ]; then
                    echo "ERROR: --profile requires release or debug" >&2
                    return 2
                fi
                profile="$2"
                shift 2
                ;;
            --help|-h)
                echo "Usage: $0 [--profile release|debug]"
                return 0
                ;;
            *)
                echo "ERROR: unknown option: $1" >&2
                echo "Usage: $0 [--profile release|debug]" >&2
                return 2
                ;;
        esac
    done

    local script_build_dir project_root
    script_build_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
    project_root=$(cd "$script_build_dir/../.." && pwd)
    # shellcheck source=../util.sh
    source "$project_root/scripts/util.sh"
    init_guest_vars
    init_musl_toolchain "$GUEST_TARGET"
    ensure_guest_e2fsprogs_for_target "$GUEST_TARGET" "$profile"
)

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    _build_e2fsprogs_guest_main "$@"
fi
