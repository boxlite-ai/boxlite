// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

/**
 * One managed GCP Filestore NFS instance the API may dispatch. The API never
 * creates or deletes instances (the operator provisions them); this list is
 * the declarative set of what a box's mount dispatch may resolve to. Requests
 * and Volume rows carry only the logical name — the address travels solely
 * inside the internal dispatch DTO and the box's persisted volume metadata.
 */
export interface FilestoreInstance {
  name: string
  server: string
  export: string
  mountOptions?: string[]
}

/**
 * Bounds what a Filestore instance logical name may look like. The name is
 * joined into runner-side mount paths (/mnt/boxlite-filestore-<name>), so
 * this rejects anything that could carry a path separator or relative
 * component into one. The runner derives its mount paths from the dispatched
 * name and validates nothing, so this boundary is the only guard.
 */
export const FILESTORE_INSTANCE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

/**
 * Decodes and validates the FILESTORE_INSTANCES JSON array. An unset or empty
 * value means "this deployment consumes no Filestore instances" and is not an
 * error; a create naming an instance outside the list is rejected loudly
 * instead.
 *
 * Every failure below is a deployment mistake that would otherwise surface as
 * a mystery at first box create: malformed JSON, a duplicate name (the runner
 * mount root is keyed by name, so duplicates would alias two instances onto
 * one path), an entry that cannot produce a usable mount, or a mount option
 * that would silently override the pinned protocol. All of them throw so the
 * API refuses to start rather than half-serve.
 */
export function parseFilestoreInstances(env: NodeJS.ProcessEnv = process.env): FilestoreInstance[] {
  const raw = env.FILESTORE_INSTANCES?.trim()
  if (!raw) return []

  let instances: FilestoreInstance[]
  try {
    instances = JSON.parse(raw)
  } catch {
    throw new Error('FILESTORE_INSTANCES is not a valid JSON array of instances')
  }
  if (!Array.isArray(instances)) {
    throw new Error('FILESTORE_INSTANCES is not a valid JSON array of instances')
  }

  const seen = new Set<string>()
  for (const inst of instances) {
    // JSON.parse returns whatever shape it finds: a missing name arrives as
    // undefined, and RegExp.test would stringify it to the literal
    // 'undefined' — which happens to match the pattern.
    if (typeof inst.name !== 'string' || !FILESTORE_INSTANCE_NAME_PATTERN.test(inst.name)) {
      throw new Error(`FILESTORE_INSTANCES entry has an invalid name '${inst.name}' (must match ${FILESTORE_INSTANCE_NAME_PATTERN})`)
    }
    if (seen.has(inst.name)) {
      throw new Error(`FILESTORE_INSTANCES defines instance '${inst.name}' more than once`)
    }
    seen.add(inst.name)
    if (!inst.server) {
      throw new Error(`FILESTORE_INSTANCES entry '${inst.name}' has no server`)
    }
    if (!inst.export) {
      throw new Error(`FILESTORE_INSTANCES entry '${inst.name}' has no export`)
    }
    // The protocol version and retry posture are design-pinned (NFSv4.1,
    // hard): mount(8) lets a later duplicate option override an earlier one,
    // so an entry carrying them would silently override the pinned argv.
    // Everything else may be appended via mountOptions.
    for (const opt of inst.mountOptions ?? []) {
      const lower = opt.trim().toLowerCase()
      for (const pinned of ['vers', 'nfsvers', 'proto', 'soft', 'hard']) {
        if (lower.startsWith(pinned)) {
          throw new Error(`FILESTORE_INSTANCES entry '${inst.name}' sets pinned mount option '${opt}' (protocol is NFSv4.1, retry posture is hard; mountOptions may not override them)`)
        }
      }
    }
  }

  return instances
}
