/*
 * How a Cloud Run container is handed a secret by reference.
 *
 * Two shapes, and a container reads both the same way. A plain value becomes an
 * `env` entry with `value`; an address becomes one with `valueSource.
 * secretKeyRef`, which the platform resolves just before the container starts —
 * so the value never enters the revision, and `gcloud run revisions describe`
 * shows a reference rather than a password.
 *
 * A name in both is not a preference the platform resolves: a Cloud Run
 * revision refuses the pair outright, where an ECS task definition would take
 * whichever was written last. The composition root refuses it earlier, but this
 * is where the difference would surface, so it is named here too.
 *
 * `secretKeyRef.secret` takes a secret and `version` takes the version beside
 * it. Splitting happens here and only here, which is what lets mstage carry an
 * explicit payload version without writing that suffix into Cloud Run's
 * `secret` field as well.
 *
 * Two forms arrive, from two sources that genuinely differ:
 *
 *   projects/<p>/secrets/<s>              a stored address that follows latest.
 *   projects/<p>/secrets/<s>/versions/<v> a stored or provider-created address
 *                                         pinned to one payload version.
 *
 * Accepting both rather than picking one: an unversioned address resolves
 * `latest`, while a versioned one makes rotation an explicit deployment input.
 */

/** What a reference with no version of its own resolves to. */
const LATEST = 'latest'

type ParsedSecretRef = { project: string; secret: string; version: string }

const parseSecretRef = (reference: string): ParsedSecretRef => {
  const match = /^projects\/([^/]+)\/secrets\/([^/]+)(?:\/versions\/([^/]+))?$/.exec(reference)
  if (!match) {
    throw new Error(
      `${JSON.stringify(reference)} is not a Secret Manager reference; a GCP stage delivers a secret as ` +
        'projects/<project>/secrets/<secret>, optionally with /versions/<version>',
    )
  }
  return { project: match[1] as string, secret: match[2] as string, version: match[3] ?? LATEST }
}

/** One `env` entry, in the shape `gcp.cloudrunv2.Service` takes. */
export type ContainerEnv = {
  name: string
  value?: $util.Input<string>
  valueSource?: { secretKeyRef: { secret: $util.Input<string>; version: $util.Input<string> } }
}

/**
 * A Secret Manager reference, split into the two parts Cloud Run wants.
 *
 * Both accepted forms are named above. What it refuses is a string that is not
 * a reference at all — a plaintext secret about to be delivered as if it named
 * one, which is the failure the whole by-reference channel exists to prevent.
 */
export const splitSecretRef = (reference: string): { secret: string; version: string } => {
  const { secret, version } = parseSecretRef(reference)
  return { secret, version }
}

/** The project and secret id an IAM binding attaches to. */
export const secretCoordinatesOf = (reference: string): { project: string; secret: string } => {
  const { project, secret } = parseSecretRef(reference)
  return { project, secret }
}

/** The full payload resource name, pinned so a new version rolls the Pods. */
export const versionedSecretRef = (reference: string): string => {
  const { project, secret, version } = parseSecretRef(reference)
  return `projects/${project}/secrets/${secret}/versions/${version}`
}

/**
 * The secret's own id, for a caller that grants access rather than mounts it.
 *
 * The same parse, so a form one of them accepts is a form the other does. Two
 * regexes for one reference is how the granting side ends up refusing an address
 * the mounting side had just accepted.
 */
export const secretIdOf = (reference: string): string => splitSecretRef(reference).secret

/**
 * The container's whole environment: values and addresses, in one list.
 *
 * One list because that is what Cloud Run takes — unlike ECS, which has
 * separate `environment` and `secrets` arrays. The two channels are still
 * distinct in what they carry; they merely arrive in the same array.
 */
export const containerEnvironment = ({
  values,
  addresses,
}: {
  values: Record<string, $util.Input<string>>
  addresses: Record<string, $util.Input<string>>
}): $util.Output<ContainerEnv[]> => {
  const plain: ContainerEnv[] = Object.entries(values).map(([name, value]) => ({ name, value }))
  const names = Object.keys(addresses)
  if (names.length === 0) return $util.output(plain)
  return $resolve(Object.values(addresses)).apply((references: string[]) => [
    ...plain,
    ...names.map((name, index) => {
      const { secret, version } = splitSecretRef(references[index] as string)
      return { name, valueSource: { secretKeyRef: { secret, version } } }
    }),
  ])
}
