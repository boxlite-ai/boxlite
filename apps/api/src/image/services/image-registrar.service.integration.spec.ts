/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { Image } from '../entities/image.entity'
import { ImageTag } from '../entities/image-tag.entity'
import { ImageVersion } from '../entities/image-version.entity'
import { isCuratedSelector } from '../utils/image-ref.util'
import { ImageRegistrarService } from './image-registrar.service'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `image_registrar_${process.pid}_${randomUUID().replaceAll('-', '')}`

const ORG = '00000000-0000-4000-8000-000000000001'
const OTHER_ORG = '00000000-0000-4000-8000-000000000002'
const DIGEST = `sha256:${'a'.repeat(64)}`
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`

describeIfDatabase('ImageRegistrarService (integration, real Postgres)', () => {
  let dataSource: DataSource
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
      entities: [Image, ImageVersion, ImageTag],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      synchronize: false,
      extra: { options: `-c search_path=${schemaName},public` },
    }).initialize()

    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    ownsSchema = true
    await dataSource.synchronize()
    registrar = new ImageRegistrarService(dataSource)
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
  })

  function report(ref: string, digest = DIGEST, sizeBytes = 4096) {
    return registrar.onBoxStarted(ORG, { ref, isOrgOwned: true }, { digest, sizeBytes })
  }

  function countOf(table: string): Promise<number> {
    return dataSource
      .query(`SELECT COUNT(*)::int AS count FROM "${schemaName}"."${table}"`)
      .then((rows) => rows[0].count)
  }

  it('records the image, the version and the tag a box booted from', async () => {
    await report('quay.io/acme/app:v1')

    const [image] = await dataSource.getRepository(Image).find()
    expect(image).toMatchObject({ organizationId: ORG, name: 'quay.io/acme/app' })
    expect(image.lastUsedAt).not.toBeNull()

    const [version] = await dataSource.getRepository(ImageVersion).find()
    expect(version).toMatchObject({
      imageId: image.id,
      digest: DIGEST,
      sizeBytes: 4096,
      sourceSpec: { sourceRef: 'quay.io/acme/app:v1' },
      storageRef: `quay.io/acme/app@${DIGEST}`,
    })

    const [tag] = await dataSource.getRepository(ImageTag).find()
    expect(tag).toMatchObject({ imageId: image.id, name: 'v1', versionId: version.id })
  })

  /**
   * A report can arrive more than once for the same box — the runner retries,
   * and a replayed job starts the same box again.
   */
  it('is idempotent for the same image and digest', async () => {
    await report('quay.io/acme/app:v1')
    await report('quay.io/acme/app:v1')

    expect(await countOf('image')).toBe(1)
    expect(await countOf('image_version')).toBe(1)
    expect(await countOf('image_tag')).toBe(1)
  })

  /**
   * Two boxes can be the first to use the same new reference. The unique
   * constraint settles it, so neither report has to read before it writes.
   */
  it('produces one row when two boxes report the same new reference at once', async () => {
    await Promise.all([report('quay.io/acme/app:v1'), report('quay.io/acme/app:v1')])

    expect(await countOf('image')).toBe(1)
    expect(await countOf('image_version')).toBe(1)
  })

  /**
   * S1 does not move tags. A tag that resolved once keeps naming that build,
   * and deleting the image is what will pick up a move once the catalog API
   * exposes a delete — without this, an upstream tag move would silently
   * change what a box boots from.
   */
  it('leaves a tag pointing at the build it first resolved to', async () => {
    await report('quay.io/acme/app:v1', DIGEST)
    await report('quay.io/acme/app:v1', OTHER_DIGEST)

    const versions = await dataSource.getRepository(ImageVersion).find()
    const tags = await dataSource.getRepository(ImageTag).find()
    const first = versions.find((version) => version.digest === DIGEST)

    expect(versions).toHaveLength(2)
    expect(tags).toHaveLength(1)
    expect(tags[0].versionId).toBe(first?.id)
  })

  it('records no tag for a reference the caller already pinned', async () => {
    await report(`quay.io/acme/app@${DIGEST}`)

    expect(await countOf('image_version')).toBe(1)
    expect(await countOf('image_tag')).toBe(0)
  })

  /**
   * The acceptance criterion this pair exists for: a second create of the same
   * reference must be handed a digest. A bare repository is served by the
   * registry as `latest`, so that is the tag it booted from — and it has to be
   * recorded under the name the resolver looks it up by, or the reference
   * re-resolves forever and every box built from it can get a different build.
   */
  it('records a bare repository under the tag the registry served it as', async () => {
    await report('quay.io/acme/app')

    const [tag] = await dataSource.getRepository(ImageTag).find()
    expect(tag?.name).toBe('latest')
    expect(await countOf('image_version')).toBe(1)
  })

  /**
   * An operator's image belongs to no tenant catalog: it is shared by every
   * organization, and a row would count against one tenant's limit and let
   * that tenant delete what everyone boots from.
   *
   * The ref here is deliberately one the curated set no longer holds — an
   * operator rotated past it while this box kept running. That is the case
   * this signature exists for: working ownership out from the ref would call
   * it the organization's and file it, because the set moved and `box.image`
   * did not. Only the box knows, and the box was told at create.
   */
  it('records nothing for an operator image the curated set has moved past', async () => {
    const rotatedAway = 'ghcr.io/boxlite-ai/boxlite-agent-base:v0.0.1'
    expect(isCuratedSelector(rotatedAway)).toBe(false)

    await registrar.onBoxStarted(ORG, { ref: rotatedAway, isOrgOwned: false }, { digest: DIGEST, sizeBytes: 4096 })

    expect(await countOf('image')).toBe(0)
    expect(await countOf('image_version')).toBe(0)
  })

  /**
   * Deleting an image is how a tenant will pick up a tag that moved. Using it
   * again has to bring it back — as a new active row beside the soft-deleted
   * one, which is exactly what the partial unique index exists to allow. The
   * delete itself ships with the catalog API; the index has to be right before
   * it does, or the first delete is also a migration.
   */
  it('gives a soft-deleted name a new active row when the image is used again', async () => {
    await report('quay.io/acme/app:v1')
    await dataSource.getRepository(Image).update({ name: 'quay.io/acme/app' }, { deletedAt: new Date() })

    await report('quay.io/acme/app:v1', OTHER_DIGEST)

    const images = await dataSource.getRepository(Image).find()
    const active = images.filter((image) => image.deletedAt === null)
    expect(images).toHaveLength(2)
    expect(active).toHaveLength(1)

    const versions = await dataSource.getRepository(ImageVersion).find()
    expect(versions.find((version) => version.digest === OTHER_DIGEST)?.imageId).toBe(active[0].id)
  })

  /**
   * A digest this schema cannot hold is refused on its own. The caller catches
   * it and still records the box's state: a running box that reported an
   * unusable digest is still running, and rejecting the whole report would
   * leave the control plane believing it is still starting.
   */
  it('refuses a digest it cannot store and writes nothing', async () => {
    await expect(report('quay.io/acme/app:v1', 'sha512:deadbeef')).rejects.toThrow(/not a sha256 digest/)

    expect(await countOf('image')).toBe(0)
    expect(await countOf('image_version')).toBe(0)
  })

  it('keeps one organization out of another catalog', async () => {
    await report('quay.io/acme/app:v1')
    await registrar.onBoxStarted(
      OTHER_ORG,
      { ref: 'quay.io/acme/app:v1', isOrgOwned: true },
      { digest: DIGEST, sizeBytes: 4096 },
    )

    const images = await dataSource.getRepository(Image).find()
    expect(images).toHaveLength(2)
    expect(new Set(images.map((image) => image.organizationId))).toEqual(new Set([ORG, OTHER_ORG]))
  })
})
