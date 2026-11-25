import { TrieRouter } from 'hono/router/trie-router'
import { OrganizationResourcePermission as Permission } from '../organization/enums/organization-resource-permission.enum'

const routes = new TrieRouter<readonly Permission[]>()
const read = [Permission.READ_APPS]
const write = [Permission.WRITE_APPS]
const remove = [Permission.DELETE_APPS]
// The SQL and CLI Open handlers check the final scope after validating their request body.
const byMode = [Permission.READ_APPS, Permission.WRITE_APPS]
const app = '/apps/:app'
const env = app + '/envs/:env'

function allow(prefix: string, method: string, scopes: readonly Permission[], paths: string[]) {
  for (const path of paths) routes.add(method, prefix + path, scopes)
}

allow('', 'GET', read, ['/apps', '/apps/deleted', '/cli/version'])
allow('', 'POST', write, ['/apps', '/apps/deleted/:name/restore'])
allow('', 'DELETE', remove, [app, '/apps/deleted/:name'])

allow(app, 'GET', read, [
  '',
  '/activity',
  '/auth',
  '/auth/email',
  '/context',
  '/database',
  '/database/export',
  '/database/rows/:table',
  '/deployments/:n',
  '/deployments/:n/source',
  '/environments',
  '/envs',
  '/handoff',
  '/logs',
  '/notes',
  '/preview',
  '/secrets',
  '/users.csv',
  '/view',
  '/volumes/:name/files',
])
allow(app, 'POST', write, [
  '/actions',
  '/auth/email/test',
  '/database/restore',
  '/domains',
  '/domains/:host/verify',
  '/environments',
  '/envs',
  '/feedback',
  '/notes',
  '/preview',
  '/publish',
  '/releases/:rid/activate',
  '/restart',
  '/restore',
  '/schedules/:name/run',
  '/sleep',
  '/uploads',
  '/uploads/:id/complete',
  '/users/:uid/:op{sign-out|block|unblock}',
  '/variables/copy',
])
allow(app, 'POST', read, ['/open-ticket'])
allow(app, 'POST', byMode, ['/sql'])
allow(app, 'PUT', write, [
  '/auth/email',
  '/auth/methods/:provider',
  '/secrets/:name{.+}',
  '/uploads/:id/files/:sha',
  '/volumes/:name/files',
])
allow(app, 'DELETE', write, [
  '/auth/email',
  '/domains/:host',
  '/environments/:env',
  '/notes/:id{[0-9]+}',
  '/secrets/:name{.+}',
  '/volumes/:name/files',
])

allow(env, 'GET', read, [
  '',
  '/access',
  '/auth',
  '/auth/redirect-uris',
  '/auth/users',
  '/auth/users/export',
  '/context',
  '/db',
  '/db/applied',
  '/db/export',
  '/db/migrations',
  '/db/rows/:table',
  '/db/schema',
  '/db/schema/:table',
  '/db/snapshots',
  '/deployments',
  '/deployments/:n',
  '/deployments/:n/events',
  '/deployments/:n/source',
  '/deployments/:n/timeline',
  '/domains',
  '/logs',
  '/logs/search',
  '/probe',
  '/schedules',
  '/services',
  '/spec',
  '/vars',
  '/volumes',
  '/volumes/:name/files',
])
allow(env, 'GET', write, ['/dev-env'])
allow(env, 'POST', write, [
  '/auth/test-sessions',
  '/auth/users/:id/block',
  '/auth/users/:id/signout',
  '/auth/users/:id/unblock',
  '/db/import',
  '/db/reset',
  '/db/restore',
  '/db/snapshots',
  '/deployments',
  '/deployments/:n/cancel',
  '/domains',
  '/domains/:host/verify',
  '/findings/:id/ack',
  '/plan',
  '/schedules/:name/run',
  '/services/:name/restart',
])
allow(env, 'POST', byMode, ['/db/sql', '/open-ticket'])
allow(env, 'PUT', write, ['/access', '/volumes/:name/files'])
allow(env, 'DELETE', write, ['', '/auth/test-users', '/domains/:host', '/findings/:id/ack', '/volumes/:name/files'])

export function appRoutePermissions(method: string, path: string): readonly Permission[] {
  const [matches] = routes.match(method === 'HEAD' ? 'GET' : method, path.replace(/\/$/, ''))
  return matches[0]?.[0] ?? []
}
