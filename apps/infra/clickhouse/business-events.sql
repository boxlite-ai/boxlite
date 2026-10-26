-- Business events the API logs, copied out of otel.otel_logs as they arrive and kept for 400 days
-- in organization order, so one organization's activity reads without scanning telemetry.
-- Only events naming an organization are copied; rows logged before the view existed are not.
CREATE DATABASE IF NOT EXISTS analytics;

CREATE TABLE IF NOT EXISTS analytics.business_events (
    Timestamp DateTime64(9, 'UTC') CODEC(Delta(8), ZSTD(1)),
    OrganizationId String CODEC(ZSTD(1)),
    UserId String CODEC(ZSTD(1)),
    EventName LowCardinality(String),
    Outcome LowCardinality(String),
    CorrelationId String CODEC(ZSTD(1)),
    ActorKind LowCardinality(String),
    Reason LowCardinality(String),
    ExceptionType LowCardinality(String),
    AuthMethod LowCardinality(String),
    ClientSource LowCardinality(String),
    SdkVersion LowCardinality(String)
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(Timestamp)
ORDER BY (OrganizationId, Timestamp)
TTL toDateTime(Timestamp) + INTERVAL 400 DAY
SETTINGS ttl_only_drop_parts = 1;

CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.business_events_mv TO analytics.business_events AS
SELECT
    Timestamp,
    LogAttributes['organization.id'] AS OrganizationId,
    LogAttributes['user.id'] AS UserId,
    LogAttributes['event.name'] AS EventName,
    LogAttributes['event.outcome'] AS Outcome,
    LogAttributes['correlation.id'] AS CorrelationId,
    LogAttributes['actor.kind'] AS ActorKind,
    LogAttributes['event.reason'] AS Reason,
    LogAttributes['exception.type'] AS ExceptionType,
    LogAttributes['auth.method'] AS AuthMethod,
    LogAttributes['client.source'] AS ClientSource,
    LogAttributes['sdk.version'] AS SdkVersion
FROM otel.otel_logs
WHERE LogAttributes['event.name'] != '' AND LogAttributes['organization.id'] != '';
