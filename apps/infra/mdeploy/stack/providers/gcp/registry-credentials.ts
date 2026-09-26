/*
 * Registry passwords in Secret Manager: two custom roles and one condition.
 *
 * Custom because no predefined role fits. `secretmanager.admin` carries
 * `versions.access`, the read the API must not have, and `secrets.setIamPolicy`,
 * with which it could grant itself that read. `secretVersionAdder` cannot
 * create a secret. So the API is given exactly the three permissions it calls,
 * and none of `versions.access`, `setIamPolicy` or `secrets.delete`: destroying
 * a version waits seven days before the password is gone, and deleting the
 * secret would skip that wait.
 *
 * Two roles rather than one because the halves bind differently. Adding and
 * destroying versions is bounded to the credentials' secrets by a condition on
 * the name. Creating a secret cannot be: it is authorized against the project,
 * where the name a condition would test does not exist yet. So `create` stands
 * alone, and all it allows is an empty secret the API still cannot fill outside
 * the prefix.
 *
 * The condition is on the project number because that is how Secret Manager
 * spells `resource.name`, whatever the caller wrote.
 */

import type { RegistryCredentialStore } from '../../registry-credentials.ts'

/** Must match the API's `REGISTRY_SECRET_PREFIX` in `apps/api/src/registry/stores/secret.store.ts`. */
export const REGISTRY_SECRET_PREFIX = 'registry-credential-'

export const REGISTRY_SECRET_CREATE_PERMISSIONS = ['secretmanager.secrets.create']
export const REGISTRY_SECRET_WRITE_PERMISSIONS = ['secretmanager.versions.add', 'secretmanager.versions.destroy']

/**
 * A custom role id: letters, digits, `_` and `.`, and unique in the project,
 * which other stages and the rest of BoxLite share, so it carries the stage.
 */
const roleIdFor = (appShort: string, stage: string, role: string): string => {
  const id = `${appShort}_${stage}_${role}`.replace(/[^a-zA-Z0-9_.]/g, '_')
  if (id.length > 64) throw new Error(`The custom role id "${id}" is ${id.length} characters and the limit is 64`)
  return id
}

export const gcpRegistryCredentialStoreProvider =
  ({ project, appShort }: { project: string; appShort: string }) =>
  (): RegistryCredentialStore => {
    const creator = new gcp.projects.IAMCustomRole('RegistryCredentialCreator', {
      project,
      roleId: roleIdFor(appShort, $app.stage, 'registry_credential_creator'),
      title: `Create registry credential secrets (${$app.stage})`,
      permissions: REGISTRY_SECRET_CREATE_PERMISSIONS,
    })
    const writer = new gcp.projects.IAMCustomRole('RegistryCredentialWriter', {
      project,
      roleId: roleIdFor(appShort, $app.stage, 'registry_credential_writer'),
      title: `Write registry credential passwords (${$app.stage})`,
      permissions: REGISTRY_SECRET_WRITE_PERMISSIONS,
    })
    const { number } = gcp.organizations.getProjectOutput({ projectId: project })

    return {
      active: true,
      binding: {
        cloud: 'gcp',
        createRole: creator.name,
        writeRole: writer.name,
        condition: {
          title: 'registry-credentials-only',
          description: `Secrets named ${REGISTRY_SECRET_PREFIX}*`,
          expression: number.apply(
            (projectNumber: string) =>
              `resource.name.startsWith("projects/${projectNumber}/secrets/${REGISTRY_SECRET_PREFIX}")`,
          ),
        },
      },
    }
  }
