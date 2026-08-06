/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { isAxiosError } from 'axios'

function getAxiosError(error: unknown): unknown {
  let current = error
  const visited = new Set<unknown>()

  while (current && !visited.has(current)) {
    if (isAxiosError(current)) {
      return current
    }

    visited.add(current)
    current = current instanceof Error ? current.cause : undefined
  }

  return undefined
}

export function isAmbiguousBillingError(error: unknown): boolean {
  const axiosError = getAxiosError(error)
  if (!isAxiosError(axiosError)) {
    return false
  }

  const status = axiosError.response?.status
  return status === undefined || status === 408 || status === 425 || status === 429 || status >= 500
}

export function shouldRetryBillingMutation(failureCount: number, error: unknown): boolean {
  return failureCount < 1 && isAmbiguousBillingError(error)
}

interface TrackedOperation {
  createdAt: number
  expiresAt: number
  idempotencyKey: string
  isInFlight: boolean
  signature: string
}

interface PersistedOperation {
  createdAt: number
  expiresAt: number
  idempotencyKey: string
  signature: string
}

interface PersistedOperationStore {
  version: 1
  operations: PersistedOperation[]
}

export type BillingOperationScope = 'redeem-coupon' | 'wallet-top-up'

const BILLING_OPERATION_TTL_MS = 24 * 60 * 60 * 1000
const BILLING_OPERATION_STORAGE_PREFIX = 'boxlite.billing-operation.v1'
const MAX_SIGNATURE_LENGTH = 4096
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Owns one logical write operation. A lost response keeps its key available for
 * a retry across navigation/reload, while a confirmed result or changed input
 * starts a fresh operation. Persisted entries expire so an abandoned request
 * cannot pin a logical operation forever.
 */
export class BillingOperationTracker {
  private operation: TrackedOperation | undefined
  private readonly storage: Storage | null
  private readonly storageKey: string

  public constructor(scope: BillingOperationScope) {
    this.storageKey = `${BILLING_OPERATION_STORAGE_PREFIX}.${scope}`
    this.storage = getSessionStorage()
  }

  public begin(signature: string): string | undefined {
    this.discardExpiredOperation()

    if (this.operation?.isInFlight) {
      return undefined
    }

    if (this.operation?.signature === signature) {
      this.operation.isInFlight = true
      this.persistOperation(this.operation)
      return this.operation.idempotencyKey
    }

    const persisted = this.findPersistedOperation(signature)
    if (persisted) {
      this.operation = { ...persisted, isInFlight: true }
      return persisted.idempotencyKey
    }

    const createdAt = Date.now()
    this.operation = {
      createdAt,
      expiresAt: createdAt + BILLING_OPERATION_TTL_MS,
      idempotencyKey: crypto.randomUUID(),
      isInFlight: true,
      signature,
    }
    this.persistOperation(this.operation)
    return this.operation.idempotencyKey
  }

  public succeed(idempotencyKey: string): void {
    if (this.operation?.idempotencyKey === idempotencyKey) {
      this.removePersistedOperation(idempotencyKey)
      this.operation = undefined
    }
  }

  public fail(idempotencyKey: string, error: unknown): void {
    if (this.operation?.idempotencyKey !== idempotencyKey) {
      return
    }

    if (isAmbiguousBillingError(error)) {
      this.operation.isInFlight = false
      return
    }

    this.removePersistedOperation(idempotencyKey)
    this.operation = undefined
  }

  private discardExpiredOperation(): void {
    if (!this.operation || this.operation.expiresAt > Date.now()) {
      return
    }

    this.removePersistedOperation(this.operation.idempotencyKey)
    this.operation = undefined
  }

  private findPersistedOperation(signature: string): PersistedOperation | undefined {
    return this.readPersistedOperations().find((operation) => operation.signature === signature)
  }

