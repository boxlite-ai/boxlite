/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export class EmailUtils {
  static normalize(email: string): string {
    return email.toLowerCase().trim()
  }

  static areEqual(email1: string, email2: string): boolean {
    return this.normalize(email1) === this.normalize(email2)
  }
}
