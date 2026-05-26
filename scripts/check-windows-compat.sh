#!/usr/bin/env bash
# Pre-CI check: detect code that would fail Windows compilation.
#
# Mirrors the CI workflow (.github/workflows/test-windows.yml):
#   cargo check --workspace --all-targets --exclude boxlite-guest
#   cargo clippy --workspace --all-targets --exclude boxlite-guest -- -D warnings
#   (with BOXLITE_DEPS_STUB=1, which stubs libkrun/gvproxy)
#
# SCOPE: This script reliably catches module-level and file-level issues:
#   - Integration tests missing #![cfg(unix)] (caused CI failures 3 times)
#   - cfg(unix) modules with ungated re-exports (caused CI failure 1 time)
#   - Cross-platform modules missing Windows stub (caused CI failure 1 time)
#
# LIMITATION: Cannot detect function/block-level #[cfg(unix)] gating.
#   For that, you'd need `cargo check --target x86_64-pc-windows-msvc`
#   (requires Windows SDK) or a Rust analysis tool.
#
# Usage: ./scripts/check-windows-compat.sh

set -euo pipefail

RED='\033[0;31m'
YELLOW='\033[0;33m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

errors=0
warnings=0

error() { ((errors++)); echo -e "  ${RED}ERROR${NC}: $1"; }
warn()  { ((warnings++)); echo -e "  ${YELLOW}WARN${NC}: $1"; }
info()  { echo -e "${BOLD}$1${NC}"; }

# Directories NOT compiled on Windows
EXCLUDED_DIRS=("src/guest/" "src/deps/")

UNIX_PATTERNS='use nix::|std::os::unix|std::os::fd::|tokio::signal::unix|use signal_hook|libc::kill|libc::SIG[A-Z]'

# Build list of source paths inside #[cfg(unix)] modules
collect_cfg_unix_paths() {
    while IFS= read -r modfile; do
        local moddir
        moddir=$(dirname "$modfile")
        local prev_is_cfg=false

        while IFS= read -r line; do
            if echo "$line" | grep -qE '^\s*#\[cfg\((unix|target_os\s*=\s*"(linux|macos)"|feature\s*=\s*"(libslirp|seccomp)")\)\]'; then
                prev_is_cfg=true
                continue
            fi
            if $prev_is_cfg; then
                local modname
                modname=$(echo "$line" | sed -n 's/^[[:space:]]*\(pub[[:space:]]*\)\{0,1\}mod[[:space:]]*\([a-z_][a-z0-9_]*\).*/\2/p')
                if [ -n "$modname" ]; then
                    [ -d "$moddir/$modname" ] && echo "$moddir/$modname/"
                    [ -f "$moddir/$modname.rs" ] && echo "$moddir/$modname.rs"
                fi
            fi
            prev_is_cfg=false
        done < "$modfile"
    done < <(find src/ -name 'mod.rs' -o -name 'lib.rs' 2>/dev/null | grep -v src/deps/)
}

CFG_UNIX_PATHS=$(collect_cfg_unix_paths)

is_excluded() {
    local file="$1"
    for dir in "${EXCLUDED_DIRS[@]}"; do
        [[ "$file" == *"$dir"* ]] && return 0
    done
    [[ "$file" == *"/unix.rs" || "$file" == *"/unix/"* ]] && return 0
    head -3 "$file" 2>/dev/null | grep -q '#!\[cfg(unix)\]' && return 0
    while IFS= read -r cfgpath; do
        [ -z "$cfgpath" ] && continue
        [[ "$file" == *"$cfgpath"* ]] && return 0
    done <<< "$CFG_UNIX_PATHS"
    return 1
}

# ============================================================================
# CHECK 1: Integration tests missing #![cfg(unix)]
#
# This is the highest-value check. Every time we've had a Windows CI failure
# from test code, it was because a test file used Unix APIs without #![cfg(unix)].
# The CI compiles tests with --all-targets even though it doesn't run them.
# ============================================================================
info "=== Check 1: Integration tests missing #![cfg(unix)] ==="

