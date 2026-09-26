/*
 * Where private registry passwords live, and what the API may do with them.
 *
 * The API writes a password when a credential is added and destroys it when
 * the credential is removed, and it may not read one back: an API that could
 * read would put every tenant's registry login one control-plane compromise
 * away. So the store hands out grants per workload rather than one role, and
 * these are the API's. Nothing here grants a read.
 *
 * Kept on the cloud the proxy is on. Without the proxy nothing could use a
 * credential, so the other cloud reports no store and its API leaves private
 * registries off, the way a stage without ClickHouse reports no telemetry.
 */

export type RegistryCredentialStore =
  | { active: false }
  | {
      active: true
      binding: {
        cloud: 'gcp'
        /**
         * Creating a secret, unconditioned. Google authorizes a create against
         * the project, before the secret has a name a condition could test.
         */
        createRole: $util.Output<string>
        /** Adding and destroying versions, bounded by `condition`. */
        writeRole: $util.Output<string>
        /** The credentials' secrets and nothing else in the project. */
        condition: { title: string; description: string; expression: $util.Input<string> }
      }
    }

export type RegistryCredentialStoreProvider = () => RegistryCredentialStore

/** The variable the API picks its store by, from `apps/api/src/config/configuration.ts`. */
export const REGISTRY_SECRET_STORE_VARIABLE = 'REGISTRY_SECRET_STORE'

/** What the API is told, which is nothing at all where there is no store. */
export const registryCredentialEnvironment = (store: RegistryCredentialStore): Record<string, string> =>
  store.active ? { [REGISTRY_SECRET_STORE_VARIABLE]: store.binding.cloud } : {}
