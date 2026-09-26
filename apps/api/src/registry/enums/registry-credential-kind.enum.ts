/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// How the registry proxy logs in upstream. Only `basic` — a username and a
// password or token — exists while every supported registry takes it; another
// kind is an `ALTER TYPE` when one lands.
export enum RegistryCredentialKind {
  BASIC = 'basic',
}
