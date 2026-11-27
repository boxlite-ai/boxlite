-- +goose Up
ALTER TABLE secret_access_log DROP CONSTRAINT secret_access_log_result_check;
ALTER TABLE secret_access_log ADD CONSTRAINT secret_access_log_result_check CHECK (result IN
 ('ok', 'attestation_failed', 'credential_invalid', 'runner_mismatch',
  'not_found', 'disabled', 'decrypt_failed', 'api_unavailable',
  'scope_mismatch', 'store_unavailable', 'attestation_unavailable'));
