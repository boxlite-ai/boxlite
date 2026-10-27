-- Reconcile the configured log reader: remove inherited roles and obsolete grants.
REVOKE ALL FROM __LOG_READER__;
REVOKE ALL ON *.* FROM __LOG_READER__;
CREATE SETTINGS PROFILE OR REPLACE __LOG_READER_PROFILE__ SETTINGS
  readonly = 1 CONST,
  cancel_http_readonly_queries_on_client_close = 1 CONST,
  allow_ddl = 0 CONST,
  allow_introspection_functions = 0 CONST,
  max_execution_time = 30 CONST,
  max_result_rows = 10000 CONST,
  max_result_bytes = 10485760 CONST,
  max_rows_to_read = 10000000 CONST,
  max_bytes_to_read = 1073741824 CONST,
  max_memory_usage = 536870912 CONST,
  max_memory_usage_for_user = 1073741824 CONST,
  max_threads = 2 CONST,
  max_concurrent_queries_for_user = 8 CONST,
  result_overflow_mode = 'throw' CONST,
  timeout_overflow_mode = 'throw' CONST,
  read_overflow_mode = 'throw' CONST,
  group_by_overflow_mode = 'throw' CONST,
  output_format_json_quote_64bit_integers = 1 CONST;
ALTER USER __LOG_READER__ SETTINGS PROFILE __LOG_READER_PROFILE__;
GRANT SELECT, SHOW COLUMNS ON otel.otel_logs TO __LOG_READER__;
