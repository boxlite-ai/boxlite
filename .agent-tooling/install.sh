#!/usr/bin/env bash
# Consumer bootstrap: install the tooling revision this repository floats on.
#
# The profile declares a BRANCH (`tooling.ref`), not a revision. This script resolves
# the branch tip, fetches that exact commit into the immutable content-addressed cache
# (.git/agent-tooling/<sha>/), runs the fetched revision's own setup — which validates
# the profile and configures the Git gates — and only THEN records the revision as
# current. `current` is written last on purpose: it means "fully adopted", so a crash
# anywhere earlier leaves the previous revision active and verifiable.
#
# The recorded revision, not the profile, is what scripts/verify-installation.sh holds
# commits and pushes to — a pure local check, so gates stay fail-closed offline while
# resolution happens only here and in scripts/refresh-installation.sh.
#
# Emergency brake: a `.agent-tooling/hold` file containing exactly one full lowercase
# commit SHA freezes the installation at that revision (resolution is skipped
# entirely). A malformed hold aborts the installation — a broken brake must stop the
# vehicle, never quietly keep floating.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$repo_root" ]] || { printf 'agent-tooling: run inside a Git repository\n' >&2; exit 2; }
profile_file="$repo_root/.agent-tooling/profile.json"
[[ -r "$profile_file" ]] || { printf 'agent-tooling: missing %s\n' "$profile_file" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { printf 'agent-tooling: jq is required\n' >&2; exit 1; }
command -v perl >/dev/null 2>&1 || { printf 'agent-tooling: perl is required\n' >&2; exit 1; }

# BEGIN installer lease helper
install_lock_native() {  # cache directory
  case "${OSTYPE:-}" in
    darwin*)
      LC_ALL=C /bin/df -lP -- "$1" >/dev/null 2>&1 \
        && LC_ALL=C /bin/df -PT apfs,hfs -- "$1" >/dev/null 2>&1 || return 1 ;;
    linux*)
      case "$(stat -f -c %T -- "$1" 2>/dev/null)" in
        ext2/ext3|xfs|btrfs|f2fs|zfs|tmpfs) ;;
        *) return 1 ;;
      esac ;;
    *) return 1 ;;
  esac
  perl -MConfig -e 'exit($Config{d_flock} eq "define" ? 0 : 1)'
}

install_lock_lease() {  # enter|verify|release, cache directory, [command...]
  local perl_command=(perl)
  [[ "$1" != enter ]] || perl_command=(exec perl)
  "${perl_command[@]}" -MFcntl=:DEFAULT,:flock,:mode -MPOSIX=dup2 -e '
    my ($mode, $cache, @command) = @ARGV;
    my $guard = "$cache/.install.guard";
    my $marker = "$cache/.install.lock";
    my $unavailable = sub {
      print STDERR "agent-tooling: another installation is already in progress or the lock is unavailable: $marker\n"
        if $mode eq "enter";
      exit 1;
    };
    my $same_file = sub {
      my ($fh, $path) = @_;
      my @opened = stat($fh);
      my @named = lstat($path);
      return @opened && @named && S_ISREG($opened[2]) && S_ISREG($named[2])
        && $opened[0] == $named[0] && $opened[1] == $named[1];
    };
    if ($mode eq "verify") {
      open(my $lease, "<&=9") or exit 1;
      exit 1 unless flock($lease, LOCK_EX | LOCK_NB)
        && $same_file->($lease, $guard) && $same_file->($lease, $marker);
      exit 0;
    }
    my $flags = O_RDWR | O_NONBLOCK | O_NOFOLLOW;
    $flags |= O_CREAT if $mode eq "enter";
    sysopen(my $lease, $guard, $flags, 0600) or $unavailable->();
    $unavailable->() unless -f $lease && flock($lease, LOCK_EX | LOCK_NB)
      && $same_file->($lease, $guard);
    if ($mode eq "release") {
      exit 0 unless $same_file->($lease, $marker);
      exit(unlink($marker) ? 0 : 1);
    }
    exit 1 unless $mode eq "enter";
    # link() cannot replace a legacy directory or another inode.
    if (!$same_file->($lease, $marker)) {
      link($guard, $marker) or $unavailable->();
    }
    $unavailable->() unless $same_file->($lease, $guard) && $same_file->($lease, $marker);
    dup2(fileno($lease), 9) == 9 or $unavailable->();
    open(my $inherited, "<&=9") or $unavailable->();
    fcntl($inherited, F_SETFD, 0) or $unavailable->();
    exec @command;
    exit 127;
  ' "$@"
}
# END installer lease helper

