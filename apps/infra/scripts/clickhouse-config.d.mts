interface BaseClickHouseConfig {
  active: boolean
  database?: string
  writerUsername?: string
  readerUsername?: string
}

export interface DisabledClickHouseConfig extends BaseClickHouseConfig {
  mode: 'disabled'
  active: false
}

export interface SelfHostedClickHouseConfig extends BaseClickHouseConfig {
  mode: 'self-hosted'
  instanceType: string
  dataGiB: number
  retentionHours: number
}

export interface ManagedClickHouseConfig extends BaseClickHouseConfig {
  mode: 'managed'
  url: string
  writerSecretArn: string
  readerSecretArn: string
}

export type ClickHouseConfig =
  | DisabledClickHouseConfig
  | SelfHostedClickHouseConfig
  | ManagedClickHouseConfig

export function resolveClickHouseConfig(environment: NodeJS.ProcessEnv): ClickHouseConfig
export function requireClickHouseSecretArn(
  name: string,
  value: string,
  scope: { region: string; accountId: string; appName: string; stage: string },
): string
export const CLICKHOUSE_STAGE_CONFIG_KEYS: readonly string[]