  private readPersistedOperations(): PersistedOperation[] {
    if (!this.storage) {
      return []
    }

    try {
      const serialized = this.storage.getItem(this.storageKey)
      if (!serialized) {
        return []
      }

      const value: unknown = JSON.parse(serialized)
      if (!isPersistedOperationStore(value)) {
        this.storage.removeItem(this.storageKey)
        return []
      }

      const now = Date.now()
      const validOperations = value.operations.filter((operation) => isValidPersistedOperation(operation, now))
      if (validOperations.length !== value.operations.length) {
        this.writePersistedOperations(validOperations)
      }
      return validOperations
    } catch {
      // Storage can be unavailable in privacy/sandboxed contexts, and its value
      // is untrusted browser state. Fall back to page-local deduplication.
      try {
        this.storage.removeItem(this.storageKey)
      } catch {
        // best effort
      }
      return []
    }
  }

  private persistOperation(operation: TrackedOperation): void {
    if (!this.storage) {
      return
    }

    const persistedOperation: PersistedOperation = {
      createdAt: operation.createdAt,
      expiresAt: operation.expiresAt,
      idempotencyKey: operation.idempotencyKey,
      signature: operation.signature,
    }
    const operations = this.readPersistedOperations().filter(
      (candidate) =>
        candidate.signature !== persistedOperation.signature &&
        candidate.idempotencyKey !== persistedOperation.idempotencyKey,
    )
    operations.push(persistedOperation)
    this.writePersistedOperations(operations)
  }

  private removePersistedOperation(idempotencyKey: string): void {
    if (!this.storage) {
      return
    }

    const operations = this.readPersistedOperations()
    const remaining = operations.filter((operation) => operation.idempotencyKey !== idempotencyKey)
    if (remaining.length !== operations.length) {
      this.writePersistedOperations(remaining)
    }
  }

  private writePersistedOperations(operations: PersistedOperation[]): void {
    if (!this.storage) {
      return
    }

    try {
      if (operations.length === 0) {
        this.storage.removeItem(this.storageKey)
        return
      }
      const store: PersistedOperationStore = { version: 1, operations }
      this.storage.setItem(this.storageKey, JSON.stringify(store))
    } catch {
      // In-memory tracking still protects the current page when storage is full
      // or blocked by the browser.
      return
    }
  }
}

function getSessionStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage
  } catch {
    return null
  }
}

function isPersistedOperationStore(value: unknown): value is PersistedOperationStore {
  if (!value || typeof value !== 'object') {
    return false
  }

  const store = value as Partial<PersistedOperationStore>
  if (store.version !== 1 || !Array.isArray(store.operations) || !store.operations.every(isPersistedOperation)) {
    return false
  }

  const signatures = new Set(store.operations.map((operation) => operation.signature))
  const idempotencyKeys = new Set(store.operations.map((operation) => operation.idempotencyKey))
  return signatures.size === store.operations.length && idempotencyKeys.size === store.operations.length
}

function isPersistedOperation(value: unknown): value is PersistedOperation {
  if (!value || typeof value !== 'object') {
    return false
  }

  const operation = value as Partial<PersistedOperation>
  return (
    typeof operation.createdAt === 'number' &&
    Number.isFinite(operation.createdAt) &&
    typeof operation.expiresAt === 'number' &&
    Number.isFinite(operation.expiresAt) &&
    typeof operation.idempotencyKey === 'string' &&
    UUID_PATTERN.test(operation.idempotencyKey) &&
    typeof operation.signature === 'string' &&
    operation.signature.length > 0 &&
    operation.signature.length <= MAX_SIGNATURE_LENGTH
  )
}

function isValidPersistedOperation(value: unknown, now: number): value is PersistedOperation {
  if (!isPersistedOperation(value)) {
    return false
  }

  return (
    value.createdAt <= now && value.expiresAt > now && value.expiresAt - value.createdAt === BILLING_OPERATION_TTL_MS
  )
}
