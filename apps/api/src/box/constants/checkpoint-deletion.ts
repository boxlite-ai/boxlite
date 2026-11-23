// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

// A cancelled import may already have installed a native Box. Keep its public
// row and retry destruction until the runner confirms the destroyed state.
export const CANCELLED_CHECKPOINT_TARGET_SQL = `EXISTS (
  SELECT 1 FROM checkpoint_operation operation
  WHERE operation."boxId" = box.id AND operation.state = 'cancelled'
)`
