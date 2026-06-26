export const BOX_CREATE_SECRETS_TTL_SECONDS = 24 * 60 * 60

export function boxCreateSecretsKey(boxId: string): string {
  return `box:create-secrets:${boxId}`
}
