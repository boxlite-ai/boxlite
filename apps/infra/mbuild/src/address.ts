/*
 * Where an image lives, so nothing else has to build the string.
 *
 * This is the module mdeploy imports. A deploy names a component and a commit;
 * what comes back is the address that cloud's runtime will pull from. Neither
 * side concatenates anything, which is the point — the two registries put the
 * component in different halves of the address:
 *
 *   ECR                <registry>/<repository>:<tag>-<component>
 *   Artifact Registry  <host>/<project>/<repository>/<component>:<tag>
 *
 * A caller building its own string works against one registry and produces a
 * nonsense address for the other. `sst.config.ts:292-294` is such a string
 * today, and it disagrees about whether the repository name carries the stage.
 *
 * Pure: no network, no credentials. The registry's coordinates — account id,
 * project — are inputs, because the caller already resolved an identity.
 */

import { registryFor, type BuildConfig } from './config.ts'

/**
 * A released version as a git tag spells it: `v` then a stable X.Y.Z.
 *
 * Written once and used by both constants below, so the two cannot drift into
 * disagreeing about what a version looks like.
 */
const VERSION = 'v(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)'

/** What `mbuild --version` accepts, and what a release's git tag must be. */
export const RELEASE_VERSION = new RegExp(`^${VERSION}$`)

/**
 * A full lowercase commit SHA, so a deploy names exact bytes, carrying the
 * version in front of it when the bytes are a release build.
 *
 * The two builds are different bytes. A commit build is whatever the deploy
 * path needed at the time; a release build is the image a version was cut
 * from, and `.github/workflows/mbuild-release.yml` refuses to write one twice.
 * Sharing one address would leave a stage that means to admit only released
 * images with nothing to read — the registry cannot say which run produced the
 * bytes it holds.
 *
 * The version rather than a bare marker, because "which release is this" is
 * the question an operator actually asks of a running stage, and a marker
 * would send them back to a build log to answer it. Same shape as
 * `build-apps-api-image.yml`'s `v<version>-<ref>`, which this supersedes.
 *
 * `mdeploy/src/stack-env.ts` validates the deployed tag against this same
 * constant. It used to carry its own copy, which is how a release image would
 * have published fine and then been refused at the apply.
 */
export const IMAGE_TAG = new RegExp(`^(?:${VERSION}-)?[0-9a-f]{40}$`)

/**
 * Everything needed to write an address, and nothing to look up again.
 *
 * Kind and repository come from mbuild's config; region and account from
 * mstage. Carried here rather than read back from a config, so one process can
 * address two stages at once — which is what promoting between them is.
 */
export type Registry =
  | {
      kind: 'ecr'
      /** `<account>.dkr.ecr.<region>.amazonaws.com`. */
      host: string
      repository: string
      /** Kept because every ECR API call needs it, not only the host. */
      region: string
    }
  | {
      kind: 'artifact-registry'
      /** `<region>-docker.pkg.dev`. */
      host: string
      project: string
      repository: string
    }

export class ImageAddressError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImageAddressError'
  }
}

export const assertTag = (tag: string): string => {
  if (!IMAGE_TAG.test(tag)) {
    throw new ImageAddressError(
      `An image tag must be one full lowercase commit SHA, optionally prefixed "v<X.Y.Z>-"; got ${JSON.stringify(tag)}`,
    )
  }
  return tag
}

/**
 * The release build's tag: the version a release was cut at, and the commit it
 * was cut from.
 *
 * Composed here for the reason every other address in this module is: a caller
 * that concatenates its own is a second place the convention lives, and the
 * first typo in it publishes bytes nothing will ever look for. The one caller
 * that does compose it, `mdeploy-all.yml`, only ever hands the result to
 * `mbuild verify` and `BOXLITE_IMAGE_TAG`, and both refuse a tag this module
 * would not have produced — so a slip there is a refusal rather than a publish
 * under a name nothing pulls.
 *
 * Both halves are required. The version alone would move when a release is
 * re-cut, and everything downstream treats an image tag as an identity it
 * never looks inside; the commit alone is the commit build's own address.
 */
export const releaseTagFor = ({ version, sha }: { version: string; sha: string }): string => {
  if (!RELEASE_VERSION.test(version)) {
    throw new ImageAddressError(`A release version is "v" and a stable X.Y.Z; got ${JSON.stringify(version)}`)
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new ImageAddressError(`A release names the commit it was cut from, as a full lowercase SHA; got ${JSON.stringify(sha)}`)
  }
  return assertTag(`${version}-${sha}`)
}

/** Own properties only, for the reason `onlyArtifact` says: `in` finds `toString`. */
const assertArtifact = (config: BuildConfig, artifact: string): string => {
  if (!Object.hasOwn(config.artifacts, artifact)) {
    const known = Object.keys(config.artifacts).join(', ')
    throw new ImageAddressError(`${config.path} declares no artifact "${artifact}". Declared: ${known}`)
  }
  return artifact
}

/**
 * The address for one artifact at one commit. On ECR the artifact is a tag
 * suffix (one repository holds every artifact); on Artifact Registry it is a
 * path segment, because a repository there is a namespace.
 */
export const addressFor = ({
  config,
  registry,
  artifact,
  tag,
}: {
  config: BuildConfig
  registry: Registry
  artifact: string
  tag: string
}): string => {
  assertArtifact(config, artifact)
  assertTag(tag)
  switch (registry.kind) {
    case 'ecr':
      return `${registry.host}/${registry.repository}:${tag}-${artifact}`
    case 'artifact-registry':
      return `${registry.host}/${registry.project}/${registry.repository}/${artifact}:${tag}`
  }
}

/** Every artifact at one commit, which is what a publish iterates over. */
export const addressesFor = ({
  config,
  registry,
  tag,
}: {
  config: BuildConfig
  registry: Registry
  tag: string
}): Record<string, string> =>
  Object.fromEntries(
    Object.keys(config.artifacts).map((artifact) => [artifact, addressFor({ config, registry, artifact, tag })]),
  )

/** The ECR host for an account and region; the address shape lives only here. */
export const ecrHost = ({ accountId, region }: { accountId: string; region: string }): string => {
  if (!/^\d{12}$/.test(accountId)) throw new ImageAddressError(`An AWS account id is twelve digits; got ${accountId}`)
  return `${accountId}.dkr.ecr.${region}.amazonaws.com`
}

/** The Artifact Registry host for a region. */
export const artifactRegistryHost = (region: string): string => `${region}-docker.pkg.dev`

/** One stage's registry: the declared half, plus the caller's account or project. */
export const resolveRegistry = ({
  config,
  stage,
  region,
  accountId,
  project,
}: {
  config: BuildConfig
  stage: string
  /** Where the stage lives. mstage declares this; mbuild does not repeat it. */
  region: string
  /** Required for ECR. */
  accountId?: string
  /** Required for Artifact Registry. */
  project?: string
}): Registry => {
  const declared = registryFor(config, stage)
  if (!region.trim()) throw new ImageAddressError(`Stage "${stage}" has no region; mstage declares where a stage lives`)
  switch (declared.kind) {
    case 'ecr':
      if (!accountId) throw new ImageAddressError(`Stage "${stage}" publishes to ECR, which needs an account id`)
      return {
        kind: 'ecr',
        host: ecrHost({ accountId, region }),
        repository: declared.repository,
        region,
      }
    case 'artifact-registry':
      if (!project) throw new ImageAddressError(`Stage "${stage}" publishes to Artifact Registry, which needs a project`)
      return {
        kind: 'artifact-registry',
        host: artifactRegistryHost(region),
        project,
        repository: declared.repository,
      }
  }
}
