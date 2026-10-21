/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/** Delete is soft (PRD 3.13): what stops now, what is kept, and for how long. */
export const RETENTION_DAYS = 7

export function deleteAppBody(name: string) {
  return (
    <span className="flex flex-col gap-2">
      <span>
        {name} stops now: its App key is revoked, its URLs answer &ldquo;deleted&rdquo; and its Boxes are stopped.
      </span>
      <span>
        Its databases, volumes, deployments and logs are kept for {RETENTION_DAYS} days. Until then you can restore it
        from Recently deleted on the Apps page; after that everything is removed for good.
      </span>
    </span>
  )
}
