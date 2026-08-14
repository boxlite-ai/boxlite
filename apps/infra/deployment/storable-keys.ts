// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * The keys a stage's secret store may put into a deploy's environment.
 *
 * This started as a denylist of process controls, and seven review rounds each found a new way past
 * it: NODE_OPTIONS, then BASH_ENV and GIT_SSH_COMMAND, then DOCKER_HOST, DOCKER_CONTEXT, LD_AUDIT,
 * SST_BUN_PATH, GH_TOKEN, RUSTC_WRAPPER, SSH_ASKPASS. Every one of them turns a stored string into
 * code or a moved trust boundary inside the sst child, which runs Pulumi with the deploy role's
 * credentials. An enumeration of dangerous names cannot be finished, so this is the other shape:
 * nothing is hydrated unless the deploy demonstrably reads it.
 *
 * Derived from the source that reads them — every `envOr` / `requireEnv` / `process.env.X` under
 * stack/, deployment/, artifacts/, runner/ and shared/, minus the keys isLocalOnlyDeploymentKey
 * refuses. The test beside this file re-derives that set and fails when the two disagree, so adding a
 * config key to the stack fails until it is added here. That failure is the point: it makes widening
 * what a store can inject a decision someone makes, not something that happens.
 *
 * The denylist stays as a second check. It is not the boundary any more, but a key that is both read
 * by the stack and dangerous — AWS_PROFILE is one — must still be refused.
 */
export const STORABLE_STAGE_CONFIG_KEYS: readonly string[] = [
  'ADMIN_API_KEY',
  'APP_URL',
  'BILLING_API_URL',
  'BOXLITE_API_KEY',
  'BOXLITE_API_URL',
  'BOXLITE_RUNNER_STATE_BASELINE',
  'BOXLITE_SYSTEM_BASE_IMAGE',
  'BOXLITE_SYSTEM_IMAGES',
  'BOXLITE_SYSTEM_IMAGE_TAG',
  'BOXLITE_SYSTEM_NODE_IMAGE',
  'BOXLITE_SYSTEM_PYTHON_IMAGE',
  'BOXLITE_SYSTEM_SOURCE_REGISTRY_NAME',
  'BOXLITE_SYSTEM_SOURCE_REGISTRY_PASSWORD',
  'BOXLITE_SYSTEM_SOURCE_REGISTRY_PROJECT_ID',
  'BOXLITE_SYSTEM_SOURCE_REGISTRY_URL',
  'BOXLITE_SYSTEM_SOURCE_REGISTRY_USERNAME',
  'BOX_MIGRATION_ARCHIVE_PREFIX',
  'BOX_OTEL_ENDPOINT_URL',
  'CLICKHOUSE_COMPRESS',
  'CLICKHOUSE_CREATE_SCHEMA',
  'CLICKHOUSE_DATABASE',
  'CLICKHOUSE_ENDPOINT',
  'CLICKHOUSE_EXPORTER_ENABLED',
  'CLICKHOUSE_HOST',
  'CLICKHOUSE_OTEL_ENDPOINT',
  'CLICKHOUSE_PASSWORD',
  'CLICKHOUSE_PORT',
  'CLICKHOUSE_PROTOCOL',
  'CLICKHOUSE_READER_DATABASE',
  'CLICKHOUSE_READER_HOST',
  'CLICKHOUSE_READER_PASSWORD',
  'CLICKHOUSE_READER_PORT',
  'CLICKHOUSE_READER_PROTOCOL',
  'CLICKHOUSE_READER_URL',
  'CLICKHOUSE_READER_USERNAME',
  'CLICKHOUSE_URL',
  'CLICKHOUSE_USERNAME',
  'CLICKHOUSE_WRITER_DATABASE',
  'CLICKHOUSE_WRITER_ENDPOINT',
  'CLICKHOUSE_WRITER_PASSWORD',
  'CLICKHOUSE_WRITER_USERNAME',
  'DASHBOARD_BASE_API_URL',
  'DASHBOARD_URL',
  'DEFAULT_REGION_ID',
  'DEFAULT_RUNNER_API_KEY',
  'DEFAULT_RUNNER_NAME',
  'DEFAULT_TEMPLATE',
  'ENCRYPTION_KEY',
  'ENCRYPTION_SALT',
  'GHCR_TOKEN',
  'GHCR_USERNAME',
  'IAM_PERMISSIONS_BOUNDARY_STAGE',
  'INSTANCE_IDS',
  'JAEGER_PUBLIC',
  'MAILDEV_PUBLIC',
  'OIDC_AUDIENCE',
  'OIDC_END_SESSION_ENDPOINT',
  'OIDC_ISSUER_BASE_URL',
  'OIDC_MANAGEMENT_API_AUDIENCE',
  'OIDC_MANAGEMENT_API_BASE_URL',
  'OIDC_MANAGEMENT_API_ENABLED',
  'OIDC_MANAGEMENT_API_TOKEN_URL',
  'OIDC_POST_LOGOUT_REDIRECT_ALLOWLIST',
  'OTEL_COLLECTOR_API_KEY',
  'OTEL_ENABLED',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_TRACING_ENABLED',
  'PGADMIN_CONFIG_MASTER_PASSWORD_REQUIRED',
  'PGADMIN_CONFIG_SERVER_MODE',
  'PGADMIN_DEFAULT_EMAIL',
  'PGADMIN_DEFAULT_PASSWORD',
  'PGADMIN_PUBLIC',
  'POSTHOG_HOST',
  'PROXY_API_KEY',
  'PROXY_DOMAIN',
  'PROXY_PROTOCOL',
  'PROXY_TEMPLATE_URL',
  'PUBLIC_OIDC_DOMAIN',
  'RUNNERS',
  'RUNNER_PORT',
  'RUNNER_VERSION',
  'STACK_DOMAIN',
  'SVIX_SERVER_URL',
  'USAGE_EXPORT_URL',
]

const STORABLE = new Set(STORABLE_STAGE_CONFIG_KEYS)

export function isStorableStageConfigKey(key: string) {
  return STORABLE.has(key)
}
