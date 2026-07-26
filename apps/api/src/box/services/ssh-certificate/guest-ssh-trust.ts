/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/** One trusted CA public key and its non-secret identifier. */
export interface GuestSshCaKeyConfig {
  /** Non-secret signer/version identifier, for audit and rotation diagnostics. */
  keyId: string
  /** Canonical OpenSSH CA **public** key line. */
  publicKey: string
}

/**
 * CA trust delivered to a box's in-guest SSH listener at create time.
 *
 * Public material only: CA *public* keys plus non-secret identifiers. No
 * private key of any kind belongs here, which is why this can safely be
 * persisted on the Box row and forwarded through the runner.
 *
 * Immutable for a VM generation. It is persisted with the Box and replayed on
 * start/stop and ordinary recover, so a restart can never pick up a rotated CA
 * set. Picking up a new CA set requires a new VM generation — in this system,
 * creating a replacement Box, which resolves the organization's current set
 * afresh.
 */
export interface GuestSshTrustConfig {
  /** Address the guest SSH server binds inside the VM, e.g. `0.0.0.0:22`. */
  listenAddr: string
  /** Organization every accepted certificate must name as `org:<id>`. */
  organizationId: string
  /** Canonical box ID every accepted certificate must name as `box:<id>`. */
  boxId: string
  /**
   * Trusted CA public keys: the `current` key, plus `next` while a rotation is
   * in flight. At least one, because a listener trusting nothing accepts
   * nothing but still exposes a port.
   */
  caKeys: GuestSshCaKeyConfig[]
}
