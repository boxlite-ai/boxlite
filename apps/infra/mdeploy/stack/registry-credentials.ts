/** The API writes and revokes credentials; the registry proxy alone reads them. */
export type RegistryCredentialStore =
  | { active: false }
  | {
      active: true
      binding:
        | {
            cloud: 'gcp'
            createRole: $util.Output<string>
            writeRole: $util.Output<string>
            readRole: string
            condition: { title: string; description: string; expression: $util.Input<string> }
          }
        | {
            cloud: 'aws'
            prefix: string
            accountId: string
            region: string
            writeGrant: string
            readGrant: string
          }
    }

export type RegistryCredentialStoreProvider = () => RegistryCredentialStore
export const REGISTRY_SECRET_STORE_VARIABLE = 'REGISTRY_SECRET_STORE'

/** Addresses and namespace metadata only; passwords never enter workload configuration. */
export const registryCredentialEnvironment = (store: RegistryCredentialStore): Record<string, string> => {
  if (!store.active) return {}
  const binding = store.binding
  return {
    [REGISTRY_SECRET_STORE_VARIABLE]: binding.cloud,
    ...(binding.cloud === 'aws'
      ? {
          REGISTRY_SECRET_PREFIX: binding.prefix,
          REGISTRY_SECRET_ACCOUNT_ID: binding.accountId,
          AWS_REGION: binding.region,
        }
      : {}),
  }
}
