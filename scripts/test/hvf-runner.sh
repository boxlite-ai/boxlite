#!/usr/bin/env bash
# Cargo runner for the HVF hardware tests. Hypervisor.framework refuses a
# binary without the hypervisor entitlement, so this signs the test binary,
# then runs it under a deadline that ends a stalled guest.
set -euo pipefail

deadline_seconds=120

codesign --sign - --force --entitlements /dev/stdin "$1" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>com.apple.security.hypervisor</key>
	<true/>
</dict>
</plist>
PLIST

# macOS has no timeout(1); the alarm survives exec and ends the test binary.
exec perl -e 'alarm shift; exec @ARGV or die "exec $ARGV[0]: $!\n"' "$deadline_seconds" "$@"
