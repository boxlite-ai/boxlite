import type { Box } from '../entities/box.entity'
import type { Runner } from '../entities/runner.entity'
import { memoryGiBOf } from '../utils/memory-allocation'
import type { CompleteCreateBox } from './outbound-control'

export function outboundCreateBoxRequest(
  runner: Runner,
  box: Box,
  image: string,
  metadata?: Record<string, string>,
  nestedVirtualization = false,
): CompleteCreateBox {
  if (box.privileged && !runner.supportsPrivileged) {
    throw new Error(`Runner ${runner.id} does not support privileged Boxes`)
  }
  return {
    id: box.id,
    ...(nestedVirtualization ? { nestedVirtualization: true } : {}),
    image,
    osUser: box.osUser,
    cpuQuota: box.cpu,
    gpuQuota: box.gpu,
    memoryQuota: memoryGiBOf(box),
    storageQuota: box.disk,
    env: box.env,
    runAsUser: box.runAsUser,
    privileged: box.privileged,
    workingDir: box.workingDir,
    entrypoint: box.entrypoint,
    cmd: box.cmd,
    volumes: box.volumes?.map(({ volumeId, mountPath, subpath }) => ({ volumeId, mountPath, subpath })),
    secrets: box.secrets?.map(({ name, value, hosts, placeholder, headers }) => ({
      name,
      value,
      hosts,
      placeholder,
      headers,
    })),
    metadata,
    authToken: box.authToken,
    organizationId: box.organizationId,
    regionId: box.region,
  }
}
