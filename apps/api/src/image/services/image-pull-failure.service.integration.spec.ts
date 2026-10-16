/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { randomUUID } from 'node:crypto'
import { DataSource } from 'typeorm'
import { supportedImages } from '../../box/constants/curated-images.constant'
import { CustomNamingStrategy } from '../../common/utils/naming-strategy.util'
import { Image } from '../entities/image.entity'
import { ImageAlias } from '../entities/image-alias.entity'
import { ImageAliasEvent } from '../entities/image-alias-event.entity'
import { ImageVersion } from '../entities/image-version.entity'
import { ImageVersionState } from '../enums/image-version-state.enum'
import { CuratedImagePinService } from './curated-image-pin.service'
import { ImagePullFailureService } from './image-pull-failure.service'
import { ImageRegistrarService } from './image-registrar.service'

const describeIfDatabase = process.env.DB_HOST ? describe : describe.skip
const schemaName = `image_pull_failure_${process.pid}_${randomUUID().replaceAll('-', '')}`

const ORG = '00000000-0000-4000-8000-000000000001'
const OTHER_ORG = '00000000-0000-4000-8000-000000000002'
const DIGEST = `sha256:${'a'.repeat(64)}`
const PINNED = `quay.io/acme/app@${DIGEST}`
const PROXY_HOST = 'registry-proxy.test'

/** A runner's pull error as the runtime words it, naming the ref it was given. */
const failedPull = (ref: string, line: string) =>
  `storage error: Failed to pull image '${ref}' after trying 1 registry:\n  - ${ref}: storage error: ${line}`
const unknownManifest = (ref: string) =>
  failedPull(ref, 'failed to pull manifest [MANIFEST_UNKNOWN]: Registry error: url https://quay.io/v2/, envelope: x')

