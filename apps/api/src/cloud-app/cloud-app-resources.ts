import { Injectable, NotFoundException } from '@nestjs/common'
import { DataSource } from 'typeorm'
import { BoxService } from '../box/services/box.service'
import { VolumeService } from '../box/services/volume.service'
import { TunnelService } from '../box/services/tunnel.service'
import { BoxStateWaiterService } from '../box/services/box-state-waiter.service'
import { OrganizationService } from '../organization/services/organization.service'
import { CommerceBoxLimitService } from '../boxlite-rest/commerce-box-limit.service'
import { createBoxToCreateBox, boxToBoxResponse } from '../boxlite-rest/mappers/box-to-box.mapper'
import { Context } from '../common/context/context'
import { EncryptionService } from '../encryption/encryption.service'
import type { BoxliteClient, BoxInfo, CreateBoxRequest } from './engine/boxlite'

@Injectable()
export class CloudAppResources {
  constructor(
    private readonly boxes: BoxService,
    private readonly volumes: VolumeService,
    private readonly tunnels: TunnelService,
    private readonly waiter: BoxStateWaiterService,
    private readonly organizations: OrganizationService,
    private readonly limits: CommerceBoxLimitService,
    private readonly database: DataSource,
    private readonly encryption: EncryptionService,
  ) {}

  forOrganization(organizationId: string): BoxliteClient {
    const organization = async () => {
      const value = await this.organizations.findOne(organizationId)
      if (!value) throw new NotFoundException('Organization not found')
      this.organizations.assertOrganizationIsNotSuspended(value)
      return value
    }
    const info = async (id: string): Promise<BoxInfo> => {
      const box = await this.boxes.findOneByIdOrName(id, organizationId)
      const response = boxToBoxResponse(await this.boxes.toBoxDto(box))
      return { id: response.box_id, name: response.name, status: response.status }
    }
    return {
      createBox: async (request: CreateBoxRequest) => {
        const org = await organization()
        const maxCreatedBoxes = await this.limits.resolveMaxCreatedBoxes(organizationId)
        const dto = createBoxToCreateBox(request)
        dto.labels = { 'boxlite.io/managed-by': 'cloud-app' }
        const box = await this.boxes.create(dto, org, Context.user(), { maxCreatedBoxes })
        await this.waiter.waitForStarted(box.id, organizationId, 120)
        return info(box.id)
      },
      getBox: async (id) => {
        try {
          return await info(id)
        } catch (error) {
          if (error instanceof NotFoundException) return null
          throw error
        }
      },
      startBox: async (id) => {
        await this.boxes.start(id, await organization(), Context.user())
        await this.waiter.waitForStarted(id, organizationId, 120)
      },
      stopBox: async (id) => {
        await this.boxes.stop(id, organizationId, Context.user())
      },
      deleteBox: async (id) => {
        try {
          await this.boxes.destroy(id, organizationId, Context.user())
        } catch (error) {
          if (!(error instanceof NotFoundException)) throw error
        }
        await this.database.query('DELETE FROM cloud_app.box_tunnels WHERE box_id = $1 AND organization_id = $2', [
          id,
          organizationId,
        ])
      },
      tunnel: async (id, port) => {
        await this.boxes.findOneByIdOrName(id, organizationId)
        const [existing] = await this.database.query(
          'SELECT url FROM cloud_app.box_tunnels WHERE box_id = $1 AND organization_id = $2',
          [id, organizationId],
        )
        if (existing) return existing.url
        let access = await this.tunnels.prepare(id, port, false)
        if (!access.token || access.token.includes('*')) {
          await this.tunnels.revoke(id, port)
          access = await this.tunnels.prepare(id, port, false)
        }
        const url = await this.boxes.getNetworkTunnelUrl(id, organizationId, port)
        const token = await this.encryption.encrypt(access.token)
        await this.database.query(
          'INSERT INTO cloud_app.box_tunnels (box_id, organization_id, url, encrypted_token) VALUES ($1, $2, $3, $4) ON CONFLICT (box_id) DO UPDATE SET url = EXCLUDED.url, encrypted_token = EXCLUDED.encrypted_token',
          [id, organizationId, url, token],
        )
        return url
      },
      createVolume: async (name) => {
        const volume = await this.volumes.create(await organization(), { name }, Context.user())
        await this.volumes.waitForReady(volume.id, 120)
        return { id: volume.id, name: volume.name }
      },
      listVolumes: async () =>
        (await this.volumes.findAll(organizationId)).map((v) => ({ id: v.id, name: v.name, state: v.state })),
      deleteVolume: async (id) => {
        const volume = await this.volumes.findOne(id)
        if (volume.organizationId !== organizationId) throw new NotFoundException('Volume not found')
        await this.volumes.delete(id, Context.user(), true)
      },
    }
  }

  async tunnelHeaders(url: string): Promise<Record<string, string>> {
    const [tunnel] = await this.database.query('SELECT encrypted_token FROM cloud_app.box_tunnels WHERE url = $1', [
      url,
    ])
    if (!tunnel) throw new NotFoundException('App tunnel not found')
    return { 'X-BoxLite-Access-Token': await this.encryption.decrypt(tunnel.encrypted_token) }
  }
}
