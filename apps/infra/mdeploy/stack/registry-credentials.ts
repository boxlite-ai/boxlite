/*
 * Where private registry passwords live, and who may do what with them.
 *
 * The API writes a password when a credential is added and destroys it when
 * the credential is removed. The registry proxy reads it. Neither may do the
 * other's half: an API that could read would put every tenant's registry login
 * one control-plane compromise away, and a proxy that could write could swap
 * one unnoticed. So the store hands out a write grant and a read grant rather
 * than one role, and each workload is given only its own.
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
        /** Reading a version, the registry proxy's alone, bounded the same way. */
        readRole: string
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
