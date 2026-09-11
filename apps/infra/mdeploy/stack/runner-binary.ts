/*
 * Which runner binary a deploy installs, resolved from the checkout.
 *
 * The same question `artifacts/source.ts` and `artifacts/runner.ts` answer on
 * the incumbent path, answered here without reaching into that tree — mdeploy is
 * a package whose only dependencies are mstage and mbuild.
 *
 * Two sources, one shape:
 *
 *   release → the assets published for a stable X.Y.Z, over public HTTPS
 *   build   → an object staged for one commit, read with the host's own role
 *             rather than published; AWS only, because the staging bucket is S3
 *
 * The version is the *checkout's*, not a stage's setting: the workspace
 * `Cargo.toml` is what the release workflow publishes under, and `VERSION`
 * overrides it for a run that means to install a different published release.
 * Nothing about it is stored — a store value would let a stage pin a fleet to
 * whatever was current the day someone seeded it, and would drift from the
 * commit the rest of the deploy is shipping.
 *
 * Synchronous, and no network. Both engines evaluate the stack synchronously, so
 * a resolver that reached for a digest could not be called from it at all. What
 * this produces is therefore a *pair of addresses* — the tarball and its
 * `.sha256` sidecar — and the host is what compares the bytes it downloaded
 * against the manifest it fetched beside them. `runner-boot.ts` does that at
 * first boot and `runner-upgrade.ts` does it on every later deploy, from one
 * rendering of the same three lines.
 *
 * Every string here is interpolated into bash that runs as root on a host, so
 * each is validated where it enters rather than where it is spent.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export class RunnerBinaryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunnerBinaryError'
  }
}

/**
 * Where a published runner asset lives.
 *
 * A constant rather than a setting, and the same one `artifacts/runner-release
 * .ts` uses: the release is this repository's own, so a stage that could point
 * it elsewhere is a stage that could install a binary nobody here published.
 */
const RELEASE_DOWNLOAD_ROOT = 'https://github.com/boxlite-ai/boxlite/releases/download'

/** Stable X.Y.Z only. A prerelease has no ordering the upgrade guard can use. */
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
/** Full git object names only: an abbreviation addresses a different object. */
const COMMIT_REF = /^[0-9a-f]{40}$/
/** The S3 rules that matter here: lowercase, no underscores, 3-63 characters. */
const BUCKET_NAME = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/

export type RunnerBinarySource = 'release' | 'build'

/** What a deploy selected, before it is turned into addresses. */
export type RunnerBinarySelector =
  | { kind: 'release'; version: string }
  | { kind: 'build'; version: string; ref: string }

/** The two addresses a source resolves to, and how each is read. */
export type RunnerArtifact = {
  tarballName: string
  tarballUrl: string
  checksumUrl: string
  /** Public HTTPS, or an object only a role may read. */
  transport: 'https' | 's3'
}

/** What the stack installs, and what a live host must report once it has. */
export type ResolvedRunnerBinary = RunnerArtifact & {
  source: RunnerBinarySource
  /** The stable version this checkout publishes under. */
  version: string
  /**
   * The identity a host serving this binary reports on its health route.
   *
   * A build carries its commit as semver build metadata, because two builds of
   * one checkout are otherwise indistinguishable on the wire — and an upgrade
   * that could not tell them apart would skip every dev deploy after the first.
   */
  identity: string
}

const trimmed = (environment: NodeJS.ProcessEnv, key: string): string | null => environment[key]?.trim() || null

/**
 * `RUNNER_*` wins over `BOXLITE_*`, and the key that answered is reported.
 *
 * Two levels because the two artifacts are staged by different things: CI
 * publishes the images and the runner for one commit and sets the global key,
 * while staging only a runner has to say so — otherwise the API would resolve a
 * commit image that nothing pushed. Reporting the key is what lets a failure
 * name the variable an operator actually set rather than the global one they may
 * never have touched.
 */
const componentOrGlobal = (
  environment: NodeJS.ProcessEnv,
  componentKey: string,
  globalKey: string,
): { key: string; value: string | null } => {
  const own = trimmed(environment, componentKey)
  if (own) return { key: componentKey, value: own }
  return { key: globalKey, value: trimmed(environment, globalKey) }
}

/**
 * The version this checkout publishes under.
 *
 * Read from the workspace `Cargo.toml`, found by walking up from the config's
 * own directory rather than from a path relative to this file: `mdeploy` is
 * installed as a package, so its own location says nothing about the repository
 * it is deploying.
 *
 * One marker, not two. The incumbent's `findRepositoryRoot` also requires
 * `apps/infra/package.json`, which is this repository's own shape — a name
 * mdeploy has no business knowing.
 */