# Once installed, future adoption fixes come from the recorded package. The rest
# of this file is the self-contained first-install/older-release fallback.
bootstrap_common="$(git -C "$repo_root" rev-parse --path-format=absolute --git-common-dir)"
bootstrap_revision="$(head -n1 "$bootstrap_common/agent-tooling/current" 2>/dev/null || true)"
if [[ "${1:-}" != --install-lease-held && "$bootstrap_revision" =~ ^[0-9a-f]{40}$ ]]; then
  bootstrap_cache="$bootstrap_common/agent-tooling"
  bootstrap_runtime="$bootstrap_cache/$bootstrap_revision/plugins/boxlite-agent-tooling/scripts/install.sh"
  if [[ -x "$bootstrap_runtime" ]]; then
    # A legacy runtime can only acquire the directory form. Retire an unlocked
    # modern marker before handing off, without carrying a descriptor into it.
    if [[ -f "$bootstrap_cache/.install.lock" ]] && install_lock_native "$bootstrap_cache"; then
      install_lock_lease release "$bootstrap_cache" || true
    fi
    exec bash "$bootstrap_runtime" "$@"
  fi
fi

tooling_repo="$(jq -er '.tooling.repository | select(type == "string" and length > 0)' "$profile_file")" || {
  printf 'agent-tooling: tooling.repository is required\n' >&2
  exit 1
}
[[ "$tooling_repo" == "boxlite-ai/agent-tooling" ]] || {
  printf 'agent-tooling: unsupported tooling repository: %s\n' "$tooling_repo" >&2
  exit 1
}
tooling_ref="$(jq -er '.tooling.ref | select(type == "string" and length > 0)' "$profile_file")" || {
  printf 'agent-tooling: tooling.ref must name the branch to float on\n' >&2
  exit 1
}
[[ ! "$tooling_ref" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'agent-tooling: tooling.ref names a branch; to freeze a revision write it to .agent-tooling/hold\n' >&2
  exit 1
}
# check-ref-format allows a leading dash (it is legal REF syntax); refuse it anyway
# so the ref can never read as an option to anything downstream.
if [[ "$tooling_ref" == -* ]] || ! git check-ref-format "refs/heads/$tooling_ref" >/dev/null 2>&1; then
  printf 'agent-tooling: tooling.ref is not a valid branch name: %s\n' "$tooling_ref" >&2
  exit 1
fi

common_git_dir="$(git -C "$repo_root" rev-parse --git-common-dir)"
[[ "$common_git_dir" == /* ]] || common_git_dir="$repo_root/$common_git_dir"
cache_parent="$common_git_dir/agent-tooling"
record_file="$cache_parent/current"
mkdir -p "$cache_parent"

lock_dir="$cache_parent/.install.lock"
lease_held=0
lock_unavailable() {
  printf 'agent-tooling: another installation is already in progress or the lock is unavailable: %s\n' "$lock_dir" >&2
  exit 1
}
if [[ "${1:-}" == --install-lease-held ]]; then
  shift
  install_lock_native "$cache_parent" && install_lock_lease verify "$cache_parent" || lock_unavailable
  lease_held=1
elif install_lock_native "$cache_parent"; then
  install_lock_lease enter "$cache_parent" bash -- "$0" --install-lease-held "$@" || lock_unavailable
  exit 0
else
  mkdir "$lock_dir" 2>/dev/null || lock_unavailable
fi

scratch=""
cleanup() {
  if [[ -n "$scratch" && -d "$scratch" && "$scratch" == "$cache_parent"/.install.* ]]; then
    rm -rf -- "$scratch"
  fi
  if (( lease_held )); then
    exec 9>&-
    install_lock_lease release "$cache_parent" || true
  else
    rm -f -- "$lock_dir/pid"
    rmdir "$lock_dir" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
(( lease_held )) || printf '%s\n' "$$" > "$lock_dir/pid"

recorded_sha() {
  local rec
  rec="$(head -n1 "$record_file" 2>/dev/null || true)"
  [[ "$rec" =~ ^[0-9a-f]{40}$ ]] || return 1
  printf '%s' "$rec"
}

hold_file="$repo_root/.agent-tooling/hold"
target_sha=""
target_source=""
is_offline_repair=0
if [[ -e "$hold_file" ]]; then
  hold_sha="$(tr -d '\n' < "$hold_file")"
  { [[ "$hold_sha" =~ ^[0-9a-f]{40}$ ]] && [[ "$(wc -c < "$hold_file")" -le 41 ]]; } || {
    printf 'agent-tooling: %s must contain exactly one full lowercase commit SHA\n' "$hold_file" >&2
    exit 1
  }
  target_sha="$hold_sha"
  target_source="hold"
else
  resolved="$(git ls-remote "https://github.com/$tooling_repo.git" "refs/heads/$tooling_ref" | awk 'NR==1{print $1}')" || resolved=""
  if [[ "$resolved" =~ ^[0-9a-f]{40}$ ]]; then
    target_sha="$resolved"
    target_source="$tooling_ref"
  else
    # The record is shared across worktrees, but hook paths are worktree-local.
    # Reuse the recorded cache through the same locked validation and setup path:
    # an offline worktree may still be configured for an older adopted revision.
    if current="$(recorded_sha)" && [[ -d "$cache_parent/$current" ]]; then
      printf 'agent-tooling: could not resolve %s on %s; keeping %s\n' "$tooling_ref" "$tooling_repo" "$current" >&2
      target_sha="$current"
      is_offline_repair=1
    else
      printf 'agent-tooling: could not resolve %s on %s and no revision is installed\n' "$tooling_ref" "$tooling_repo" >&2
      exit 1
    fi
  fi
fi

# Git exports GIT_DIR to every hook it runs in a linked worktree, pointing at
# .git/worktrees/<name> — and the lifecycle hooks reach this bootstrap through
# scripts/sync-installation.sh. `git -C <dir>` only changes the working directory; it
# does not clear that environment, so an unguarded git call below would operate on the
# CONSUMER repository instead of the cache: `init` re-initializes the hook's gitdir,
# and because its basename is not `.git` that writes core.bare=true into the SHARED
# config, after which every worktree refuses to operate; `remote add`, `fetch`, and
# `checkout` retarget the consumer's own remotes and working tree; and `rev-parse HEAD`
# answers with the consumer's HEAD, which reads as a corrupt cache. Every call against
# the cache goes through this wrapper. Only the calls that mean the consumer's
# repository (repo_root above) are left to inherit it.
git_cache() {
  env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_INDEX_FILE -u GIT_PREFIX \
      -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES -u GIT_NAMESPACE \
      git "$@"
}

checkout="$cache_parent/$target_sha"
if [[ -e "$checkout" ]]; then
  actual="$(git_cache -C "$checkout" rev-parse HEAD 2>/dev/null || true)"
  [[ "$actual" == "$target_sha" ]] || {
    printf 'agent-tooling: cached checkout has unexpected HEAD: %s\n' "$checkout" >&2
    exit 1
  }
else
  scratch="$(mktemp -d "$cache_parent/.install.XXXXXX")"
  git_cache -C "$scratch" init -q
  git_cache -C "$scratch" remote add origin "https://github.com/$tooling_repo.git"
  git_cache -C "$scratch" fetch -q --depth 1 origin "$target_sha"
  git_cache -C "$scratch" -c advice.detachedHead=false checkout -q --detach "$target_sha"
  actual="$(git_cache -C "$scratch" rev-parse HEAD)"
  [[ "$actual" == "$target_sha" ]] || {
    printf 'agent-tooling: fetched %s instead of resolved %s\n' "$actual" "$target_sha" >&2
    exit 1
  }
  mv "$scratch" "$checkout"
  scratch=""
fi

setup="$checkout/plugins/boxlite-agent-tooling/scripts/setup.sh"
[[ -x "$setup" ]] || { printf 'agent-tooling: fetched checkout has no executable setup script\n' >&2; exit 1; }
"$setup" "$repo_root"

if [[ "$is_offline_repair" == 1 ]]; then
  "$checkout/plugins/boxlite-agent-tooling/scripts/verify-installation.sh" "$repo_root"
  printf 'agent-tooling: repaired installation from cached revision %s (offline)\n' "$target_sha"
  exit 0
fi

# Adopt: everything above succeeded, so this revision is now "current". The record
# moves FIRST, then the metadata — deliberately. A crash between these writes can
# cost the history a line for an adoption that DID happen (a detectable gap: current
# has no matching tail entry); metadata-first would let the history claim an adoption
# that never happened, and a trail that can lie is worse than one that can skip.
tmp_record="$cache_parent/.current.$$"
printf '%s\n' "$target_sha" > "$tmp_record"
mv "$tmp_record" "$record_file"
printf '%s %s %s\n' "$(date +%s)" "$target_source" "$target_sha" >> "$cache_parent/history.log"
touch "$cache_parent/last-check"
printf 'agent-tooling: adopted %s (%s)\n' "$target_sha" "$target_source"
