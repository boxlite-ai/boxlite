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
 * A reference is `projects/<p>/secrets/<s>/versions/<v>`, and the two halves
 * Cloud Run wants are the secret and the version. Splitting it here rather than
 * at each call site is what keeps the parsing in one place — and lets a
 * malformed reference say so by name.
 */

/** One `env` entry, in the shape `gcp.cloudrunv2.Service` takes. */
export type ContainerEnv = {
  name: string
  value?: $util.Input<string>
  valueSource?: { secretKeyRef: { secret: $util.Input<string>; version: $util.Input<string> } }
}

/**
 * A Secret Manager version reference, split into the two parts Cloud Run wants.
 *
 * `latest` is accepted and pinned versions are preferred, which is the
 * providers' own choice rather than this function's — what it refuses is a
 * string that is not a reference at all, because that is a plaintext secret
 * about to be delivered as if it named one.
 */
export const splitSecretRef = (reference: string): { secret: string; version: string } => {
  const match = /^projects\/[^/]+\/secrets\/([^/]+)\/versions\/([^/]+)$/.exec(reference)
  if (!match) {
    throw new Error(
      `${JSON.stringify(reference)} is not a Secret Manager version reference; ` +
        'a GCP stage delivers a secret as projects/<project>/secrets/<secret>/versions/<version>',
    )
  }
  return { secret: match[1] as string, version: match[2] as string }
}

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
