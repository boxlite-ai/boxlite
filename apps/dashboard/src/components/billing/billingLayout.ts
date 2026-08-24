/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * The billing surface sets its own page width rather than using the shared
 * PageLayout shell. Shared so the plan-change confirmation lines up with the
 * billing page it is reached from and returns to.
 */
export const BILLING_PAGE_CONTAINER = 'mx-auto w-full max-w-[1440px] px-4 sm:px-5 2xl:px-0'
