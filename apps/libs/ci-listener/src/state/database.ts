/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export interface StateRecord {
  key: string
  version: string
  schema: number
  payload: Json
}

/** Internal storage port; transactions contain no GitHub or Box network calls. */
export interface StateTransaction {
  now(): Promise<number>
  get(key: string, lock?: boolean): Promise<StateRecord | undefined>
  page(after: string, limit: number, prefix?: string): Promise<StateRecord[]>
  put(record: StateRecord, expected: string | null): Promise<boolean>
  remove(key: string, expected: string): Promise<boolean>
}

export interface StateDatabase {
  transaction<T>(
    namespace: string,
    work: (tx: StateTransaction) => Promise<T>,
    mode?: 'write' | 'bootstrap' | 'snapshot',
  ): Promise<T>
}

export class StateConflict extends Error {
  constructor() {
    super('Listener state version changed; reload durable facts before retrying')
  }
}
export class StateCorrupt extends Error {
  constructor() {
    super('Listener state is incomplete or has an unsupported schema; admission is blocked')
  }
}
export class LeaseLost extends Error {
  constructor() {
    super('Listener execution lease is unavailable or expired')
  }
}
