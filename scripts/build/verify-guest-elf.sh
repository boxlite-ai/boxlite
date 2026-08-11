#!/bin/bash
# Validate that a guest executable is a static, non-PIE Linux ELF for TARGET.
#
# Source this file and call:
#   verify_guest_elf <target> <path>
#
# It can also be executed directly with the same two arguments.  Keeping all
# state local makes sourcing this file safe for the build orchestration scripts.

verify_guest_elf() {
    if [ "$#" -ne 2 ]; then
        echo "ERROR: verify_guest_elf requires <target> <path>" >&2
        return 2
    fi

    local LC_ALL=C
    export LC_ALL

    local target="$1"
    local elf_path="$2"
    local expected_machine
    case "$target" in
        x86_64-unknown-linux-musl)
            expected_machine='Advanced Micro Devices X86-64|X86-64'
            ;;
        aarch64-unknown-linux-musl)
            expected_machine='AArch64'
            ;;
        *)
            echo "ERROR: unsupported guest target for ELF verification: $target" >&2
            return 2
            ;;
    esac

    if [ ! -f "$elf_path" ]; then
        echo "ERROR: guest ELF does not exist: $elf_path" >&2
        return 1
    fi
    if [ ! -s "$elf_path" ]; then
        echo "ERROR: guest ELF is empty: $elf_path" >&2
        return 1
    fi
    if [ ! -x "$elf_path" ]; then
        echo "ERROR: guest ELF is not executable: $elf_path" >&2
        return 1
    fi

    local target_arch="${target%%-*}"
    local readelf_tool="${READELF:-}"
    if [ -z "$readelf_tool" ]; then
        local candidate
        for candidate in \
            "${target_arch}-linux-musl-readelf" \
            llvm-readelf \
            /opt/homebrew/opt/llvm/bin/llvm-readelf \
            /usr/local/opt/llvm/bin/llvm-readelf \
            readelf; do
            if command -v "$candidate" >/dev/null 2>&1; then
                readelf_tool="$candidate"
                break
            fi
        done
    fi
    if [ -z "$readelf_tool" ] || ! command -v "$readelf_tool" >/dev/null 2>&1; then
        echo "ERROR: readelf or llvm-readelf is required to verify $elf_path" >&2
        return 1
    fi

    local header_output program_output section_output
    if ! header_output=$("$readelf_tool" -hW "$elf_path" 2>&1); then
        echo "ERROR: failed to read ELF header for $elf_path" >&2
        echo "$header_output" >&2
        return 1
    fi
    if ! program_output=$("$readelf_tool" -lW "$elf_path" 2>&1); then
        echo "ERROR: failed to read ELF program headers for $elf_path" >&2
        echo "$program_output" >&2
        return 1
    fi
    if ! section_output=$("$readelf_tool" -SW "$elf_path" 2>&1); then
        echo "ERROR: failed to read ELF section headers for $elf_path" >&2
        echo "$section_output" >&2
        return 1
    fi

    if ! printf '%s\n' "$header_output" | grep -Eq 'Class:[[:space:]]+ELF64'; then
        echo "ERROR: guest executable must be ELF64: $elf_path" >&2
        return 1
    fi
    if ! printf '%s\n' "$header_output" | grep -Eq "Data:[[:space:]]+2.s complement, little endian"; then
        echo "ERROR: guest executable must be little-endian: $elf_path" >&2
        return 1
    fi
    if ! printf '%s\n' "$header_output" | grep -Eq 'Type:[[:space:]]+EXEC([[:space:]]|$)'; then
        echo "ERROR: guest executable must be non-PIE ET_EXEC: $elf_path" >&2
        return 1
    fi
    if ! printf '%s\n' "$header_output" | grep -Eq "Machine:[[:space:]]+(${expected_machine})([[:space:]]|$)"; then
        echo "ERROR: guest executable machine does not match $target: $elf_path" >&2
        return 1
    fi
    if printf '%s\n' "$program_output" | grep -Eq '(^|[[:space:]])INTERP([[:space:]]|$)'; then
        echo "ERROR: guest executable has a PT_INTERP segment: $elf_path" >&2
        return 1
    fi
    if printf '%s\n' "$program_output" | grep -Eq '(^|[[:space:]])DYNAMIC([[:space:]]|$)'; then
        echo "ERROR: guest executable has a PT_DYNAMIC segment: $elf_path" >&2
        return 1
    fi
    # `readelf -d` implementations disagree once PT_DYNAMIC is absent. The
    # static guest contract rejects the underlying section, so inspect it
    # directly instead of inferring its presence from dynamic-table output.
    if printf '%s\n' "$section_output" | grep -Eq '^[[:space:]]*\[[[:space:]]*[0-9]+\][[:space:]]+([^[:space:]]+[[:space:]]+)?DYNAMIC([[:space:]]|$)'; then
        echo "ERROR: guest executable has an SHT_DYNAMIC section: $elf_path" >&2
        return 1
    fi

    return 0
}

_verify_guest_elf_main() (
    set -eu
    if [ "$#" -ne 2 ]; then
        echo "Usage: $0 <target> <path>" >&2
        return 2
    fi
    verify_guest_elf "$1" "$2"
)

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    _verify_guest_elf_main "$@"
fi
