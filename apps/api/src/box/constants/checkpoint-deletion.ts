// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

// A cancelled import may already have installed a native Box. Keep its public
// row and retry destruction until the runner confirms the destroyed state.
export const CANCELLED_CHECKPOINT_TARGET_SQL = `EXISTS (
  SELECT 1 FROM checkpoint_operation operation
  WHERE operation."boxId" = box.id AND operation.state = 'cancelled'
)`

/** Periodic retries and stale-row deletion must agree on which Boxes still need a runner receipt. */
export function pendingDeletionTarget(hostedClientId: string | undefined) {
  if (!hostedClientId) return { sql: CANCELLED_CHECKPOINT_TARGET_SQL, parameters: {} }
  return {
    sql: `(${CANCELLED_CHECKPOINT_TARGET_SQL} OR EXISTS (
      SELECT 1 FROM ci_listener_state ledger
      JOIN ci_listener_state scope ON scope.namespace = ledger.namespace AND scope.record_key = ledger.payload->>'scope'
      WHERE ledger.namespace = :ciNamespace AND ledger.schema_version = 1 AND scope.schema_version = 1
        AND ledger.record_key = 'box-native/' || substring(box.name from '^DESTROYED_ci-jit-([0-9a-f]{32})_[0-9]+$')
        AND ledger.payload->>'box' = box.id AND scope.payload#>>'{scope,organization}' = box."organizationId"::text
    ))`,
    parameters: { ciNamespace: 'ci:' + hostedClientId },
  }
}

/** Retain a terminal Box while its original allocation still needs the destruction receipt. */
export function chargedNativeTombstone(hostedClientId: string | undefined) {
  if (!hostedClientId) return { sql: 'FALSE', parameters: {} }
  return {
    sql: `EXISTS (
      SELECT 1 FROM ci_listener_state worker
      JOIN ci_listener_state ledger ON ledger.namespace = worker.namespace
        AND ledger.record_key = 'box-native/' || substring(worker.record_key from 8)
      JOIN ci_listener_state scope ON scope.namespace = worker.namespace AND scope.record_key = worker.payload->>'scope'
      WHERE worker.namespace = :ciNamespace AND worker.record_key LIKE 'worker/%'
        AND scope.schema_version = 1 AND scope.payload#>>'{scope,organization}' = box."organizationId"::text
        AND worker.schema_version = 1 AND ledger.schema_version = 1
        AND ledger.payload->>'box' = box.id AND ledger.payload->>'scope' = worker.payload->>'scope'
        AND worker.payload#>>'{box,phase}' IN ('requested','known')
    )`,
    parameters: { ciNamespace: 'ci:' + hostedClientId },
  }
}
