// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

export class RuntimeSecretEcsBindings {
  #definitions
  #initialVersions
  #secrets

  constructor({ definitions, initialVersions, secrets }) {
    if (!Array.isArray(definitions)) throw new Error('runtime secret definitions are required')
    if (!initialVersions || typeof initialVersions !== 'object' || Array.isArray(initialVersions)) {
      throw new Error('runtime secret initial versions are required')
    }
    if (!secrets || typeof secrets !== 'object' || Array.isArray(secrets)) {
      throw new Error('runtime secrets are required')
    }
    this.#definitions = definitions
    this.#initialVersions = initialVersions
    this.#secrets = secrets
  }

  arn(id) {
    const arn = this.#secrets[id]?.arn
    if (typeof arn !== 'string' || !arn) {
      throw new Error(`runtime secret ${id} must have a stable known ARN`)
    }
    return arn
  }

  initialVersionsFor(component) {
    if (typeof component !== 'string' || !component) {
      throw new Error('runtime secret consumer component is required')
    }
    let hasRegisteredConsumer = false
    const versions = []
    for (const definition of this.#definitions) {
      const isConsumer = definition.consumers?.some((consumer) => consumer.component === component) ?? false
      if (!isConsumer) continue
      hasRegisteredConsumer = true
      const version = this.#initialVersions[definition.id]
      if (version) versions.push(version)
    }
    if (!hasRegisteredConsumer) throw new Error(`unknown runtime secret consumer component '${component}'`)
    return versions
  }
}
