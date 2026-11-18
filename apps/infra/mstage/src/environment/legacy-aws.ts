import { awsBackend, ambientClients } from './aws-backend.ts'

/** SST launchers load TypeScript directly without building the shared CLI package first. */
export const legacyAwsOwnership = (region: string) => {
  const ownership = awsBackend(ambientClients(region)).ownership
  if (!ownership) throw new Error('AWS backend has no deployment ownership guard')
  return ownership
}
