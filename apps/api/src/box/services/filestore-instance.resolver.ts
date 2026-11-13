import { Injectable, Optional } from '@nestjs/common'
import { CloudFilestoreManagerClient } from '@google-cloud/filestore'
import { TypedConfigService } from '../../config/typed-config.service'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { ServiceUnavailableException } from '@nestjs/common'

export interface ResolvedFilestoreInstance {
  server: string
  export: string
}

export type FilestoreLookupSource = 'request' | 'configured'

interface FilestoreApiInstance {
  state?: unknown
  networks?: Array<{
    ipAddresses?: Array<string | null | undefined> | null | undefined
  }> | null
  fileShares?: Array<{
    name?: string | null | undefined
  }> | null
}

export interface FilestoreInstanceLookup {
  getInstance(request: { name: string }): Promise<[FilestoreApiInstance, unknown?, unknown?]>
}

const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/
const READY_FILESTORE_STATE = 2
const CACHE_TTL_MS = 60_000

@Injectable()
export class FilestoreInstanceResolver {
  private client?: FilestoreInstanceLookup
  private readonly cache = new Map<string, { value: ResolvedFilestoreInstance; expiresAt: number }>()

  constructor(
    private readonly configService: TypedConfigService,
    @Optional() private readonly clientFactory?: () => FilestoreInstanceLookup,
  ) {}

  async resolve(instanceName: string, source: FilestoreLookupSource): Promise<ResolvedFilestoreInstance> {
    const config = this.configService.getOrThrow('volume.filestoreInstances')
    const configured = config.instances.find((entry) => entry.instance === instanceName)
    if (!configured) {
      throw new BadRequestError(`unknown Filestore instance '${instanceName}'`)
    }

    const resourceName = `projects/${configured.projectId}/locations/${configured.zone}/instances/${instanceName}`
    const cached = this.cache.get(resourceName)
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value
    }

    const value = await this.lookup(resourceName, source)
    this.cache.set(resourceName, { value, expiresAt: Date.now() + CACHE_TTL_MS })
    return value
  }

  private async lookup(resourceName: string, source: FilestoreLookupSource): Promise<ResolvedFilestoreInstance> {
    let instance: FilestoreApiInstance
    try {
      ;[instance] = await this.lookupClient().getInstance({ name: resourceName })
    } catch (error) {
      if (this.isNotFound(error)) {
        throw source === 'request'
          ? new BadRequestError(`Filestore instance '${resourceName}' was not found`)
          : new ServiceUnavailableException(`Configured Filestore instance '${resourceName}' was not found`)
      }
      throw new ServiceUnavailableException(`Could not look up Filestore instance '${resourceName}'`)
    }
    return this.mountTarget(instance, source, resourceName)
  }

  private lookupClient(): FilestoreInstanceLookup {
    if (!this.client) {
      this.client = this.clientFactory?.() ?? new CloudFilestoreManagerClient()
    }
    return this.client
  }

  private mountTarget(
    instance: FilestoreApiInstance,
    source: FilestoreLookupSource,
    resourceName: string,
  ): ResolvedFilestoreInstance {
    if (instance.state && instance.state !== 'READY') {
      throw this.notUsable(source, `${resourceName} is not ready`)
    }

    const addresses = (instance.networks ?? [])
      .flatMap((network) => network.ipAddresses ?? [])
      .filter((address): address is string => Boolean(address) && IPV4_PATTERN.test(address))
    const shares = (instance.fileShares ?? [])
      .map((share) => share.name)
      .filter((name): name is string => Boolean(name))

    if (typeof instance.state === 'number' && instance.state !== READY_FILESTORE_STATE) {
      throw this.notUsable(source, `${resourceName} is not ready`)
    }

    if (addresses.length !== 1 || shares.length !== 1) {
      throw this.notUsable(source, `${resourceName} does not expose exactly one IPv4 address and one file share`)
    }

    return { server: addresses[0], export: `/${shares[0]}` }
  }

  private notUsable(source: FilestoreLookupSource, reason: string): ServiceUnavailableException | BadRequestError {
    const message = `Filestore instance ${reason}`
    return source === 'request' ? new BadRequestError(message) : new ServiceUnavailableException(message)
  }

  private isNotFound(error: unknown): boolean {
    const code = (error as { code?: number | string } | null)?.code
    return code === 5 || code === '5' || (error instanceof Error && /NOT_FOUND/i.test(error.message))
  }
}