export const readWorkspaceVersion = ({ from }: { from: string }): string => {
  let directory = resolve(from)
  for (;;) {
    const candidate = join(directory, 'Cargo.toml')
    let contents: string
    try {
      contents = readFileSync(candidate, 'utf8')
    } catch {
      const parent = dirname(directory)
      if (parent === directory) {
        throw new RunnerBinaryError(
          `could not find a workspace Cargo.toml above ${resolve(from)} to read the runner version from. ` +
            'Set VERSION to name a published release explicitly',
        )
      }
      directory = parent
      continue
    }
    const version = contents.match(/^version\s*=\s*"(.+?)"/m)?.[1]
    if (!version) {
      throw new RunnerBinaryError(`${candidate} has no top-level \`version = "X.Y.Z"\` to read the runner version from`)
    }
    return version
  }
}

/**
 * Release or build, and the commit a build is addressed by.
 *
 * The default is `release`, which is what an unconfigured deploy has always
 * installed. A build is opt-in for the reason the incumbent resolver records: a
 * rule derived from the stage would silently change which binary a plain deploy
 * puts onto a state-holding host.
 */
export const selectRunnerBinary = ({
  environment,
  workspaceVersion,
}: {
  environment: NodeJS.ProcessEnv
  workspaceVersion: string
}): RunnerBinarySelector => {
  const configuredVersion = trimmed(environment, 'VERSION')
  const version = (configuredVersion ?? workspaceVersion).replace(/^v/, '')
  if (!STABLE_VERSION.test(version)) {
    throw new RunnerBinaryError(
      configuredVersion
        ? `VERSION must be a stable semantic version (X.Y.Z); got ${JSON.stringify(configuredVersion)}`
        : `the workspace version ${JSON.stringify(workspaceVersion)} is not a stable semantic version (X.Y.Z)`,
    )
  }

  const { key: sourceKey, value: configured } = componentOrGlobal(
    environment,
    'RUNNER_ARTIFACT_SOURCE',
    'BOXLITE_ARTIFACT_SOURCE',
  )
  const kind = configured ?? 'release'
  if (kind !== 'release' && kind !== 'build') {
    throw new RunnerBinaryError(`${sourceKey} must be "release" or "build"; got ${JSON.stringify(configured)}`)
  }
  if (kind === 'release') return { kind, version }

  const { key: refKey, value: ref } = componentOrGlobal(environment, 'RUNNER_ARTIFACT_REF', 'BOXLITE_ARTIFACT_REF')
  if (!ref || !COMMIT_REF.test(ref.toLowerCase())) {
    throw new RunnerBinaryError(
      `a build-mode runner binary is addressed by the commit it was produced from; set ${refKey} to a ` +
        `full git commit sha (40 hex characters), got ${JSON.stringify(ref ?? '')}`,
    )
  }
  return { kind, version, ref: ref.toLowerCase() }
}

/**
 * Where a build-mode binary is staged, composed rather than configured.
 *
 * The bootstrap owns this bucket for the same ordering reason it owns the image
 * repository: CI stages the object before the stack can consume one, so the
 * consumer cannot also create its own input. That makes the name a rule rather
 * than a setting — and one three things have to agree on: the read-only grant
 * the runner gets, the address this module resolves, and the destination
 * `src/runner-build.ts` uploads to. It is spelled once, here.
 *
 * The shape is the incumbent's (`deployment/environment.ts`'s
 * `awsResourceName`), because mdeploy adopts the bucket that path created rather
 * than making a second one beside it.
 */
export const runnerArtifactsBucket = ({
  app,
  stage,
  accountId,
}: {
  app: string
  stage: string
  /** S3's namespace is global, so the bucket needs a qualifier no other account can claim. */
  accountId: string
}): string => `${app}-app-${stage}-artifacts-${accountId}`

/**
 * The two addresses one selector resolves to.
 *
 * The names are the publisher's, not this file's choice: `build-runner-binary
 * .yml` uploads exactly these, and a deploy that composed a different name would
 * resolve an address nothing published.
 */
export const runnerArtifactFor = ({
  selector,
  artifactsBucket = null,
}: {
  selector: RunnerBinarySelector
  /** Where a build-mode object is staged. The provider knows it; a release needs none. */
  artifactsBucket?: string | null
}): RunnerArtifact => {
  if (selector.kind === 'release') {
    const tarballName = `boxlite-runner-v${selector.version}-linux-amd64.tar.gz`
    const release = `${RELEASE_DOWNLOAD_ROOT}/v${selector.version}`
    return {
      tarballName,
      tarballUrl: `${release}/${tarballName}`,
      checksumUrl: `${release}/${tarballName}.sha256`,
      transport: 'https',
    }
  }
  const bucket = artifactsBucket?.trim()
  if (!bucket) {
    throw new RunnerBinaryError(
      'a build-mode runner binary is staged in a bucket, and this stage has none. Only an AWS stage ' +
        'stages one, so a GCP stage installs a published release',
    )
  }
  if (!BUCKET_NAME.test(bucket)) {
    throw new RunnerBinaryError(`the artifacts bucket ${JSON.stringify(bucket)} is not a valid S3 bucket name`)
  }
  const tarballName = `boxlite-runner-v${selector.version}-${selector.ref}-linux-amd64.tar.gz`
  const key = `runner/${selector.ref}/${tarballName}`
  return {
    tarballName,
    tarballUrl: `s3://${bucket}/${key}`,
    checksumUrl: `s3://${bucket}/${key}.sha256`,
    transport: 's3',
  }
}

