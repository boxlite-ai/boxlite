/*
 * The machines boxes actually run on.
 *
 * Every other module in this directory describes something both clouds offer a
 * managed version of. This one does not, and that is the point of BoxLite: a
 * box is a microVM under KVM, so the host has to be a virtual machine that can
 * itself run a hypervisor. There is no serverless answer on either cloud, and a
 * contract that tried to hide the machine would have nothing left to describe.
 *
 * So `nestedVirtualization` is a request rather than an assumption, and both
 * providers have to satisfy it in their own way. AWS gives it on any modern
 * `.metal`-capable Nitro instance family without asking. GCP does not: nested
 * virtualization needs a machine family that supports it, a minimum CPU
 * platform of Haswell or later, and `advancedMachineFeatures.
 * enableNestedVirtualization` set explicitly — the exact three things
 * `scripts/deploy/gcp/create-instance.sh` has been doing by hand. A provider
 * that omitted any of them produces a host that boots, registers, and then
 * fails every box with no `/dev/kvm`.
 *
 * `size` is a request, never a machine type. `c8i.2xlarge` and `n2-standard-8`
 * are answers, and each cloud answers differently — including about which
 * families can nest at all.
 *
 * The binary is not built here. A runner installs a published release asset or
 * an object staged for one commit, and both reach it as a URL and a checksum;
 * which of the two a deploy chose is `RunnerBinary` below, resolved before any
 * machine exists so a bad selector fails before a host is created rather than
 * at its first boot.
 */

import type { Placement } from './network.ts'
import { instanceFor } from 'naming'

export type RunnerSize = 'small' | 'medium' | 'large'

/** One host, as the control plane will know it. */
export type RunnerSlot = {
  /** The logical resource name. Stable, so a re-deploy updates rather than replaces. */
  resourceName: string
  /** What the machine is labelled with, for a person reading a console. */
  nameTag: string
  /** The name the control plane registers it under. Unique across the fleet. */
  controlPlaneRunnerName: string
}

/**
 * One host and the token that pairs it with its row in the control plane.
 *
 * Carried together rather than as two lists, because they are only ever correct
 * together: pairing is token-based — the row's `apiKey` must equal the host's
 * `BOXLITE_RUNNER_TOKEN` — so a token that drifted one index from its host
 * would register a fleet where every member authenticates as its neighbour.
 *
 * Every host's token is minted by the composition root, one per host, because
 * two consumers in two different phases need the same value: the API reads the
 * first host's as `DEFAULT_RUNNER_API_KEY` and seeds that row from it, and the
 * host itself reads it as `BOXLITE_RUNNER_TOKEN`. The API is built before the
 * fleet, so a provider that minted its own would be minting after the one value
 * that has to match it was already spent. `stack/index.ts` holds it for the same
 * reason `apps/infra/stack/deploy.ts:71` does on the engine this replaces.
 */
export type RunnerAssignment = { slot: RunnerSlot; token: $util.Input<string> }

/**
 * What a host installs: two addresses, and the identity it must then report.
 *
 * One shape for both sources — a published release and a per-commit object —
 * because the host does the same thing with either: fetch the tarball, fetch the
 * `.sha256` sidecar beside it, refuse to install unless the manifest names
 * exactly that tarball and its digest matches.
 *
 * The digest travels as an address rather than a value because the stack is
 * evaluated synchronously by both engines: nothing here can read it. That is
 * also why `identity` is carried separately — the in-place upgrade converges on
 * what a live host *reports*, and a running runner cannot be asked for a digest.
 *
 * Resolved by `runner-binary.ts`, from the checkout, before any machine exists.
 * Plain strings, every one of them: nothing here comes from another resource, so
 * a provider renders the boot script and the upgrade payload without resolving
 * anything — which is also what lets both be tested without an engine.
 */
export type RunnerBinary = {
  tarballUrl: string
  /** The `.sha256` manifest beside it, which the host verifies against. */
  checksumUrl: string
  /** The filename the manifest must name. Not derivable from the URL on the host. */
  tarballName: string
  /** How both addresses are read: public HTTPS, or an object only a role may read. */
  transport: 'https' | 's3'
  /** Which source this came from. Decides whether ordering can be guarded. */
  source: 'release' | 'build'
  /**
   * What a host serving this binary reports on its health route: `X.Y.Z` for a
   * release, `X.Y.Z+<commit>` for a build — two builds of one checkout are
   * otherwise indistinguishable on the wire, and an upgrade that could not tell
   * them apart would skip every dev deploy after the first.
   */
  identity: string
}

export type RunnerRequest = {
  size: RunnerSize
  rootDiskGb: number
  /**
   * Required, and named rather than assumed. See the note above: it is one flag
   * on AWS and three separate decisions on GCP.
   */
  nestedVirtualization: true
  /** Each host and the token it authenticates with. See `RunnerAssignment`. */
  fleet: readonly RunnerAssignment[]
  binary: RunnerBinary
  /** Where a host registers itself, and where it ships telemetry. */
  apiUrl: $util.Input<string>
  otlpUrl: $util.Input<string>
  /** Values every host reads. */
  environment: Record<string, $util.Input<string>>
  /** Names it reads by reference: its own registration key, and the admin key. */
  secrets: Record<string, $util.Input<string>>
}

export type RunnerDependencies = {
  /**
   * The runner's own placement, taken straight from the network rather than
   * through a cluster: it is a machine, not a task, so there is no host to be
   * placed in — see `cluster.ts`. Its exposure is `egress-only-public`, and a
   * provider handed anything else should refuse rather than place a host that
   * cannot pull its own binary.
   */
  placement: Placement
  /** Nothing registers before the control plane can answer. */
  dependsOn: any[]
}

export type Runners = {
  /** One id per slot, in the order they were requested. */
  ids: $util.Output<string>[]
  ready: any[]
}

export type RunnerProvider = (request: RunnerRequest) => Runners

/** The one port a runner listens on: its API, the box proxy and the ssh gateway. */
/**
 * What a host is called, which is also how the fleet is found again.
 *
 * `<app>-<stage>-runner`, through the same `instanceFor` every other resource
 * goes through, rather than a literal. A name without the stage cannot be
 * deployed twice into one project — a GCE instance name is project-scoped, so
 * the second stage collides outright — and `runner-update.ts` walks the fleet
 * by this prefix, so a stage-less name would sweep another stage's hosts into
 * this stage's roll.
 *
 * The first host takes the bare prefix and the rest a number, which is the
 * order a roll visits them in.
 */
export const runnerNamePrefix = ({ app, stage }: { app: string; stage: string }): string =>
  instanceFor({ app, stage, artifact: 'runner' })

export const runnerNameFor = ({ app, stage, index }: { app: string; stage: string; index: number }): string =>
  index === 1 ? runnerNamePrefix({ app, stage }) : `${runnerNamePrefix({ app, stage })}-${index}`

export const RUNNER_PORT = 3003

/**
 * What the host reads its registration token from.
 *
 * `apps/runner/cmd/runner/config/config.go` looks for this, falls back to
 * `API_TOKEN`, and otherwise refuses to start. The API reads the same value
 * under its own name — `DEFAULT_RUNNER_API_KEY` — because that is what seeds
 * the first runner's row; one minted secret, two readers, two names.
 */
export const RUNNER_TOKEN_VARIABLE = 'BOXLITE_RUNNER_TOKEN'

/** What the API reads the first host's token as, and seeds its row from. */
export const API_RUNNER_TOKEN_VARIABLE = 'DEFAULT_RUNNER_API_KEY'
