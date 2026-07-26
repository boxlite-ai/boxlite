/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { SshCertificateCredential } from '../../box/entities/ssh-certificate-credential.entity'
import { SshCertificateCredentialDto } from '../dto/ssh-certificate.dto'

/** Guest SSH port reached through the existing direct tunnel. */
export const SSH_GUEST_PORT = 22

/**
 * The tunnel URI is region-aware and produced solely by
 * `BoxService.getNetworkTunnelUrl`. Splitting it here keeps hostname
 * construction in exactly one place: nothing in this module ever assembles a
 * proxy hostname itself.
 */
export function tunnelHostFromUri(tunnelUri: string): string {
  // `getNetworkTunnelUrl` returns `<proto>://<host>`; the SSH client needs the
  // bare host, and `URL` is the only correct way to strip the scheme.
  return new URL(tunnelUri).host
}

/**
 * Render the `ProxyCommand` that reaches guest port 22 over the existing
 * direct tunnel. This intentionally reuses the deployed generic tunnel — the
 * SSH work adds no transport of its own.
 */
export function buildProxyCommand(host: string): string {
  return `proxytunnel -p ${host}:443 -E -d 127.0.0.1:${SSH_GUEST_PORT}`
}

/**
 * `known_hosts` entry for the box's persistent host key.
 *
 * Currently always empty: the guest persists a host key and reports its
 * fingerprint over `Guest.Ping`, but nothing carries the key itself to this
 * API, so every caller of `sshCertificateToDto` leaves `hostKey` defaulted.
 * Returning an empty string is deliberate — fabricating a line callers would
 * pin would be worse than admitting we cannot supply one yet.
 */
export function buildKnownHosts(host: string, hostKey: string): string {
  if (!hostKey) {
    return ''
  }
  return `[${host}]:${SSH_GUEST_PORT} ${hostKey}`
}

/**
 * SSH command *template*. `<private-key>` and `<certificate>` stay literal:
 * the caller holds the private key and chooses where to write both files, so
 * this cannot be a ready-to-run line.
 */
export function buildSshCommand(host: string, proxyCommand: string): string {
  return [
    'ssh',
    '-i <private-key>',
    '-o CertificateFile=<certificate>',
    `-o ProxyCommand="${proxyCommand}"`,
    `-p ${SSH_GUEST_PORT}`,
    `root@${host}`,
  ].join(' ')
}

/**
 * Map a stored credential plus its region-aware endpoint into the public DTO.
 *
 * `serial` stays a decimal string end to end. It is a uint64, so a value above
 * 2^53 cannot survive a JavaScript `Number` — converting here would silently
 * corrupt the serial that identifies the certificate to the CA.
 */
export function sshCertificateToDto(
  credential: SshCertificateCredential,
  tunnelUri: string,
  hostKey = '',
): SshCertificateCredentialDto {
  const host = tunnelHostFromUri(tunnelUri)
  const proxyCommand = buildProxyCommand(host)

  return {
    id: credential.id,
    box_id: credential.boxId,
    certificate: credential.certificate,
    public_key: credential.publicKey,
    fingerprint: credential.fingerprint,
    serial: credential.serial,
    ca_key_id: credential.caKeyId,
    valid_after: credential.validAfter.toISOString(),
    expires_at: credential.expiresAt.toISOString(),
    revoked_at: credential.revokedAt ? credential.revokedAt.toISOString() : null,
    host,
    port: SSH_GUEST_PORT,
    ssh_command: buildSshCommand(host, proxyCommand),
    proxy_command: proxyCommand,
    known_hosts: buildKnownHosts(host, hostKey),
    created_at: credential.createdAt.toISOString(),
    updated_at: credential.updatedAt.toISOString(),
  }
}
