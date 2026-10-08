/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { Box } from '../../box/entities/box.entity'
import { BoxLastActivity } from '../../box/entities/box-last-activity.entity'
import { BoxMigration } from '../../box/entities/box-migration.entity'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BoxState } from '../../box/enums/box-state.enum'
import { supportedImages } from '../../box/constants/curated-images.constant'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { Organization } from '../../organization/entities/organization.entity'
import { Image } from '../entities/image.entity'
import { ImageTag } from '../entities/image-tag.entity'
import { ImageVersion } from '../entities/image-version.entity'
import { CuratedImagePinService } from './curated-image-pin.service'
import { ImageCatalogService } from './image-catalog.service'
import { ImagePreparationService } from './image-preparation.service'
import { ImageRegistrarService } from './image-registrar.service'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `image_preparation_${process.pid}_${randomUUID().replaceAll('-', '')}`

const ORG_ID = '00000000-0000-4000-8000-000000000001'
const OTHER_ORG_ID = '00000000-0000-4000-8000-000000000002'
const ORG = { id: ORG_ID, imageCountLimit: 20 } as Organization
const DIGEST = `sha256:${'a'.repeat(64)}`

describeIfDatabase('ImagePreparationService (integration, real Postgres)', () => {
  let dataSource: DataSource
  let preparation: ImagePreparationService
  let registrar: ImageRegistrarService
  let catalog: ImageCatalogService
  let ownsSchema = false

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema: schemaName,
      entities: [Image, ImageVersion, ImageTag, Box, BoxLastActivity, BoxMigration],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      synchronize: false,
      extra: { options: `-c search_path=${schemaName},public` },
    }).initialize()

    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    ownsSchema = true
    await dataSource.synchronize()
    // The registrar locks and counts against the organization row before it
    // records a new name, so it needs one. Just the columns it reads; the
    // organization entity and its relations are not this spec's to build.
    await dataSource.query(
      `CREATE TABLE "${schemaName}"."organization" ("id" uuid PRIMARY KEY, "image_count_limit" integer NOT NULL DEFAULT 20)`,
    )
    // No curated image is booted here, so nothing is ever pinned.
    registrar = new ImageRegistrarService(dataSource, {
      remember: jest.fn(async () => undefined),
    } as unknown as CuratedImagePinService)
    preparation = new ImagePreparationService(dataSource.getRepository(ImageVersion))
    catalog = new ImageCatalogService(
      dataSource.getRepository(Image),
      dataSource.getRepository(ImageVersion),
      dataSource.getRepository(ImageTag),
      dataSource.getRepository(Box),
    )
  })

  afterAll(async () => {
    if (!dataSource?.isInitialized) {
      return
    }
    try {
      if (ownsSchema) {
        await dataSource.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`)
      }
    } finally {
      await dataSource.destroy()
    }
  })

  beforeEach(async () => {
    await dataSource.query(`DELETE FROM "${schemaName}"."image_tag"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."image_version"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."image"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."organization"`)
    await dataSource.query(`INSERT INTO "${schemaName}"."organization" ("id") VALUES ($1), ($2)`, [
      ORG_ID,
      OTHER_ORG_ID,
    ])
  })

  function use(ref: string, { org = ORG_ID, digest = DIGEST } = {}) {
    return registrar.onBoxStarted(org, { ref, isOrgOwned: true }, { digest, sizeBytes: 4096 })
  }

  function creatingBox(image: string, { orgOwned = true, organizationId = ORG_ID } = {}): Box {
    const created = new Box('us')
    created.organizationId = organizationId
    created.osUser = 'boxlite'
    created.image = image
    created.imageIsOrgOwned = orgOwned
    created.state = BoxState.CREATING
    created.desiredState = BoxDesiredState.STARTED
    return created
  }

  it('reports a box whose image the catalog has never recorded', async () => {
    const box = creatingBox('quay.io/acme/app:v1')

    expect(await preparation.preparingImage([box])).toEqual(new Set([box.id]))
  })

  it('stops reporting once that image has a pulled version', async () => {
    await use('quay.io/acme/app:v1')
    const box = creatingBox('quay.io/acme/app:v1')

    expect(await preparation.preparingImage([box])).toEqual(new Set())
  })

  /**
   * Three spellings name one catalog row, and a box created with any of them is
   * waiting on the same bytes. Comparing the raw string would report a cached
   * image as still downloading whenever the caller spelled it differently.
   */
  it('recognises the recorded image under a different spelling', async () => {
    await use('quay.io/acme/app:v1')

    const spellings = [
      creatingBox('quay.io/acme/app'),
      creatingBox('quay.io/acme/app:v2'),
      creatingBox(`quay.io/acme/app@${DIGEST}`),
    ]

    expect(await preparation.preparingImage(spellings)).toEqual(new Set())
  })

  it('does not let one organization answer for another', async () => {
    await use('quay.io/acme/app:v1', { org: OTHER_ORG_ID })
    const box = creatingBox('quay.io/acme/app:v1')

    expect(await preparation.preparingImage([box])).toEqual(new Set([box.id]))
  })

  /**
   * Deleting an image is how a tenant picks up a moved tag, so the next box
   * using that reference really is waiting on a fresh pull.
   */
  it('reports again after the image is removed from the catalog', async () => {
    await use('quay.io/acme/app:v1')
    await catalog.delete(ORG, 'quay.io/acme/app')
    const box = creatingBox('quay.io/acme/app:v1')

    expect(await preparation.preparingImage([box])).toEqual(new Set([box.id]))
  })

  /**
   * The curated path must touch neither the catalog nor a registry, so it is
   * excluded before any query is considered — and a curated image is on every
   * runner already, which is the thing progress would be reporting about.
   */
  it('never reports a curated image, and asks the catalog nothing to say so', async () => {
    const curated = supportedImages()[0]
    const box = creatingBox(curated.ref, { orgOwned: false })
    const versions = dataSource.getRepository(ImageVersion)
    const query = jest.spyOn(versions, 'createQueryBuilder')
    const service = new ImagePreparationService(versions)

    expect(await service.preparingImage([box])).toEqual(new Set())
    expect(query).not.toHaveBeenCalled()

    query.mockRestore()
  })

  it('asks nothing for boxes that are not being created', async () => {
    const started = creatingBox('quay.io/acme/app:v1')
    started.state = BoxState.STARTED
    const versions = dataSource.getRepository(ImageVersion)
    const query = jest.spyOn(versions, 'createQueryBuilder')
    const service = new ImagePreparationService(versions)

    expect(await service.preparingImage([started])).toEqual(new Set())
    expect(query).not.toHaveBeenCalled()

    query.mockRestore()
  })

  it('answers a mixed list in a single query', async () => {
    await use('quay.io/acme/cached:v1')
    const cached = creatingBox('quay.io/acme/cached:v1')
    const fresh = creatingBox('quay.io/acme/fresh:v1')
    const started = creatingBox('quay.io/acme/other:v1')
    started.state = BoxState.STARTED

    const versions = dataSource.getRepository(ImageVersion)
    const query = jest.spyOn(versions, 'createQueryBuilder')
    const service = new ImagePreparationService(versions)

    expect(await service.preparingImage([cached, fresh, started])).toEqual(new Set([fresh.id]))
    expect(query).toHaveBeenCalledTimes(1)

    query.mockRestore()
  })
})
