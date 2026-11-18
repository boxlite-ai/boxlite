/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { MigrationInterface, QueryRunner } from 'typeorm'

export class RequestDrivenCustomDomains1794398400000 implements MigrationInterface {
  async up(runner: QueryRunner): Promise<void> {
    await runner.query(`ALTER TABLE custom_domain_config
      ADD confirmed_at timestamptz,
      ADD dns_checked_at timestamptz,
      ADD tls_checked_at timestamptz,
      ADD certificate_observed_at timestamptz,
      ADD certificate_expires_at timestamptz,
      ADD superseded_by uuid,
      ADD cleaned_at timestamptz,
      ADD last_action_at timestamptz NOT NULL DEFAULT now(),
      ADD dns_checks jsonb NOT NULL DEFAULT '[]',
      ADD submission_status varchar NOT NULL DEFAULT 'not_submitted'
        CHECK (submission_status IN ('not_submitted', 'unknown', 'accepted'))`)
    // The old deadline is a capped freshness value, not a certificate's expiry.
    // Preserve completed setups, but never silently restore explicit ownership failures.
    await runner.query(`UPDATE custom_domain_config SET
      confirmed_at = CASE WHEN phase = 'ready' AND (error_code IS NULL OR error_code IN
        ('dns_unavailable', 'verification_unavailable', 'subscription_required', 'subscription_not_ready'))
        THEN updated_at ELSE NULL END,
      phase = CASE WHEN phase = 'ready' AND error_code IN
        ('ownership_txt_mismatch', 'traffic_cname_mismatch', 'traffic_address_mismatch', 'dns_record_missing')
        THEN 'pending_verification' ELSE phase END,
      submission_status = CASE WHEN phase = 'ready' THEN 'accepted' ELSE 'not_submitted' END,
      next_check_at = 'infinity'`)
    await runner.query(`ALTER TABLE custom_domain_config ALTER next_check_at SET DEFAULT 'infinity'`)
    await runner.query(`CREATE INDEX custom_domain_hostname ON custom_domain_config (hostname)`)
  }

  async down(): Promise<void> {
    throw new Error('Custom-domain ownership transfers require a forward migration; do not run legacy writers.')
  }
}
