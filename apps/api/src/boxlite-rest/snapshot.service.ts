import {
  Injectable,
  HttpException,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { randomUUID } from 'crypto'
import { FilesystemSnapshot } from './snapshot.entity'
import { BoxService } from '../box/services/box.service'
import { RunnerService } from '../box/services/runner.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { CommerceBoxLimitService } from './commerce-box-limit.service'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { Context } from '../common/context/context'
import { BoxState } from '../box/enums/box-state.enum'
import { CreateBoxDto } from './dto/create-box.dto'
import { boxToBoxResponse, createBoxToCreateBox } from './mappers/box-to-box.mapper'
import { OrganizationResourcePermission as Permission } from '../organization/enums/organization-resource-permission.enum'
import { hasOrganizationResourcePermissions } from '../organization/guards/organization-resource-action.guard'

@Injectable()
export class SnapshotService {
  constructor(
    @InjectRepository(FilesystemSnapshot) private readonly catalog: Repository<FilesystemSnapshot>,
    private readonly boxes: BoxService,
    private readonly runners: RunnerService,
    private readonly waiter: BoxStateWaiterService,
    private readonly limits: CommerceBoxLimitService,
  ) {}

  private async runnerRequest(
    runnerId: string,
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<Record<string, any>> {
    const runner = await this.runners.findOne(runnerId)
    if (!runner || !(runner.apiUrl || runner.proxyUrl)) throw new NotFoundException('snapshot runner is unavailable')
    const response = await fetch(`${runner.apiUrl || runner.proxyUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${runner.apiKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    })
    if (response.status === 204) return {}
    const data = await response.json()
    if (!response.ok) {
      // Nest's exception filter reads flat message/code fields. Preserve the
      // runner's typed error instead of collapsing every 409 into InvalidState.
      throw new HttpException(
        {
          message: data.error?.message ?? 'snapshot runner request failed',
          code: data.error?.code,
        },
        response.status,
      )
    }
    return data
  }

  async capture(auth: OrganizationAuthContext, source: string, body: { name: string; snapshot_type?: string }) {
    const box = await this.boxes.findOneByIdOrName(source, auth.organizationId)
    if (!box.runnerId) throw new NotFoundException('source runner is unavailable')
    const info = await this.runnerRequest(
      box.runnerId,
      `/v1/boxes/${encodeURIComponent(box.id)}/snapshots`,
      'POST',
      body,
    )
    if (info.snapshot_type !== 'filesystem' || info.is_mock || typeof info.id !== 'string') {
      throw new BadRequestException('runner returned an invalid filesystem snapshot')
    }
    const id = randomUUID()
    const record = this.catalog.create({
      id,
      nativeId: info.id,
      runnerId: box.runnerId,
      organizationId: auth.organizationId,
      sourceBoxId: box.id,
      name: body.name,
      metadata: { ...info, id, box_id: box.id },
      createOptions: {
        image: box.image,
        cpu: box.cpu,
        memory: box.mem,
        disk: box.disk,
        target: box.region,
        class: box.class,
        runAsUser: box.runAsUser,
        workingDir: box.workingDir,
        entrypoint: box.entrypoint,
        cmd: box.cmd,
        env: box.env,
        autoStop: box.autoStop,
        autoDelete: box.autoDelete,
        autoResume: box.autoResume,
        outboundEnabled: box.outboundEnabled,
        outboundAllowNet: box.outboundAllowNet ?? undefined,
        // External volumes, secrets, host ports and network identity are explicit new inputs.
        inboundEnabled: false,
      },
    })
    try {
      await this.catalog.save(record)
    } catch (error) {
      await this.runnerRequest(box.runnerId, `/v1/snapshots/${encodeURIComponent(info.id)}`, 'DELETE')
      throw error
    }
    return record.metadata
  }

  async owned(auth: OrganizationAuthContext, id: string): Promise<FilesystemSnapshot> {
    // A malformed UUID is absence, not a PostgreSQL parser error.
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('snapshot not found')
    const snapshot = await this.catalog.findOneBy({ id, organizationId: auth.organizationId })
    if (!snapshot) throw new NotFoundException('snapshot not found')
    return snapshot
  }

  async byName(auth: OrganizationAuthContext, source: string, name: string) {
    const box = await this.boxes.findOneByIdOrName(source, auth.organizationId)
    const snapshot = await this.catalog.findOneBy({ sourceBoxId: box.id, organizationId: auth.organizationId, name })
    if (!snapshot) throw new NotFoundException('snapshot not found')
    return snapshot
  }

  async list(auth: OrganizationAuthContext, source: string) {
    const box = await this.boxes.findOneByIdOrName(source, auth.organizationId)
    return {
      snapshots: (await this.catalog.findBy({ sourceBoxId: box.id, organizationId: auth.organizationId })).map(
        (s) => s.metadata,
      ),
    }
  }

  async get(auth: OrganizationAuthContext, id: string) {
    const snapshot = await this.owned(auth, id)
    await this.runnerRequest(snapshot.runnerId, `/v1/snapshots/${encodeURIComponent(snapshot.nativeId)}`)
    return snapshot.metadata
  }

  async remove(auth: OrganizationAuthContext, id: string) {
    const snapshot = await this.owned(auth, id)
    await this.runnerRequest(snapshot.runnerId, `/v1/snapshots/${encodeURIComponent(snapshot.nativeId)}`, 'DELETE')
    await this.catalog.delete({ id, organizationId: auth.organizationId })
  }

  async copy(auth: OrganizationAuthContext, id: string, runnerId: string, name?: string) {
    const source = await this.owned(auth, id)
    if (source.metadata.snapshot_type !== 'filesystem' || source.metadata.is_mock)
      throw new HttpException({ code: 'unsupported', message: 'only filesystem snapshots can be copied' }, 501)
    const target = await this.runners.getRandomAvailableRunner({
      requiredRunnerId: runnerId,
      regions: [source.createOptions.target],
      boxClass: source.createOptions.class,
    })
    const owner = await this.runners.findOne(source.runnerId)
    if (!owner || !(owner.apiUrl || owner.proxyUrl) || !(target.apiUrl || target.proxyUrl))
      throw new NotFoundException('snapshot runner is unavailable')
    const copyId = randomUUID()
    const copyName = name ?? `copy-${copyId}`
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 240000)
    let info: Record<string, any> | undefined
    try {
      const archive = await fetch(
        `${owner.apiUrl || owner.proxyUrl}/v1/snapshots/${encodeURIComponent(source.nativeId)}/archive`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${owner.apiKey}` },
          signal: abort.signal,
          redirect: 'error',
        },
      )
      if (!archive.ok) await this.transferError(archive)
      if (!archive.body) throw new BadRequestException('snapshot archive is missing')
      const architecture = archive.headers.get('X-Boxlite-Architecture')
      if (!architecture || !['arm64', 'amd64'].includes(architecture)) {
        await archive.body.cancel()
        throw new BadRequestException('snapshot architecture is missing or unsupported')
      }
      const upload = {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${target.apiKey}`,
          'Content-Type': 'application/vnd.boxlite.archive',
          'X-Boxlite-Architecture': architecture,
        },
        body: archive.body,
        duplex: 'half',
        signal: abort.signal,
        redirect: 'error' as const,
      }
      const response = await fetch(
        `${target.apiUrl || target.proxyUrl}/v1/snapshot-imports/${encodeURIComponent(copyName)}`,
        upload,
      )
      if (!response.ok) await this.transferError(response)
      info = await response.json()
      if (info.snapshot_type !== 'filesystem' || info.is_mock || typeof info.id !== 'string')
        throw new BadRequestException('runner returned an invalid filesystem snapshot')
      const record = this.catalog.create({
        id: copyId,
        nativeId: info.id,
        runnerId: target.id,
        organizationId: auth.organizationId,
        sourceBoxId: source.sourceBoxId,
        name: copyName,
        metadata: { ...info, id: copyId, box_id: source.sourceBoxId, name: copyName },
        createOptions: { ...source.createOptions },
      })
      await this.catalog.save(record)
      return record.metadata
    } catch (error) {
      if (typeof info?.id === 'string')
        await this.runnerRequest(target.id, `/v1/snapshots/${encodeURIComponent(info.id)}`, 'DELETE')
      if (error?.driverError?.code === '23505') throw new ConflictException('snapshot name already exists')
      throw error
    } finally {
      clearTimeout(timer)
      // Also cancels a source stream if the destination rejects before reading it.
      abort.abort()
    }
  }

  private async transferError(response: Response): Promise<never> {
    const data = await response.json()
    throw new HttpException(
      { code: data.error?.code, message: data.error?.message ?? 'snapshot transfer failed' },
      response.status,
    )
  }

  async createBox(auth: OrganizationAuthContext, id: string, name?: string, options?: CreateBoxDto) {
    const snapshot = await this.owned(auth, id)
    const info = await this.runnerRequest(snapshot.runnerId, `/v1/snapshots/${encodeURIComponent(snapshot.nativeId)}`)
    if (info.snapshot_type !== 'filesystem' || info.is_mock)
      throw new HttpException({ code: 'unsupported', message: 'only filesystem snapshots can cold-create boxes' }, 501)
    if (
      options?.volumes?.length &&
      !hasOrganizationResourcePermissions(auth, [Permission.READ_VOLUMES, Permission.WRITE_VOLUMES])
    ) {
      throw new ForbiddenException('volume permissions required')
    }
    const config = options ? createBoxToCreateBox(options) : { ...snapshot.createOptions }
    // The snapshot determines the disk image; placement never falls back to another runner.
    config.image = snapshot.createOptions.image
    config.target = snapshot.createOptions.target
    config.name = name
    const maxCreatedBoxes = await this.limits.resolveMaxCreatedBoxes(auth.organizationId)
    let box = await this.boxes.create(config, auth.organization, Context.user(), {
      maxCreatedBoxes,
      snapshot: { nativeId: snapshot.nativeId, runnerId: snapshot.runnerId },
    })
    try {
      if (box.state !== BoxState.STARTED) box = await this.waiter.waitForStarted(box.id, auth.organizationId, 90)
      return boxToBoxResponse(box)
    } catch (error) {
      await this.boxes.destroy(box.id, auth.organizationId, Context.user())
      throw error
    }
  }
}
