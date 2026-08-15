export const CLICKHOUSE_IMAGE: string
export const EC2_USER_DATA_MAX_BYTES: number
export function renderClickHouseSchema(retentionHours: number): string
export interface ClickHouseUserDataInput {
  region: string
  volumeId: string
  adminSecretArn: string
  writerSecretArn: string
  readerSecretArn: string
  retentionHours: number
}
export function buildClickHouseUserData(input: ClickHouseUserDataInput): string
export function encodeClickHouseUserData(input: ClickHouseUserDataInput): string
