/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException, NotFoundException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { Box } from '../../box/entities/box.entity'
// Box relates to both, so mapping Box without them leaves TypeORM unable to
// resolve its inverse sides. Neither is read here.
import { BoxLastActivity } from '../../box/entities/box-last-activity.entity'
import { BoxMigration } from '../../box/entities/box-migration.entity'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { Organization } from '../../organization/entities/organization.entity'
import { Image } from '../entities/image.entity'
import { ImageTag } from '../entities/image-tag.entity'
import { ImageVersion } from '../entities/image-version.entity'
import { CuratedImagePinService } from './curated-image-pin.service'
import { ImageCatalogService } from './image-catalog.service'
import { ImageRegistrarService } from './image-registrar.service'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `image_catalog_${process.pid}_${randomUUID().replaceAll('-', '')}`

const ORG_ID = '00000000-0000-4000-8000-000000000001'
const OTHER_ORG_ID = '00000000-0000-4000-8000-000000000002'
const ORG = { id: ORG_ID, imageCountLimit: 20 } as Organization
const OTHER_ORG = { id: OTHER_ORG_ID, imageCountLimit: 20 } as Organization
const DIGEST = `sha256:${'a'.repeat(64)}`
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`

describeIfDatabase('ImageCatalogService (integration, real Postgres)', () => {
  let dataSource: DataSource
  let catalog: ImageCatalogService
  let registrar: ImageRegistrarService
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
    await dataSource.query(`DELETE FROM "${schemaName}"."box"`)
    await dataSource.query(`DELETE FROM "${schemaName}"."organization"`)
    await dataSource.query(`INSERT INTO "${schemaName}"."organization" ("id") VALUES ($1), ($2)`, [
      ORG_ID,
      OTHER_ORG_ID,
    ])
  })

  /** Rows enter the catalog by being used, so seed them the way production does. */
  function use(ref: string, { org = ORG_ID, digest = DIGEST, sizeBytes = 4096 } = {}) {
    return registrar.onBoxStarted(org, { ref, isOrgOwned: true }, { digest, sizeBytes })
  }

  /** Built through the constructor, which is what fills the id and auth token. */
  async function addBox(
    image: string,
    { desiredState = BoxDesiredState.STARTED, organizationId = ORG_ID } = {},
  ): Promise<string> {
    const created = new Box('us')
    created.organizationId = organizationId
    created.osUser = 'boxlite'
    created.image = image
    created.imageIsOrgOwned = true
    created.desiredState = desiredState
    await dataSource.getRepository(Box).save(created)
    return created.id
  }

  const ownImages = async (organization = ORG) => (await catalog.list(organization)).filter((image) => !image.curated)

  it('lists each tag at the version it points to, then an untagged version by digest', async () => {
    await use('quay.io/acme/app:v1')
    await use('quay.io/acme/app:v2', { digest: OTHER_DIGEST, sizeBytes: 1024 })
    await use(`quay.io/acme/pinned@${DIGEST}`)
    await use('quay.io/acme/mixed:v1')
    await use(`quay.io/acme/mixed@${OTHER_DIGEST}`, { digest: OTHER_DIGEST, sizeBytes: 1024 })
    await use('quay.io/acme/elsewhere:v1', { org: OTHER_ORG_ID })

    const references = await catalog.listReferences(ORG)

    expect(references.map(({ reference, tag, digest, sizeBytes }) => ({ reference, tag, digest, sizeBytes }))).toEqual([
      { reference: 'quay.io/acme/app:v1', tag: 'v1', digest: DIGEST, sizeBytes: 4096 },
      { reference: 'quay.io/acme/app:v2', tag: 'v2', digest: OTHER_DIGEST, sizeBytes: 1024 },
      { reference: 'quay.io/acme/mixed:v1', tag: 'v1', digest: DIGEST, sizeBytes: 4096 },
      { reference: `quay.io/acme/mixed@${OTHER_DIGEST}`, tag: '<none>', digest: OTHER_DIGEST, sizeBytes: 1024 },
      { reference: `quay.io/acme/pinned@${DIGEST}`, tag: '<none>', digest: DIGEST, sizeBytes: 4096 },
    ])
    expect(references[0].name).toBe('quay.io/acme/app')
    expect(references[0].recordedAt).toBeInstanceOf(Date)
  })

  it('lists an image with the tags, version count and size recorded for it', async () => {
    await use('quay.io/acme/app:v1')
    await use('quay.io/acme/app:v2', { digest: OTHER_DIGEST, sizeBytes: 1024 })

    const [image] = await ownImages()

    expect(image).toMatchObject({
      name: 'quay.io/acme/app',
      curated: false,
      curatedRef: null,
      tags: ['v1', 'v2'],
      versionCount: 2,
      sizeBytes: 5120,
    })
    expect(image.id).toEqual(expect.any(String))
    expect(image.lastUsedAt).toEqual(expect.any(String))
  })

  it('keeps one organization out of another catalog', async () => {
    await use('quay.io/acme/app:v1')

    expect(await ownImages(OTHER_ORG)).toEqual([])
    await expect(catalog.get(OTHER_ORG, 'quay.io/acme/app')).rejects.toThrow(NotFoundException)
    expect((await catalog.usage(OTHER_ORG)).count).toBe(0)
  })

  /**
   * Curated images are operator configuration rather than rows, so they are
   * unioned in at read time. They belong to every organization and none, which
   * is why they are neither deletable nor counted.
   */
  it('includes the curated set, which cannot be deleted or counted', async () => {
    const curated = (await catalog.list(ORG)).filter((image) => image.curated)

    expect(curated.length).toBeGreaterThan(0)
    expect(curated.every((image) => image.id === null)).toBe(true)
    expect(curated.every((image) => image.curatedRef?.includes('/'))).toBe(true)

    await expect(catalog.delete(ORG, curated[0].name)).rejects.toThrow(BadRequestError)
    expect((await catalog.usage(ORG)).count).toBe(0)
  })

  /**
   * The cascade only fires on a real delete, so a soft-deleted image keeps its
   * versions and tags. Every read has to join back and filter them out — miss
   * it and a deleted image still answers by name and still fills the quota.
   */
  it('leaves a soft-deleted image out of the list, the detail and the usage', async () => {
    await use('quay.io/acme/app:v1')
    await catalog.delete(ORG, 'quay.io/acme/app')

    const orphanedVersions = await dataSource
      .query(`SELECT COUNT(*)::int AS count FROM "${schemaName}"."image_version"`)
      .then((rows) => rows[0].count)
    expect(orphanedVersions).toBe(1)

    expect(await ownImages()).toEqual([])
    await expect(catalog.get(ORG, 'quay.io/acme/app')).rejects.toThrow(NotFoundException)
    expect(await catalog.usage(ORG)).toMatchObject({ count: 0, knownBytes: 0 })
  })

  it('answers the detail for a catalog id and for every reference that names it', async () => {
    await use('quay.io/acme/app:v1')
    const [listed] = await ownImages()

    for (const idOrRef of [
      listed.id as string,
      'quay.io/acme/app',
      'quay.io/acme/app:v1',
      `quay.io/acme/app@${DIGEST}`,
    ]) {
      const detail = await catalog.get(ORG, idOrRef)
      expect(detail.id).toBe(listed.id)
      expect(detail.versions).toHaveLength(1)
      expect(detail.versions[0]).toMatchObject({ digest: DIGEST, sizeBytes: 4096, sourceRef: 'quay.io/acme/app:v1' })
      // Nothing moves a tag today, so there is nothing to report — and an
      // absent field would mean something different to a caller than an empty
      // one.
      expect(detail.history).toEqual([])
    }
  })

  it('counts held images against the limit and sums what the manifests declared', async () => {
    await use('quay.io/acme/app:v1', { sizeBytes: 4096 })
    await use('quay.io/acme/other:v1', { digest: OTHER_DIGEST, sizeBytes: 1024 })

    expect(await catalog.usage(ORG)).toEqual({ count: 2, limit: 20, knownBytes: 5120 })
  })

  /**
   * C3: a box that has not been destroyed can still boot from the image, so
   * removing the entry would leave that box naming a reference the catalog no
   * longer pins. It is a conflict, not a bad request — nothing about the call
   * is wrong.
   */
  it('refuses while a box that has not been destroyed can still boot from it', async () => {
    await use('quay.io/acme/app:v1')
    const boxId = await addBox('quay.io/acme/app:v1')

    await expect(catalog.delete(ORG, 'quay.io/acme/app')).rejects.toThrow(ConflictException)
    // The box is named, not just counted: the caller's next move is to find it.
    await expect(catalog.delete(ORG, 'quay.io/acme/app')).rejects.toThrow(boxId)
    expect(await ownImages()).toHaveLength(1)
  })

  /**
   * The box's reference is whatever the caller typed, and three spellings name
   * one row. A guard that compared strings would miss two of them and delete an
   * image a live box still uses.
   */
  it('recognises a box using the image under a different spelling', async () => {
    await use('quay.io/acme/app:v1')
    await addBox(`quay.io/acme/app@${DIGEST}`)

    await expect(catalog.delete(ORG, 'quay.io/acme/app')).rejects.toThrow(ConflictException)
  })

  it('allows the delete once the box using it is destroyed', async () => {
    await use('quay.io/acme/app:v1')
    await addBox('quay.io/acme/app:v1', { desiredState: BoxDesiredState.DESTROYED })

    await catalog.delete(ORG, 'quay.io/acme/app')

    expect(await ownImages()).toEqual([])
  })

  it('ignores a live box in another organization', async () => {
    await use('quay.io/acme/app:v1')
    await addBox('quay.io/acme/app:v1', { organizationId: OTHER_ORG_ID })

    await catalog.delete(ORG, 'quay.io/acme/app')

    expect(await ownImages()).toEqual([])
  })

  /**
   * Deleting is how a tenant picks up a tag that moved upstream: the name comes
   * back as a fresh entry the next time it is used. The partial unique index is
   * what allows that, and this is the assertion that keeps it.
   */
  it('frees the name for a new entry once deleted', async () => {
    await use('quay.io/acme/app:v1')
    const [before] = await ownImages()
    await catalog.delete(ORG, 'quay.io/acme/app')

    await use('quay.io/acme/app:v1', { digest: OTHER_DIGEST })

    const [after] = await ownImages()
    expect(after.name).toBe('quay.io/acme/app')
    expect(after.id).not.toBe(before.id)
  })

  it('reports a second delete as not found', async () => {
    await use('quay.io/acme/app:v1')
    await catalog.delete(ORG, 'quay.io/acme/app')

    await expect(catalog.delete(ORG, 'quay.io/acme/app')).rejects.toThrow(NotFoundException)
  })
})
