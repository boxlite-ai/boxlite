import { CreateApiKeyPermissionsEnum as Permission } from '@boxlite-ai/api-client'
import { CREATE_API_KEY_PERMISSIONS_GROUPS } from '@/constants/CreateApiKeyPermissionsGroups'

/** Labels describe enforced operations, rather than assuming write implies read or delete. */
export const API_KEY_PERMISSION_LABELS: Record<string, string> = {
  'write:boxes': 'Operate boxes',
  'delete:boxes': 'Delete boxes',
  'read:apps': 'View Apps',
  'write:apps': 'Manage Apps',
  'delete:apps': 'Delete Apps',
  'read:volumes': 'View volumes',
  'write:volumes': 'Manage volumes',
  'delete:volumes': 'Delete volumes',
  'read:images': 'View image catalog',
  'write:images': 'Manage image aliases',
  'delete:images': 'Delete images',
  'read:registries': 'View registries',
  'write:registries': 'Manage registry credentials',
  'delete:registries': 'Delete registry credentials',
  'read:members': 'View members',
  'write:members': 'Manage members and invitations',
  'write:templates': 'Manage legacy templates',
  'delete:templates': 'Delete legacy templates',
  'write:regions': 'Manage regions',
  'delete:regions': 'Delete regions',
  'read:runners': 'View runners',
  'write:runners': 'Manage runners',
  'delete:runners': 'Delete runners',
  'read:audit_logs': 'View audit logs',
}
export const API_KEY_PERMISSION_HELP: Record<string, string> = {
  'write:boxes': 'Operate boxes across this organization, including terminal access.',
  'delete:boxes': 'Allows deleting boxes in this organization.',
  'read:apps': 'View Apps and their environments across this organization.',
  'write:apps': 'Create and deploy Apps, and manage their environments across this organization.',
  'delete:apps': 'Allows deleting Apps in this organization.',
  'write:images': 'Includes creating and deleting image aliases.',
  'write:members': 'Includes member and invitation management, and API key revocation.',
}
// The generated fallback represents an unknown API value, not a grant.
export const SUPPORTED_API_KEY_PERMISSIONS = Object.values(Permission).filter(
  (permission) => permission !== Permission.UNKNOWN_DEFAULT_OPEN_API,
)

const primaryGroupNames = ['Boxes', 'Apps', 'Volumes', 'Images', 'Registries', 'Members']
const permissionGroups = [
  ...primaryGroupNames.map((name) => CREATE_API_KEY_PERMISSIONS_GROUPS.find((group) => group.name === name)!),
  ...CREATE_API_KEY_PERMISSIONS_GROUPS.filter((group) => !primaryGroupNames.includes(group.name)),
]
const groupedPermissions = new Set(permissionGroups.flatMap((group) => group.permissions))

export const API_KEY_PERMISSION_GROUPS = [
  ...permissionGroups,
  {
    name: 'Other permissions',
    permissions: SUPPORTED_API_KEY_PERMISSIONS.filter((permission) => !groupedPermissions.has(permission)),
  },
]
export const IMPLICIT_BOX_READ = 'Reading boxes is included and cannot be disabled here.'

export function apiKeyPermissionSummary(permissions: readonly string[]): string {
  const unique = [...new Set(permissions)]
  if (!unique.length) return 'No permissions selected'
  if (unique.length === 1)
    return unique[0] === 'write:boxes' ? 'Box operations' : (API_KEY_PERMISSION_LABELS[unique[0]] ?? unique[0])
  const groups = API_KEY_PERMISSION_GROUPS.filter((group) => group.permissions.some((p) => unique.includes(p)))
  const known = new Set<string>(API_KEY_PERMISSION_GROUPS.flatMap((group) => group.permissions))
  if (groups.length === 1 && unique.every((p) => known.has(p)))
    return `${groups[0].name} · ${unique.length} permissions`
  return `${unique.length} permissions`
}

export function apiKeyExpirationLabel(expiresAt?: string | Date | null): string {
  if (!expiresAt) return 'No expiration'
  const date = new Date(expiresAt)
  if (!Number.isFinite(date.getTime())) return 'Unknown expiration'
  if (date.getTime() <= Date.now()) return 'Expired'
  const days = Math.ceil((date.getTime() - Date.now()) / 86400000)
  return `In ${days} day${days === 1 ? '' : 's'}`
}
export function apiKeyExpirationDate(expiresAt?: string | Date | null): string {
  return expiresAt
    ? new Date(expiresAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'long' })
    : 'No expiration'
}

/** Presets are exact capability bundles, never a partial intersection with available scopes. */
export const API_KEY_ACCESS_PRESETS: { id: string; label: string; description: string; permissions: Permission[] }[] = [
  {
    id: 'operate',
    label: 'Operate boxes',
    description: 'Create, start and stop boxes, and use the terminal. Box deletion is not included.',
    permissions: [Permission.WRITE_BOXES],
  },
  {
    id: 'lifecycle',
    label: 'Manage box lifecycle',
    description: 'Create, operate and delete boxes. Useful for automation that cleans up its resources.',
    permissions: [Permission.WRITE_BOXES, Permission.DELETE_BOXES],
  },
  {
    id: 'volumes',
    label: 'Use boxes with volumes',
    description: 'Create and operate boxes with managed volumes. Box and volume deletion are not included.',
    permissions: [Permission.WRITE_BOXES, Permission.READ_VOLUMES, Permission.WRITE_VOLUMES],
  },
]
