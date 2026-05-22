#!/usr/bin/env bash
# Strip trailing whitespace and collapse trailing newlines to exactly one
# across a generated TypeScript client tree, so regens stay byte-identical
# regardless of openapi-generator template quirks.
#
# Usage: postprocess.sh <output-dir> [client-name]
#
# openapi-generator's typescript-axios template (verified on 7.12.0 and
# 7.22.0) emits trailing whitespace on JSDoc continuation lines and on
# "if (... !== undefined) {" guard lines, plus a spurious trailing blank
# line. None of it is human-authored; stripping it lets `git diff --check`
# stay quiet and keeps regen diffs focused on real spec changes.
#
# Generator metadata under .openapi-generator/{VERSION,FILES} is left
# untouched — those files are written verbatim by the generator and
# regen-diff parity matters more than trailing-newline hygiene there.

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $(basename "$0") <output-dir> [client-name]" >&2
  exit 2
fi

OUT_DIR="$1"
CLIENT_NAME="${2:-client}"

if [ ! -d "$OUT_DIR" ]; then
  echo "$(basename "$0"): $OUT_DIR is not a directory" >&2
  exit 1
fi

find "$OUT_DIR" -type f \
  -not -path "*/.openapi-generator/*" \
  \( -name '*.ts' -o -name '*.js' -o -name '*.json' \
     -o -name '*.md' -o -name '*.sh' \) \
  -print0 |
while IFS= read -r -d '' f; do
  # Slurp the whole file (-0777), strip trailing spaces/tabs from every
  # line (multiline /m, global /g), then replace any trailing whitespace
  # (\s*) before end-of-file (\z) with exactly one \n. Single perl pass
  # so we don't pay the rewrite cost twice.
  perl -i -0777 -pe 's/[ \t]+$//mg; s/\s*\z/\n/' "$f"
done

echo "$(basename "$0"): cleaned $OUT_DIR ($CLIENT_NAME)"
