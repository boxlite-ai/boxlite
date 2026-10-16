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
import { ImageAlias } from '../entities/image-alias.entity'
import { ImageAliasEvent } from '../entities/image-alias-event.entity'
import { ImageVersion } from '../entities/image-version.entity'
import { ImageVersionState } from '../enums/image-version-state.enum'
import { IMAGE_HISTORY_LIMIT } from '../dto/image.dto'
import { CuratedImagePinService } from './curated-image-pin.service'
import { ImageCatalogService, VersionSelector } from './image-catalog.service'
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
      entities: [Image, ImageVersion, ImageAlias, ImageAliasEvent, Box, BoxLastActivity, BoxMigration],
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
      dataSource.getRepository(ImageAlias),
      dataSource.getRepository(ImageAliasEvent),
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
    await dataSource.query(`DELETE FROM "${schemaName}"."image_tag_event"`)
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

  /** A curated image has no recorded build to name, so it lists no reference. */
  it('lists no reference for an organization that has used no image, though it sees the curated set', async () => {
    expect((await catalog.list(ORG)).some((image) => image.curated)).toBe(true)

    expect(await catalog.listReferences(ORG)).toEqual([])
  })

  /**
   * Only ready versions are read, so a tag can point at a version that is not
   * ready, and an image can have no ready version at all. Neither may list a
   * reference to that build.
   */
  it('lists no reference to a version that is not ready', async () => {
    await use('quay.io/acme/app:v1')
    await use('quay.io/acme/app:v2', { digest: OTHER_DIGEST, sizeBytes: 1024 })
    await use('quay.io/acme/gone:v1', { digest: OTHER_DIGEST, sizeBytes: 1024 })
    await dataSource.getRepository(ImageVersion).update({ digest: OTHER_DIGEST }, { state: ImageVersionState.DELETED })

    const references = await catalog.listReferences(ORG)

    expect(references.map(({ reference }) => reference)).toEqual(['quay.io/acme/app:v1'])
  })

  it('lists an image with the aliases, version count and size recorded for it', async () => {
    await use('quay.io/acme/app:v1')
    await use('quay.io/acme/app:v2', { digest: OTHER_DIGEST, sizeBytes: 1024 })

    const [image] = await ownImages()

    expect(image).toMatchObject({
      name: 'quay.io/acme/app',
      curated: false,
      curatedRef: null,
      aliases: ['v1', 'v2'],
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
   * A curated image has no row to look up, so its detail is the listed entry
   * with nothing recorded under it — reached by either of the two names a
   * caller knows it by.
   */
  it('answers the detail for a curated image by its name and by its reference', async () => {
    const [curated] = (await catalog.list(ORG)).filter((image) => image.curated)

    for (const idOrRef of [curated.name, curated.curatedRef as string]) {
      expect(await catalog.get(ORG, idOrRef)).toEqual({ ...curated, versions: [], history: [] })
    }
  })

  /**
   * The route parameter is whatever the caller sent. One that is neither a
   * catalog id nor a reference names nothing here, which is a 404 — not a
   * parse error escaping from a read.
   */
  it('reports a reference that does not parse as not found', async () => {
    await use('quay.io/acme/app:v1')

    await expect(catalog.get(ORG, 'quay.io/Acme/App')).rejects.toThrow(NotFoundException)
    await expect(catalog.delete(ORG, 'quay.io/Acme/App')).rejects.toThrow(NotFoundException)
    expect(await ownImages()).toHaveLength(1)
  })

  /**
   * A digest-pinned reference names no tag, so the registrar records none. The
   * image still lists and answers, with no aliases rather than a missing field.
   */
  it('lists and details an image used only by digest with no aliases', async () => {
    await use(`quay.io/acme/app@${DIGEST}`)

    const [listed] = await ownImages()
    expect(listed).toMatchObject({ name: 'quay.io/acme/app', aliases: [], versionCount: 1 })
    expect((await catalog.get(ORG, 'quay.io/acme/app')).aliases).toEqual([])
  })

  /**
   * Only a ready version is one a box can boot from, so only those are listed,
   * sized and summed. Nothing writes another state yet; the row is moved by
   * hand because the filter is what is under test.
   */
  it('leaves a version that is no longer ready out of the size, the detail and the usage', async () => {
    await use('quay.io/acme/app:v1', { sizeBytes: 4096 })
    await dataSource.query(`UPDATE "${schemaName}"."image_version" SET "state" = $1`, [ImageVersionState.DELETED])

    const [listed] = await ownImages()
    expect(listed).toMatchObject({ name: 'quay.io/acme/app', versionCount: 0, sizeBytes: 0 })
    expect((await catalog.get(ORG, 'quay.io/acme/app')).versions).toEqual([])
    expect(await catalog.usage(ORG)).toEqual({ count: 1, limit: 20, knownBytes: 0 })
  })

  it('lists only aliases of ready versions, in order, in both list and detail', async () => {
    await use('quay.io/acme/app:z-ready')
    await use('quay.io/acme/app:a-ready')
    await use('quay.io/acme/app:removed', { digest: OTHER_DIGEST })
    await dataSource.getRepository(ImageVersion).update({ digest: OTHER_DIGEST }, { state: ImageVersionState.DELETED })

    const [listed] = await ownImages()
    expect(listed).toMatchObject({ aliases: ['a-ready', 'z-ready'], versionCount: 1 })
    expect((await catalog.get(ORG, 'quay.io/acme/app')).aliases).toEqual(['a-ready', 'z-ready'])
    expect((await catalog.listReferences(ORG)).map((ref) => ref.tag)).toEqual(['a-ready', 'z-ready'])

    await dataSource.getRepository(ImageVersion).update({ digest: DIGEST }, { state: ImageVersionState.DELETED })
    expect((await ownImages())[0].aliases).toEqual([])
    expect((await catalog.get(ORG, 'quay.io/acme/app')).aliases).toEqual([])
    expect(await catalog.listReferences(ORG)).toEqual([])
  })

  /**
   * The cascade only fires on a real delete, so a soft-deleted image keeps its
   * versions and aliases. Every read has to join back and filter them out — miss
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
    expect(await catalog.listReferences(ORG)).toEqual([])
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
      expect(detail.versions[0]).toMatchObject({
        digest: DIGEST,
        sizeBytes: 4096,
        sourceRef: 'quay.io/acme/app:v1',
        aliases: ['v1'],
      })
      // The pull that recorded the tag is its first event.
      expect(detail.history).toEqual([
        expect.objectContaining({ aliasName: 'v1', fromVersionId: null, toVersionId: detail.versions[0].id }),
      ])
    }
  })

  it('reports when each version was last used, and when its registry no longer had it', async () => {
    await use('quay.io/acme/app:v1')
    const before = await catalog.get(ORG, 'quay.io/acme/app')
    expect(before.versions[0].lastUsedAt).not.toBeNull()
    expect(before.versions[0].upstreamMissingAt).toBeNull()
    const foundGone = new Date('2026-09-29T00:00:00.000Z')
    await dataSource.getRepository(ImageVersion).update({ id: before.versions[0].id }, { upstreamMissingAt: foundGone })

    const after = await catalog.get(ORG, 'quay.io/acme/app')

    expect(after.versions[0].upstreamMissingAt).toBe(foundGone.toISOString())
  })

  it('answers a curated image with no history, since the operator pins its reference', async () => {
    const [curated] = (await catalog.list(ORG)).filter((image) => image.curated)

    const detail = await catalog.get(ORG, curated.name)

    expect(detail.versions).toEqual([])
    expect(detail.history).toEqual([])
  })

  it('keeps the most recent events when the history outgrows the detail', async () => {
    await use('quay.io/acme/app:v1')
    const { id: imageId, versions } = await catalog.get(ORG, 'quay.io/acme/app')
    // As many events again as the detail carries, each a second after the one
    // before and all after the pull's own, so the newest is the last of these.
    await dataSource.query(
      `INSERT INTO "${schemaName}"."image_tag_event" ("imageId", "tagName", "toVersionId", "createdAt")
       SELECT $1, 't' || n, $2, clock_timestamp() + n * interval '1 second' FROM generate_series(1, $3) AS n`,
      [imageId, versions[0].id, IMAGE_HISTORY_LIMIT],
    )

    const detail = await catalog.get(ORG, 'quay.io/acme/app')

    expect(detail.history).toHaveLength(IMAGE_HISTORY_LIMIT)
    expect(detail.history[0].aliasName).toBe(`t${IMAGE_HISTORY_LIMIT}`)
    // The pull that recorded v1 is the oldest event, and fell off.
    expect(detail.history.map((event) => event.aliasName)).not.toContain('v1')
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

  describe('alias creation refuses overwrite', () => {
    const createAlias = (alias: string, digest: string) =>
      catalog.createAlias(ORG, 'quay.io/acme/app', alias, { digest }, 'auth0|alice')

    it.each([DIGEST, OTHER_DIGEST])('rejects an existing alias for target %s without changing it', async (digest) => {
      await use('quay.io/acme/app:v1')
      await use('quay.io/acme/app:v2', { digest: OTHER_DIGEST })
      const before = await catalog.get(ORG, 'quay.io/acme/app')

      await expect(createAlias('v1', digest)).rejects.toBeInstanceOf(ConflictException)

      const after = await catalog.get(ORG, 'quay.io/acme/app')
      expect(after.versions).toEqual(before.versions)
      expect(after.history).toEqual(before.history)
    })

    it('allows exactly one concurrent creation of an alias', async () => {
      await use('quay.io/acme/app:v1')
      await use('quay.io/acme/app:v2', { digest: OTHER_DIGEST })

      const results = await Promise.allSettled([createAlias('stable', DIGEST), createAlias('stable', OTHER_DIGEST)])

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      const rejected = results.filter((result) => result.status === 'rejected')
      expect(rejected).toHaveLength(1)
      expect(rejected[0].reason).toBeInstanceOf(ConflictException)
      const detail = await catalog.get(ORG, 'quay.io/acme/app')
      expect(detail.history.filter((event) => event.aliasName === 'stable')).toHaveLength(1)
    })
  })

  describe('catalog aliases', () => {
    const ACTOR = 'auth0|alice'
    const create = (alias: string, digest = DIGEST) =>
      catalog.createAlias(ORG, 'quay.io/acme/app', alias, { digest }, ACTOR)

    it('creates an alias and records its actor without pulling another version', async () => {
      await use('quay.io/acme/app:v1')
      const before = await catalog.get(ORG, 'quay.io/acme/app')

      const detail = await create('stable')

      expect(detail.versions).toHaveLength(before.versions.length)
      expect(detail.versions[0].aliases).toEqual(['stable', 'v1'])
      expect(detail.history[0]).toMatchObject({
        aliasName: 'stable',
        fromDigest: null,
        toDigest: DIGEST,
        actorId: ACTOR,
      })
    })

    it('refuses targets that are missing, belong to another image or are not ready', async () => {
      await use('quay.io/acme/app:v1')
      await use('quay.io/acme/other:v1', { digest: OTHER_DIGEST })
      const other = await catalog.get(ORG, 'quay.io/acme/other')
      for (const target of [
        { digest: undefined },
        { digest: '' },
        { digest: OTHER_DIGEST },
        { versionId: other.versions[0].id },
      ]) {
        await expect(
          catalog.createAlias(ORG, 'quay.io/acme/app', 'stable', target as unknown as VersionSelector, ACTOR),
        ).rejects.toBeInstanceOf(BadRequestError)
      }
      const detail = await catalog.get(ORG, 'quay.io/acme/app')
      await dataSource
        .getRepository(ImageVersion)
        .update({ id: detail.versions[0].id }, { state: ImageVersionState.DELETED })
      await expect(create('stable')).rejects.toBeInstanceOf(BadRequestError)
    })

    it('refuses malformed names, curated images and another organization', async () => {
      await use('quay.io/acme/app:v1')
      await expect(create('-stable')).rejects.toBeInstanceOf(BadRequestError)
      const [curated] = (await catalog.list(ORG)).filter((image) => image.curated)
      await expect(catalog.createAlias(ORG, curated.name, 'stable', { digest: DIGEST }, ACTOR)).rejects.toBeInstanceOf(
        BadRequestError,
      )
      await expect(
        catalog.createAlias(OTHER_ORG, 'quay.io/acme/app', 'stable', { digest: DIGEST }, ACTOR),
      ).rejects.toBeInstanceOf(NotFoundException)
    })

    it('deletes only the alias and requires explicit deletion before a replacement', async () => {
      await use('quay.io/acme/app:v1')
      await use('quay.io/acme/app:v2', { digest: OTHER_DIGEST })
      const pinned = `quay.io/acme/app@${DIGEST}`
      const boxId = await addBox(pinned)
      const before = await create('stable')

      await catalog.deleteAlias(ORG, 'quay.io/acme/app', 'stable')

      const deleted = await catalog.get(ORG, 'quay.io/acme/app')
      expect(deleted.aliases).not.toContain('stable')
      expect(deleted.versions.map((version) => version.digest)).toEqual(
        before.versions.map((version) => version.digest),
      )
      expect(deleted.history).toEqual(before.history)
      await expect(catalog.deleteAlias(ORG, 'quay.io/acme/app', 'stable')).rejects.toBeInstanceOf(NotFoundException)
      const recreated = await create('stable', OTHER_DIGEST)
      expect(recreated.versions.find((version) => version.aliases.includes('stable'))?.digest).toBe(OTHER_DIGEST)
      expect((await dataSource.getRepository(Box).findOneByOrFail({ id: boxId })).image).toBe(pinned)
    })

    it('scopes alias deletion to the image owner', async () => {
      await use('quay.io/acme/app:v1')
      await expect(catalog.deleteAlias(OTHER_ORG, 'quay.io/acme/app', 'v1')).rejects.toBeInstanceOf(NotFoundException)
      expect((await catalog.get(ORG, 'quay.io/acme/app')).aliases).toContain('v1')
    })
  })
})
