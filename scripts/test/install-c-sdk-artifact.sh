#!/usr/bin/env bash

set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
installer="$repo_root/scripts/ci/install-c-sdk-artifact.sh"
test_root=$(mktemp -d "${TMPDIR:-/tmp}/boxlite-c-sdk-artifact-test.XXXXXX")
cleanup() {
  rm -rf "$test_root"
}
trap cleanup EXIT

make_archive() {
  local artifact_dir=$1 version=$2 contents=$3
  local package_dir="$test_root/package-$version/boxlite-c-v$version-linux-x64-gnu"
  mkdir -p "$artifact_dir" "$package_dir/lib"
  printf 'const char *boxlite_test_member(void) { return "%s"; }\n' "$contents" >"$package_dir/member.c"
  cc -c "$package_dir/member.c" -o "$package_dir/member.o"
  ar rcs "$package_dir/lib/libboxlite.a" "$package_dir/member.o"
  tar czf "$artifact_dir/boxlite-c-v$version-linux-x64-gnu.tar.gz" \
    -C "$(dirname "$package_dir")" "$(basename "$package_dir")"
}

valid_dir="$test_root/valid"
make_archive "$valid_dir" '0.9.8-alpha' 'valid archive member'
bash "$installer" "$valid_dir" "$test_root/output/libboxlite.a"
ar t "$test_root/output/libboxlite.a" | grep -Fxq 'member.o'

if bash "$installer" "$test_root/missing" "$test_root/missing-output.a" 2>/dev/null; then
  echo "error: installer accepted a missing artifact directory" >&2
  exit 1
fi

ambiguous_dir="$test_root/ambiguous"
make_archive "$ambiguous_dir" '0.9.8-alpha' 'first archive'
make_archive "$ambiguous_dir" '0.9.8-beta' 'second archive'
if bash "$installer" "$ambiguous_dir" "$test_root/ambiguous-output.a" 2>/dev/null; then
  echo "error: installer accepted multiple C SDK archives" >&2
  exit 1
fi

invalid_dir="$test_root/invalid"
mkdir -p "$invalid_dir/package/not-the-sdk/lib"
printf 'not an archive\n' >"$invalid_dir/package/not-the-sdk/lib/libboxlite.a"
tar czf "$invalid_dir/boxlite-c-v0.9.8-alpha-linux-x64-gnu.tar.gz" \
  -C "$invalid_dir/package" not-the-sdk
if bash "$installer" "$invalid_dir" "$test_root/invalid-output.a" 2>/dev/null; then
  echo "error: installer accepted an archive without the expected package layout" >&2
  exit 1
fi

corrupt_dir="$test_root/corrupt"
corrupt_package="$corrupt_dir/package/boxlite-c-v0.9.8-alpha-linux-x64-gnu"
mkdir -p "$corrupt_dir/artifact" "$corrupt_package/lib"
printf 'not an ar archive\n' >"$corrupt_package/lib/libboxlite.a"
tar czf "$corrupt_dir/artifact/boxlite-c-v0.9.8-alpha-linux-x64-gnu.tar.gz" \
  -C "$(dirname "$corrupt_package")" "$(basename "$corrupt_package")"
if bash "$installer" "$corrupt_dir/artifact" "$test_root/corrupt-output.a" 2>/dev/null; then
  echo "error: installer accepted a corrupt libboxlite.a" >&2
  exit 1
fi

echo "runner C SDK artifact installer tests passed"