found=false
for testfile in src/boxlite/tests/*.rs; do
    [ -f "$testfile" ] || continue
    [ "$(basename "$testfile")" = "mod.rs" ] && continue

    head -3 "$testfile" | grep -q '#!\[cfg(unix)\]' 2>/dev/null && continue

    if grep -qE "$UNIX_PATTERNS" "$testfile" 2>/dev/null; then
        error "$testfile -- Uses Unix APIs but missing #![cfg(unix)]"
        grep -nE "$UNIX_PATTERNS" "$testfile" 2>/dev/null | head -3 | \
            while IFS= read -r m; do echo "      $m"; done
        found=true
    fi
done

$found || echo "  No issues found."

# ============================================================================
# CHECK 2: Module-level imports without cfg gate
#
# Catches: file's top-level `use nix::...` or `use std::os::unix::...`
# that would fail on Windows. Only checks the first 20 lines (import block).
# Skips files excluded from Windows compilation.
# ============================================================================
info ""
info "=== Check 2: Top-level Unix imports in non-gated source files ==="

found=false
while IFS= read -r match; do
    [ -z "$match" ] && continue
    file=$(echo "$match" | cut -d: -f1)
    lineno=$(echo "$match" | cut -d: -f2)
    content=$(echo "$match" | cut -d: -f3-)

    # Only check top-level imports (first 25 lines)
    [ "$lineno" -gt 25 ] && continue

    # Skip test files and excluded paths
    [[ "$file" == */tests/*.rs ]] && continue
    is_excluded "$file" && continue

    # Check preceding line for cfg gate
    if [ "$lineno" -gt 1 ]; then
        prev=$(sed -n "$((lineno-1))p" "$file" 2>/dev/null || true)
        echo "$prev" | grep -qE '#\[cfg\((unix|target_os|feature)' && continue
    fi

    error "$file:$lineno -- $content"
    found=true
done < <(grep -rnE 'use nix::|use std::os::unix|use std::os::fd::|use tokio::signal::unix|use signal_hook' src/ --include='*.rs' 2>/dev/null || true)

$found || echo "  No issues found."

# ============================================================================
# CHECK 3: Cross-platform module completeness
#
# If a directory has unix.rs and its mod.rs dispatches by cfg, there should
# be a matching windows.rs.
# ============================================================================
info ""
info "=== Check 3: Cross-platform module completeness ==="

found=false
while IFS= read -r unix_file; do
    [ -z "$unix_file" ] && continue
    dir=$(dirname "$unix_file")

    skip=false
    for excl in "${EXCLUDED_DIRS[@]}"; do
        [[ "$unix_file" == *"$excl"* ]] && skip=true && break
    done
    $skip && continue

    if [ ! -f "$dir/windows.rs" ]; then
        if [ -f "$dir/mod.rs" ] && grep -q 'cfg(windows)' "$dir/mod.rs" 2>/dev/null; then
            error "$dir/ -- mod.rs references cfg(windows) but windows.rs is missing"
            found=true
        fi
    fi
done < <(find src/ -name 'unix.rs' -not -path '*/deps/*' 2>/dev/null || true)

$found || echo "  No issues found."

# ============================================================================
# CHECK 4: Re-exports from cfg(unix) modules without matching gate
# ============================================================================
info ""
info "=== Check 4: Ungated re-exports from cfg(unix) modules ==="

found=false
while IFS= read -r modfile; do
    [ -z "$modfile" ] && continue
    is_excluded "$modfile" && continue

    # Find cfg(unix)-gated module names in this file
    prev_is_cfg=false
    while IFS= read -r line; do
        if echo "$line" | grep -qE '^\s*#\[cfg\(unix\)\]'; then
            prev_is_cfg=true
            continue
        fi
        if $prev_is_cfg; then
            modname=$(echo "$line" | sed -n 's/^[[:space:]]*\(pub[[:space:]]*\)\{0,1\}mod[[:space:]]*\([a-z_][a-z0-9_]*\).*/\2/p')
            if [ -n "$modname" ]; then
                # Check for ungated pub use from this module
                while IFS= read -r useline; do
                    useno=$(echo "$useline" | cut -d: -f1)
                    if [ "$useno" -gt 1 ]; then
                        prev=$(sed -n "$((useno-1))p" "$modfile" 2>/dev/null || true)
                        if ! echo "$prev" | grep -qE '#\[cfg\(unix\)'; then
                            error "$modfile:$useno -- pub use from cfg(unix) module '$modname' without #[cfg(unix)]"
                            found=true
                        fi
                    fi
                done < <(grep -n "pub use ${modname}::" "$modfile" 2>/dev/null || true)
            fi
        fi
        prev_is_cfg=false
    done < "$modfile"
done < <(find src/ -name 'mod.rs' -o -name 'lib.rs' 2>/dev/null | grep -v src/deps/)

$found || echo "  No issues found."

# ============================================================================
# SUMMARY
# ============================================================================
echo ""
echo "=============================="
if [ "$errors" -gt 0 ]; then
    echo -e "${RED}${BOLD}FAILED${NC}: $errors error(s), $warnings warning(s)"
    echo ""
    echo "These would likely fail Windows CI."
    echo ""
    echo "Note: This script checks module/file-level issues. Function-level"
    echo "#[cfg(unix)] blocks are NOT detected (use cargo check --target"
    echo "x86_64-pc-windows-msvc for full cross-compilation check)."
    exit 1
elif [ "$warnings" -gt 0 ]; then
    echo -e "${YELLOW}${BOLD}PASSED with warnings${NC}: $warnings warning(s)"
    exit 0
else
    echo -e "${GREEN}${BOLD}PASSED${NC}: No Windows compatibility issues found."
    echo ""
    echo "Note: This covers module/file-level gating. Function-level"
    echo "#[cfg(unix)] blocks require cross-compilation to verify."
    exit 0
fi
