import { API_KEY_PERMISSION_LABELS, IMPLICIT_BOX_READ, apiKeyPermissionSummary } from '@/lib/api-key-permissions'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { organizationAllowsScope } from '@/lib/app-hosting-permissions'

/** Preserves unknown API scopes instead of silently hiding them from the inventory. */
export function ApiKeyPermissionsSummary({
  permissions,
  appHostingPermissions,
}: {
  permissions: readonly string[]
  appHostingPermissions?: readonly string[]
}) {
  return (
    <Popover>
      <PopoverTrigger className="text-left text-body underline decoration-dotted underline-offset-4 focus-visible:outline focus-visible:outline-2">
        {apiKeyPermissionSummary(permissions)}
      </PopoverTrigger>
      <PopoverContent className="max-h-80 overflow-auto space-y-3">
        <p className="text-body font-medium">Permissions</p>
        <ul className="space-y-2">
          {[...new Set(permissions)].map((permission) => (
            <li key={permission} className="text-body">
              {API_KEY_PERMISSION_LABELS[permission] ?? permission}
              {appHostingPermissions &&
                !organizationAllowsScope(permission, appHostingPermissions) &&
                ' · Disabled for this organization'}
              <div className="font-mono text-meta text-muted-foreground break-all">{permission}</div>
            </li>
          ))}
        </ul>
        <p className="text-meta text-muted-foreground">{IMPLICIT_BOX_READ}</p>
      </PopoverContent>
    </Popover>
  )
}