const AWS_REGION_NAME = /^[a-z0-9-]+$/

/**
 * How one of those addresses is read, on the host.
 *
 * Shared by both install paths — first boot and every later upgrade — so "how do
 * we get this URL" is answered once. Bounded on purpose: a transport that can
 * hang forever may continue after the deploy supervising it already failed, and
 * swap a binary nobody is watching for.
 */
export const artifactFetchCommand = ({
  artifact,
  url,
  destination,
  region = null,
}: {
  artifact: Pick<RunnerArtifact, 'transport'>
  url: string
  destination: string
  /** Required for an `s3://` address, meaningless for a public one. */
  region?: string | null
}): string => {
  if (artifact.transport === 'https') {
    return (
      `curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' ` +
      `--connect-timeout 10 --max-time 300 --retry 5 --retry-delay 2 --retry-connrefused ` +
      `--retry-max-time 300 "${url}" -o "${destination}"`
    )
  }
  if (!AWS_REGION_NAME.test(region ?? '')) {
    throw new RunnerBinaryError(`reading ${url} needs the region that bucket lives in, got ${JSON.stringify(region ?? '')}`)
  }
  return `aws --cli-connect-timeout 10 --cli-read-timeout 300 s3 cp --region ${region} "${url}" "${destination}"`
}

/**
 * The bytes are what the manifest beside them says, or nothing is installed.
 *
 * Fail-closed on all three counts, and each is a real failure mode:
 *
 *   - a manifest that does not name this tarball is a valid checksum for
 *     another file, which a digest comparison alone would not catch. The name is
 *     matched as an awk ERE, so its dots are escaped — unescaped they are
 *     wildcards, and a differently-named asset could satisfy the check.
 *   - a first field that is not a lowercase digest means the manifest was not
 *     the format assumed, and the comparison below would be garbage against
 *     garbage.
 *   - a mismatch is fatal rather than a warning: this binary runs as root.
 */
export const verifyAgainstManifest = ({
  tarballName,
  tarball,
  manifest,
}: {
  tarballName: string
  /** Shell path of the downloaded tarball. */
  tarball: string
  /** Shell path of the downloaded `.sha256` sidecar. */
  manifest: string
}): string => {
  const pattern = tarballName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return `EXPECTED=$(awk '$2 ~ /^\\*?${pattern}$/ {print $1}' "${manifest}")
[ -n "$EXPECTED" ] || { echo "FATAL: the checksum manifest does not name ${tarballName}" >&2; exit 1; }
case "$EXPECTED" in
  *[!0-9a-f]* | "") echo "FATAL: the checksum manifest names no lowercase sha256 for ${tarballName}" >&2; exit 1 ;;
esac
[ \${#EXPECTED} -eq 64 ] || { echo "FATAL: the checksum manifest digest is not 64 hex characters" >&2; exit 1; }
ACTUAL=$(sha256sum "${tarball}" | awk '{print $1}')
[ "$EXPECTED" = "$ACTUAL" ] || {
  echo "FATAL: runner checksum mismatch (want $EXPECTED got $ACTUAL)" >&2
  exit 1
}
echo "runner tarball checksum verified ($ACTUAL)"`
}

/**
 * One deploy's runner binary, from the checkout to the addresses a host reads.
 *
 * Called by both composition roots — `sst.config.ts` and `pulumi/program.ts` —
 * rather than by each provider, for the same reason `readStackEnvironment` is:
 * two copies that drifted would install a different binary on one cloud, found
 * months later with nothing reporting it. The roots are also where the
 * artifacts bucket is known, which is what a build-mode address needs.
 */
export const resolveRunnerBinary = ({
  environment,
  configRoot,
  artifactsBucket = null,
  readVersion = readWorkspaceVersion,
}: {
  environment: NodeJS.ProcessEnv
  /** Where `mdeploy.config.json` was found; the workspace is at or above it. */
  configRoot: string
  artifactsBucket?: string | null
  /** Injected so the resolution is provable without a checkout. */
  readVersion?: typeof readWorkspaceVersion
}): ResolvedRunnerBinary => {
  const selector = selectRunnerBinary({ environment, workspaceVersion: readVersion({ from: configRoot }) })
  return {
    ...runnerArtifactFor({ selector, artifactsBucket }),
    source: selector.kind,
    version: selector.version,
    identity: selector.kind === 'build' ? `${selector.version}+${selector.ref}` : selector.version,
  }
}