describeIfDatabase('ImagePullFailureService (integration, real Postgres)', () => {
  let dataSource: DataSource
  let registrar: ImageRegistrarService
  let pullFailures: ImagePullFailureService
  let ownsSchema = false
  const proxyHostBefore = process.env.REGISTRY_PROXY_HOST

  beforeAll(async () => {
    dataSource = await new DataSource({
      type: 'postgres',
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USERNAME,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_DATABASE,
      schema: schemaName,
      entities: [Image, ImageVersion, ImageAlias, ImageAliasEvent],
      namingStrategy: new CustomNamingStrategy(),
      entitySkipConstructor: true,
      synchronize: false,
      extra: { options: `-c search_path=${schemaName},public` },
    }).initialize()

    await dataSource.query(`CREATE SCHEMA "${schemaName}"`)
    ownsSchema = true
    await dataSource.synchronize()
    // Just the columns registration reads.
    await dataSource.query(
      `CREATE TABLE "${schemaName}"."organization" ("id" uuid PRIMARY KEY, "image_count_limit" integer NOT NULL DEFAULT 20)`,
    )
    registrar = new ImageRegistrarService(dataSource, {
      remember: jest.fn(async () => undefined),
    } as unknown as CuratedImagePinService)
    pullFailures = new ImagePullFailureService(
      dataSource.getRepository(ImageVersion),
      dataSource.getRepository(ImageAlias),
    )
  })

  afterAll(async () => {
    process.env.REGISTRY_PROXY_HOST = proxyHostBefore
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
    process.env.REGISTRY_PROXY_HOST = PROXY_HOST
    for (const table of ['image_tag_event', 'image_tag', 'image_version', 'image', 'organization']) {
      await dataSource.query(`DELETE FROM "${schemaName}"."${table}"`)
    }
    await dataSource.query(`INSERT INTO "${schemaName}"."organization" ("id") VALUES ($1), ($2)`, [ORG, OTHER_ORG])
  })

  /** The catalog as a pull records it: `quay.io/acme/app:v1` at DIGEST. */
  const recordV1 = (organizationId = ORG) =>
    registrar.onBoxStarted(
      organizationId,
      { ref: 'quay.io/acme/app:v1', isOrgOwned: true },
      { digest: DIGEST, sizeBytes: 1 },
    )
  const versions = (organizationId = ORG) =>
    dataSource
      .getRepository(ImageVersion)
      .createQueryBuilder('version')
      .innerJoin('image', 'image', 'image.id = version."imageId"')
      .where('image."organizationId" = :organizationId', { organizationId })
      .getMany()

  it('marks a build the catalog holds and names the aliases that still point at it', async () => {
    await recordV1()

    const reason = await pullFailures.reasonFor({ organizationId: ORG, image: PINNED }, unknownManifest(PINNED))

    const [version] = await versions()
    expect(version.upstreamMissingAt).toBeInstanceOf(Date)
    // A mark, not a verdict: the row and its state stay, since a runner that
    // cached the build still starts it.
    expect(version.state).toBe(ImageVersionState.READY)
    expect(reason).toBe(
      `Failed to pull image '${PINNED}': quay.io no longer has it (MANIFEST_UNKNOWN). Boxes on runners that already hold it still start. Move the tag 'v1' to a version its registry still has, or remove the image from the catalog and use the reference again.`,
    )
  })

  it('keeps the first time a build was found gone', async () => {
    await recordV1()
    await pullFailures.reasonFor({ organizationId: ORG, image: PINNED }, unknownManifest(PINNED))
    const [first] = await versions()

    await pullFailures.reasonFor({ organizationId: ORG, image: PINNED }, unknownManifest(PINNED))

    const [again] = await versions()
    expect(again.upstreamMissingAt).toEqual(first.upstreamMissingAt)
  })

  /**
   * A private image is pulled by a registry proxy ref. The tenant named the
   * upstream image, and the proxy's address is nothing they can act on.
   */
  it('names the upstream image a proxy ref stands for, and marks it', async () => {
    await recordV1()
    const proxied = `${PROXY_HOST}/${ORG}/${PINNED}`

    const reason = await pullFailures.reasonFor({ organizationId: ORG, image: proxied }, unknownManifest(PINNED))

    expect(reason).toContain(`Failed to pull image '${PINNED}': quay.io no longer has it`)
    expect(reason).not.toContain(PROXY_HOST)
    expect((await versions())[0].upstreamMissingAt).toBeInstanceOf(Date)
  })

  it('explains an image the catalog never held without marking anything', async () => {
    await recordV1()
    const typo = 'quay.io/acme/app:v2'

    const reason = await pullFailures.reasonFor({ organizationId: ORG, image: typo }, unknownManifest(typo))

    expect(reason).toBe(
      `Failed to pull image '${typo}': quay.io has no such image (MANIFEST_UNKNOWN). Check the repository and the tag.`,
    )
    expect((await versions())[0].upstreamMissingAt).toBeNull()
  })

  /**
   * The catalog is per organization. Another one holding the same build is
   * not this box's catalog, so nothing of theirs is marked, and for this
   * organization the image was never recorded at all.
   */
  it('leaves another organization holding the same build alone', async () => {
    await recordV1(OTHER_ORG)

    const reason = await pullFailures.reasonFor({ organizationId: ORG, image: PINNED }, unknownManifest(PINNED))

    expect(reason).toContain('quay.io has no such image')
    expect((await versions(OTHER_ORG))[0].upstreamMissingAt).toBeNull()
  })

  /**
   * C8: a refusal is never a missing image. A direct pull is one no login
   * covers — a covered one goes through the proxy — and a registry refuses a
   * repository that does not exist the way it refuses a private one.
   */
  it('tells a direct pull its registry refused that no login covers it, and marks nothing', async () => {
    await recordV1()

    const reason = await pullFailures.reasonFor(
      { organizationId: ORG, image: PINNED },
      failedPull(PINNED, 'failed to pull manifest [UNAUTHORIZED]: Not authorized: url https://quay.io/v2/'),
    )

    expect(reason).toBe(
      `Failed to pull image '${PINNED}': quay.io refused the pull (UNAUTHORIZED). The image is private or does not exist, and no registry login of the organization covers it.`,
    )
    expect((await versions())[0].upstreamMissingAt).toBeNull()
  })

  /**
   * The proxy refuses on its own account too, with the same codes — here, a
   * runner that hosts no box of the organization — and its words say which
   * refusal it was. Turning them into login advice would send the tenant after
   * the wrong thing.
   */
  it('keeps the words of a refusal through the registry proxy', async () => {
    await recordV1()
    const proxied = `${PROXY_HOST}/${ORG}/${PINNED}`
    const original = failedPull(
      PINNED,
      'failed to pull manifest [DENIED]: Registry error: envelope: OCI API errors: [OCI API error: this runner hosts no box of the organization, so its registry credential is not used]',
    )

    const reason = await pullFailures.reasonFor({ organizationId: ORG, image: proxied }, original)

    expect(reason).toBe(original)
    expect((await versions())[0].upstreamMissingAt).toBeNull()
  })

  it.each([
    ['a failure with no registry code', failedPull(PINNED, 'failed to pull manifest: error sending request')],
    ['a failure that is not a pull', 'Box has no runner'],
  ])('records %s as it came', async (_what, original) => {
    await recordV1()

    const reason = await pullFailures.reasonFor({ organizationId: ORG, image: PINNED }, original)

    expect(reason).toBe(original)
    expect((await versions())[0].upstreamMissingAt).toBeNull()
  })

  /**
   * The operator's curated set is theirs to fix; a tenant has no tag to move.
   * A box recorded before ownership was is judged the way every other reader
   * judges it, by the curated set as it stands.
   */
  it.each([
    ['recorded as curated', PINNED, false],
    ['from before ownership was recorded', supportedImages()[0].ref, null],
  ])('leaves a failure of a curated image %s in the runtime words', async (_when, image, imageIsOrgOwned) => {
    const original = unknownManifest(image)

    const reason = await pullFailures.reasonFor({ organizationId: ORG, image, imageIsOrgOwned }, original)

    expect(reason).toBe(original)
  })
})
