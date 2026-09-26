/*
 * The registry credential store as the GCP provider actually builds it.
 *
 * `gcp-pitfalls.test.ts` pins the permission lists and reads the grants out of
 * the source. This runs the provider against a stand-in for the engine, so what
 * is checked is which permissions each role was created with, under which id,
 * and the condition as it is rendered — not the literals they are built from.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { gcpRegistryCredentialStoreProvider } from '../stack/providers/gcp/registry-credentials.ts'

type CreatedRole = { name: string; args: { project: string; roleId: string; permissions: string[] } }

const install = (stage: string) => {
  const roles: CreatedRole[] = []
  const target = globalThis as Record<string, unknown>
  target.$app = { name: 'boxlite', stage }
  target.gcp = {
    projects: {
      IAMCustomRole: class {
        name: string
        constructor(_name: string, args: CreatedRole['args']) {
          this.name = `projects/${args.project}/roles/${args.roleId}`
          roles.push({ name: this.name, args })
        }
      },
    },
    organizations: {
      getProjectOutput: () => ({ number: { apply: (render: (n: string) => string) => render('123456789012') } }),
    },
  }
  return roles
}

test('the API is given two roles, and only the version writes are bounded', () => {
  const roles = install('gcp-dev')
  const store = gcpRegistryCredentialStoreProvider({ project: 'boxlite-dev', appShort: 'bl-app' })()

  assert.deepEqual(
    roles.map((role) => [role.args.roleId, role.args.permissions]),
    [
      ['bl_app_gcp_dev_registry_credential_creator', ['secretmanager.secrets.create']],
      ['bl_app_gcp_dev_registry_credential_writer', ['secretmanager.versions.add', 'secretmanager.versions.destroy']],
    ],
  )
  assert.ok(store.active)
  assert.equal(store.binding.createRole, roles[0].name)
  assert.equal(store.binding.writeRole, roles[1].name)
  assert.equal(
    store.binding.condition.expression,
    'resource.name.startsWith("projects/123456789012/secrets/registry-credential-")',
  )
})

test('a role id that would not fit is refused where it is named', () => {
  install('a-stage-name-long-enough-to-overflow-the-limit')

  assert.throws(
    () => gcpRegistryCredentialStoreProvider({ project: 'boxlite-dev', appShort: 'bl-app' })(),
    /the limit is 64/,
  )
})
