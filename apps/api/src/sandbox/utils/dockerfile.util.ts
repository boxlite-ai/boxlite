/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// Detects "no-op" dockerfiles that consist of a single `FROM <ref>` and nothing
// else. These can be served by the snapshot-pull path (which is implemented end
// to end) instead of the snapshot-build path (which is currently a stub in the
// BoxLite Go runner — see apps/runner/pkg/boxlite/stubs.go::BuildSnapshot).

// Strips Docker-style comments and trailing whitespace; preserves quoted text.
function stripComments(line: string): string {
  return line.replace(/^\s*#.*$/, '').replace(/\s+$/, '')
}

// Returns the ref if `dockerfile` contains exactly one non-empty instruction
// `FROM <ref>` (case-insensitive, optional platform/stage). Returns null
// otherwise — any RUN/COPY/ADD/ARG/ENV/etc. instruction or multi-stage build
// disqualifies the dockerfile from the pull short-circuit.
export function parseDockerfileForSingleFromRef(dockerfile: string | undefined | null): string | null {
  if (!dockerfile) {
    return null
  }

  const lines = dockerfile.split(/\r?\n/).map(stripComments).filter((l) => l.length > 0)

  if (lines.length !== 1) {
    return null
  }

  const match = lines[0].match(/^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+\S+)?\s*$/i)
  if (!match) {
    return null
  }

  const ref = match[1]
  // Reject build-arg interpolation in the ref — caller would need the build env.
  if (ref.includes('$')) {
    return null
  }

  return ref
}
