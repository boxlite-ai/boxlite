#!/bin/bash
# Build with the supplied Cargo arguments and print BoxLite's exact runtime path.
set -euo pipefail

package_id=$(cargo pkgid -p boxlite)
messages=$(mktemp "${TMPDIR:-/tmp}/boxlite-runtime.XXXXXX")
trap 'rm -f "$messages"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# Keep Cargo diagnostics on stderr and preserve its exit status before parsing.
cargo build "$@" --message-format=json-render-diagnostics > "$messages"

python3 - "$messages" "$package_id" <<'PY'
import json
from pathlib import Path
import sys

try:
    outputs = []
    with open(sys.argv[1]) as messages:
        for line in messages:
            if not line.strip():
                continue
            message = json.loads(line)
            if not isinstance(message, dict):
                raise ValueError("expected a Cargo JSON object")
            if (message.get("reason") == "build-script-executed"
                    and message.get("package_id") == sys.argv[2]):
                outputs.append(message.get("out_dir"))
    if len(outputs) != 1 or not isinstance(outputs[0], str):
        raise ValueError("expected exactly one BoxLite build-script out_dir")
    runtime = Path(outputs[0]) / "runtime"
    if not runtime.is_absolute() or not runtime.is_dir():
        raise ValueError(f"invalid runtime directory: {runtime}")
    print(runtime)
except (OSError, ValueError) as error:
    sys.exit(f"Cannot locate BoxLite runtime from Cargo output: {error}")
PY
