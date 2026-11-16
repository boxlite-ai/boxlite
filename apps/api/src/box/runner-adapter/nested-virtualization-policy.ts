import type { OrganizationService } from '../../organization/services/organization.service'
import type { RunnerAdapter } from './runnerAdapter'

/** Choose this Cloud attempt only; capability failure falls back before dispatch. */
export async function resolveNestedVirtualization(
  organizationId: string,
  organizations: Pick<OrganizationService, 'isNestedVirtualizationEnabled'>,
  runner: Pick<RunnerAdapter, 'runnerInfo'>,
  timeoutMs: number,
): Promise<boolean> {
  if (!(await organizations.isNestedVirtualizationEnabled(organizationId))) return false
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout>
  try {
    const info = await Promise.race([
      runner.runnerInfo(controller.signal),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort()
          resolve(undefined)
        }, timeoutMs)
      }),
    ])
    return info?.nestedVirtualizationEnabled === true
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}
