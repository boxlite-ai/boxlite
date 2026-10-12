/*
 * The registry proxy: how a runner pulls an image whose registry credentials
 * only the platform holds.
 *
 * A runner authenticates to it with its own key and it authenticates upstream
 * for the organization, then relays the answer without touching it. It is a
 * workload of its own rather than a route on the API because of what it will
 * hold: once registry credentials exist, this is the one process that reads
 * them, and keeping them out of the control plane is the point.
 *
 * It holds none yet. The release that introduces it pulls only what an
 * upstream serves anonymously, which is why there is no `secrets` channel
 * here — a channel with nothing in it would be a grant waiting for a reason.
 *
 * Deployed on one cloud. The handle says so rather than the bundle throwing: a
 * stage on the other cloud deploys everything else and reports no proxy, which
 * is true, where a throw would take the whole stage down for a service nothing
 * there calls.
 */

export type RegistryProxyRequest = {
  image: $util.Input<string>
  /** Values the container reads, already assembled. */
  environment: Record<string, $util.Input<string>>
}

export type RegistryProxy =
  | { active: false }
  | {
      active: true
      /**
       * Where a caller reaches it, with no trailing slash.
       *
       * An HTTPS origin, because the runtime that pulls through it connects to
       * a registry over TLS unless told otherwise, and telling it otherwise is
       * a setting nobody should have to remember per stage.
       */
      url: $util.Output<string>
      ready: any[]
    }

export type RegistryProxyProvider = (request: RegistryProxyRequest) => RegistryProxy

/**
 * The port the binary listens on, and the one its platform is told to send to.
 *
 * One constant for both, because the binary does not read the platform's own
 * `PORT`: it reads `REGISTRY_PROXY_PORT`, and a platform told one port while
 * the container listens on another starts a revision that never passes its
 * first probe.
 */
export const REGISTRY_PROXY_PORT = 4100

/** The variables the binary reads, from `apps/image-service/cmd/registry-proxy/config`. */
export const REGISTRY_PROXY_PORT_VARIABLE = 'REGISTRY_PROXY_PORT'
export const REGISTRY_PROXY_CONTROL_PLANE_VARIABLE = 'BOXLITE_API_URL'

/** Where the platform asks whether the process is up. */
export const REGISTRY_PROXY_HEALTH_PATH = '/health'
