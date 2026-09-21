/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * How long to suggest a caller waits before asking about a box again while its
 * image is being prepared.
 *
 * A hint, not a deadline: nothing enforces it, and the box may be ready sooner.
 * Five seconds because a cold pull runs for roughly twenty-odd seconds, so this
 * is about five checks over one — often enough to notice the transition
 * promptly, rare enough not to be a request per second for half a minute.
 */
export const IMAGE_PREPARATION_RETRY_AFTER_MS = 5_000
