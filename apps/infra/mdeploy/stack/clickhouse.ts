/*
 * Where telemetry is written and read back from.
 *
 * Three modes rather than one, and the split is not a portability concern: it
 * is what a stage is willing to run. `self-hosted` is one node this stack owns;
 * `managed` is an endpoint someone else owns, which this stack only records;
 * `disabled` is a stage that keeps no telemetry at all and is the cheapest
 * thing a preview stage can be. All three exist on both clouds, because the
 * choice is about who operates the database rather than about who hosts it.
 *
 * Two accounts, not one. The collector writes and the API reads, and giving
 * both the same credential would mean a compromised read path could rewrite the
 * history it is reading. Each gets its own reference, and neither ever sees a
 * password as a value.
 *
 * `credentialVersion` is here because a rotated password is otherwise invisible
 * to a running container: the reference does not change, so nothing redeploys
 * and the old value stays mounted until something restarts for another reason.
 * Carrying the version into the environment makes the rotation a change the
 * deploy can see.
 */

export type ClickHouseMode = 'self-hosted' | 'managed' | 'disabled'

export type ClickHouseRequest = {
  mode: ClickHouseMode
  /** The database telemetry lands in. One name on every stage. */
  database: string
  writerUsername: string
  readerUsername: string
  /** Only read when `mode` is self-hosted; a managed endpoint sizes itself. */
  instanceSize: 'small' | 'medium'
  dataGb: number
}

/** One account's way in: never a password, always a reference and its version. */
export type ClickHouseAccount = {
  username: string
  passwordRef: $util.Output<string>
  credentialVersion: $util.Output<string>
}

/**
 * What marks a workload as allowed to connect, in the shape its cloud uses.
 *
 * One value on AWS, where a security group admits every member of it at once;
 * a list on GCP, where admission is per identity — so the two callers this
 * database has are two entries there and cannot be collapsed into one.
 */
export type ClickHouseBinding =
  | { cloud: 'aws'; clientGrant: $util.Output<string> }
  | { cloud: 'gcp'; clientGrants: $util.Output<string>[] }

/**
 * A stage that keeps no telemetry.
 *
 * A separate member rather than a nullable handle, so a consumer that reads a
 * URL has to say what it does without one. The collector's answer is to drop
 * its ClickHouse exporter; the API's is to serve no observability pages. Both
 * are deliberate, and neither is what an empty string would have produced.
 */
export type ClickHouse =
  | { active: false; mode: 'disabled' }
  | {
      active: true
      mode: Exclude<ClickHouseMode, 'disabled'>
      url: $util.Output<string>
      database: string
      writer: ClickHouseAccount
      reader: ClickHouseAccount
      binding: ClickHouseBinding
      id: $util.Output<string>
      ready: any[]
    }

export type ClickHouseProvider = (request: ClickHouseRequest) => ClickHouse

/** The name every consumer reads a ClickHouse password under. */
export const CLICKHOUSE_PASSWORD_VARIABLE = 'CLICKHOUSE_PASSWORD'

/**
 * The variable each consumer reads the endpoint under.
 *
 * Two names for one value, because the two programs reading it are unrelated
 * and each already had its own contract: the collector's ClickHouse exporter
 * takes `CLICKHOUSE_ENDPOINT` (`apps/otel-collector/config.yaml`) and the API
 * takes `CLICKHOUSE_URL` (`apps/api/src/config/configuration.ts`). Sending one
 * name to both leaves the other on its own default, and the collector's default
 * is `clickhouse-disabled.invalid` — every batch retried forever against a host
 * that does not exist, with nothing in the deploy having failed.
 *
 * Keyed on the account because in this stack the writer is the collector and
 * the reader is the API; a third consumer arrives with an account of its own.
 */
const ENDPOINT_VARIABLE = { writer: 'CLICKHOUSE_ENDPOINT', reader: 'CLICKHOUSE_URL' } as const

/**
 * What one account needs in a container's plain environment.
 *
 * The password is deliberately absent — it arrives by reference under
 * `CLICKHOUSE_PASSWORD` — and so is anything that would let the two accounts be
 * confused: a caller asks for the writer's or the reader's and gets exactly
 * that one's username.
 */
export const clickHouseEnvironment = (
  clickhouse: ClickHouse,
  account: 'writer' | 'reader',
): Record<string, $util.Output<string> | string> =>
  clickhouse.active
    ? {
        [ENDPOINT_VARIABLE[account]]: clickhouse.url,
        CLICKHOUSE_DATABASE: clickhouse.database,
        CLICKHOUSE_USERNAME: clickhouse[account].username,
        CLICKHOUSE_CREDENTIAL_VERSION: clickhouse[account].credentialVersion,
      }
    : {}
