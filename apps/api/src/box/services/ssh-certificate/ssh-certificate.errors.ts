/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, HttpStatus } from '@nestjs/common'

/**
 * Stable, publicly documented error codes for SSH certificate issuance.
 * They are part of the API contract - never rename or repurpose one.
 */
export enum SshCertificateErrorCode {
  SSH_PUBLIC_KEY_REQUIRED = 'SSH_PUBLIC_KEY_REQUIRED',
  INVALID_PUBLIC_KEY = 'INVALID_PUBLIC_KEY',
  UNSUPPORTED_KEY_ALGORITHM = 'UNSUPPORTED_KEY_ALGORITHM',
  INVALID_TTL = 'INVALID_TTL',
  TOO_MANY_ACTIVE_CREDENTIALS = 'TOO_MANY_ACTIVE_CREDENTIALS',
  SSH_CA_UNAVAILABLE = 'SSH_CA_UNAVAILABLE',
  SSH_CERTIFICATE_ISSUANCE_DISABLED = 'SSH_CERTIFICATE_ISSUANCE_DISABLED',
  SSH_CERTIFICATE_NOT_FOUND = 'SSH_CERTIFICATE_NOT_FOUND',
}

/**
 * Messages must stay free of key material: they are surfaced to callers and
 * written to logs. Describe the defect, never echo the offending input.
 */
export class SshCertificateError extends HttpException {
  public readonly code: SshCertificateErrorCode

  constructor(code: SshCertificateErrorCode, message: string, statusCode: HttpStatus, options?: { cause?: unknown }) {
    super({ statusCode, message, code }, statusCode, options)
    this.name = 'SshCertificateError'
    this.code = code
  }

  static publicKeyRequired(): SshCertificateError {
    return new SshCertificateError(
      SshCertificateErrorCode.SSH_PUBLIC_KEY_REQUIRED,
      'An OpenSSH public key is required to issue an SSH certificate',
      HttpStatus.BAD_REQUEST,
    )
  }

  static invalidPublicKey(reason: string): SshCertificateError {
    return new SshCertificateError(
      SshCertificateErrorCode.INVALID_PUBLIC_KEY,
      `Invalid OpenSSH public key: ${reason}`,
      HttpStatus.BAD_REQUEST,
    )
  }

  static unsupportedKeyAlgorithm(algorithm: string): SshCertificateError {
    return new SshCertificateError(
      SshCertificateErrorCode.UNSUPPORTED_KEY_ALGORITHM,
      `Unsupported SSH public key algorithm "${algorithm}"; only ssh-ed25519 is supported`,
      HttpStatus.BAD_REQUEST,
    )
  }

  static invalidTtl(reason: string): SshCertificateError {
    return new SshCertificateError(
      SshCertificateErrorCode.INVALID_TTL,
      `Invalid certificate TTL: ${reason}`,
      HttpStatus.BAD_REQUEST,
    )
  }

  static tooManyActiveCredentials(reason: string): SshCertificateError {
    return new SshCertificateError(
      SshCertificateErrorCode.TOO_MANY_ACTIVE_CREDENTIALS,
      reason,
      HttpStatus.TOO_MANY_REQUESTS,
    )
  }

  static caUnavailable(reason: string, cause?: unknown): SshCertificateError {
    return new SshCertificateError(
      SshCertificateErrorCode.SSH_CA_UNAVAILABLE,
      `SSH certificate authority unavailable: ${reason}`,
      HttpStatus.SERVICE_UNAVAILABLE,
      { cause },
    )
  }

  static issuanceDisabled(): SshCertificateError {
    return new SshCertificateError(
      SshCertificateErrorCode.SSH_CERTIFICATE_ISSUANCE_DISABLED,
      'SSH certificate issuance is disabled for this deployment',
      HttpStatus.FORBIDDEN,
    )
  }

  static notFound(credentialId: string): SshCertificateError {
    return new SshCertificateError(
      SshCertificateErrorCode.SSH_CERTIFICATE_NOT_FOUND,
      `SSH certificate credential "${credentialId}" not found`,
      HttpStatus.NOT_FOUND,
    )
  }
}
